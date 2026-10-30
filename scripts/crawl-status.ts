// Crawl coverage and history so far. Stop the dev server before running.
//   npx tsx --env-file=.env.local --conditions=react-server scripts/crawl-status.ts
//
// This used to report "crawl runs: 0" and it was reading the wrong table.
// `internship_crawl_runs` belonged to the AI crawler that was retired with
// src/lib/internship-crawler.ts; its own schema comment says nothing writes to
// it any more. So the line was always 0, and it read as "this crawler has never
// run" while 133 checks sat recorded in `monitoring_check_runs` - the
// per-SOURCE audit trail that replaced it.
//
// A status script that reports zero activity on a system that is working is
// worse than no status script, because it gets believed.
import { openScriptDb } from "./_db";
import { desc } from "drizzle-orm";
import * as schema from "../src/db/schema";

async function main() {
  const { db } = await openScriptDb();

  const programs = await db.query.firmPrograms.findMany();
  const postings = await db.query.internshipPostings.findMany();
  const sources = await db.query.firmMonitoringSources.findMany();
  const listings = await db.query.detectedListings.findMany();
  const checks = await db.query.monitoringCheckRuns.findMany({
    orderBy: [desc(schema.monitoringCheckRuns.startedAt)],
  });

  console.log(`firm programs:     ${programs.length}`);
  console.log(`monitored sources: ${sources.length}`);
  console.log(`detected listings: ${listings.length}`);
  console.log(`postings stored:   ${postings.length}`);
  console.log(`checks recorded:   ${checks.length}`);

  if (checks.length === 0) {
    console.log("\nNo checks recorded yet. Run: npm run monitor:run -- --limit 25");
    process.exit(0);
  }

  const byOutcome = new Map<string, number>();
  for (const c of checks) {
    const k = c.outcome ?? "(null)";
    byOutcome.set(k, (byOutcome.get(k) ?? 0) + 1);
  }
  console.log(`\nby outcome:`);
  for (const [k, v] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }

  // How much of the monitored set has ever actually been checked. This is the
  // number behind "has anything been crawled twice yet", which is what the
  // announcement watcher needs and has never had.
  const perSource = new Map<string, number>();
  for (const c of checks) perSource.set(c.sourceId, (perSource.get(c.sourceId) ?? 0) + 1);
  const everChecked = perSource.size;
  const checkedTwice = [...perSource.values()].filter((n) => n >= 2).length;

  console.log(`\nsources ever checked:   ${everChecked} of ${sources.length}`);
  console.log(
    `sources checked twice+: ${checkedTwice}` +
      `   <- the announcement watcher needs this; it diffs one check against the previous`,
  );

  /**
   * Sources that have never once answered, and what they cost.
   *
   * These were invisible. A source whose every read is inconclusive - HTTP 0,
   * 403, 429 - is deliberately never charged a failure and never marked
   * broken, because a throttle is not a verdict on the firm (see
   * lib/monitoring/http-outcome.ts). The consequence nobody was shown is that
   * such a source also never LEAVES: on 11 October 2026, 351 of them had
   * consumed 12,902 of 28,597 check runs, 45% of the whole crawl, while 319
   * still read as healthy.
   *
   * Printed as a share of the crawl rather than a count, because the count
   * alone looked tolerable for three weeks.
   */
  const succeededBySource = new Map<string, number>();
  for (const c of checks) {
    if (c.outcome === "changed" || c.outcome === "no_change") {
      succeededBySource.set(c.sourceId, (succeededBySource.get(c.sourceId) ?? 0) + 1);
    }
  }
  const neverAnswered = [...perSource].filter(
    ([id, attempts]) => attempts >= 3 && !succeededBySource.has(id),
  );
  const spentOnThem = neverAnswered.reduce((sum, [, attempts]) => sum + attempts, 0);
  if (neverAnswered.length) {
    const share = Math.round((100 * spentOnThem) / checks.length);
    console.log(
      `\nnever answered:         ${neverAnswered.length} source(s) with 3+ attempts and no successful read` +
        `\n                        ${spentOnThem} check(s) spent on them - ${share}% of the crawl`,
    );
    const stillHealthy = sources.filter(
      (s) => s.sourceHealth === "healthy" && neverAnswered.some(([id]) => id === s.id),
    ).length;
    if (stillHealthy) {
      console.log(
        `                        ${stillHealthy} of them still read as healthy` +
          ` <- correct: an inconclusive read is not a verdict on the firm`,
      );
    }
  }

  const newest = checks[0];
  const oldest = checks[checks.length - 1];
  console.log(
    `\nfirst check: ${oldest.startedAt?.toISOString().slice(0, 16).replace("T", " ")}` +
      `\nlast check:  ${newest.startedAt?.toISOString().slice(0, 16).replace("T", " ")}`,
  );

  const errors = checks.filter((c) => c.outcome === "error").slice(0, 5);
  if (errors.length) {
    console.log(`\nmost recent errors:`);
    for (const e of errors) {
      console.log(`  ${e.startedAt?.toISOString().slice(0, 16)}  ${(e.errorMessage ?? "(no message recorded)").slice(0, 88)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
