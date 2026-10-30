import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { videoInterviewQuestions, videoInterviewRecordings, videoInterviewSessions } from "@/db/schema";
import { VIDEO_POLICY_VERSION } from "./types";
import { VideoInterviewError } from "./errors";
import { getObjectStorage, type PrivateObjectStorage } from "./object-storage";
import { ALLOWED_VIDEO_TYPES, DURATION_GRACE_MS, maxVideoBytesFor } from "./types";
import { baseMimeType } from "./upload-validation";

/**
 * Training recordings: an answer's camera video, with its audio, kept in
 * private object storage - ONLY under a current training opt-in, and only
 * when storage is configured. With training off nothing here runs: the page
 * never asks, and every entry point re-checks consent itself.
 *
 *   request  -> checks everything, writes a PENDING row with a random key,
 *               returns one short-lived presigned PUT for exactly that key,
 *               content type and byte length
 *   (browser PUTs the file straight to the bucket)
 *   confirm  -> re-checks consent, checks the object really is that size,
 *               type and container, then marks the row STORED
 *
 * Any check that fails removes the object and the row. A pending row that is
 * never confirmed expires and is swept, object and all - so an abandoned tab
 * leaves nothing behind. Deletion marks rows DELETING before touching the
 * store, so a store outage mid-delete leaves a row that says so and is
 * retried, never an object nobody knows about.
 *
 * The one thing none of this can take back is the presigned URL itself: an
 * S3-style grant is neither single-use nor revocable, so until it expires a
 * second PUT can replace the bytes that were checked, or put an object back
 * under a key whose row has gone. The window is therefore kept as short as
 * the upload allows (see uploadWindowSecFor) and the pending row is given the
 * same lifetime, so nothing waits in the bucket for longer than the URL that
 * put it there. Closing the rest needs the bucket's own help - versioning or
 * object lock on the confirmed key, or a lifecycle rule over training-video/
 * - which is bucket configuration, not something this file can assert.
 */

/**
 * How long the presigned PUT lives, from the size the upload declared.
 *
 * This window is the whole bound on the grant, because an S3-style presigned
 * URL cannot be made single-use or revoked: it stays valid until it expires,
 * whatever happens to the row meanwhile. So a PUT can land again after the
 * confirm - replacing the checked bytes with other bytes of the same length
 * and type - or after a deletion, recreating an object under a key no row
 * names any more. Shortening the window is what shrinks that, so it is sized
 * to the bytes rather than fixed: enough time to send them over a slow phone
 * connection and little more. Never longer than the five minutes it used to
 * be flat, and usually a fraction of it.
 */
const UPLOAD_WINDOW_MIN_SEC = 90;
const UPLOAD_WINDOW_MAX_SEC = 300;
/** A deliberately pessimistic uplink: 160kbit/s, slower than any usable recording. */
const SLOW_UPLOAD_BYTES_PER_SEC = 20_000;
export function uploadWindowSecFor(size: number): number {
  const needed = Math.ceil(Math.max(0, size) / SLOW_UPLOAD_BYTES_PER_SEC) + 15;
  return Math.min(UPLOAD_WINDOW_MAX_SEC, Math.max(UPLOAD_WINDOW_MIN_SEC, needed));
}
/**
 * How long after its URL dies the pending row lives on.
 *
 * The row used to outlive the grant by ten minutes, which left the object it
 * names - uploaded, unchecked, never confirmed - sitting in the bucket for
 * that long. A minute is enough for a PUT that finished inside its window to
 * be confirmed, and after that the sweep takes object and row together.
 */
const CONFIRM_GRACE_MS = 60 * 1000;
/** A recording's length must agree with the answer the server processed. */
const DURATION_TOLERANCE_MS = 3_000;

type RecordingRow = typeof videoInterviewRecordings.$inferSelect;

function requireStorage(): PrivateObjectStorage {
  const s = getObjectStorage();
  if (!s) throw new VideoInterviewError("Recording storage isn't set up on this server, so no training recording is kept.", false, "storage_unconfigured");
  return s;
}

