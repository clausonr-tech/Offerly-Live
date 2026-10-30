// Seed `consecutive_inconclusive` from the check history already on record.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-inconclusive-streaks.ts
//   ... --apply     to write
//
// WHY THIS EXISTS
// ---------------
// `consecutive_inconclusive` (drizzle/0040) is what the inconclusive retry
// curve reads, and it starts at 0 for all 5,102 sources. So on the day the
// column lands, the 351 sources that have NEVER produced a successful read
// are back at attempt 1 - a 15-minute retry - and have to fail three more
// times each before the backoff reaches an hour, and eight before it reaches
// a day. That is thousands of requests spent re-learning what
// `monitoring_check_runs` already says.
//
// The streak is reconstructible exactly: walk each source's runs newest-first
// and count the inconclusive ones until the first successful read. That is the
// same number the crawler would have had if the column had always existed.
//
// REPORT BY DEFAULT, WRITE ONLY WITH --apply
// -----------------------------------------
// The repository's standing rule for anything that changes the schedule, as
// apply-discovered-boards.ts follows it: print what would change,
// write only when asked, and leave the list in the output so there is a record
// of what was applied.
import { desc, inArray } from "drizzle-orm";

import * as schema from "../src/db/schema";
import { openScriptDb } from "./_db";

const APPLY = process.argv.includes("--apply");

/**
 * Statuses that mean "we did not get an answer".
 *
 * Matched on the message rather than re-deriving from `http_status`, because
 * the inconclusive branch is the only thing that writes this prefix - so the
 * streak counts exactly the reads that branch handled, including any whose
 * status it classified differently from how `isInconclusive` would today.
 */
const INCONCLUSIVE_PREFIX = "inconclusive:";

function isSuccess(outcome: string | null): boolean {
  return outcome === "changed" || outcome === "no_change";
}

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const sources = await db
      .select({
        id: schema.firmMonitoringSources.id,
        stored: schema.firmMonitoringSources.consecutiveInconclusive,
      })
      .from(schema.firmMonitoringSources);

    // One read of the whole history rather than a query per source: 28,597
    // rows is nothing, and 5,102 round trips to a pooler is not.
    const runs = await db
      .select({
        sourceId: schema.monitoringCheckRuns.sourceId,
        startedAt: schema.monitoringCheckRuns.startedAt,
        outcome: schema.monitoringCheckRuns.outcome,
        errorMessage: schema.monitoringCheckRuns.errorMessage,
      })
      .from(schema.monitoringCheckRuns)
      .orderBy(desc(schema.monitoringCheckRuns.startedAt));

    const bySource = new Map<string, typeof runs>();
    for (const run of runs) {
      const list = bySource.get(run.sourceId) ?? [];
      list.push(run);
      bySource.set(run.sourceId, list);
    }

    const streaks = new Map<string, number>();
    for (const [sourceId, history] of bySource) {
      let streak = 0;
      // Newest first: stop at the first read that actually answered.
      for (const run of history) {
        if (isSuccess(run.outcome)) break;
        if (run.outcome === "error" && run.errorMessage?.startsWith(INCONCLUSIVE_PREFIX)) {
          streak += 1;
          continue;
        }
        // A conclusive failure (a 404, a real error) is not part of an
        // inconclusive streak and is already counted by failureCount. It ends
        // the streak rather than extending it.
        break;
      }
      if (streak > 0) streaks.set(sourceId, streak);
    }

    const changes = sources
      .filter((s) => (streaks.get(s.id) ?? 0) !== s.stored)
      .map((s) => ({ id: s.id, from: s.stored, to: streaks.get(s.id) ?? 0 }))
      .sort((a, b) => b.to - a.to);

    console.log(
      `${sources.length} source(s), ${bySource.size} with history.\n` +
        `${streaks.size} currently mid-streak; ${changes.length} row(s) would change.`,
    );

    const buckets = new Map<string, number>();
    for (const c of changes) {
      const k = c.to >= 8 ? "8+ (daily retry)" : c.to >= 4 ? "4-7 (hourly+)" : `${c.to}`;
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    console.log("\nnew streak value:");
    for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(5)}  ${k}`);
    }
    console.log(
      `\nlongest: ${changes.slice(0, 5).map((c) => `${c.to}`).join(", ") || "none"}`,
    );

    if (!APPLY) {
      console.log("\nReport only. Re-run with --apply to write.");
      return;
    }

    // Grouped by value so this is one UPDATE per distinct streak length
    // (single digits) rather than one per source.
    const byValue = new Map<number, string[]>();
    for (const c of changes) {
      byValue.set(c.to, [...(byValue.get(c.to) ?? []), c.id]);
    }
    for (const [value, ids] of byValue) {
      for (let i = 0; i < ids.length; i += 500) {
        await db
          .update(schema.firmMonitoringSources)
          .set({ consecutiveInconclusive: value })
          .where(inArray(schema.firmMonitoringSources.id, ids.slice(i, i + 500)));
      }
      console.log(`  set ${ids.length} source(s) to ${value}`);
    }
    console.log(`\nApplied to ${changes.length} source(s).`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
