import type { getDb } from "@/db/client";
import { aiJobUsage } from "@/db/schema";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Records one model call's spend. Best-effort: a failure to write this row is
 * logged and never ends the run. On 29 September 2026 the laptop slept in the
 * middle of a run, the database connection died, and the insert recording the
 * timed-out call crashed the whole run - so nothing got ranked either.
 */
export async function recordJobUsage(db: Db, values: typeof aiJobUsage.$inferInsert): Promise<void> {
  try {
    await db.insert(aiJobUsage).values(values);
  } catch (err) {
    console.warn(`  (usage not recorded: ${err instanceof Error ? err.message.split("\n")[0] : err})`);
  }
}
