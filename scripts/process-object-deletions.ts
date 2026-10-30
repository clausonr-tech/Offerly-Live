/**
 * Drains object_deletion_queue: retries deleting private-storage objects left
 * behind when storage was unreachable during an account deletion. Safe to run
 * any number of times, and from a cron (see docs/VIDEO_INTERVIEW_SETUP.md).
 *
 *   npm run storage:process-deletions
 *
 * Uses the app's own database connection (DATABASE_URL, or local PGlite) and
 * the VIDEO_STORAGE_* configuration. Prints counts only - never keys.
 */
import { processObjectDeletionQueue } from "../src/lib/video-interview/deletion-queue";

async function main() {
  const url = process.env.DATABASE_URL;
  console.log(`[deletions] target: ${url ? `remote Postgres — ${new URL(url).host}` : "LOCAL PGlite"}`);
  let total = { deleted: 0, failed: 0, remaining: 0 };
  // Batches until the queue is empty or a whole batch fails.
  for (let i = 0; i < 100; i++) {
    const r = await processObjectDeletionQueue(50);
    total = { deleted: total.deleted + r.deleted, failed: total.failed + r.failed, remaining: r.remaining };
    if (r.remaining === 0 || r.deleted === 0) break;
  }
  console.log(`[deletions] deleted ${total.deleted}, still failing ${total.failed}, remaining in queue ${total.remaining}`);
  process.exit(total.remaining > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error("[deletions] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
