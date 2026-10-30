import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, videoInterviewQuestions, videoInterviewRecordings, videoInterviewSessions } from "@/db/schema";
import { CATEGORY_LABELS, type QuizCategory, type QuizDifficulty } from "../question-bank/types";
import { getConsentState, readTrainingStanding, recordTrainingStanding, trainingLock } from "./consent";
import { computeDeliveryMetrics } from "./delivery-metrics";
import { gradeSpokenAnswer } from "./grading";
import { LIMITS, buildReport, sessionLimitMessage, submissionLimitMessage } from "./limits";
import { expectedPointsFor } from "./question-bank-db";
import { chargeableSeconds, reserveAudioSeconds, tooLongForAnswer } from "./stt-budget";
import { resolveTargeting, selectInterviewQuestions } from "./question-selection";
import { deleteTrainingRecordings } from "./training-video";
import { TranscriptionError, TranscriptionUnconfiguredError, getTranscriptionProvider } from "./transcription";
import {
  ANSWER_OPTIONS,
  DIFFICULTY_CHOICES,
  DURATION_GRACE_MS,
  INTERVIEW_MODES,
  THINK_OPTIONS,
  VIDEO_POLICY_VERSION,
  type AnswerFeedback,
  type AnswerStatus,
  type ClientAnswer,
  type ClientQuestion,
  type ClientSession,
  type DifficultyChoice,
  type InterviewMode,
  type TrainingChoice,
} from "./types";
import { validateAudioUpload } from "./upload-validation";
import { VideoInterviewError } from "./errors";

/**
 * The video coach's server side: starting an interview, taking each answer
 * through upload -> transcript -> delivery metrics -> grading -> (optional)
 * retention, and the final report.
 *
 * Authorization is structural: every read and write here is filtered by the
 * caller's user id AND the row's id, so a question or session id from someone
 * else's interview matches nothing - it is indistinguishable from an id that
 * does not exist. Callers pass the id from the session cookie, never from the
 * request.
 */

export { VideoInterviewError };

type Tx = Awaited<ReturnType<typeof getDb>>;
async function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await getDb();
  // One transaction type across the two drivers (PGlite, postgres-js).
  const run = db.transaction.bind(db) as unknown as <R>(f: (tx: Tx) => Promise<R>) => Promise<R>;
  return run(fn);
}

export type StartInput = {
  mode: unknown;
  thinkSeconds: unknown;
  answerSeconds: unknown;
  difficulty: unknown;
  /** The answer to "contribute this interview?" - required, never defaulted. */
  trainingChoice: unknown;
  /** One per Start dialog; a repeat returns the same session. */
  startToken: unknown;
};

export type ParsedStart = {
  mode: InterviewMode;
  thinkSeconds: number;
  answerSeconds: number;
  difficulty: DifficultyChoice;
  trainingChoice: TrainingChoice;
  startToken: string;
};

/** The browser's setup, checked - every field is a fixed choice. There is no
 *  default training choice: anything but an explicit "yes" or "no" is refused. */
export function parseStartInput(raw: StartInput): ParsedStart | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.trainingChoice !== "yes" && raw.trainingChoice !== "no") return null;
  if (typeof raw.startToken !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(raw.startToken)) return null;
  if (!INTERVIEW_MODES.includes(raw.mode as InterviewMode)) return null;
  if (!THINK_OPTIONS.includes(raw.thinkSeconds as (typeof THINK_OPTIONS)[number])) return null;
  if (!ANSWER_OPTIONS.includes(raw.answerSeconds as (typeof ANSWER_OPTIONS)[number])) return null;
  const difficulty = DIFFICULTY_CHOICES.includes(raw.difficulty as DifficultyChoice) ? (raw.difficulty as DifficultyChoice) : "auto";
  return {
    mode: raw.mode as InterviewMode,
    thinkSeconds: raw.thinkSeconds as number,
    answerSeconds: raw.answerSeconds as number,
    difficulty,
    trainingChoice: raw.trainingChoice,
    startToken: raw.startToken,
  };
}

