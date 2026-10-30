// The video interview coach against a real Postgres (in-memory PGlite
// migrated from drizzle/*.sql and seeded from the authored bank - never the
// live database): the database-backed question bank, authorization between
// students, default-off and revocable training consent, answer processing
// with retries, no answer key in anything the browser receives, and the
// limits. Training VIDEO uploads are in video-interview-training.test.ts.
//
// The transcription provider and the grading model are swapped for fakes, and
// the network guard fails any real request.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { eq, sql } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import {
  interviewQuestions,
  users,
  videoInterviewConsentEvents,
  videoInterviewQuestions,
  videoInterviewRecordings,
  videoInterviewSessions,
} from "@/db/schema";
import { getConsentState, grantAnalysisConsent } from "@/lib/video-interview/consent";
import {
  VideoInterviewError,
  deleteAllVideoData,
  deleteSession,
  finishSession,
  getActiveSession,
  getSessionForUser,
  markQuestionAsked,
  recordPracticeAnswer,
  skipAnswer,
  startSession,
  submitAnswer,
} from "@/lib/video-interview/sessions";
import { expectedPointsFor } from "@/lib/video-interview/question-bank-db";
import { seedInterviewQuestions } from "@/lib/video-interview/seed";
import { setObjectStorageForTests } from "@/lib/video-interview/object-storage";
import { setGradingModelForTests } from "@/lib/video-interview/grading";
import { TranscriptionError, setTranscriptionProviderForTests, type TranscriptionProvider } from "@/lib/video-interview/transcription";
import { LIMITS } from "@/lib/video-interview/limits";
import { VIDEO_POLICY_VERSION } from "@/lib/video-interview/types";

delete process.env.DATABASE_URL;

let h: TestDatabase;
let restore: () => void;
let alice: string;
let bob: string;

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]), Buffer.alloc(2000, 7)]);
const TRANSCRIPT =
  "So in that role I led a team of four on a pricing project. The situation was that margins were falling, " +
  "my task was to find why, I built a model of every product line, and the result was a ten percent margin recovery. " +
  "What I learned is to test the assumptions first.";

let transcribeCalls = 0;
const fakeTranscriber: TranscriptionProvider = {
  name: "fake",
  async transcribe() {
    transcribeCalls++;
    return { text: TRANSCRIPT, words: null };
  },
};

const MODEL_REPLY = {
  summary: "A clear, specific story with a measurable result.",
  strengths: ["Specific numbers"],
  improvements: ["Say more about your own actions"],
  grammarNotes: [],
  coveredPoints: [1, 2],
  factualErrors: [],
  star: { situation: true, task: true, action: true, result: true, reflection: true },
  scores: { grammarClarity: 8, structure: 8, relevance: 9, completeness: 7, logic: 8, concision: 7 },
};

before(async () => {
  h = await createTestDb();
  restore = installAsAppDb(h.db);
  const [a] = await h.db.insert(users).values({ email: "alice@example.edu", passwordHash: "x", preferredCategories: ["investment_banking"], nicheInterests: ["Restructuring"] }).returning();
  const [b] = await h.db.insert(users).values({ email: "bob@example.edu", passwordHash: "x" }).returning();
  alice = a.id;
  bob = b.id;
  await seedInterviewQuestions(h.db as never);
});

after(async () => {
  restore();
  await h.close();
});

beforeEach(async () => {
  transcribeCalls = 0;
  setTranscriptionProviderForTests(fakeTranscriber);
  setGradingModelForTests(async () => MODEL_REPLY);
  setObjectStorageForTests(null);
  await h.db.delete(videoInterviewSessions);
  await h.db.delete(videoInterviewConsentEvents);
});

afterEach(() => {
  setTranscriptionProviderForTests(undefined);
  setGradingModelForTests(null);
  setObjectStorageForTests(undefined);
});