/** The container the bytes really are, from their first bytes. */
export function sniffVideoContainer(head: Uint8Array): "webm" | "mp4" | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "mp4";
  return null;
}

/** Removes a row's object, then the row. If the store refuses, the row is
 *  left as "deleting" so it is retried rather than forgotten. */
async function discard(row: Pick<RecordingRow, "id" | "userId" | "storageKey">, storage: PrivateObjectStorage | null): Promise<boolean> {
  const db = await getDb();
  try {
    if (!storage) throw new Error("no storage");
    await storage.delete(row.storageKey);
  } catch {
    await db
      .update(videoInterviewRecordings)
      .set({ status: "deleting" })
      .where(and(eq(videoInterviewRecordings.id, row.id), eq(videoInterviewRecordings.userId, row.userId)))
      .catch(() => {});
    return false;
  }
  await db.delete(videoInterviewRecordings).where(and(eq(videoInterviewRecordings.id, row.id), eq(videoInterviewRecordings.userId, row.userId)));
  return true;
}

/** Finishes what was left: expired pending uploads and interrupted deletes. */
export async function sweepTrainingUploads(userId: string, now = new Date()): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: videoInterviewRecordings.id, userId: videoInterviewRecordings.userId, storageKey: videoInterviewRecordings.storageKey })
    .from(videoInterviewRecordings)
    .where(
      and(
        eq(videoInterviewRecordings.userId, userId),
        or(
          and(eq(videoInterviewRecordings.status, "pending"), lt(videoInterviewRecordings.expiresAt, now)),
          eq(videoInterviewRecordings.status, "deleting"),
        ),
      ),
    );
  if (rows.length === 0) return 0;
  const storage = getObjectStorage();
  let n = 0;
  for (const r of rows) if (await discard(r, storage)) n++;
  return n;
}

export type UploadGrant = { uploadId: string; url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };

