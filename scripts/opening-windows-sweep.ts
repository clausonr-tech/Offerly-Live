// Derive an opening window for EVERY monitored source, and write the datasheet.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/opening-windows-sweep.ts
//   ... --apply     also write opening_signals rows (source "prediction")
//   ... --limit N   stop after N firms (default: all)
//   ... --years 4   how many years of archive history to read (default 5)
//   ... --resume    skip firms already in the datasheet, and keep their rows
//   ... --firm NAME only firms whose name contains this
//
// Uses DATABASE_URL when set (Supabase), otherwise the local PGlite file -
// and only the local file has the single-writer restriction.
//
// WHY THIS EXISTS SEPARATELY FROM opening-history.ts
// --------------------------------------------------
// That script answers "what is this firm's window" for a handful of firms,
// interactively, and defaults to five. This one is the sweep: it runs the
// whole monitored set and produces a file the crawler can act on, which is the
// half the crawler roadmap called item #1 and nobody built.
//
// RESUMABLE, BECAUSE THE ARCHIVE IS SLOW AND UNRELIABLE
// -----------------------------------------------------
// Measured 19 Sep across a 22-firm sample: the same shape of CDX query
// returned in 2.7s for one firm and 39.3s for another, and three of the 22
// errored outright. Over 142 sources that is somewhere between twenty minutes
// and two hours, with failures guaranteed. A sweep that cannot be resumed
// would have to be restarted from zero every time the Archive has a bad
// afternoon, so every firm is written to the datasheet as it completes - both
// the hits and the misses, because "we looked and there is no usable history"
// is a real answer worth not paying for twice.
//
// SCOPE: MONITORED SOURCES, NOT THE DIRECTORY
// -------------------------------------------
// The directory holds 22,580 firms and 20,663 of them have no careers URL at
// all. There is nothing to ask the Archive about, and at measured latency the
// full set would be roughly 63 hours. The monitored sources are also the only
// ones the crawler can act on: a window for a firm with no source cannot
// change any schedule. `--all` exists for when that stops being true.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import * as schema from "../src/db/schema";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { openDb } from "../src/db/open";
import {
  gatherObservations,
  deriveWindow,
} from "../src/lib/monitoring/opening-history";
import { recordOpeningSignal } from "../src/lib/opening-signals";
import { windowUrgency } from "../src/lib/monitoring/opening-window";
import { decideEnrollment, ENABLED_CATEGORIES } from "../src/lib/monitoring/enrollment";
import { sizeForWebsite } from "../src/lib/monitoring/form-adv";
import { detectConnector } from "../src/lib/monitoring/connectors";
import { FIRM_TIER_BY_SLUG } from "../src/lib/firm-content";
import { eq } from "drizzle-orm";
import type { FirmProgramCategory } from "../src/lib/firm-metadata";

/** A firm to read archive history for, from either scope. */
type SweepTarget = {
  /** Source id, or `firm:<firmId>` for a candidate with no source yet. Used
   *  as the datasheet key, so --resume works across both scopes. */
  id: string;
  firmId: string;
  firmSlug: string;
  firmName: string;
  careersUrl: string;
  connectorId: string;
  sectorCategory: string;
};

const JSON_PATH = "scripts/data/opening-windows.json";
const CSV_PATH = "scripts/data/opening-windows.csv";

const apply = process.argv.includes("--apply");
const resume = process.argv.includes("--resume");
/** "sources" (the 188 crawled today) or "candidates" (every firm that passes
 *  the enrolment bar - roughly 4,700 across all fourteen sectors). */
const scope =
  process.argv[process.argv.indexOf("--scope") + 1] === "candidates" &&
  process.argv.includes("--scope")
    ? "candidates"
    : "sources";
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
/**
 * How many years of Archive history to read.
 *
 * Five, not three. A window needs TWO years of evidence before deriveWindow
 * will say anything, and the Archive's coverage of any one firm is patchy -
 * three years routinely yields one usable observation and therefore nothing.
 * Reaching back further costs one extra boundary search per year on the firms
 * that need it, and turns "insufficient-history" into a window for the firms
 * that were one observation short.
 */
const years = arg("years") ? Number(arg("years")) : 5;
const firmFilter = arg("firm")?.toLowerCase() ?? null;

