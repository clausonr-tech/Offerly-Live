// Derive opening windows from the postings we already collected.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/opening-history-from-postings.ts [--firm NAME] [--apply]
//
// A SECOND EVIDENCE SOURCE FOR THE SAME QUESTION
// ----------------------------------------------
// opening-history.ts answers "when does this firm open?" from Internet Archive
// snapshots. This answers it from our own `detected_listings`, and needs no
// third party at all: every listing carries `published_at`, the firm's own
// posting date off its own board, and the cycle it was classified into. A firm
// that posted for cycle 2027 in July and cycle 2026 in June has told us its
// season directly.
//
// This matters most for the listings we REJECT. A posting whose cycle has
// passed is not waste - it is the only record of when that firm posted that
// year. Those rows are kept deliberately (see
// scripts/test/history-is-never-deleted.test.ts) and this is what reads them.
//
// IT REUSES THE RULES RATHER THAN INVENTING THEM
// ----------------------------------------------
// The hard part of a prediction is knowing when to refuse to make one, and
// opening-history.ts already worked that out. So the observations built here go
// through the SAME `deriveWindow`, which supplies:
//
//   - at least two observations, or nothing. One posting date is an anecdote.
//     Those observations are keyed on the CALENDAR YEAR the firm posted, not
//     on the cycle the role was for - see the comment in the loop, which is
//     the one subtle thing in this file. Measured 13 October 2026 that leaves
//     exactly ONE firm (BDO Capital Advisors, which posted in November 2025
//     and September 2026), because we have only been collecting for thirteen
//     months. That is the honest yield and it grows by itself: this is also
//     why the Archive path exists, since the Archive can reach back years
//     today and we cannot.
//   - a span of at most 75 days, or nothing - "a shrug with dates on it".
//   - a padded window, never a single date.
//
// and `recordOpeningSignal` with source "prediction", which ranks LAST in
// opening-signals.ts precedence: a firm announcement, a live sighting or a
// student's report all beat it. A derived guess must never outrank something
// somebody actually saw.
//
// WHAT IT DOES NOT DO
// -------------------
// It never reads `first_detected_at`. That is the day WE first saw a listing,
// bounded below by the day we started crawling that source, so a window built
// from it would describe our deployment schedule in a row that claims to
// describe the firm. A firm with no posting date of its own gets no prediction.
//
// Dry run by default.
import { and, eq, sql } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import * as schema from "../src/db/schema";
import { deriveWindow, type YearObservation } from "../src/lib/monitoring/opening-history";
import { recordOpeningSignal } from "../src/lib/opening-signals";
import { openScriptDb, rowsOf } from "./_db";

const APPLY = process.argv.includes("--apply");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const FIRM = arg("firm") ?? null;

export type Seed = {
  firm_id: string;
  firm: string;
  category: string | null;
  cycle: number;
  first_published: string;
  url: string | null;
  title: string;
};

/**
 * One observation per CALENDAR year of posting, not per cycle.
 *
 * This is the correction that makes the two-observation rule mean what it says.
 * `deriveWindow` requires two because one is an anecdote - and it was written
 * for Archive snapshots, where each observation is a different calendar year
 * and two of them really are a repeated annual pattern.
 *
 * Two CYCLES are not that. Measured 13 October 2026: of the 8 firms that passed
 * when cycles were fed in as years, 7 had both postings in the same calendar
 * year. Leerink Partners' two "years of evidence" were 2026-09-10 and
 * 2026-09-18 - eight days apart. That is one September burst which happened to
 * carry roles labelled for two cycles, and passing it off as two years of
 * history smuggles in exactly the anecdote the rule exists to refuse.
 *
 * So the evidence is keyed on the year the firm POSTED. A firm that posted in
 * two different calendar years has shown its season twice.
 */
