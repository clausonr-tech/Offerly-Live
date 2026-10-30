// Training recordings (camera video with its audio) and the coach's
// readiness states, against a real Postgres (in-memory PGlite, never the live
// database) and an in-memory stand-in for the private bucket. Proves: nothing
// is uploaded with training off; an upload is authorised only under current
// consent, for one answer, type, size and duration; the object is checked
// before it is kept; revocation and every deletion path remove object and
// row; failures never leave an orphaned object; and missing schema, an
// unseeded bank, an outage, and unconfigured transcription or storage are
// distinct states.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

import "./helpers/no-network";
import { applyMigrations, createTestDb, installAsAppDb, migrationFiles, type TestDatabase } from "./helpers/test-db";
import * as schema from "@/db/schema";
import { objectDeletionQueue, users, videoInterviewConsentEvents, videoInterviewQuestions, videoInterviewRecordings, videoInterviewSessions } from "@/db/schema";
import { getConsentState, grantAnalysisConsent, setTrainingStanding } from "@/lib/video-interview/consent";
import { deleteAllVideoData, deleteSession, getSessionForUser, markQuestionAsked, startSession, submitAnswer } from "@/lib/video-interview/sessions";
import {
  confirmTrainingVideoUpload,
  deleteTrainingRecordings,
  requestTrainingVideoUpload,
  deleteAllTrainingRecordings,
  sweepTrainingUploads,
  uploadWindowSecFor,
} from "@/lib/video-interview/training-video";
import { setObjectStorageForTests, isObjectStorageConfigured, type PrivateObjectStorage } from "@/lib/video-interview/object-storage";
import { setGradingModelForTests } from "@/lib/video-interview/grading";
import { setTranscriptionProviderForTests, isTranscriptionConfigured } from "@/lib/video-interview/transcription";
import { seedInterviewQuestions } from "@/lib/video-interview/seed";
import { checkVideoCoachReadiness, logReadiness } from "@/lib/video-interview/readiness";
import { AccountCleanupError, prepareRecordingsForAccountDeletion, processObjectDeletionQueue } from "@/lib/video-interview/deletion-queue";
import { VideoInterviewError } from "@/lib/video-interview/errors";
import { VIDEO_POLICY_VERSION, maxVideoBytesFor } from "@/lib/video-interview/types";

delete process.env.DATABASE_URL;

/** The private bucket, in memory. `failX` flags simulate an outage. */
class FakeBucket implements PrivateObjectStorage {
  readonly provider = "s3";
  objects = new Map<string, { bytes: Uint8Array; type: string }>();
  grants: { key: string; contentType: string; contentLength: number }[] = [];
  failDelete = false;
  failHead = false;
  failGrant = false;
  async createUpload(input: { key: string; contentType: string; contentLength: number; expiresSec: number }) {
    if (this.failGrant) throw new Error("signing failed");
    this.grants.push(input);
    return { url: `https://bucket.test/${input.key}?signed`, method: "PUT" as const, headers: { "Content-Type": input.contentType }, expiresAt: new Date(Date.now() + input.expiresSec * 1000).toISOString() };
  }
  /** What the browser's PUT does - here, directly. */
  put(key: string, bytes: Uint8Array, type: string) {
    this.objects.set(key, { bytes, type });
  }
  async head(key: string) {
    if (this.failHead) throw new Error("storage down");
    const o = this.objects.get(key);
    return o ? { size: o.bytes.length, contentType: o.type } : null;
  }
  async readPrefix(key: string, n: number) {
    const o = this.objects.get(key);
    return o ? o.bytes.slice(0, n) : null;
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error("storage down");
    this.objects.delete(key);
  }
}

let h: TestDatabase;
let restore: () => void;
let alice: string;
let bob: string;
let bucket: FakeBucket;

const WEBM_AUDIO = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 7)]);
const videoBytes = (n: number) => {
  const b = new Uint8Array(n);
  b.set([0x1a, 0x45, 0xdf, 0xa3]);
  return b;
};