/** One row of the datasheet. A miss is recorded as deliberately as a hit. */
type WindowRow = {
  sourceId: string;
  firmSlug: string;
  firmName: string;
  careersUrl: string;
  connectorId: string;
  /** Which archive method produced the evidence: url-index, api, pages, or a
   *  combination. Recorded so a thin result can be told from a method that
   *  never ran - the distinction the first sweep could not make. */
  method?: string;
  /** "window" | "insufficient-history" | "window-too-wide" | "no-snapshots" | "error" */
  outcome: string;
  cycleYear: number | null;
  opensStart: string | null;
  opensEnd: string | null;
  /** The dated snapshot URLs the window came from, so it can be checked. */
  observations: { year: number; firstSeen: string; snapshotUrl: string; matched: string }[];
  note: string;
  checkedAt: string;
};

function loadExisting(): Map<string, WindowRow> {
  if (!resume) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(JSON_PATH, "utf8")) as { rows?: WindowRow[] };
    return new Map((parsed.rows ?? []).map((r) => [r.sourceId, r]));
  } catch {
    return new Map();
  }
}

function writeDatasheet(rows: WindowRow[]) {
  mkdirSync(dirname(JSON_PATH), { recursive: true });

  writeFileSync(
    JSON_PATH,
    `${JSON.stringify(
      { generatedAt: new Date().toISOString(), years, count: rows.length, rows },
      null,
      1,
    )}\n`,
  );

  // A CSV as well, because this is a datasheet a person reads and decides
  // from - the observations column carries the archive URLs so a window can be
  // disagreed with by opening the page as it actually stood.
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = [
    "firm",
    "slug",
    "connector",
    "outcome",
    "cycle_year",
    "opens_start",
    "opens_end",
    "years_observed",
    "evidence",
    "note",
    "careers_url",
  ].join(",");
  const lines = rows
    .slice()
    .sort((a, b) => (a.opensStart ?? "9").localeCompare(b.opensStart ?? "9"))
    .map((r) =>
      [
        esc(r.firmName),
        esc(r.firmSlug),
        esc(r.connectorId),
        esc(r.outcome),
        r.cycleYear ?? "",
        r.opensStart ?? "",
        r.opensEnd ?? "",
        r.observations.length,
        esc(r.observations.map((o) => `${o.firstSeen} ${o.snapshotUrl}`).join(" | ")),
        esc(r.note),
        esc(r.careersUrl),
      ].join(","),
    );
  writeFileSync(CSV_PATH, `${[header, ...lines].join("\n")}\n`);
}