export function observationsFromPostings(rows: Seed[]): YearObservation[] {
  const byPostingYear = new Map<number, Seed>();
  for (const r of rows) {
    const year = Number(r.first_published.slice(0, 4));
    const prev = byPostingYear.get(year);
    if (!prev || r.first_published < prev.first_published) byPostingYear.set(year, r);
  }
  return [...byPostingYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, r]) => ({
      year,
      // The checkable URL for this evidence, as the Archive path uses its
      // snapshot URL.
      snapshotUrl: r.url ?? `(listing with no url: ${r.title})`,
      firstSeen: new Date(`${r.first_published}T00:00:00Z`),
      // The cycle is kept here so the evidence says which cycle the date was a
      // posting FOR, which the year alone does not.
      matched: `${r.title} (cycle ${r.cycle})`,
    }));
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { db, close: closeDb } = await openScriptDb();
  try {
    /**
     * One row per firm and cycle: the EARLIEST posting that firm made for that
     * cycle, with its url and title so the resulting claim can be checked by
     * opening the thing it was derived from.
     */
    const seeds = rowsOf<Seed>(
      await db.execute(sql`
        SELECT DISTINCT ON (f.id, (l.classification->>'recruitingCycle')::int)
               f.id::text AS firm_id,
               f.name AS firm,
               s.sector_category::text AS category,
               (l.classification->>'recruitingCycle')::int AS cycle,
               l.published_at::date::text AS first_published,
               l.listing_url AS url,
               l.title AS title
        FROM detected_listings l
        JOIN firm_monitoring_sources s ON s.id = l.source_id
        JOIN firms f ON f.id = s.firm_id
        WHERE (l.classification->>'relevant') = 'true'
          AND (l.classification->>'recruitingCycle') IS NOT NULL
          AND l.published_at IS NOT NULL
          ${FIRM ? sql`AND f.name ILIKE ${"%" + FIRM + "%"}` : sql``}
        ORDER BY f.id, (l.classification->>'recruitingCycle')::int, l.published_at ASC
      `),
    );

    const byFirm = new Map<string, Seed[]>();
    for (const s of seeds) {
      const got = byFirm.get(s.firm_id);
      if (got) got.push(s);
      else byFirm.set(s.firm_id, [s]);
    }

    /** Firm+cycle pairs that already carry a prediction, so we add rather than
     *  stack a second guess on top of the Archive's. */
    const already = new Set(
      rowsOf<{ k: string }>(
        await db.execute(sql`
          SELECT firm_id::text || ':' || cycle_year::text AS k
          FROM opening_signals WHERE source = 'prediction'`),
      ).map((r) => r.k),
    );

    const planned: {
      firmId: string;
      firm: string;
      category: string | null;
      cycleYear: number;
      evidence: string;
      sourceUrl: string | null;
      opensStart: string;
      opensEnd: string;
    }[] = [];
    const refused: { firm: string; why: string }[] = [];

    for (const [firmId, rows] of byFirm) {
      const observations = observationsFromPostings(rows);

      const win = deriveWindow(observations);
      if (!win) {
        refused.push({
          firm: rows[0].firm,
          why:
            observations.length < 2
              ? `only one calendar year of postings (${observations[0].year})`
              : "postings too far apart in the year to be one season",
        });
        continue;
      }
      if (already.has(`${firmId}:${win.cycleYear}`)) {
        refused.push({ firm: rows[0].firm, why: `cycle ${win.cycleYear} already predicted` });
        continue;
      }
      planned.push({
        firmId,
        firm: rows[0].firm,
        category: rows[0].category,
        cycleYear: win.cycleYear,
        evidence: `From this firm's own posting dates: ${win.evidence}`,
        sourceUrl: win.observations[win.observations.length - 1].snapshotUrl,
        opensStart: win.opensStart.toISOString().slice(0, 10),
        opensEnd: win.opensEnd.toISOString().slice(0, 10),
      });
    }

    console.log(
      `${byFirm.size} firms have at least one posting date of their own.\n` +
        `${planned.length} windows derived; ${refused.length} refused.\n`,
    );
    for (const p of planned) {
      console.log(
        `  ${p.firm.slice(0, 30).padEnd(30)} cycle ${p.cycleYear}  ${p.opensStart} .. ${p.opensEnd}`,
      );
    }
    const counts = new Map<string, number>();
    for (const r of refused) counts.set(r.why, (counts.get(r.why) ?? 0) + 1);
    console.log("\n  refused:");
    for (const [why, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${why}`);
    }

    if (!APPLY) {
      console.log("\nDry run. Nothing written. Re-run with --apply.");
      return;
    }

    mkdirSync("scripts/data", { recursive: true });
    const record = `scripts/data/opening-windows-from-postings-${today}.json`;
    writeFileSync(record, JSON.stringify({ derivedAt: today, planned, refused }, null, 2));
    console.log(`\nRecorded ${planned.length} intended writes to ${record} before writing.`);

    let stored = 0;
    for (const p of planned) {
      await recordOpeningSignal(
        {
          firmId: p.firmId,
          cycleYear: p.cycleYear,
          programCategory: (p.category as never) ?? null,
          source: "prediction",
          evidence: p.evidence,
          sourceUrl: p.sourceUrl,
          opensStart: new Date(`${p.opensStart}T00:00:00Z`),
          opensEnd: new Date(`${p.opensEnd}T00:00:00Z`),
        },
        db as never,
      );
      stored += 1;
    }
    console.log(`Stored ${stored} predictions.`);
  } finally {
    await closeDb();
  }
}

if (process.argv[1]?.endsWith("opening-history-from-postings.ts")) main();
