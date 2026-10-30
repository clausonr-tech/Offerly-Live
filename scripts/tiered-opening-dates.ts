// Internship release dates for every actively-monitored firm, per industry.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/tiered-opening-dates.ts
//   ... --apply      write the windows as opening_signals (source "prediction")
//   ... --resume     keep rows already in the datasheet and skip those pairs
//   ... --tier X     only this monitoring tier (critical, high, standard, discovery)
//   ... --firm NAME  only firms whose name contains this
//   ... --years 5    how many years of archive history to read (default 5)
//   ... --limit N    stop after N firm x industry pairs
//   ... --boards F   read the board list from a JSON file instead of the
//                    database (see scripts/data/monitored-boards.json)
//
// Stop the dev server first - PGlite is single-writer.
//
// WHAT IT PRODUCES
// ----------------
// scripts/data/tiered-opening-dates.{json,csv}: one row per FIRM x INDUSTRY,
// carrying the date that industry's internships first appeared in each
// archived year, and the window derived from them.
//
// SCOPE: MONITORING TIER, NOT LEAGUE TABLE
// ----------------------------------------
// Every source at tier `discovery` or above - which is every tier except
// `inactive`, whose own definition is "no usable careers page or programme".
//
// Deliberately NOT the ibTier/peTier league tables. Those describe 93 firms
// and say how prestigious a firm is; the monitoring tier says whether we crawl
// it and how often, which is the thing a release date is meant to improve, and
// it spans every industry rather than the two that happen to have a ranking.
//
// A firm is asked once per INDUSTRY, deduplicated. Several programmes
// routinely share one: Goldman Sachs has 12 programme entries across 5
// industries, JPMorgan 12 across 5, Harris Williams 6 that are all investment
// banking. The Archive has one answer per industry however many programmes sit
// inside it, so mapping programmes straight to tasks would re-ask the same
// question 77 times across the seeded firms alone.
//
// A firm-level window would be wrong for most of those 33: Morgan Stanley's
// markets programme and its banking programme are not one event, and a window
// spanning both describes neither.
//
// WHAT THE ARCHIVE CAN AND CANNOT ANSWER
// --------------------------------------
// This is the honest limit, and it is not small. The Archive stores the HTML
// it was served. A board that renders its listings in JavaScript - Workday,
// Oracle HCM, Eightfold, Dayforce - is archived as an empty shell, so there is
// nothing in the capture to read and no date to derive. observed-openings.ts
// hit exactly this: six firms out of 108 yielded a usable date.
//
// The method here is weaker-but-wider than that one - it looks for internship
// LANGUAGE in the captured HTML rather than requiring the cycle year in a URL
// slug - so it should do better. It will still return nothing for most
// Workday firms, and that is a fact about the Archive rather than a bug here.
// Every such firm is written to the datasheet as `no-usable-history` so the
// gap is counted rather than silently absent.
//
// COST
// ----
// Each firm x industry x year costs a binary search of roughly six snapshot
// fetches. Measured Archive latency is 2.7s to 39s per request. 134 pairs
// across three years is a long run - hours, not minutes - which is why this
// writes after every pair and takes --resume.
import type { Db } from "../src/db/types";
import { openScriptDb } from "./_db";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import {
  fetchSnapshots,
  fetchJobUrlSnapshots,
  observationsFromJobUrls,
  atsApiUrl,
  findFirstInternshipSnapshot,
  type Snapshot,
  deriveWindow,
  type YearObservation,
} from "../src/lib/monitoring/opening-history";
import { recordOpeningSignal } from "../src/lib/opening-signals";
import { windowUrgency } from "../src/lib/monitoring/opening-window";
import type { FirmProgramCategory } from "../src/lib/firm-metadata";
import { FIRM_SEEDS } from "../src/lib/firm-content";

const JSON_PATH = "scripts/data/tiered-opening-dates.json";
const CSV_PATH = "scripts/data/tiered-opening-dates.csv";