before(async () => {
  h = await createTestDb();
  restore = installAsAppDb(h.db);
  const [a] = await h.db.insert(users).values({ email: "alice@example.edu", passwordHash: "x", preferredCategories: ["investment_banking"] }).returning();
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
  bucket = new FakeBucket();
  setObjectStorageForTests(bucket);
  setTranscriptionProviderForTests({ name: "fake", transcribe: async () => ({ text: "I led a team of four on a pricing project and we recovered margin by ten percent.", words: null }) });
  setGradingModelForTests(async () => null); // delivery-only is fine here
  await h.db.delete(videoInterviewSessions);
  await h.db.delete(videoInterviewConsentEvents);
  await h.db.delete(objectDeletionQueue);
});

afterEach(() => {
  setObjectStorageForTests(undefined);
  setTranscriptionProviderForTests(undefined);
  setGradingModelForTests(null);
});

/** An interview whose first answer (30s) has been processed. */
async function answered(userId = alice, trainingChoice: "yes" | "no" = "yes") {
  await grantAnalysisConsent(userId);
  const s = await startSession(userId, { mode: "both", thinkSeconds: 30, answerSeconds: 120, difficulty: "auto", trainingChoice, startToken: randomUUID() });
  const q = s.questions[0].id;
  await markQuestionAsked(userId, q);
  await h.db.update(videoInterviewQuestions).set({ askedAt: new Date(Date.now() - 60_000) }).where(eq(videoInterviewQuestions.id, q));
  await submitAnswer(userId, { questionId: q, durationMs: 30_000, file: { bytes: WEBM_AUDIO, type: "audio/webm", size: WEBM_AUDIO.length } });
  return { session: s, questionId: q };
}

const request = (questionId: string, over: Partial<{ contentType: string; size: number; durationMs: number }> = {}, userId = alice) =>
  requestTrainingVideoUpload(userId, { questionId, contentType: "video/webm;codecs=vp9,opus", size: 1_000_000, durationMs: 30_200, ...over });

/** The whole happy path: grant, PUT, confirm. */
async function keep(questionId: string, size = 1_000_000) {
  const grant = await request(questionId, { size });
  const key = bucket.grants.at(-1)!.key;
  bucket.put(key, videoBytes(size), "video/webm");
  await confirmTrainingVideoUpload(alice, grant.uploadId);
  return { grant, key };
}

const rows = () => h.db.select().from(videoInterviewRecordings);

// ---------- consent gates the upload ----------

test("a declined interview: no video upload is ever authorised", async () => {
  const { questionId } = await answered(alice, "no");
  await assert.rejects(request(questionId), (e: VideoInterviewError) => e.code === "training_off");
  assert.equal(bucket.grants.length, 0, "no URL was signed");
  assert.equal(bucket.objects.size, 0);
  assert.equal((await rows()).length, 0);
});

test("with training on, the upload is authorised for one key, type and exact length, and kept only after checking", async () => {
  const { questionId, session } = await answered();
  const { grant, key } = await keep(questionId);

  assert.match(key, /^training-video\/[0-9a-f-]{36}\.webm$/, "a random key, nothing about the user");
  assert.ok(!key.includes(alice) && !key.includes(session.id) && !key.includes(questionId));
  // The window is sized to the bytes (uploadWindowSecFor) rather than a flat
  // five minutes: a presigned PUT cannot be revoked, so the only thing that
  // bounds a second PUT after the confirm is how soon the URL dies.
  assert.deepEqual(bucket.grants[0], { key, contentType: "video/webm", contentLength: 1_000_000, expiresSec: uploadWindowSecFor(1_000_000) });
  assert.ok(uploadWindowSecFor(1_000_000) <= 300 && uploadWindowSecFor(40 * 1024 * 1024) <= 300, "never longer than it used to be");
  assert.ok(!("secretAccessKey" in grant) && !JSON.stringify(grant).includes("secret"));

  const [row] = await rows();
  assert.equal(row.status, "stored");
  assert.equal(row.trainingPolicyVersion, VIDEO_POLICY_VERSION);
  assert.equal(row.userId, alice);
  assert.deepEqual(
    Object.keys(row).sort(),
    ["byteSize", "confirmedAt", "contentType", "createdAt", "durationMs", "expiresAt", "id", "questionId", "status", "storageDriver", "storageKey", "trainingPolicyVersion", "userId"],
    "minimal metadata only",
  );
  assert.equal((await getSessionForUser(alice, session.id))!.answers[0].retained, true);
});