async function main() {
  // Follows DATABASE_URL, so --apply writes its predictions to whichever
  // database the project is actually using. Opening PGlite directly here
  // would have filed every prediction into a local file nothing reads.
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}`);

  try {
    const sources = await db.query.firmMonitoringSources.findMany({ with: { firm: true } });

    /**
     * What counts as "a firm we will be crawling".
     *
     * The default is the monitored sources - 188 of them - which is what this
     * sweep has always read. That is the set we crawl TODAY, and it is a
     * fraction of the set we will crawl: 17,883 firms carry a careers URL, and
     * roughly 4,700 of those pass the enrolment bar in enrollment.ts.
     *
     * `--scope candidates` reads that wider set. It matters because archive
     * history is the one thing that cannot be collected retroactively at the
     * moment you need it: by the time a firm is enrolled and a student is
     * asking when it opens, the answer has to already be on hand. Even a thin
     * result is worth having, and a firm that turns out to have no archived
     * history at all is itself a fact worth recording once rather than
     * rediscovering.
     *
     * The bar is `decideEnrollment`, not a new rule - so the firms swept here
     * are exactly the firms seed-monitoring-sources.ts would register.
     */
    const targets: SweepTarget[] = sources.map((s) => ({
      id: s.id,
      firmId: s.firmId,
      firmSlug: s.firm?.slug ?? "",
      firmName: s.firm?.name ?? s.firmId,
      careersUrl: s.careersUrl,
      connectorId: s.connectorId,
      sectorCategory: s.sectorCategory,
    }));

    if (scope === "candidates") {
      const already = new Set(targets.map((t) => t.firmId));
      const rows = await db
        .select({
          firmId: schema.firms.id,
          slug: schema.firms.slug,
          name: schema.firms.name,
          website: schema.firms.website,
          aum: schema.firms.aum,
          hasVerifiedProgram: schema.firms.hasVerifiedProgram,
          careersUrl: schema.firmPrograms.careersUrl,
          category: schema.firmPrograms.category,
        })
        .from(schema.firmPrograms)
        .innerJoin(schema.firms, eq(schema.firmPrograms.firmId, schema.firms.id));

      const seenFirm = new Set<string>();
      let considered = 0;
      for (const r of rows) {
        if (!r.careersUrl || already.has(r.firmId) || seenFirm.has(r.firmId)) continue;
        if (!ENABLED_CATEGORIES.has(r.category)) continue;
        considered += 1;
        const size = sizeForWebsite(r.website);
        const connector = detectConnector(r.careersUrl);
        const decision = decideEnrollment(
          {
            slug: r.slug,
            name: r.name,
            website: r.website ?? null,
            category: r.category,
            aum: r.aum ?? size?.aum ?? null,
            employees: size?.employees ?? null,
            hasVerifiedProgram: r.hasVerifiedProgram,
            ibTier: FIRM_TIER_BY_SLUG[r.slug]?.ibTier ?? null,
          },
          { careersUrl: r.careersUrl, connectorId: connector.id, verifiedParsing: false },
          new Set(),
        );
        if (decision.action === "skip" || decision.action === "duplicate") continue;
        seenFirm.add(r.firmId);
        targets.push({
          id: `firm:${r.firmId}`,
          firmId: r.firmId,
          firmSlug: r.slug,
          firmName: r.name,
          careersUrl: r.careersUrl,
          connectorId: connector.id,
          sectorCategory: r.category,
        });
      }
      console.log(
        `scope=candidates: ${considered} firms with a careers URL considered, ` +
          `${targets.length - sources.length} passed the enrolment bar.`,
      );
    }

    /**
     * Round-robin across sectors, not sector by sector.
     *
     * The natural order is monitored sources first, then candidates - and 106
     * of the 188 sources are investment banking, so a straight pass spends its
     * first several hours entirely on banks. Measured on the first run: of 86
     * boards read, essentially every one was IB - Goldman, Evercore, Lazard,
     * PJT, Perella, Jefferies, Houlihan, Barclays, Citi, Nomura.
     *
     * This sweep takes days across 4,950 firms, so the order decides what is
     * known at every point before it finishes. Interleaving means that after
     * one hour there is archive history for banks AND hedge funds AND
     * insurance, instead of a complete answer for one sector and nothing at
     * all for thirteen. A partial sweep that covers every industry is useful;
     * a partial sweep that covers one is the position this project was
     * already in.
     *
     * Stable within each sector, so --resume stays meaningful.
     */
    const bySector = new Map<string, SweepTarget[]>();
    for (const t of targets) {
      if (!bySector.has(t.sectorCategory)) bySector.set(t.sectorCategory, []);
      bySector.get(t.sectorCategory)!.push(t);
    }
    const interleaved: SweepTarget[] = [];
    for (let i = 0; interleaved.length < targets.length; i++) {
      for (const list of bySector.values()) if (i < list.length) interleaved.push(list[i]);
    }
    console.log(
      `interleaved across ${bySector.size} sector(s): ` +
        [...bySector].map(([k, v]) => `${k} ${v.length}`).join(", "),
    );

    const existing = loadExisting();

    const queue = interleaved
      .filter((s) => (firmFilter ? s.firmName.toLowerCase().includes(firmFilter) : true))
      .filter((s) => !(resume && existing.has(s.id)))
      .slice(0, limit === Infinity ? undefined : limit);

    console.log(
      `${targets.length} target(s); ${existing.size} already in the datasheet; ${queue.length} to read.\n` +
        `Reading ${years} years of Archive history each. This is slow by nature - 2.7s to 39s per firm, measured.\n`,
    );

    const rows: WindowRow[] = [...existing.values()];
    const now = new Date();
    const thisYear = now.getUTCFullYear();
    let withWindow = 0;

    for (const [i, source] of queue.entries()) {
      const name = source.firmName;
      process.stdout.write(`[${i + 1}/${queue.length}] ${name.slice(0, 40).padEnd(40)} `);

      const base: WindowRow = {
        sourceId: source.id,
        firmSlug: source.firmSlug,
        firmName: name,
        careersUrl: source.careersUrl,
        connectorId: source.connectorId,
        outcome: "error",
        cycleYear: null,
        opensStart: null,
        opensEnd: null,
        observations: [],
        note: "",
        checkedAt: new Date().toISOString(),
      };

      try {
        /**
         * All three ways of asking, not just the archived page.
         *
         * This used to call `fetchSnapshots(source.careersUrl)` and read the
         * captured HTML, which is the one method that cannot see the boards
         * most of these firms run: a Workday, Oracle or Greenhouse careers
         * page is archived as an empty JavaScript shell, so the titles were
         * never in the bytes to find.
         *
         * It showed. Of the 144 boards this sweep covered on 20 September
         * 2026, 79 had captures in the Archive and not one carried a readable
         * internship, 31 had no captures of that exact URL, and exactly ONE
         * produced a usable window. `gatherObservations` adds the two methods
         * `tiered-opening-dates.ts` already had - the index of job URLs
         * beneath the board, and the vendor's API endpoint, whose archived
         * replies are JSON - both of which read boards this one cannot.
         */
        const { observations, method, archiveReachable, archiveError } = await gatherObservations({
          careersUrl: source.careersUrl,
          fromYear: thisYear - years,
          toYear: thisYear,
        });
        base.method = method;

        if (observations.length === 0 && !archiveReachable) {
          /**
           * The Archive was never reached, so this says nothing about the board.
           *
           * The note below is a positive claim about what the Archive holds,
           * and writing it after a transport failure would be inventing a fact
           * about a firm - the one thing this pipeline forbids. An error
           * outcome instead, so a later sweep re-reads the board rather than
           * treating the silence as settled.
           */
          rows.push({
            ...base,
            outcome: "error",
            note: `the Internet Archive could not be reached: ${archiveError ?? "no response"}`,
          });
          console.log("ARCHIVE UNREACHABLE");
          writeDatasheet(rows);
          continue;
        }

        if (observations.length === 0) {
          rows.push({
            ...base,
            outcome: "no-snapshots",
            note: "no archived capture of this board named an internship, by URL index, API or page",
          });
          console.log("no usable snapshots");
          writeDatasheet(rows);
          continue;
        }

        base.observations = observations.map((o) => ({
          year: o.year,
          firstSeen: o.firstSeen.toISOString().slice(0, 10),
          snapshotUrl: o.snapshotUrl,
          matched: o.matched,
        }));

        // Two years minimum, and the span cap, are deriveWindow's own rules -
        // one observation is an anecdote and a 140-day range is a shrug with
        // dates on it. Both refusals are recorded rather than retried.
        const window = deriveWindow(observations, now);
        if (!window) {
          const outcome = observations.length < 2 ? "insufficient-history" : "window-too-wide";
          rows.push({
            ...base,
            outcome,
            note:
              observations.length < 2
                ? `only ${observations.length} year(s) carried internship language`
                : "the observed dates span more than 75 days, too wide to act on",
          });
          console.log(`${outcome} (${observations.length} year(s))`);
          writeDatasheet(rows);
          continue;
        }

        const urgency = windowUrgency(window, now);
        rows.push({
          ...base,
          outcome: "window",
          cycleYear: window.cycleYear,
          opensStart: window.opensStart.toISOString().slice(0, 10),
          opensEnd: window.opensEnd.toISOString().slice(0, 10),
          note: urgency.reason,
        });
        withWindow += 1;
        console.log(
          `${window.opensStart.toISOString().slice(0, 10)} to ${window.opensEnd.toISOString().slice(0, 10)}` +
            ` (${observations.length} years)${urgency.imminent ? "  <-- IMMINENT" : ""}`,
        );

        if (apply) {
          // Through recordOpeningSignal, never around it: precedence,
          // deduplication and the evidence rule all live there.
          await recordOpeningSignal(
            {
              firmId: source.firmId,
              cycleYear: window.cycleYear,
              programCategory: source.sectorCategory as FirmProgramCategory,
              source: "prediction",
              evidence: window.evidence,
              sourceUrl: source.careersUrl,
              opensStart: window.opensStart,
              opensEnd: window.opensEnd,
              observedAt: new Date(),
            },
            db,
          );
        }
      } catch (err) {
        rows.push({ ...base, outcome: "error", note: (err as Error).message.slice(0, 160) });
        console.log(`ERROR ${(err as Error).message.slice(0, 60)}`);
      }

      // Written after every firm, not at the end: see the header on why a
      // sweep this slow must survive being interrupted.
      writeDatasheet(rows);
    }

    const imminent = rows.filter(
      (r) => r.opensStart && windowUrgency({ opensStart: new Date(r.opensStart), opensEnd: new Date(r.opensEnd!) }, now).imminent,
    );

    console.log(
      `\n${rows.length} rows in the datasheet, ${rows.filter((r) => r.outcome === "window").length} with a usable window` +
        ` (${withWindow} derived this run).`,
    );
    console.log(`${imminent.length} are inside or approaching their window right now.`);
    for (const row of imminent.slice(0, 15)) {
      console.log(`  ${row.firmName.slice(0, 34).padEnd(34)} ${row.opensStart} to ${row.opensEnd}`);
    }
    console.log(`\nDatasheet: ${JSON_PATH}\n           ${CSV_PATH}`);
    if (!apply) {
      console.log("\nDry run - no opening_signals written. Re-run with --apply to store the windows.");
    }
    console.log(
      "\nThe crawler reads these from opening_signals, so --apply is what makes them act on\n" +
        "the schedule. See src/lib/monitoring/opening-window.ts.",
    );
  } finally {
    await opened.close();
  }
}

main();
