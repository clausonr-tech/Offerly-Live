import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { objectDeletionQueue, videoInterviewRecordings } from "@/db/schema";
import { getObjectStorage } from "./object-storage";
import { deleteTrainingRecordings } from "./training-video";

/**
 * Deletions that must survive their owner.
 *
 * Interview deletion, "delete all" and revoking training can simply refuse
 * and retry while the store is down - the recording rows still name their
 * objects. Account deletion cannot wait, and the users cascade removes those
 * rows. So before an account goes, every object the store could not delete is
 * written to object_deletion_queue, which has no link to the user and nothing
 * personal in it, and processObjectDeletionQueue() keeps retrying until each
 * object is confirmed gone. A missing object counts as gone.
 */

export class AccountCleanupError extends Error {
  constructor() {
    super("Couldn't safely remove your interview recordings right now. Nothing was deleted - try again in a few minutes.");
    this.name = "AccountCleanupError";
  }
}

/**
 * Called by account deletion BEFORE the user row is deleted. Deletes every
 * training object it can; queues the rest durably. Throws AccountCleanupError
 * - so the account is not deleted - if anything could not be accounted for,
 * because deleting the user then would leave an object nobody knows about.
 */
export async function prepareRecordingsForAccountDeletion(userId: string): Promise<{ deleted: number; queued: number }> {
  // A database without the video coach's tables (before migration 0029) has
  // no recordings to account for - that must not block deleting an account.
  if (!(await recordingsTableExists())) return { deleted: 0, queued: 0 };
  let result: Awaited<ReturnType<typeof deleteTrainingRecordings>>;
  try {
    result = await deleteTrainingRecordings(userId);
  } catch {
    throw new AccountCleanupError();
  }
  if (result.outstanding === 0) return { deleted: result.deleted, queued: 0 };

  const db = await getDb();
  try {
    // Read provider + key from the rows that are still there - they are the
    // ones the store refused - and queue them in one statement.
    const left = await db
      .select({ provider: videoInterviewRecordings.storageDriver, objectKey: videoInterviewRecordings.storageKey })
      .from(videoInterviewRecordings)
      .where(eq(videoInterviewRecordings.userId, userId));
    if (left.length > 0) {
      await db
        .insert(objectDeletionQueue)
        .values(
          left.map((r) => ({
            provider: r.provider,
            objectKey: r.objectKey,
            lastErrorCategory: getObjectStorage() ? ("storage_error" as const) : ("storage_unconfigured" as const),
          })),
        )
        .onConflictDoNothing();
    }
    // Every outstanding key must now be in the queue, or the account stays.
    const queued = await db
      .select({ key: objectDeletionQueue.objectKey })
      .from(objectDeletionQueue)
      .where(inArray(objectDeletionQueue.objectKey, result.outstandingKeys));
    const inQueue = new Set(queued.map((q) => q.key));
    if (!result.outstandingKeys.every((k) => inQueue.has(k))) throw new Error("queue incomplete");
    return { deleted: result.deleted, queued: result.outstandingKeys.length };
  } catch {
    throw new AccountCleanupError();
  }
}

async function recordingsTableExists(): Promise<boolean> {
  try {
    const db = await getDb();
    const res = (await db.execute(sql`select to_regclass('public.video_interview_recordings') is not null as ok`)) as unknown;
    const row = Array.isArray(res) ? res[0] : (res as { rows?: { ok?: boolean }[] }).rows?.[0];
    return row?.ok === true;
  } catch {
    // Can't even ask: treat as "might have recordings" so deletion stops safely.
    return true;
  }
}

/**
 * Retries queued deletions, oldest first. Idempotent: running it twice, or in
 * two places at once, is harmless - a row is removed only after its object is
 * confirmed gone (or already missing), and a failure only bumps the attempt
 * count. Returns what happened, for a script or cron to report.
 */
export async function processObjectDeletionQueue(limit = 50): Promise<{ deleted: number; failed: number; remaining: number }> {
  const db = await getDb();
  const rows = await db.select().from(objectDeletionQueue).orderBy(asc(objectDeletionQueue.createdAt)).limit(limit);
  const storage = getObjectStorage();
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    let category: "storage_unconfigured" | "storage_error" | null = null;
    if (!storage || storage.provider !== row.provider) category = "storage_unconfigured";
    else {
      try {
        await storage.delete(row.objectKey); // a missing object resolves: already gone
      } catch {
        category = "storage_error";
      }
    }
    if (category) {
      failed++;
      await db
        .update(objectDeletionQueue)
        .set({ attempts: sql`${objectDeletionQueue.attempts} + 1`, lastErrorCategory: category, lastAttemptAt: new Date() })
        .where(eq(objectDeletionQueue.id, row.id));
    } else {
      deleted++;
      await db.delete(objectDeletionQueue).where(and(eq(objectDeletionQueue.id, row.id), eq(objectDeletionQueue.objectKey, row.objectKey)));
    }
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(objectDeletionQueue);
  return { deleted, failed, remaining: Number(n) };
}