test("the pending row dies with the URL that filled it, not fifteen minutes later", async () => {
  // A presigned PUT cannot be revoked, so the row must not outlive its grant:
  // an object uploaded but never confirmed used to sit in the bucket for ten
  // minutes after the URL that put it there had already expired.
  const { questionId } = await answered();
  const grant = await request(questionId, { size: 1_000_000 });
  const windowMs = uploadWindowSecFor(1_000_000) * 1000;
  const [row] = await rows();
  const left = row.expiresAt!.getTime() - Date.now();
  assert.ok(left > windowMs, "with a grace period, so an upload that finished just in time can still confirm");
  assert.ok(left <= windowMs + 61_000, `the pending row has ${Math.round(left / 1000)}s left, which is the window plus a minute`);
  assert.ok(new Date(grant.expiresAt).getTime() <= row.expiresAt!.getTime(), "the URL dies first, the row second");
});

test("training on but storage unconfigured: nothing is authorised, and the reason says so", async () => {
  setObjectStorageForTests(null);
  const { questionId } = await answered();
  await assert.rejects(request(questionId), (e: VideoInterviewError) => e.code === "storage_unconfigured" && /no training recording is kept/.test(e.message));
  assert.equal((await rows()).length, 0);
});

test("consent withdrawn mid-upload: the confirm refuses and the object is removed", async () => {
  const { questionId } = await answered();
  const grant = await request(questionId);
  const key = bucket.grants[0].key;
  bucket.put(key, videoBytes(1_000_000), "video/webm");
  await deleteAllTrainingRecordings(alice); // withdraws this interview, deletes the pending object too
  await assert.rejects(confirmTrainingVideoUpload(alice, grant.uploadId), VideoInterviewError);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await rows()).length, 0);
});

// ---------- revocation and deletion ----------

test("revoking training deletes every kept video, object and row", async () => {
  const { questionId } = await answered();
  await keep(questionId);
  assert.equal(bucket.objects.size, 1);
  const r = await deleteAllTrainingRecordings(alice);
  assert.deepEqual(r, { deleted: 1, outstanding: 0 });
  assert.equal(bucket.objects.size, 0);
  assert.equal((await rows()).length, 0);
});

test("deleting an interview, or everything, deletes the kept videos", async () => {
  const one = await answered();
  await keep(one.questionId);
  assert.equal(await deleteSession(alice, one.session.id), true);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await rows()).length, 0);

  const two = await answered();
  await keep(two.questionId);
  await deleteAllVideoData(alice);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await rows()).length, 0);
  assert.equal((await h.db.select().from(videoInterviewSessions).where(eq(videoInterviewSessions.userId, alice))).length, 0);
});

test("if the store can't delete, nothing is orphaned: the row stays marked and the retry finishes it", async () => {
  const { questionId, session } = await answered();
  const { key } = await keep(questionId);
  bucket.failDelete = true;
  await assert.rejects(deleteSession(alice, session.id), (e: VideoInterviewError) => e.retryable);
  assert.ok(await getSessionForUser(alice, session.id), "the interview - which still names the object - is not deleted");
  const [row] = await rows();
  assert.equal(row.status, "deleting");
  assert.equal((await getSessionForUser(alice, session.id))!.answers[0].retained, false, "no longer counted as kept");
  assert.ok(bucket.objects.has(key));

  bucket.failDelete = false;
  assert.equal(await sweepTrainingUploads(alice), 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await rows()).length, 0);
});

test("account deletion's path removes objects before the rows cascade", async () => {
  const { questionId } = await answered();
  await keep(questionId);
  bucket.failDelete = true;
  const partial = await deleteTrainingRecordings(alice);
  assert.equal(partial.outstanding, 1);
  assert.equal(partial.outstandingKeys.length, 1, "the key is reported so an operator can remove it");
  bucket.failDelete = false;
  assert.deepEqual((await deleteTrainingRecordings(alice)).outstanding, 0);
  assert.equal(bucket.objects.size, 0);
});

// ---------- authorization ----------

test("another student cannot request, confirm, or delete someone else's training upload", async () => {
  const { questionId } = await answered(alice);
  await assert.rejects(request(questionId, {}, bob), (e: VideoInterviewError) => e.code === "not_found");

  const grant = await request(questionId);
  bucket.put(bucket.grants[0].key, videoBytes(1_000_000), "video/webm");
  await assert.rejects(confirmTrainingVideoUpload(bob, grant.uploadId), (e: VideoInterviewError) => e.code === "not_found");
  assert.deepEqual(await deleteTrainingRecordings(bob), { deleted: 0, outstanding: 0, outstandingKeys: [] });
  assert.equal(bucket.objects.size, 1, "Alice's upload is untouched");
  await confirmTrainingVideoUpload(alice, grant.uploadId);
  assert.equal((await rows())[0].status, "stored");
});