/** transcription_status for an answer recorded, kept on-device, not scored. */
const PRACTICE_ONLY = "practice_only";

type QuestionRow = typeof videoInterviewQuestions.$inferSelect;
type SessionRow = typeof videoInterviewSessions.$inferSelect;

/** What the browser may see of a question. Named fields, never a spread of
 *  the row - there is nothing secret on the row, but a column added later
 *  must be a decision to expose, not an accident. */
function toClientQuestion(q: QuestionRow): ClientQuestion {
  return {
    id: q.id,
    position: q.position,
    kind: q.kind as ClientQuestion["kind"],
    prompt: q.prompt,
    topic: q.topic,
    ...(q.category ? { sectorLabel: CATEGORY_LABELS[q.category as QuizCategory] ?? undefined } : {}),
    difficulty: q.difficulty as ClientQuestion["difficulty"],
  };
}

function toClientAnswer(q: QuestionRow, retained: boolean): ClientAnswer {
  return {
    questionId: q.id,
    status: q.status as AnswerStatus,
    transcript: q.transcript,
    feedback: (q.feedback as AnswerFeedback | null) ?? null,
    error: q.status === "failed" ? q.lastError : null,
    retained,
    practiceOnly: q.status === "skipped" && q.transcriptionStatus === PRACTICE_ONLY,
  };
}

async function loadClientSession(userId: string, session: SessionRow): Promise<ClientSession> {
  const db = await getDb();
  const questions = await db
    .select()
    .from(videoInterviewQuestions)
    .where(and(eq(videoInterviewQuestions.sessionId, session.id), eq(videoInterviewQuestions.userId, userId)))
    .orderBy(asc(videoInterviewQuestions.position));
  const kept = questions.length
    ? await db
        .select({ questionId: videoInterviewRecordings.questionId })
        .from(videoInterviewRecordings)
        .where(
          and(
            eq(videoInterviewRecordings.userId, userId),
            eq(videoInterviewRecordings.status, "stored"),
            inArray(videoInterviewRecordings.questionId, questions.map((q) => q.id)),
          ),
        )
    : [];
  const keptIds = new Set(kept.map((k) => k.questionId));
  return {
    id: session.id,
    mode: session.mode as InterviewMode,
    thinkSeconds: session.thinkSeconds,
    answerSeconds: session.answerSeconds,
    status: session.status === "complete" ? "complete" : "in_progress",
    tailoredTo: session.tailoredTo,
    questions: questions.map(toClientQuestion),
    answers: questions.map((q) => toClientAnswer(q, keptIds.has(q.id))),
    report: (session.report as ClientSession["report"]) ?? null,
    createdAt: session.createdAt.toISOString(),
    training: { optedIn: session.trainingOptIn, decidedAt: session.trainingDecidedAt?.toISOString() ?? null },
  };
}

export async function getSessionForUser(userId: string, sessionId: string): Promise<ClientSession | null> {
  if (!isUuid(sessionId)) return null;
  const db = await getDb();
  const [session] = await db
    .select()
    .from(videoInterviewSessions)
    .where(and(eq(videoInterviewSessions.id, sessionId), eq(videoInterviewSessions.userId, userId)))
    .limit(1);
  return session ? loadClientSession(userId, session) : null;
}

/** The interview the student left unfinished, if any - what a reload resumes. */
export async function getActiveSession(userId: string): Promise<ClientSession | null> {
  const db = await getDb();
  const [session] = await db
    .select()
    .from(videoInterviewSessions)
    .where(and(eq(videoInterviewSessions.userId, userId), eq(videoInterviewSessions.status, "in_progress")))
    .orderBy(desc(videoInterviewSessions.createdAt))
    .limit(1);
  return session ? loadClientSession(userId, session) : null;
}