export async function requestTrainingVideoUpload(
  userId: string,
  input: { questionId: unknown; contentType: unknown; size: unknown; durationMs: unknown },
): Promise<UploadGrant> {
  const storage = requireStorage();
  if (typeof input.questionId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.questionId)) throw new VideoInterviewError("That question isn't part of your interview.", false, "not_found");
  const db = await getDb();
  const [owned] = await db
    .select({
      q: videoInterviewQuestions,
      answerSeconds: videoInterviewSessions.answerSeconds,
      trainingOptIn: videoInterviewSessions.trainingOptIn,
      trainingPolicyVersion: videoInterviewSessions.trainingPolicyVersion,
    })
    .from(videoInterviewQuestions)
    .innerJoin(videoInterviewSessions, eq(videoInterviewSessions.id, videoInterviewQuestions.sessionId))
    .where(and(eq(videoInterviewQuestions.id, input.questionId), eq(videoInterviewQuestions.userId, userId), eq(videoInterviewSessions.userId, userId)))
    .limit(1);
  if (!owned) throw new VideoInterviewError("That question isn't part of your interview.", false, "not_found");
  // The authorisation: THIS interview was contributed, under the policy in
  // force. Not an account setting, and never anything the browser says.
  if (!sessionOptedIn(owned)) throw new VideoInterviewError("This interview wasn't contributed for training, so no video is uploaded.", false, "training_off");
  const q = owned.q;
  if (q.status !== "complete" || q.durationMs == null) throw new VideoInterviewError("A training recording can only be saved for an answer that was processed.", false, "invalid");

  const type = baseMimeType(typeof input.contentType === "string" ? input.contentType : "");
  if (!(ALLOWED_VIDEO_TYPES as readonly string[]).includes(type)) throw new VideoInterviewError("That video format isn't supported.", false, "invalid");
  const durationMs = Number(input.durationMs);
  if (!Number.isFinite(durationMs) || Math.abs(durationMs - q.durationMs) > DURATION_TOLERANCE_MS || durationMs > owned.answerSeconds * 1000 + DURATION_GRACE_MS) {
    throw new VideoInterviewError("That video's length doesn't match the answer.", false, "invalid");
  }
  const size = Number(input.size);
  if (!Number.isInteger(size) || size <= 0) throw new VideoInterviewError("The video was empty.", false, "invalid");
  if (size > maxVideoBytesFor(durationMs)) throw new VideoInterviewError("That video is too large to keep.", false, "invalid");

  await sweepTrainingUploads(userId);
  const [existing] = await db
    .select({ status: videoInterviewRecordings.status })
    .from(videoInterviewRecordings)
    .where(and(eq(videoInterviewRecordings.questionId, q.id), eq(videoInterviewRecordings.userId, userId)))
    .limit(1);
  if (existing) {
    if (existing.status === "stored") throw new VideoInterviewError("This answer's training recording is already saved.", false, "already_stored");
    throw new VideoInterviewError("This answer's recording is already being uploaded.", false, "duplicate");
  }

  // The row and the URL are given one lifetime between them: the row expires
  // a minute after the grant does, so no object can be waiting in the bucket
  // under a key whose URL is already dead.
  const windowSec = uploadWindowSecFor(size);
  const key = `training-video/${randomUUID()}.${type === "video/mp4" ? "mp4" : "webm"}`;
  // The unique index on question_id is what makes this the only upload for
  // the answer, even when two requests race past the check above.
  const [row] = await db
    .insert(videoInterviewRecordings)
    .values({
      questionId: q.id,
      userId,
      storageDriver: storage.provider,
      storageKey: key,
      contentType: type,
      byteSize: size,
      durationMs: Math.round(durationMs),
      trainingPolicyVersion: owned.trainingPolicyVersion!,
      status: "pending",
      expiresAt: new Date(Date.now() + windowSec * 1000 + CONFIRM_GRACE_MS),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new VideoInterviewError("This answer's recording is already being uploaded.", false, "duplicate");

  try {
    const grant = await storage.createUpload({ key, contentType: type, contentLength: size, expiresSec: windowSec });
    return { uploadId: row.id, ...grant };
  } catch {
    await db.delete(videoInterviewRecordings).where(and(eq(videoInterviewRecordings.id, row.id), eq(videoInterviewRecordings.userId, userId)));
    throw new VideoInterviewError("Couldn't prepare the training upload. Your answer is still saved.", true, "storage_failed");
  }
}

export async function confirmTrainingVideoUpload(userId: string, uploadId: unknown): Promise<{ retained: true; questionId: string }> {
  const storage = requireStorage();
  if (typeof uploadId !== "string" || !/^[0-9a-f-]{36}$/i.test(uploadId)) throw new VideoInterviewError("That upload isn't yours or has expired.", false, "not_found");
  const db = await getDb();
  const [row] = await db
    .select()
    .from(videoInterviewRecordings)
    .where(and(eq(videoInterviewRecordings.id, uploadId), eq(videoInterviewRecordings.userId, userId), eq(videoInterviewRecordings.status, "pending")))
    .limit(1);
  if (!row) throw new VideoInterviewError("That upload isn't yours or has expired.", false, "not_found");

  const reject = async (message: string, code: "invalid" | "training_off" | "not_found" = "invalid"): Promise<never> => {
    await discard(row, storage);
    throw new VideoInterviewError(message, false, code);
  };

  if (!row.expiresAt || row.expiresAt.getTime() < Date.now()) return reject("That upload took too long and was discarded.", "not_found");
  // Consent is checked again here: the session's contribution may have been
  // withdrawn mid-upload (by deleting training recordings).
  const [sess] = await db
    .select({ trainingOptIn: videoInterviewSessions.trainingOptIn, trainingPolicyVersion: videoInterviewSessions.trainingPolicyVersion })
    .from(videoInterviewQuestions)
    .innerJoin(videoInterviewSessions, eq(videoInterviewSessions.id, videoInterviewQuestions.sessionId))
    .where(and(eq(videoInterviewQuestions.id, row.questionId), eq(videoInterviewSessions.userId, userId)))
    .limit(1);
  if (!sess || !sessionOptedIn(sess) || sess.trainingPolicyVersion !== row.trainingPolicyVersion) return reject("This interview isn't contributed for training, so the video wasn't kept.", "training_off");

  let meta: Awaited<ReturnType<PrivateObjectStorage["head"]>>;
  let head: Uint8Array | null;
  try {
    meta = await storage.head(row.storageKey);
    head = meta ? await storage.readPrefix(row.storageKey, 16) : null;
  } catch {
    // Leave the pending row: it expires and is swept, object and all.
    throw new VideoInterviewError("Couldn't check the uploaded video just now. Try again.", true, "storage_failed");
  }
  if (!meta || !head) return reject("The video didn't arrive.", "not_found");
  if (meta.size !== row.byteSize || meta.size > maxVideoBytesFor(row.durationMs)) return reject("The uploaded video wasn't the size that was agreed.");
  if (meta.contentType && baseMimeType(meta.contentType) !== row.contentType) return reject("The uploaded video wasn't the type that was agreed.");
  const container = sniffVideoContainer(head);
  if (!container || `video/${container}` !== row.contentType) return reject("The uploaded file isn't a video this coach can keep.");

  try {
    const [stored] = await db
      .update(videoInterviewRecordings)
      .set({ status: "stored", confirmedAt: new Date(), expiresAt: null })
      .where(and(eq(videoInterviewRecordings.id, row.id), eq(videoInterviewRecordings.userId, userId), eq(videoInterviewRecordings.status, "pending")))
      .returning();
    if (!stored) throw new Error("row changed underneath");
  } catch {
    // The database write failed: the object must not outlive its record.
    await discard(row, storage).catch(() => false);
    throw new VideoInterviewError("Couldn't save the training recording. Your answer is still saved.", true, "storage_failed");
  }
  return { retained: true, questionId: row.questionId };
}

/**
 * Deletes a student's training recordings - every one, or those for the given
 * questions. Rows are marked "deleting" first, so they stop counting as kept
 * immediately; then each object is removed and its row with it. Returns how
 * many are gone and how many the store could not delete yet (those stay
 * marked and are retried by sweepTrainingUploads).
 */
export async function deleteTrainingRecordings(
  userId: string,
  questionIds?: string[],
): Promise<{ deleted: number; outstanding: number; outstandingKeys: string[] }> {
  if (questionIds && questionIds.length === 0) return { deleted: 0, outstanding: 0, outstandingKeys: [] };
  const db = await getDb();
  const where = questionIds
    ? and(eq(videoInterviewRecordings.userId, userId), inArray(videoInterviewRecordings.questionId, questionIds))
    : eq(videoInterviewRecordings.userId, userId);
  const rows = await db
    .update(videoInterviewRecordings)
    .set({ status: "deleting" })
    .where(where)
    .returning();
  if (rows.length === 0) return { deleted: 0, outstanding: 0, outstandingKeys: [] };
  const storage = getObjectStorage();
  const outstandingKeys: string[] = [];
  for (const r of rows) if (!(await discard(r, storage))) outstandingKeys.push(r.storageKey);
  return { deleted: rows.length - outstandingKeys.length, outstanding: outstandingKeys.length, outstandingKeys };
}

/**
 * "Delete all training recordings": removes every kept recording (objects
 * first, then rows) AND withdraws the contribution of those interviews, so an
 * interview still in progress stops uploading too. Interviews, transcripts and
 * feedback stay. Future interviews ask afresh at start.
 */
export async function deleteAllTrainingRecordings(userId: string): Promise<{ deleted: number; outstanding: number }> {
  const db = await getDb();
  await db
    .update(videoInterviewSessions)
    .set({ trainingOptIn: false, trainingWithdrawnAt: new Date() })
    .where(and(eq(videoInterviewSessions.userId, userId), eq(videoInterviewSessions.trainingOptIn, true)));
  const { deleted, outstanding } = await deleteTrainingRecordings(userId);
  return { deleted, outstanding };
}

/** Whether a session authorises training uploads: opted in, under the
 *  current policy version. */
function sessionOptedIn(s: { trainingOptIn: boolean; trainingPolicyVersion: string | null }): boolean {
  return s.trainingOptIn === true && s.trainingPolicyVersion === VIDEO_POLICY_VERSION;
}