// ---------- MIME, size, duration, duplicates ----------

test("type, size, duration and the answer's state are checked before any URL is signed", async () => {
  const { questionId } = await answered();
  await assert.rejects(request(questionId, { contentType: "image/png" }), /format/);
  await assert.rejects(request(questionId, { contentType: "text/html" }), /format/);
  await assert.rejects(request(questionId, { size: 0 }), /empty/);
  await assert.rejects(request(questionId, { size: maxVideoBytesFor(30_200) + 1 }), /too large/);
  await assert.rejects(request(questionId, { durationMs: 90_000 }), /length doesn't match/, "the answer the server processed was 30s");
  const s = (await h.db.select().from(videoInterviewQuestions).where(eq(videoInterviewQuestions.userId, alice))).find((r) => r.status === "pending")!;
  await assert.rejects(request(s.id), /processed/, "an unanswered question gets no upload");
  assert.equal(bucket.grants.length, 0);
});

test("one upload per answer: duplicates and races are refused", async () => {
  const { questionId } = await answered();
  const results = await Promise.allSettled([request(questionId), request(questionId), request(questionId)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one grant");
  await assert.rejects(request(questionId), (e: VideoInterviewError) => e.code === "duplicate");
  const grant = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ uploadId: string }>).value;
  bucket.put(bucket.grants[0].key, videoBytes(1_000_000), "video/webm");
  await confirmTrainingVideoUpload(alice, grant.uploadId);
  await assert.rejects(request(questionId), /already saved/);
  await assert.rejects(confirmTrainingVideoUpload(alice, grant.uploadId), (e: VideoInterviewError) => e.code === "not_found", "a confirmed upload cannot be confirmed again");
});

test("the object is checked on confirm: wrong size, wrong bytes or nothing uploaded is removed", async () => {
  const { questionId } = await answered();

  let grant = await request(questionId);
  bucket.put(bucket.grants.at(-1)!.key, videoBytes(999_999), "video/webm");
  await assert.rejects(confirmTrainingVideoUpload(alice, grant.uploadId), /size/);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await rows()).length, 0);

  grant = await request(questionId);
  bucket.put(bucket.grants.at(-1)!.key, new Uint8Array(1_000_000).fill(0x3c), "video/webm");
  await assert.rejects(confirmTrainingVideoUpload(alice, grant.uploadId), /isn't a video/);
  assert.equal(bucket.objects.size, 0);

  grant = await request(questionId);
  await assert.rejects(confirmTrainingVideoUpload(alice, grant.uploadId), /didn't arrive/);
  assert.equal((await rows()).length, 0, "a never-uploaded row is removed too");
});

// ---------- failures never orphan an object ----------

test("a database failure while keeping the upload removes the object", async () => {
  const { questionId } = await answered();
  const grant = await request(questionId);
  bucket.put(bucket.grants[0].key, videoBytes(1_000_000), "video/webm");
  await h.client.exec(`
    create or replace function fail_store() returns trigger language plpgsql as $$ begin raise exception 'simulated write failure'; end $$;
    create trigger fail_store before update on video_interview_recordings for each row when (new.status = 'stored') execute function fail_store();`);
  try {
    await assert.rejects(confirmTrainingVideoUpload(alice, grant.uploadId), (e: VideoInterviewError) => e.code === "storage_failed");
    assert.equal(bucket.objects.size, 0, "the object did not outlive its record");
  } finally {
    await h.client.exec("drop trigger fail_store on video_interview_recordings; drop function fail_store();");
  }
});

test("a signing failure leaves no pending row; a storage outage on confirm is retryable and swept later", async () => {
  const { questionId } = await answered();
  bucket.failGrant = true;
  await assert.rejects(request(questionId), (e: VideoInterviewError) => e.retryable);
  assert.equal((await rows()).length, 0);
  bucket.failGrant = false;

  const grant = await request(questionId);
  bucket.put(bucket.grants.at(-1)!.key, videoBytes(1_000_000), "video/webm");
  bucket.failHead = true;
  await assert.rejects(confirmTrainingVideoUpload(alice, grant.uploadId), (e: VideoInterviewError) => e.retryable);
  bucket.failHead = false;
  // Abandoned: once it expires, the sweep removes object and row.
  await h.db.update(videoInterviewRecordings).set({ expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await sweepTrainingUploads(alice), 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await rows()).length, 0);
});

// ---------- readiness and capability states ----------

test("missing migration, unseeded bank, outage and ready are four distinct states", async () => {
  assert.deepEqual(await checkVideoCoachReadiness(), { state: "ready" });

  const pre = new PGlite();
  await applyMigrations(pre, migrationFiles().filter((f) => !/00(29|30|31|32|37)_/.test(f)));
  assert.deepEqual(await checkVideoCoachReadiness(drizzle(pre, { schema }) as never), { state: "missing_schema", migrations: ["0029_video_interviews", "0030_interview_question_bank", "0031_object_deletion_queue", "0032_per_interview_training_consent", "0037_standing_training_consent"] });
  await applyMigrations(pre, migrationFiles().filter((f) => /0029_/.test(f)));
  assert.deepEqual(await checkVideoCoachReadiness(drizzle(pre, { schema }) as never), { state: "missing_schema", migrations: ["0030_interview_question_bank", "0031_object_deletion_queue", "0032_per_interview_training_consent", "0037_standing_training_consent"] });
  await applyMigrations(pre, migrationFiles().filter((f) => /0030_/.test(f)));
  assert.deepEqual(await checkVideoCoachReadiness(drizzle(pre, { schema }) as never), { state: "missing_schema", migrations: ["0031_object_deletion_queue", "0032_per_interview_training_consent", "0037_standing_training_consent"] });
  await applyMigrations(pre, migrationFiles().filter((f) => /0031_/.test(f)));
  assert.deepEqual(await checkVideoCoachReadiness(drizzle(pre, { schema }) as never), { state: "missing_schema", migrations: ["0032_per_interview_training_consent", "0037_standing_training_consent"] });
  await applyMigrations(pre, migrationFiles().filter((f) => /0032_/.test(f)));
  assert.deepEqual(await checkVideoCoachReadiness(drizzle(pre, { schema }) as never), { state: "missing_schema", migrations: ["0037_standing_training_consent"] });
  await applyMigrations(pre, migrationFiles().filter((f) => /0037_/.test(f)));
  assert.deepEqual(await checkVideoCoachReadiness(drizzle(pre, { schema }) as never), { state: "unseeded" });
  await pre.close();

  const down = { execute: async () => { throw new Error("ECONNREFUSED"); } };
  assert.deepEqual(await checkVideoCoachReadiness(down as never), { state: "db_unavailable" }, "an outage is not reported as a missing migration");
});

test("unconfigured transcription and unconfigured storage are reported separately", () => {
  setTranscriptionProviderForTests(null);
  setObjectStorageForTests(bucket);
  assert.deepEqual([isTranscriptionConfigured(), isObjectStorageConfigured()], [false, true]);
  setTranscriptionProviderForTests({ name: "x", transcribe: async () => ({ text: "", words: null }) });
  setObjectStorageForTests(null);
  assert.deepEqual([isTranscriptionConfigured(), isObjectStorageConfigured()], [true, false]);
});

test("expected setup states log a warning, never an error; an outage logs an error", () => {
  const calls: { level: string; msg: string }[] = [];
  const logger = { warn: (m: string) => calls.push({ level: "warn", msg: m }), error: (m: string) => calls.push({ level: "error", msg: m }) };
  logReadiness({ state: "ready" }, logger);
  logReadiness({ state: "missing_schema", migrations: ["0031_object_deletion_queue"] }, logger);
  logReadiness({ state: "unseeded" }, logger);
  logReadiness({ state: "db_unavailable" }, logger);
  assert.deepEqual(calls.map((c) => c.level), ["warn", "warn", "error"]);
  assert.match(calls[0].msg, /0031_object_deletion_queue/);
});

// ---------- account deletion with storage down ----------

async function keptVideoFor(email: string) {
  const [u] = await h.db.insert(users).values({ email, passwordHash: "x", preferredCategories: ["investment_banking"] }).returning();
  const { questionId } = await answered(u.id);
  const grant = await request(questionId, {}, u.id);
  const key = bucket.grants.at(-1)!.key;
  bucket.put(key, videoBytes(1_000_000), "video/webm");
  await confirmTrainingVideoUpload(u.id, grant.uploadId);
  return { userId: u.id, key };
}

test("a storage outage during account deletion queues the object durably - nothing is orphaned", async () => {
  const { userId, key } = await keptVideoFor("carol@example.edu");
  bucket.failDelete = true;
  assert.deepEqual(await prepareRecordingsForAccountDeletion(userId), { deleted: 0, queued: 1 });

  // The account goes, and its recording rows with it...
  await h.db.delete(users).where(eq(users.id, userId));
  assert.equal((await rows()).filter((r) => r.storageKey === key).length, 0);
  // ...but the queue, which has no link to the user, still knows the object.
  const [queued] = await h.db.select().from(objectDeletionQueue);
  assert.equal(queued.objectKey, key);
  assert.equal(queued.provider, "s3");
  assert.deepEqual(
    Object.keys(queued).sort(),
    ["attempts", "createdAt", "id", "lastAttemptAt", "lastErrorCategory", "objectKey", "provider"],
    "nothing personal: no user id, email or file details",
  );
  assert.ok(bucket.objects.has(key));

  // Still down: the row stays, the attempt is counted.
  assert.deepEqual(await processObjectDeletionQueue(), { deleted: 0, failed: 1, remaining: 1 });
  let [row] = await h.db.select().from(objectDeletionQueue);
  assert.equal(row.attempts, 1);
  assert.equal(row.lastErrorCategory, "storage_error");

  // No storage configured at all: kept, categorised, not dropped.
  setObjectStorageForTests(null);
  await processObjectDeletionQueue();
  [row] = await h.db.select().from(objectDeletionQueue);
  assert.equal(row.lastErrorCategory, "storage_unconfigured");
  assert.equal(row.attempts, 2);

  // Back up: the object is deleted, and only then the row.
  setObjectStorageForTests(bucket);
  bucket.failDelete = false;
  assert.deepEqual(await processObjectDeletionQueue(), { deleted: 1, failed: 0, remaining: 0 });
  assert.ok(!bucket.objects.has(key));
  assert.deepEqual(await processObjectDeletionQueue(), { deleted: 0, failed: 0, remaining: 0 }, "idempotent");
});

test("a queued object that is already missing counts as deleted", async () => {
  await h.db.insert(objectDeletionQueue).values({ provider: "s3", objectKey: "training-video/00000000-0000-0000-0000-000000000000.webm" });
  assert.deepEqual(await processObjectDeletionQueue(), { deleted: 1, failed: 0, remaining: 0 });
});

test("with storage up, account deletion leaves no queue rows; if the queue can't be written, the account stays", async () => {
  const up = await keptVideoFor("dave@example.edu");
  assert.deepEqual(await prepareRecordingsForAccountDeletion(up.userId), { deleted: 1, queued: 0 });
  assert.equal((await h.db.select().from(objectDeletionQueue)).length, 0, "deleted objects need no tombstone");
  assert.equal(bucket.objects.size, 0);

  const down = await keptVideoFor("erin@example.edu");
  bucket.failDelete = true;
  await h.client.exec(`
    create or replace function fail_queue() returns trigger language plpgsql as $$ begin raise exception 'simulated queue failure'; end $$;
    create trigger fail_queue before insert on object_deletion_queue for each row execute function fail_queue();`);
  try {
    await assert.rejects(prepareRecordingsForAccountDeletion(down.userId), AccountCleanupError);
    // The caller (profile deleteAccount) returns here without deleting the
    // user, so the recording row - the only record of the object - survives.
    assert.equal((await rows()).filter((r) => r.storageKey === down.key).length, 1);
  } finally {
    await h.client.exec("drop trigger fail_queue on object_deletion_queue; drop function fail_queue();");
    bucket.failDelete = false;
  }
});

test("a database without the video tables does not block account deletion", async () => {
  const pre = new PGlite();
  await applyMigrations(pre, migrationFiles().filter((f) => !/00(29|30|31|32|37)_/.test(f)));
  const put = installAsAppDb(drizzle(pre, { schema }));
  try {
    assert.deepEqual(await prepareRecordingsForAccountDeletion("00000000-0000-0000-0000-000000000001"), { deleted: 0, queued: 0 });
  } finally {
    put();
    installAsAppDb(h.db);
    await pre.close();
  }
});

// ---------- retrying a failed training upload ----------

test("a retry after a failed upload reuses every check and never stores a second copy", async () => {
  const { questionId } = await answered();

  // First try: the PUT never lands; the client confirms anyway, which clears it.
  const first = await request(questionId);
  await assert.rejects(confirmTrainingVideoUpload(alice, first.uploadId), (e: VideoInterviewError) => e.code === "not_found");
  assert.equal((await rows()).length, 0);

  // The retry is an ordinary request: same authorization, same validation.
  await assert.rejects(request(questionId, { size: maxVideoBytesFor(30_200) + 1 }), /too large/);
  const second = await request(questionId);
  bucket.put(bucket.grants.at(-1)!.key, videoBytes(1_000_000), "video/webm");
  await confirmTrainingVideoUpload(alice, second.uploadId);

  // Retrying again after success is refused as already stored - no copy two.
  await assert.rejects(request(questionId), (e: VideoInterviewError) => e.code === "already_stored");
  await assert.rejects(confirmTrainingVideoUpload(alice, first.uploadId), (e: VideoInterviewError) => e.code === "not_found");
  assert.equal((await rows()).filter((r) => r.status === "stored").length, 1);
  assert.equal(bucket.objects.size, 1);
});

// ---------- per-interview training consent ----------

const startWith = (userId: string, trainingChoice: "yes" | "no", startToken = randomUUID()) =>
  startSession(userId, { mode: "both", thinkSeconds: 30, answerSeconds: 120, difficulty: "auto", trainingChoice, startToken });

test("yes creates an opted-in session, recorded on the server with version and time, before any recording", async () => {
  await grantAnalysisConsent(alice);
  const before = Date.now();
  const s = await startWith(alice, "yes");
  assert.equal(s.training.optedIn, true);
  const [row] = await h.db.select().from(videoInterviewSessions).where(eq(videoInterviewSessions.id, s.id));
  assert.equal(row.trainingOptIn, true);
  assert.equal(row.trainingPolicyVersion, VIDEO_POLICY_VERSION);
  assert.ok(row.trainingDecidedAt && row.trainingDecidedAt.getTime() >= before - 5000);
  assert.ok((await h.db.select().from(videoInterviewQuestions).where(eq(videoInterviewQuestions.sessionId, s.id))).every((q) => q.askedAt === null), "decided before any question was even shown");
});

test("no creates a non-training session that starts normally", async () => {
  await grantAnalysisConsent(alice);
  const s = await startWith(alice, "no");
  assert.equal(s.training.optedIn, false);
  assert.equal(s.questions.length, 5);
  assert.equal(s.status, "in_progress");
  const [row] = await h.db.select().from(videoInterviewSessions).where(eq(videoInterviewSessions.id, s.id));
  assert.equal(row.trainingPolicyVersion, VIDEO_POLICY_VERSION, "a no is recorded too");
  assert.ok(row.trainingDecidedAt);
});

test("double-clicking Start makes one session, one decision - even concurrently", async () => {
  await grantAnalysisConsent(alice);
  const token = randomUUID();
  const [a, b, c] = await Promise.all([startWith(alice, "yes", token), startWith(alice, "yes", token), startWith(alice, "no", token)]);
  assert.equal(a.id, b.id);
  assert.equal(b.id, c.id);
  const sessions = await h.db.select().from(videoInterviewSessions).where(eq(videoInterviewSessions.userId, alice));
  assert.equal(sessions.length, 1, "one session");
  assert.equal((await h.db.select().from(videoInterviewQuestions).where(eq(videoInterviewQuestions.sessionId, a.id))).length, 5, "one set of questions");
  assert.equal(sessions[0].trainingOptIn, a.training.optedIn, "one decision - the first request's");
  const again = await startWith(alice, "no", token);
  assert.equal(again.id, a.id, "a later retry with the same token is still the same interview");
});

test("the first Start's answer stands: later Starts use it, whatever the page sends", async () => {
  await grantAnalysisConsent(alice);
  assert.equal((await getConsentState(alice)).training, null, "not asked yet");
  const first = await startWith(alice, "yes");
  assert.equal(first.training.optedIn, true);
  assert.equal((await getConsentState(alice)).training?.choice, "yes", "recorded as the standing answer");
  const later = await startWith(alice, "no");
  assert.equal(later.training.optedIn, true, "a stale page cannot override the standing answer");
  const events = await h.db.select().from(videoInterviewConsentEvents).where(eq(videoInterviewConsentEvents.userId, alice));
  assert.deepEqual(events.filter((e) => e.kind.startsWith("training_standing")).map((e) => e.kind), ["training_standing_yes"], "asked once, recorded once");
});

test("a repeat of the first Start records the standing answer once", async () => {
  await grantAnalysisConsent(alice);
  const token = randomUUID();
  await Promise.all([startWith(alice, "no", token), startWith(alice, "no", token)]);
  const events = await h.db.select().from(videoInterviewConsentEvents).where(eq(videoInterviewConsentEvents.userId, alice));
  assert.equal(events.filter((e) => e.kind === "training_standing_no").length, 1);
});

test("changing the answer to no stops the open interview and later ones, and leaves earlier recordings alone", async () => {
  const first = await answered(alice, "yes");
  const { key } = await keep(first.questionId);
  await setTrainingStanding(alice, "no");
  assert.equal((await getConsentState(alice)).training?.choice, "no");
  assert.equal((await getSessionForUser(alice, first.session.id))!.training.optedIn, false, "the open interview stops contributing");
  assert.ok(bucket.objects.has(key), "what was already contributed is kept");
  assert.equal((await rows()).filter((r) => r.status === "stored").length, 1);
  const later = await startWith(alice, "yes");
  assert.equal(later.training.optedIn, false, "later interviews follow the new answer");
  await setTrainingStanding(alice, "yes");
  assert.equal((await startWith(alice, "no")).training.optedIn, true, "and back again");
});

test("an upload grant works only for the opted-in session's own answers", async () => {
  const optedIn = await answered(alice, "yes");
  const declined = await answered(bob, "no");
  await assert.rejects(request(declined.questionId, {}, bob), (e: VideoInterviewError) => e.code === "training_off", "never for a declined interview");
  const grant = await request(optedIn.questionId);
  assert.ok(grant.uploadId, "the contributed interview's answer is authorised");
  await assert.rejects(request(optedIn.questionId, {}, bob), (e: VideoInterviewError) => e.code === "not_found", "and only for its owner");
});

test("sessions from before per-interview consent are opted out", async () => {
  const { questionId, session } = await answered(alice, "yes");
  // What 0032's defaults give an existing session.
  await h.db.update(videoInterviewSessions).set({ trainingOptIn: false, trainingPolicyVersion: null, trainingDecidedAt: null }).where(eq(videoInterviewSessions.id, session.id));
  await assert.rejects(request(questionId), (e: VideoInterviewError) => e.code === "training_off");
});

test("a contribution under an older policy version authorises nothing", async () => {
  const { questionId, session } = await answered(alice, "yes");
  await h.db.update(videoInterviewSessions).set({ trainingPolicyVersion: "2026-09-29" }).where(eq(videoInterviewSessions.id, session.id));
  await assert.rejects(request(questionId), (e: VideoInterviewError) => e.code === "training_off");
});

test("Delete all training recordings removes them and stops the interview in progress from contributing", async () => {
  const s = await answered(alice, "yes");
  await keep(s.questionId);
  const r = await deleteAllTrainingRecordings(alice);
  assert.deepEqual(r, { deleted: 1, outstanding: 0 });
  assert.equal(bucket.objects.size, 0);
  const [row] = await h.db.select().from(videoInterviewSessions).where(eq(videoInterviewSessions.id, s.session.id));
  assert.equal(row.trainingOptIn, false);
  assert.ok(row.trainingWithdrawnAt, "the withdrawal is recorded");
  assert.ok(await getSessionForUser(alice, s.session.id), "the interview itself stays");
  await assert.rejects(request(s.questionId), (e: VideoInterviewError) => e.code === "training_off", "no more uploads from it");
});

test("a contributed interview with no storage configured attempts no upload and says so", async () => {
  setObjectStorageForTests(null);
  const s = await answered(alice, "yes");
  await assert.rejects(request(s.questionId), (e: VideoInterviewError) => e.code === "storage_unconfigured" && /no training recording is kept/.test(e.message));
  assert.equal(bucket.grants.length, 0);
  assert.equal((await rows()).length, 0);
});