const apply = process.argv.includes("--apply");
const resume = process.argv.includes("--resume");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const tierFilter = arg("tier") ?? null;

/**
 * Which monitoring tiers count as worth asking the Archive about.
 *
 * "discovery or above" - every tier except `inactive`, which by its own
 * definition has no usable careers page or programme, so there is nothing for
 * the Archive to have captured and nothing a window could change.
 *
 * Named rather than derived from sortOrder: the order column is a display
 * concern and a re-ordering should not silently change which firms get swept.
 */
const ACTIVE_TIERS = new Set(["critical", "high", "standard", "discovery"]);
const firmFilter = arg("firm")?.toLowerCase() ?? null;
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
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
/**
 * Read the board list from a file rather than the database.
 *
 * The sweep needs the database for exactly one thing - which boards to ask
 * about - and then spends hours talking to the Internet Archive. Tying those
 * together means a database that will not open blocks work that does not
 * actually need it, which is precisely the situation this was written in.
 *
 * With --boards the run is entirely offline of PGlite: it reads the list,
 * writes the datasheet, and skips --apply (storing a signal genuinely does
 * need the database). Regenerate the file after a restore so it does not
 * quietly describe an older set of sources than the crawler has.
 */
const boardsFile = arg("boards") ?? null;

type Row = {
  key: string; // firmSlug::industry - the resume key
  firmSlug: string;
  firmName: string;
  tier: string;
  industry: string;
  careersUrl: string;
  /** "window" | "insufficient-history" | "window-too-wide" | "no-usable-history" | "no-source" | "error" */
  outcome: string;
  cycleYear: number | null;
  opensStart: string | null;
  opensEnd: string | null;
  releaseDates: { year: number; firstSeen: string; snapshotUrl: string; matched: string }[];
  note: string;
  checkedAt: string;
};

/**
 * Rows already in the datasheet, and which of them count as answered.
 *
 * The distinction matters more than it looks. An `error` row is not a finding
 * - it is the Archive having refused us, usually a 503 from its rate limiter -
 * and treating it as done means `--resume` skips that firm FOREVER, quietly
 * writing "we could not reach the Archive once" into the permanent record.
 *
 * Measured 19 September on the critical tier: 22 of 23 pairs came back 503 in
 * a single burst. Under the old rule a resume would have skipped all 22 and
 * declared the sweep complete.
 *
 * So errors are dropped from both the skip set and the carried-over rows: the
 * pair is re-attempted and its row replaced. Real answers - a window, a span
 * too wide, no usable history - are kept, because those do not improve by
 * asking again.
 */
function loadExisting(): { rows: Row[]; answered: Set<string> } {
  if (!resume) return { rows: [], answered: new Set() };
  try {
    const parsed = JSON.parse(readFileSync(JSON_PATH, "utf8")) as { rows?: Row[] };
    const all = parsed.rows ?? [];
    const keep = all.filter((r) => r.outcome !== "error");
    const retrying = all.length - keep.length;
    if (retrying) {
      console.log(`${retrying} row(s) previously errored and will be re-attempted.`);
    }
    return { rows: keep, answered: new Set(keep.map((r) => r.key)) };
  } catch {
    return { rows: [], answered: new Set() };
  }
}