export async function listRecentSessions(userId: string, limit = 8): Promise<{ id: string; mode: InterviewMode; overall: number | null; createdAt: string }[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: videoInterviewSessions.id, mode: videoInterviewSessions.mode, report: videoInterviewSessions.report, createdAt: videoInterviewSessions.createdAt })
    .from(videoInterviewSessions)
    .where(and(eq(videoInterviewSessions.userId, userId), eq(videoInterviewSessions.status, "complete")))
    .orderBy(desc(videoInterviewSessions.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode as InterviewMode,
    overall: (r.report as { overall?: number | null } | null)?.overall ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function startSession(userId: string, raw: StartInput, rng?: () => number): Promise<ClientSession> {
  const input = parseStartInput(raw);
  if (!input) throw new VideoInterviewError("Choose your interview settings, and whether to contribute this interview, to start.");

  const consent = await getConsentState(userId);
  if (!consent.analysis) throw new VideoInterviewError("Agree to how your answers are processed before starting.");

  const db = await getDb();
  const profile = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { preferredCategories: true, nicheInterests: true, targetGroup: true, technicalReadiness: true },
  });
  const targeting = resolveTargeting(profile ?? {}, input.difficulty);

  // Recent history, for rotation: the behavioral core least-recently-asked
  // first, and technicals not repeated from the last few interviews.
  const recent = await db
    .select({ kind: videoInterviewQuestions.kind, bankId: videoInterviewQuestions.bankId, at: videoInterviewQuestions.createdAt })
    .from(videoInterviewQuestions)
    .where(eq(videoInterviewQuestions.userId, userId))
    .orderBy(desc(videoInterviewQuestions.createdAt))
    .limit(60);
  const behavioralLastAsked = new Map<string, number>();
  const recentTechnicalIds = new Set<string>();
  for (const r of recent) {
    if (r.kind === "behavioral" && !behavioralLastAsked.has(r.bankId)) behavioralLastAsked.set(r.bankId, r.at.getTime());
    if (r.kind === "technical" && recentTechnicalIds.size < 25) recentTechnicalIds.add(r.bankId);
  }

  const selected = await selectInterviewQuestions({ mode: input.mode, targeting, recentTechnicalIds, behavioralLastAsked, rng });
  if (selected.length === 0) throw new VideoInterviewError("Couldn't find questions for that interview. Try another type.");

  let trainingChoice = input.trainingChoice;
  const sessionId = await inTransaction(async (tx) => {
    // Serialises one student's starts, so a double-click cannot slip two past
    // the daily count.
    await tx.execute(trainingLock(userId));
    // A repeat of the same Start (double-click, retried request) is the same
    // interview - not a second session, and not a second consent record.
    const [already] = await tx
      .select({ id: videoInterviewSessions.id })
      .from(videoInterviewSessions)
      .where(and(eq(videoInterviewSessions.userId, userId), eq(videoInterviewSessions.startToken, input.startToken)))
      .limit(1);
    if (already) return already.id;

    // The standing answer decides, once there is one: the choice the page
    // sends is only the first answer, given in the Start dialog, and a page
    // that is out of date (a tab left open across a change) cannot override
    // it. Read inside the lock, which a change of answer also takes, so a
    // "no" given while this Start waited is the answer it uses.
    const standing = await readTrainingStanding(tx, userId);
    trainingChoice = standing?.choice ?? input.trainingChoice;
    // The first Start asks; its answer stands for every interview after.
    // After the repeat check, so a double-click records it once.
    if (!standing) await recordTrainingStanding(tx, userId, trainingChoice);

    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(videoInterviewSessions)
      .where(and(eq(videoInterviewSessions.userId, userId), gte(videoInterviewSessions.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))));
    const limited = sessionLimitMessage(Number(n));
    if (limited) throw new VideoInterviewError(limited);

    // One interview at a time: starting fresh closes whatever was left open.
    await tx
      .update(videoInterviewSessions)
      .set({ status: "abandoned" })
      .where(and(eq(videoInterviewSessions.userId, userId), eq(videoInterviewSessions.status, "in_progress")));

    const [session] = await tx
      .insert(videoInterviewSessions)
      .values({
        userId,
        mode: input.mode,
        difficulty: input.mode === "behavioral" ? "n/a" : targeting.difficulty,
        thinkSeconds: input.thinkSeconds,
        answerSeconds: input.answerSeconds,
        tailoredTo: input.mode === "behavioral" ? "Core behavioral questions" : targeting.description,
        analysisPolicyVersion: VIDEO_POLICY_VERSION,
        // The standing answer, copied onto this interview before anything
        // can be recorded. A later change to the standing answer applies to
        // interviews started after it (and a no also stops this one).
        trainingOptIn: trainingChoice === "yes",
        trainingPolicyVersion: VIDEO_POLICY_VERSION,
        trainingDecidedAt: new Date(),
        startToken: input.startToken,
      })
      .returning();
    await tx.insert(videoInterviewQuestions).values(
      selected.map((q, i) => ({
        sessionId: session.id,
        userId,
        position: i,
        kind: q.kind,
        bankId: q.bankId,
        category: q.category,
        topic: q.topic,
        difficulty: q.difficulty,
        prompt: q.prompt,
      })),
    );
    return session.id;
  });

  const session = await getSessionForUser(userId, sessionId);
  if (!session) throw new VideoInterviewError("Couldn't start the interview. Try again.", true);
  return session;
}