/** A Start request: a fresh token each time (one per dialog), training
 *  declined unless a test says otherwise. */
const fresh = (over: Record<string, unknown> = {}) => ({ mode: "both", thinkSeconds: 30, answerSeconds: 120, difficulty: "auto", trainingChoice: "no", startToken: randomUUID(), ...over });

async function started(userId = alice) {
  await grantAnalysisConsent(userId);
  return startSession(userId, fresh());
}

/** Marks a question asked a minute ago, so a 30s answer fits the server clock. */
async function askedAMinuteAgo(questionId: string, userId = alice) {
  assert.equal(await markQuestionAsked(userId, questionId), true);
  await h.db.update(videoInterviewQuestions).set({ askedAt: new Date(Date.now() - 60_000) }).where(eq(videoInterviewQuestions.id, questionId));
}

const answer = (questionId: string) => ({ questionId, durationMs: 30_000, file: { bytes: WEBM, type: "audio/webm;codecs=opus", size: WEBM.length } });

// ---------- consent ----------

test("no consent is inferred from silence", async () => {
  const c = await getConsentState(alice);
  assert.equal(c.analysis, null);
  assert.equal(c.policyVersion, VIDEO_POLICY_VERSION);
  assert.equal(c.training, null, "training is asked, never assumed");
});

test("the coach cannot start without analysis consent, and works without training consent", async () => {
  await assert.rejects(startSession(alice, fresh()), VideoInterviewError);
  const s = await started();
  assert.equal(s.questions.length, 5);
  assert.equal(s.training.optedIn, false, "agreeing to analysis does not opt in to training");
});

test("analysis consent is a versioned, timestamped event; training is decided per interview", async () => {
  await grantAnalysisConsent(alice);
  const rows = await h.db.select().from(videoInterviewConsentEvents).where(eq(videoInterviewConsentEvents.userId, alice));
  assert.deepEqual(rows.map((r) => r.kind), ["analysis_granted"]);
  assert.ok(rows.every((r) => r.policyVersion === VIDEO_POLICY_VERSION && r.createdAt instanceof Date));
  assert.ok((await getConsentState(alice)).analysis);
});

test("an analysis consent under an older policy version does not count, and old account-wide training rows authorise nothing", async () => {
  await h.db.insert(videoInterviewConsentEvents).values({ userId: alice, kind: "training_granted", policyVersion: VIDEO_POLICY_VERSION });
  await h.db.insert(videoInterviewConsentEvents).values({ userId: alice, kind: "analysis_granted", policyVersion: "2020-01-01" });
  assert.equal((await getConsentState(alice)).analysis, null);
  await grantAnalysisConsent(alice);
  const s = await startSession(alice, fresh());
  assert.equal(s.training.optedIn, false, "a legacy training event does not opt an interview in");
});

test("answer audio is transcribed and never kept, whatever the training choice", async () => {
  await grantAnalysisConsent(alice);
  const s = await startSession(alice, fresh({ trainingChoice: "yes" }));
  await askedAMinuteAgo(s.questions[0].id);
  const r = await submitAnswer(alice, answer(s.questions[0].id));
  assert.equal(r.answer.status, "complete");
  assert.equal(r.answer.retained, false, "only an uploaded, confirmed training video is ever retained");
  assert.equal((await h.db.select().from(videoInterviewRecordings)).length, 0);
});

// ---------- authorization ----------