function write(rows: Row[]) {
  mkdirSync(dirname(JSON_PATH), { recursive: true });
  writeFileSync(
    JSON_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), years, count: rows.length, rows }, null, 1)}\n`,
  );

  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = [
    "firm",
    "tier",
    "industry",
    "outcome",
    "opens_start",
    "opens_end",
    "cycle_year",
    "years_observed",
    "release_dates",
    "evidence_urls",
    "note",
  ].join(",");
  const lines = rows
    .slice()
    .sort(
      (a, b) =>
        a.tier.localeCompare(b.tier) ||
        a.firmName.localeCompare(b.firmName) ||
        a.industry.localeCompare(b.industry),
    )
    .map((r) =>
      [
        esc(r.firmName),
        esc(r.tier),
        esc(r.industry),
        esc(r.outcome),
        r.opensStart ?? "",
        r.opensEnd ?? "",
        r.cycleYear ?? "",
        r.releaseDates.length,
        esc(r.releaseDates.map((d) => `${d.year}: ${d.firstSeen}`).join(" | ")),
        esc(r.releaseDates.map((d) => d.snapshotUrl).join(" | ")),
        esc(r.note),
      ].join(","),
    );
  writeFileSync(CSV_PATH, `${[header, ...lines].join("\n")}\n`);
}

type BoardRow = {
  slug: string;
  name: string;
  tier: string;
  careersUrl: string;
  connectorId: string;
  sectorCategory: string | null;
};

/** The board list as the rest of this script wants it, from either source. */
type SourceLike = {
  id: string;
  firmId: string;
  careersUrl: string;
  sectorCategory: string | null;
  firm: { slug: string; name: string } | null;
  tier: { name: string } | null;
};

function boardsFromFile(path: string): SourceLike[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { boards?: BoardRow[] };
  return (parsed.boards ?? []).map((b) => ({
    // No database, so no real ids. Only used as map keys here, and --apply is
    // refused in this mode precisely because a signal needs a real firmId.
    id: `file:${b.slug}`,
    firmId: `file:${b.slug}`,
    careersUrl: b.careersUrl,
    sectorCategory: b.sectorCategory,
    firm: { slug: b.slug, name: b.name },
    tier: { name: b.tier },
  }));
}

async function main() {
  if (boardsFile && apply) {
    console.error(
      "--apply needs the database: an opening signal is stored against a real firm id,\n" +
        "and --boards deliberately runs without opening PGlite. Run the dry sweep now and\n" +
        "apply from the datasheet once the database is back.",
    );
    process.exit(1);
  }

  let closeDb: (() => Promise<void>) | undefined;
  // Typed through the schema so drizzle's relational queries stay available -
  // a bare ReturnType<typeof drizzle> loses the schema and every `.query.x`
  // stops type-checking.
  let db: Db | undefined;
  let sources: SourceLike[];

  if (boardsFile) {
    sources = boardsFromFile(boardsFile);
    console.log(`Reading ${sources.length} boards from ${boardsFile} - no database opened.\n`);
  } else {
    ({ db, close: closeDb } = await openScriptDb());
    // `tier` as well as `firm`: the monitoring tier is what decides whether a
    // source is worth asking the Archive about at all.
    sources = (await db.query.firmMonitoringSources.findMany({
      with: { firm: true, tier: true },
    })) as unknown as SourceLike[];
  }

  try {
    // A firm can hold several sources; the industry-specific one is preferred
    // when it exists, because a board scoped to a division is better evidence
    // about that division than the firm-wide one.
    const sourcesBySlug = new Map<string, typeof sources>();
    for (const s of sources) {
      const slug = s.firm?.slug;
      if (!slug) continue;
      sourcesBySlug.set(slug, [...(sourcesBySlug.get(slug) ?? []), s]);
    }

    /**
     * Every firm monitored at `discovery` or above, not only the ones
     * carrying an investment-banking or private-equity tier.
     *
     * The IB/PE tiers describe 93 firms and say how prestigious a firm is.
     * The MONITORING tier says whether we crawl it and how often, which is the
     * thing a release date is supposed to improve - and it covers every
     * industry in the directory rather than the two that happen to have a
     * league table.
     */
    const seedBySlug = new Map(FIRM_SEEDS.map((f) => [f.slug, f]));
    const activeSources = sources.filter((s) => {
      const tier = s.tier?.name ?? "";
      if (!ACTIVE_TIERS.has(tier)) return false;
      if (tierFilter && tier !== tierFilter) return false;
      if (firmFilter && !(s.firm?.name ?? "").toLowerCase().includes(firmFilter)) return false;
      return true;
    });

    /**
     * One task per firm x INDUSTRY - deduplicated, which is not the same as
     * one task per programme.
     *
     * A firm seed lists programmes, and several programmes routinely share an
     * industry: Goldman Sachs has 12 programme entries across 5 industries,
     * JPMorgan 12 across 5, Harris Williams 6 that are all investment
     * banking. Mapping programmes straight to tasks gives 211 rows where
     * there are only 134 distinct questions - 77 duplicate Archive sweeps, at
     * roughly eighteen requests each, against an API that takes up to 39
     * seconds per call. Hours of work to recompute answers we already had.
     *
     * The archive lookup asks "when did an internship in THIS INDUSTRY first
     * appear on this firm's board", which has one answer per industry however
     * many programmes the firm runs inside it.
     */
    /**
     * The label used for a pass that asks about the firm rather than a desk.
     */
    const FIRM_WIDE = "(firm-wide)";

    const seen = new Set<string>();
    const tasks: {
      slug: string;
      name: string;
      /** What the row is FILED under - an industry, or FIRM_WIDE. */
      industry: string;
      /** What the search FILTERS by. Undefined means "any internship". */
      sector?: FirmProgramCategory;
      tier: string;
    }[] = [];
    for (const source of activeSources) {
      const slug = source.firm?.slug;
      if (!slug) continue;
      const seed = seedBySlug.get(slug);

      /**
       * The industries to ask about.
       *
       * From the firm's seeded programmes when it has them - that is the real
       * answer, and it is what makes a multi-industry firm get one window per
       * industry. A firm with no seed entry (most of the 22,580-row directory
       * is bulk-imported) falls back to the sector its SOURCE is registered
       * under, which is the only industry anything downstream would attribute
       * its listings to anyway.
       */
      const industries = seed?.programs?.length
        ? seed.programs.map((p) => p.category as FirmProgramCategory)
        : ([source.sectorCategory].filter(Boolean) as FirmProgramCategory[]);

      const distinct = [...new Set(industries)];
      const name = source.firm?.name ?? slug;
      const tier = source.tier?.name ?? "unknown";
      const add = (industry: string, sector?: FirmProgramCategory) => {
        const key = `${slug}::${industry}`;
        if (seen.has(key)) return;
        seen.add(key);
        tasks.push({ slug, name, industry, sector, tier });
      };

      /**
       * A firm's PRIMARY business is implicit in its own titles, and that
       * breaks a naive per-industry search.
       *
       * Measured 19 September on the critical tier. Morgan Stanley's
       * `sales_trading` and `asset_wealth_management` both found evidence and
       * its `investment_banking` found none - for Morgan Stanley. The reason
       * is that a firm names the desk only when it is not the obvious one:
       * "Sales and Trading Summer Analyst" says which desk, while the flagship
       * banking programme is just "2027 Summer Analyst Programme", which names
       * no industry at all. Filtering by industry therefore finds the SIDE
       * businesses and misses the main one, which is precisely backwards.
       *
       * So:
       *
       * - One industry: do not filter at all. Every internship a single-
       *   industry firm posts belongs to that industry, so the unfiltered
       *   answer IS the industry answer, and filtering only loses titles that
       *   were never going to name what the whole firm does.
       *
       * - Several: keep the filtered passes, which are genuinely more precise
       *   where a title does name a desk, and ADD an unfiltered pass filed
       *   under FIRM_WIDE. That row is not attributed to any one industry -
       *   claiming it for all of them would hand every desk the same date and
       *   make the split meaningless - but it is what the crawler actually
       *   needs, because monitor-run keys its windows by FIRM.
       */
      if (distinct.length <= 1) {
        add(distinct[0] ?? FIRM_WIDE, undefined);
      } else {
        for (const industry of distinct) add(industry, industry);
        add(FIRM_WIDE, undefined);
      }
    }

    const existing = loadExisting();
    const queue = tasks
      .filter((t) => !(resume && existing.answered.has(`${t.slug}::${t.industry}`)))
      .slice(0, limit === Infinity ? undefined : limit);

    console.log(
      `${activeSources.length} sources at tier discovery or above, ${tasks.length} firm x industry pairs.\n` +
        `${existing.answered.size} already answered; ${queue.length} to read; ${years} years each.\n` +
        `The Archive is slow (2.7s-39s per request, measured). Interrupt freely and re-run with --resume.\n`,
    );

    const rows: Row[] = [...existing.rows];
    const now = new Date();
    const thisYear = now.getUTCFullYear();

    /**
     * One Archive lookup per BOARD, not per firm x industry.
     *
     * The three CDX queries depend only on the board URL - the industry is a
     * filter applied to the RESULT - but they sat inside the per-task loop, so
     * a firm with five industries plus a firm-wide pass fetched the same index
     * six times. Goldman Sachs alone was eighteen identical requests where
     * three would do.
     *
     * That is wasteful on any day and fatal on a throttled one: it is the
     * Archive's rate limiter that decides whether this run finishes, and the
     * cheapest way to stay under it is to stop asking the same question.
     * Across 184 boards and 284 lookups this removes roughly 60% of the
     * traffic.
     *
     * A failure is cached too, deliberately. If the index refused us for this
     * board, asking again five more times in the next five seconds will not
     * change its mind - it will just spend the rate limit confirming it.
     */
    type BoardIndex = { jobUrls: Snapshot[] | null; pages: Snapshot[] | null; api: Snapshot[] | null };
    const boardCache = new Map<string, BoardIndex>();
    const boardIndex = (url: string): BoardIndex => {
      let entry = boardCache.get(url);
      if (!entry) {
        entry = { jobUrls: null, pages: null, api: null };
        boardCache.set(url, entry);
      }
      return entry;
    };

    /**
     * Stop when the Archive is plainly refusing everything.
     *
     * A throttled run does not fail fast - each lookup burns its retries first,
     * so grinding through 284 of them takes many hours to learn one fact we
     * knew after five. Better to say so and let the run be resumed later; the
     * datasheet is written after every pair, so nothing is lost.
     */
    let consecutiveRefusals = 0;
    const REFUSAL_LIMIT = 6;

    for (const [i, task] of queue.entries()) {
      const label = `${task.name} / ${task.industry}`;
      process.stdout.write(`[${i + 1}/${queue.length}] ${label.slice(0, 52).padEnd(52)} `);

      const firmSources = sourcesBySlug.get(task.slug) ?? [];
      // Prefer a source registered under this very industry; fall back to any.
      const source =
        firmSources.find((s) => s.sectorCategory === task.industry) ?? firmSources[0];

      const base: Row = {
        key: `${task.slug}::${task.industry}`,
        firmSlug: task.slug,
        firmName: task.name,
        tier: task.tier,
        industry: task.industry,
        careersUrl: source?.careersUrl ?? "",
        outcome: "error",
        cycleYear: null,
        opensStart: null,
        opensEnd: null,
        releaseDates: [],
        note: "",
        checkedAt: new Date().toISOString(),
      };

      if (!source) {
        // Tiered but not monitored - there is no careers URL to ask the
        // Archive about. Recorded rather than skipped: it is a coverage gap,
        // and an uncounted gap is the thing this project keeps having to
        // rediscover.
        rows.push({ ...base, outcome: "no-source", note: "firm has no monitored source to look up" });
        console.log("no monitored source");
        write(rows);
        continue;
      }

      try {
        /**
         * The URL index first, the page contents second.
         *
         * Prefix search is one CDX request and reads the Archive's index of
         * URLs BENEATH the board. It costs a fraction of the content search
         * (one request against roughly eighteen snapshot fetches) and it works
         * on the boards the content search cannot read at all - a Workday or
         * Oracle page is archived as an empty JavaScript shell, but its job
         * URLs are still indexed and routinely name the role.
         *
         * Falling back rather than choosing: a board with opaque numeric job
         * URLs gives the index nothing to read, and there the archived page
         * content is the only evidence there is. Neither method dominates, so
         * the cheap one runs first and the expensive one covers what it
         * missed.
         */
        let method = "url-index";
        let observations: YearObservation[] = [];
        try {
          const cache = boardIndex(source.careersUrl);
          if (cache.jobUrls === null) {
            cache.jobUrls = await fetchJobUrlSnapshots(source.careersUrl, thisYear - years);
          }
          observations = observationsFromJobUrls(cache.jobUrls, task.sector);
        } catch {
          // A prefix query that fails is not a firm without history - fall
          // through to the page search rather than recording a miss.
          observations = [];
        }

        /**
         * The vendor's API endpoint - the cheapest long shot of the three.
         *
         * One request, and an archived API reply is JSON, which does not care
         * whether the board renders in JavaScript. Lower hit rate than either
         * other method because crawlers visit human pages rather than APIs, so
         * it runs only when the index came up short.
         */
        const apiUrl = atsApiUrl(source.careersUrl);
        if (observations.length < 2 && apiUrl) {
          try {
            const cache = boardIndex(source.careersUrl);
            if (cache.api === null) cache.api = await fetchSnapshots(apiUrl, thisYear - years);
            const apiSnaps = cache.api;
            const fromApi: YearObservation[] = [];
            for (let y = thisYear - years; y <= thisYear; y++) {
              const found = await findFirstInternshipSnapshot(apiSnaps, y, task.sector);
              if (found) fromApi.push(found);
            }
            const known = new Set(observations.map((o) => o.year));
            const added = fromApi.filter((o) => !known.has(o.year));
            if (added.length) {
              method = observations.length ? `${method}+api` : "api";
              observations = [...observations, ...added].sort((a, b) => a.year - b.year);
            }
          } catch {
            // A long shot that misses is not a finding.
          }
        }

        let snapshots: Awaited<ReturnType<typeof fetchSnapshots>> = [];
        if (observations.length < 2) {
          method = observations.length ? `${method}+pages` : "pages";
          const cache = boardIndex(source.careersUrl);
          if (cache.pages === null) {
            cache.pages = await fetchSnapshots(source.careersUrl, thisYear - years);
          }
          snapshots = cache.pages;
          const fromPages: YearObservation[] = [];
          for (let y = thisYear - years; y <= thisYear; y++) {
            const found = await findFirstInternshipSnapshot(snapshots, y, task.sector);
            if (found) fromPages.push(found);
          }
          // A year the index already dated is not re-dated by the pages: the
          // index saw an actual job URL, which is the stronger of the two.
          const haveYears = new Set(observations.map((o) => o.year));
          observations = [...observations, ...fromPages.filter((o) => !haveYears.has(o.year))].sort(
            (a, b) => a.year - b.year,
          );
        }

        base.releaseDates = observations.map((o) => ({
          year: o.year,
          firstSeen: o.firstSeen.toISOString().slice(0, 10),
          snapshotUrl: o.snapshotUrl,
          matched: o.matched,
        }));

        if (observations.length === 0) {
          rows.push({
            ...base,
            outcome: "no-usable-history",
            note:
              snapshots.length === 0
                ? "the Archive holds no captures of this URL, and no job URLs indexed beneath it"
                : "captures exist but neither the indexed job URLs nor the archived pages name an internship for this industry - typically a JavaScript board whose job URLs are opaque ids",
          });
          console.log(snapshots.length === 0 ? "no snapshots" : "no readable listings");
          write(rows);
          continue;
        }

        const window = deriveWindow(observations, now);
        if (!window) {
          rows.push({
            ...base,
            outcome: observations.length < 2 ? "insufficient-history" : "window-too-wide",
            note:
              observations.length < 2
                ? `only ${observations.length} year(s) of evidence - one is an anecdote`
                : "the observed dates span more than 75 days, too wide to act on",
          });
          console.log(`${observations.length} year(s), no window`);
          write(rows);
          continue;
        }

        const urgency = windowUrgency(window, now);
        rows.push({
          ...base,
          outcome: "window",
          cycleYear: window.cycleYear,
          opensStart: window.opensStart.toISOString().slice(0, 10),
          opensEnd: window.opensEnd.toISOString().slice(0, 10),
          note: `${urgency.reason} [via ${method}]`,
        });
        console.log(
          `${base.releaseDates.map((d) => d.firstSeen).join(", ")}  ->  ` +
            `${window.opensStart.toISOString().slice(0, 10)} to ${window.opensEnd.toISOString().slice(0, 10)}` +
            `${urgency.imminent ? "  <-- IMMINENT" : ""}`,
        );

        if (apply) {
          /**
           * The INDUSTRY, not the source's registered sector - that is the
           * whole point of doing this per industry.
           *
           * Null for the firm-wide pass, which the schema already defines as
           * "the firm generally". Attributing an unfiltered window to one
           * industry would be claiming something the evidence does not say.
           */
          await recordOpeningSignal(
            {
              firmId: source.firmId,
              cycleYear: window.cycleYear,
              programCategory:
                task.industry === FIRM_WIDE ? null : (task.industry as FirmProgramCategory),
              source: "prediction",
              evidence: window.evidence,
              sourceUrl: source.careersUrl,
              opensStart: window.opensStart,
              opensEnd: window.opensEnd,
              observedAt: new Date(),
            },
            db!,
          );
        }
        consecutiveRefusals = 0;
      } catch (err) {
        const message = (err as Error).message;
        rows.push({ ...base, outcome: "error", note: message.slice(0, 160) });
        console.log(`ERROR ${message.slice(0, 50)}`);

        // Only a refusal counts. A single board that 404s is not the Archive
        // telling us to stop.
        if (/HTTP (429|50\d)/.test(message)) consecutiveRefusals += 1;
        else consecutiveRefusals = 0;

        if (consecutiveRefusals >= REFUSAL_LIMIT) {
          write(rows);
          console.log(
            `\nSTOPPING: ${consecutiveRefusals} boards in a row were refused by the Archive.\n` +
              `That is its rate limiter, not your board list - grinding through the rest would\n` +
              `take hours to learn the same thing. Everything answered so far is saved.\n\n` +
              `Wait an hour or so, then re-run the same command with --resume.`,
          );
          break;
        }
      }

      write(rows);
    }

    const tally = rows.reduce<Record<string, number>>((a, r) => {
      a[r.outcome] = (a[r.outcome] ?? 0) + 1;
      return a;
    }, {});
    console.log(`\n${rows.length} firm x industry rows:`);
    for (const [outcome, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${outcome.padEnd(22)} ${n}`);
    }

    const withWindow = rows.filter((r) => r.outcome === "window");
    console.log(`\nRelease windows by industry:`);
    const byIndustry = withWindow.reduce<Record<string, number>>((a, r) => {
      a[r.industry] = (a[r.industry] ?? 0) + 1;
      return a;
    }, {});
    for (const [industry, n] of Object.entries(byIndustry).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${industry.padEnd(24)} ${n}`);
    }

    console.log(`\nDatasheet: ${JSON_PATH}\n           ${CSV_PATH}`);
    console.log(
      "\nEvery date above is a LATE BOUND: the Archive captures a page when somebody visits it,\n" +
        "so a posting was live on or BEFORE the date shown, never after. Read the windows as\n" +
        "'be watching by', not as a published release schedule.",
    );
    if (!apply) console.log("\nDry run - re-run with --apply to store these as opening signals.");
  } finally {
    await closeDb?.();
  }
}

main();