async function ownedQuestion(userId: string, questionId: string): Promise<{ q: QuestionRow; s: SessionRow } | null> {
  if (!isUuid(questionId)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ q: videoInterviewQuestions, s: videoInterviewSessions })
    .from(videoInterviewQuestions)
    .innerJoin(videoInterviewSessions, eq(videoInterviewSessions.id, videoInterviewQuestions.sessionId))
    .where(
      and(
        eq(videoInterviewQuestions.id, questionId),
        eq(videoInterviewQuestions.userId, userId),
        eq(videoInterviewSessions.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Records that the question is on screen - its think time has begun. Only
 *  the first call counts, so the clock cannot be pushed back. */
export async function markQuestionAsked(userId: string, questionId: string): Promise<boolean> {
  const owned = await ownedQuestion(userId, questionId);
  if (!owned || owned.s.status !== "in_progress") return false;
  const db = await getDb();
  await db
    .update(videoInterviewQuestions)
    .set({ askedAt: new Date() })
    .where(and(eq(videoInterviewQuestions.id, questionId), eq(videoInterviewQuestions.userId, userId), sql`${videoInterviewQuestions.askedAt} is null`));
  return true;
}

export type SubmitResult = { answer: ClientAnswer; session: ClientSession };

/**
 * One answer, end to end. Claims the answer first - a conditional update that
 * only one request can win - so a double submit or a retry racing the original
 * processes the recording once. Everything after the claim either completes
 * the answer or releases it as failed with a reason; nothing leaves it stuck
 * except a crash, which LIMITS.staleProcessingMs recovers from.
 */
export async function submitAnswer(
  userId: string,
  input: { questionId: string; durationMs: number; file: { bytes: Buffer; type: string; size: number } },
): Promise<SubmitResult> {
  const owned = await ownedQuestion(userId, input.questionId);
  if (!owned) throw new VideoInterviewError("That question isn't part of your interview.");
  const { q, s } = owned;
  if (s.status !== "in_progress") throw new VideoInterviewError("That interview has already finished.");
  if (q.status === "complete" || q.status === "skipped") throw new VideoInterviewError("That answer was already submitted.");

  const now = Date.now();
  const check = validateAudioUpload({
    declaredType: input.file.type,
    size: input.file.size,
    head: input.file.bytes.subarray(0, 16),
    durationMs: input.durationMs,
    answerSeconds: s.answerSeconds,
    msSinceServed: q.askedAt ? now - q.askedAt.getTime() : 0,
  });
  if (!check.ok) throw new VideoInterviewError(check.error);

  const db = await getDb();

  // Earlier questions must have been dealt with - answered, failed or skipped -
  // so an interview is answered in order.
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(videoInterviewQuestions)
    .where(
      and(
        eq(videoInterviewQuestions.sessionId, s.id),
        eq(videoInterviewQuestions.userId, userId),
        lt(videoInterviewQuestions.position, q.position),
        inArray(videoInterviewQuestions.status, ["pending", "processing"]),
      ),
    );
  if (Number(open) > 0) throw new VideoInterviewError("Answer the questions in order.");

  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(videoInterviewQuestions)
    .where(and(eq(videoInterviewQuestions.userId, userId), gte(videoInterviewQuestions.processingStartedAt, new Date(now - LIMITS.submissionWindowMs))));
  const limited = submissionLimitMessage(Number(recent));
  if (limited) throw new VideoInterviewError(limited, true);

  const [claimed] = await db
    .update(videoInterviewQuestions)
    .set({ status: "processing", attempts: sql`${videoInterviewQuestions.attempts} + 1`, processingStartedAt: new Date(), lastError: null })
    .where(
      and(
        eq(videoInterviewQuestions.id, q.id),
        eq(videoInterviewQuestions.userId, userId),
        lt(videoInterviewQuestions.attempts, LIMITS.attemptsPerAnswer),
        or(
          inArray(videoInterviewQuestions.status, ["pending", "failed"]),
          and(eq(videoInterviewQuestions.status, "processing"), lt(videoInterviewQuestions.processingStartedAt, new Date(now - LIMITS.staleProcessingMs))),
        ),
      ),
    )
    .returning();
  if (!claimed) {
    if (q.attempts >= LIMITS.attemptsPerAnswer) throw new VideoInterviewError("This answer couldn't be processed after several tries. Skip it to carry on.");
    throw new VideoInterviewError("That answer is already being processed.");
  }

  const fail = async (message: string, retryable: boolean, transcriptionStatus?: string) => {
    await db
      .update(videoInterviewQuestions)
      .set({ status: "failed", lastError: message, ...(transcriptionStatus ? { transcriptionStatus } : {}) })
      .where(and(eq(videoInterviewQuestions.id, q.id), eq(videoInterviewQuestions.userId, userId)));
    throw new VideoInterviewError(message, retryable);
  };

  // 1. Transcript.
  //
  // The day's audio is RESERVED first, not checked. The byte cap above does not
  // bound what the provider bills - that is audio MINUTES, and a few hundred
  // kilobytes of low-bitrate audio can be an hour long - so this meter is what
  // actually bounds the spend, and a meter that is read before the call and
  // written after it is no bound at all: twelve submissions fired together all
  // read the same zero and all twelve reached the provider.
  //
  // Charged at what the bytes are worth, which is the figure that holds when
  // the provider reports no duration, and corrected to the real duration below
  // once it does.
  const allowedSeconds = s.answerSeconds + DURATION_GRACE_MS / 1000;
  const provisional = chargeableSeconds({
    reportedSeconds: null,
    bytes: input.file.size,
    allowedSeconds,
  });
  const budget = await reserveAudioSeconds(userId, provisional);
  if (!budget.ok) return fail(budget.error, true, "failed");

  const provider = getTranscriptionProvider();
  let transcript: {
    text: string;
    words: { word: string; start: number; end: number }[] | null;
    durationSeconds?: number | null;
  };
  try {
    if (!provider) throw new TranscriptionUnconfiguredError();
    transcript = await provider.transcribe({ bytes: input.file.bytes, contentType: check.contentType, filename: `answer.${check.extension}` });
  } catch (err) {
    // Nothing was transcribed, so nothing is charged - the same rule
    // lib/ai-runner applies to a model call that never happened. An
    // unconfigured server and a provider outage must not spend a student's day.
    await budget.release();
    if (err instanceof TranscriptionUnconfiguredError) {
      return fail("Speech-to-text isn't set up on this server, so answers can't be transcribed. Skip this question to continue.", false, "unconfigured");
    }
    const retryable = err instanceof TranscriptionError ? err.retryable : true;
    console.error("video interview transcription failed:", (err as Error)?.message);
    return fail(retryable ? "Transcription didn't go through. Your recording is still here - try again." : "The transcription service couldn't read that recording.", retryable, "failed");
  }

  // What the provider actually billed, recorded against the day's budget
  // whatever happens to this answer next - including when it is refused below,
  // so retrying the same oversized file is bounded rather than free.
  //
  // The reservation above already holds the bytes-derived charge. Settle it to
  // the duration the provider measured, when it gives one, so an honest answer
  // ends up charged for what it actually was. Never the browser's durationMs:
  // that is the number the attacker controls, and upload-validation bounds it
  // from above but not from below, so charging it let an hour of audio be
  // declared as three seconds and metered as three seconds.
  await budget.settle(transcript.durationSeconds ?? null);

  // The browser's durationMs was checked against the server's clock, but it is
  // still only a claim. Now that the provider has measured the audio, an answer
  // whose real length exceeds the question's answer time is refused and its
  // transcript discarded - so overstating the recording buys nothing.
  if (tooLongForAnswer(transcript.durationSeconds ?? null, s.answerSeconds, DURATION_GRACE_MS)) {
    return fail("That recording is longer than the answer time allows.", false, "failed");
  }

  // 2. Delivery, measured; 3. content, graded (with its own fallbacks).
  const delivery = computeDeliveryMetrics({ transcript: transcript.text, durationMs: input.durationMs, words: transcript.words });
  // The answer key, from the database bank - server-side only.
  const expected = (await expectedPointsFor(q.bankId)) ?? [];
  const feedback = await gradeSpokenAnswer({
    userId,
    kind: q.kind as "behavioral" | "technical",
    prompt: q.prompt,
    topic: q.topic,
    difficulty: q.difficulty as QuizDifficulty,
    expectedPoints: expected,
    transcript: transcript.text,
    delivery,
  });

  // The audio is not kept: it was only ever needed for the transcript. A
  // training recording (video with audio) is a separate, opt-in upload - see
  // training-video.ts.
  await db
    .update(videoInterviewQuestions)
    .set({
      status: "complete",
      durationMs: Math.round(input.durationMs),
      audioContentType: check.contentType,
      audioBytes: input.file.size,
      transcript: transcript.text,
      transcriptionStatus: "ok",
      gradingStatus: feedback.level,
      feedback,
      overallScore: feedback.overall,
      lastError: null,
      completedAt: new Date(),
    })
    .where(and(eq(videoInterviewQuestions.id, q.id), eq(videoInterviewQuestions.userId, userId)));

  await finalizeIfDone(userId, s.id);
  const session = await getSessionForUser(userId, s.id);
  const answer = session?.answers.find((a) => a.questionId === q.id);
  if (!session || !answer) throw new VideoInterviewError("Your answer was saved, but the interview couldn't be reloaded.", true);
  return { answer, session };
}

/** Leaves a question unanswered - the student moves on (or speech-to-text is
 *  not configured). Only a pending or failed answer can be skipped. */
export async function skipAnswer(userId: string, questionId: string): Promise<ClientSession> {
  const owned = await ownedQuestion(userId, questionId);
  if (!owned || owned.s.status !== "in_progress") throw new VideoInterviewError("That question isn't part of an open interview.");
  const db = await getDb();
  await db
    .update(videoInterviewQuestions)
    .set({ status: "skipped", completedAt: new Date() })
    .where(and(eq(videoInterviewQuestions.id, questionId), eq(videoInterviewQuestions.userId, userId), inArray(videoInterviewQuestions.status, ["pending", "failed"])));
  await finalizeIfDone(userId, owned.s.id);
  return (await getSessionForUser(userId, owned.s.id))!;
}

/**
 * An answer recorded while speech-to-text is not set up. Nothing is uploaded -
 * the recording stays on the student's device for playback - so the server
 * only notes that the question was answered for practice and not scored.
 *
 * Kept in the existing transcription_status column (nullable text, no check
 * constraint), so it needs no migration, and it survives a reload - a label
 * held only in the tab would turn back into "Skipped" in the saved report.
 * Refused when speech-to-text IS configured: then the answer must be
 * submitted and scored, not quietly set aside.
 */
export async function recordPracticeAnswer(userId: string, questionId: string): Promise<ClientSession> {
  const owned = await ownedQuestion(userId, questionId);
  if (!owned || owned.s.status !== "in_progress") throw new VideoInterviewError("That question isn't part of an open interview.");
  if (getTranscriptionProvider()) throw new VideoInterviewError("Speech-to-text is available, so this answer should be submitted for scoring.", true);
  if (!owned.q.askedAt) throw new VideoInterviewError("That question hasn't been asked yet.");
  const db = await getDb();
  await db
    .update(videoInterviewQuestions)
    .set({ status: "skipped", transcriptionStatus: PRACTICE_ONLY, completedAt: new Date() })
    .where(and(eq(videoInterviewQuestions.id, questionId), eq(videoInterviewQuestions.userId, userId), inArray(videoInterviewQuestions.status, ["pending", "failed"])));
  await finalizeIfDone(userId, owned.s.id);
  return (await getSessionForUser(userId, owned.s.id))!;
}

/** Ends an interview early: anything unanswered is skipped and the report is
 *  built from what was answered. */
export async function finishSession(userId: string, sessionId: string): Promise<ClientSession> {
  const current = await getSessionForUser(userId, sessionId);
  if (!current) throw new VideoInterviewError("That interview isn't yours or no longer exists.");
  if (current.status === "in_progress") {
    const db = await getDb();
    await db
      .update(videoInterviewQuestions)
      .set({ status: "skipped", completedAt: new Date() })
      .where(and(eq(videoInterviewQuestions.sessionId, sessionId), eq(videoInterviewQuestions.userId, userId), inArray(videoInterviewQuestions.status, ["pending", "failed"])));
    await finalizeIfDone(userId, sessionId);
  }
  return (await getSessionForUser(userId, sessionId))!;
}

async function finalizeIfDone(userId: string, sessionId: string): Promise<void> {
  const db = await getDb();
  const rows = await db
    .select({ status: videoInterviewQuestions.status, feedback: videoInterviewQuestions.feedback })
    .from(videoInterviewQuestions)
    .where(and(eq(videoInterviewQuestions.sessionId, sessionId), eq(videoInterviewQuestions.userId, userId)));
  if (rows.length === 0 || rows.some((r) => r.status === "pending" || r.status === "processing" || r.status === "failed")) return;
  const report = buildReport(rows.filter((r) => r.status === "complete" && r.feedback).map((r) => r.feedback as AnswerFeedback));
  await db
    .update(videoInterviewSessions)
    .set({ status: "complete", report, completedAt: new Date() })
    .where(and(eq(videoInterviewSessions.id, sessionId), eq(videoInterviewSessions.userId, userId), eq(videoInterviewSessions.status, "in_progress")));
}

/** Deletes one interview: its training recordings (objects first), then the
 *  rows - answers and transcripts cascade. False when it isn't the caller's.
 *  If recording storage cannot delete an object yet, nothing else is deleted:
 *  the interview's row is what still points at the object. */
export async function deleteSession(userId: string, sessionId: string): Promise<boolean> {
  if (!isUuid(sessionId)) return false;
  const db = await getDb();
  const qs = await db
    .select({ id: videoInterviewQuestions.id })
    .from(videoInterviewQuestions)
    .where(and(eq(videoInterviewQuestions.sessionId, sessionId), eq(videoInterviewQuestions.userId, userId)));
  const { outstanding } = await deleteTrainingRecordings(userId, qs.map((q) => q.id));
  if (outstanding > 0) throw new VideoInterviewError("Couldn't delete this interview's recording just now. Try again in a moment.", true, "storage_failed");
  const gone = await db
    .delete(videoInterviewSessions)
    .where(and(eq(videoInterviewSessions.id, sessionId), eq(videoInterviewSessions.userId, userId)))
    .returning();
  return gone.length > 0;
}

/** Deletes every interview, transcript and training recording the student
 *  has. Their consent choices stay as they are - that is a separate switch. */
export async function deleteAllVideoData(userId: string): Promise<void> {
  const { outstanding } = await deleteTrainingRecordings(userId);
  if (outstanding > 0) throw new VideoInterviewError("Couldn't delete every recording just now. Nothing else was deleted - try again in a moment.", true, "storage_failed");
  const db = await getDb();
  await db.delete(videoInterviewSessions).where(eq(videoInterviewSessions.userId, userId));
}

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