test("one student cannot read, answer, skip, finish or delete another's interview", async () => {
  const s = await started(alice);
  const q = s.questions[0].id;
  assert.equal(await getSessionForUser(bob, s.id), null);
  assert.equal(await getActiveSession(bob), null);
  assert.equal(await markQuestionAsked(bob, q), false);
  await assert.rejects(submitAnswer(bob, answer(q)), /isn't part of your interview/);
  await assert.rejects(skipAnswer(bob, q), VideoInterviewError);
  await assert.rejects(finishSession(bob, s.id), VideoInterviewError);
  assert.equal(await deleteSession(bob, s.id), false);
  await deleteAllVideoData(bob);
  assert.ok(await getSessionForUser(alice, s.id), "Alice's interview is untouched");
  // Malformed ids are just "not found".
  assert.equal(await getSessionForUser(alice, "'; drop table users; --"), null);
  await assert.rejects(submitAnswer(alice, answer("not-a-uuid")), VideoInterviewError);
});

// ---------- no answer-key leakage ----------

test("nothing the browser receives contains an expected point, before or after grading", async () => {
  const s = await started();
  // ClientQuestion carries no bank id, so the keys are looked up from the table.
  const rows = await h.db.select().from(videoInterviewQuestions).where(eq(videoInterviewQuestions.sessionId, s.id));
  const expected = (await Promise.all(rows.map((r) => expectedPointsFor(r.bankId)))).flat().filter((p): p is string => typeof p === "string");
  const firstKey = (await expectedPointsFor(rows.find((r) => r.position === 0)!.bankId))!;
  assert.ok(expected.length > 10 && firstKey.length >= 3);

  const assertClean = (payload: unknown, when: string) => {
    const json = JSON.stringify(payload);
    assert.doesNotMatch(json, /expectedPoints|bankId|bank_id/, when);
    for (const p of expected) assert.ok(!json.includes(p), `${when}: leaked "${p}"`);
  };
  assertClean(s, "on start");
  // Even a grader that parrots the answer key cannot get it into the payload.
  // The grader is only ever shown the answered question's own points.
  setGradingModelForTests(async () => ({ ...MODEL_REPLY, strengths: firstKey.slice(0, 3), improvements: firstKey.slice(1, 4), grammarNotes: [firstKey[0]], summary: `Good. ${firstKey[0]}` }));
  await askedAMinuteAgo(s.questions[0].id);
  const r = await submitAnswer(alice, answer(s.questions[0].id));
  assertClean(r, "after grading");
  assertClean(await getSessionForUser(alice, s.id), "on reload");
});

// ---------- submissions: duplicates, order, retries, validation ----------

test("an answer is processed once: duplicates and concurrent submits are refused", async () => {
  const s = await started();
  const q = s.questions[0].id;
  await askedAMinuteAgo(q);
  const results = await Promise.allSettled([submitAnswer(alice, answer(q)), submitAnswer(alice, answer(q)), submitAnswer(alice, answer(q))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one wins the claim");
  assert.equal(transcribeCalls, 1, "the recording is transcribed once");
  await assert.rejects(submitAnswer(alice, answer(q)), /already submitted/);
});

test("answers go in order, and the server clock bounds the duration", async () => {
  const s = await started();
  await askedAMinuteAgo(s.questions[1].id);
  await assert.rejects(submitAnswer(alice, answer(s.questions[1].id)), /in order/);

  const q0 = s.questions[0].id;
  // Never marked asked: a 30s answer cannot have happened.
  await assert.rejects(submitAnswer(alice, answer(q0)), /doesn't add up/);
  await askedAMinuteAgo(q0);
  await assert.rejects(submitAnswer(alice, { ...answer(q0), file: { bytes: Buffer.from("<html>"), type: "audio/webm", size: 6 } }), /isn't a recording/);
  await assert.rejects(submitAnswer(alice, { ...answer(q0), durationMs: 500_000 }), /longer than the answer time/);
  assert.equal(transcribeCalls, 0, "invalid uploads never reach the provider");
  const row = (await h.db.select().from(videoInterviewQuestions).where(eq(videoInterviewQuestions.id, q0)))[0];
  assert.equal(row.status, "pending", "a rejected upload does not consume the answer");
});

test("a transcription outage fails the answer retryably, and the retry succeeds without losing the session", async () => {
  const s = await started();
  const q = s.questions[0].id;
  await askedAMinuteAgo(q);
  setTranscriptionProviderForTests({
    name: "down",
    async transcribe() {
      throw new TranscriptionError("Transcription failed (HTTP 503).", true);
    },
  });
  await assert.rejects(submitAnswer(alice, answer(q)), (e: VideoInterviewError) => e.retryable && /try again/i.test(e.message));
  let reloaded = await getSessionForUser(alice, s.id);
  assert.equal(reloaded!.answers[0].status, "failed");
  assert.equal(reloaded!.status, "in_progress", "the session survives");

  setTranscriptionProviderForTests(fakeTranscriber);
  const r = await submitAnswer(alice, answer(q));
  assert.equal(r.answer.status, "complete");
  reloaded = await getSessionForUser(alice, s.id);
  assert.equal(reloaded!.answers[0].status, "complete");
});

test("a grading failure still completes the answer on delivery alone", async () => {
  const s = await started();
  await askedAMinuteAgo(s.questions[0].id);
  setGradingModelForTests(async () => {
    throw new Error("overloaded");
  });
  const r = await submitAnswer(alice, answer(s.questions[0].id));
  assert.equal(r.answer.status, "complete");
  assert.equal(r.answer.feedback!.level, "delivery_only");
});

test("unconfigured speech-to-text fails clearly, not retryably, and can be skipped", async () => {
  setTranscriptionProviderForTests(null);
  const s = await started();
  const q = s.questions[0].id;
  await askedAMinuteAgo(q);
  await assert.rejects(submitAnswer(alice, answer(q)), (e: VideoInterviewError) => !e.retryable && /isn't set up/.test(e.message));
  const after = await skipAnswer(alice, q);
  assert.equal(after.answers[0].status, "skipped");
});

test("attempts are capped, and a stale 'processing' claim can be recovered", async () => {
  const s = await started();
  const q = s.questions[0].id;
  await askedAMinuteAgo(q);
  await h.db.update(videoInterviewQuestions).set({ status: "processing", processingStartedAt: new Date() }).where(eq(videoInterviewQuestions.id, q));
  await assert.rejects(submitAnswer(alice, answer(q)), /already being processed/);
  await h.db
    .update(videoInterviewQuestions)
    .set({ processingStartedAt: new Date(Date.now() - LIMITS.staleProcessingMs - 1000) })
    .where(eq(videoInterviewQuestions.id, q));
  assert.equal((await submitAnswer(alice, answer(q))).answer.status, "complete", "a crashed attempt does not strand the answer");

  const q1 = s.questions[1].id;
  await askedAMinuteAgo(q1);
  await h.db.update(videoInterviewQuestions).set({ status: "failed", attempts: LIMITS.attemptsPerAnswer }).where(eq(videoInterviewQuestions.id, q1));
  await assert.rejects(submitAnswer(alice, answer(q1)), /several tries/);
});

test("finishing builds the report; completing every answer finishes on its own", async () => {
  const s = await started();
  for (const q of s.questions) {
    await askedAMinuteAgo(q.id);
    await submitAnswer(alice, answer(q.id));
  }
  const done = await getSessionForUser(alice, s.id);
  assert.equal(done!.status, "complete");
  assert.equal(done!.report!.answered, 5);
  assert.equal(typeof done!.report!.overall, "number");
  assert.equal(await getActiveSession(alice), null);
});

test("starting a new interview closes the open one; the daily cap holds", async () => {
  const first = await started();
  const second = await startSession(alice, fresh());
  const [row] = await h.db.select().from(videoInterviewSessions).where(eq(videoInterviewSessions.id, first.id));
  assert.equal(row.status, "abandoned");
  assert.equal((await getActiveSession(alice))!.id, second.id);

  const extra = LIMITS.sessionsPerDay - 2;
  for (let i = 0; i < extra; i++) {
    await h.db.insert(videoInterviewSessions).values({ userId: alice, mode: "both", difficulty: "auto", thinkSeconds: 30, answerSeconds: 120, analysisPolicyVersion: VIDEO_POLICY_VERSION, status: "abandoned" });
  }
  await assert.rejects(startSession(alice, fresh()), /today/);
});

test("the submission rate limit holds", async () => {
  const s = await started();
  await h.db.execute(sql`
    insert into video_interview_questions (session_id, user_id, position, kind, bank_id, topic, difficulty, prompt, status, processing_started_at)
    select ${s.id}, ${alice}, 100 + g, 'behavioral', 'x', 't', 'foundational', 'p', 'complete', now()
    from generate_series(1, ${LIMITS.submissionsPerWindow}) g`);
  await askedAMinuteAgo(s.questions[0].id);
  await assert.rejects(submitAnswer(alice, answer(s.questions[0].id)), /Wait a moment/);
});

test("deleting an interview removes its questions and transcripts", async () => {
  const s = await started();
  await askedAMinuteAgo(s.questions[0].id);
  await submitAnswer(alice, answer(s.questions[0].id));
  assert.equal(await deleteSession(alice, s.id), true);
  assert.equal((await h.db.select().from(videoInterviewQuestions).where(eq(videoInterviewQuestions.sessionId, s.id))).length, 0);
});

test("the migration is replay-safe", async () => {
  // Applying 0029 a second time must be a no-op (see helpers/test-db.ts).
  const { readFileSync } = await import("node:fs");
  for (const name of ["drizzle/0029_video_interviews.sql", "drizzle/0030_interview_question_bank.sql", "drizzle/0031_object_deletion_queue.sql", "drizzle/0032_per_interview_training_consent.sql"]) {
    const file = readFileSync(name, "utf8");
    for (const stmt of file.split("--> statement-breakpoint")) if (stmt.trim()) await h.client.exec(stmt.trim());
  }
});

// ---------- the database-backed question bank ----------

test("runtime selection reads interview_questions, not the static bank", async () => {
  const anchor = "universal.behavioral.b001";
  const original = (await h.db.select().from(interviewQuestions).where(eq(interviewQuestions.id, anchor)))[0];
  try {
    // An edit made only in the database shows up in the next interview.
    await h.db.update(interviewQuestions).set({ prompt: "DB-ONLY: walk me through your background." }).where(eq(interviewQuestions.id, anchor));
    // And retiring every authored technical, with five database-only ones in
    // their place, is exactly what a technical interview then serves.
    await h.db.update(interviewQuestions).set({ active: false }).where(eq(interviewQuestions.kind, "technical"));
    const dbOnly = [1, 2, 3, 4, 5].map((i) => ({
      id: `test.db-only.t${i}`,
      kind: "technical",
      prompt: `DB-ONLY technical ${i}?`,
      topic: `Topic ${i}`,
      category: "investment_banking",
      specialty: null,
      difficulty: "intermediate",
      expectedPoints: [`Secret point ${i}`],
      source: "test",
    }));
    await h.db.insert(interviewQuestions).values(dbOnly);

    await grantAnalysisConsent(alice);
    const both = await startSession(alice, fresh({ mode: "both" }));
    assert.equal(both.questions[0].prompt, "DB-ONLY: walk me through your background.");
    const tech = await startSession(alice, fresh({ mode: "technical" }));
    assert.deepEqual(tech.questions.map((q) => q.prompt).sort(), dbOnly.map((q) => q.prompt).sort());
    assert.ok(!JSON.stringify(tech).includes("Secret point"), "the database answer key stays on the server");
  } finally {
    await h.db.delete(interviewQuestions).where(eq(interviewQuestions.source, "test"));
    await h.db.update(interviewQuestions).set({ active: true }).where(eq(interviewQuestions.source, "authored"));
    await h.db.update(interviewQuestions).set({ prompt: original.prompt }).where(eq(interviewQuestions.id, anchor));
  }
});

test("seeding is idempotent, keeps stable ids, and never re-activates a retired question", async () => {
  const before = await h.db.select({ id: interviewQuestions.id }).from(interviewQuestions);
  const retired = "investment_banking.general.t001";
  await h.db.update(interviewQuestions).set({ active: false, prompt: "locally edited" }).where(eq(interviewQuestions.id, retired));

  const again = await seedInterviewQuestions(h.db as never);
  assert.equal(again.inserted, 0, "nothing new on a re-run");
  assert.equal(again.updated, again.total);

  const after = await h.db.select({ id: interviewQuestions.id }).from(interviewQuestions);
  assert.equal(after.length, before.length, "no duplicates");
  assert.deepEqual(new Set(after.map((r) => r.id)), new Set(before.map((r) => r.id)), "the same stable ids");
  const [row] = await h.db.select().from(interviewQuestions).where(eq(interviewQuestions.id, retired));
  assert.equal(row.active, false, "still retired");
  assert.notEqual(row.prompt, "locally edited", "authored wording restored");
  await h.db.update(interviewQuestions).set({ active: true }).where(eq(interviewQuestions.id, retired));
});

test("both modes stay exactly 2 + 3 and 5 + 0 when drawn from the database", async () => {
  await grantAnalysisConsent(alice);
  const both = await startSession(alice, fresh({ mode: "both" }));
  assert.deepEqual(both.questions.map((q) => q.kind), ["behavioral", "behavioral", "technical", "technical", "technical"]);
  const beh = await startSession(alice, fresh({ mode: "behavioral" }));
  assert.equal(beh.questions.length, 5);
  assert.ok(beh.questions.every((q) => q.kind === "behavioral"));
  assert.match(beh.questions[0].prompt, /Tell me about yourself/);
  // Alice's onboarding (investment banking, Restructuring) steers the technicals.
  const tech = await startSession(alice, fresh({ mode: "technical" }));
  assert.ok(tech.questions.every((q) => q.sectorLabel === "Investment Banking"));
});

// ---------- practice recordings vs real skips ----------

test("without speech-to-text, a recorded answer is 'Recorded - not scored'; skips stay skips", async () => {
  setTranscriptionProviderForTests(null);
  const s = await started();
  const [q0, q1] = s.questions;

  await askedAMinuteAgo(q0.id);
  const after = await recordPracticeAnswer(alice, q0.id);
  assert.equal(after.answers[0].status, "skipped");
  assert.equal(after.answers[0].practiceOnly, true);
  assert.equal(transcribeCalls, 0, "nothing was sent for transcription");
  assert.equal((await h.db.select().from(videoInterviewRecordings)).length, 0, "and nothing kept");

  // The student skips the next one on purpose...
  await askedAMinuteAgo(q1.id);
  const skipped = await skipAnswer(alice, q1.id);
  assert.equal(skipped.answers[1].practiceOnly, false);
  // ...and ends early: the rest are skipped by ending, not practice answers.
  const done = await finishSession(alice, s.id);
  assert.equal(done.status, "complete");
  assert.deepEqual(done.answers.map((a) => a.practiceOnly), [true, false, false, false, false]);
  // Survives a reload - the label is persisted, not held in the tab.
  assert.equal((await getSessionForUser(alice, s.id))!.answers[0].practiceOnly, true);
});

test("a practice answer is refused when speech-to-text is configured, or before the question was asked", async () => {
  const s = await started();
  await askedAMinuteAgo(s.questions[0].id);
  await assert.rejects(recordPracticeAnswer(alice, s.questions[0].id), /should be submitted for scoring/);
  setTranscriptionProviderForTests(null);
  await assert.rejects(recordPracticeAnswer(alice, s.questions[1].id), /hasn't been asked/);
  await assert.rejects(recordPracticeAnswer(bob, s.questions[0].id), VideoInterviewError, "and never for someone else's question");
});
