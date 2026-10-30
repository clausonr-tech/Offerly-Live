/**
 * Read archive history for a list of firms, with no database and no secrets.
 *
 * WHY THIS EXISTS SEPARATELY FROM opening-windows-sweep.ts
 * --------------------------------------------------------
 * That script is the real sweep: it chooses its targets by querying Supabase
 * through the enrolment rule, and writes its predictions back as
 * opening_signals rows. Both ends need DATABASE_URL.
 *
 * This one does the middle part only - careers URL in, predicted window out -
 * because `opening-history.ts` is pure. It takes a URL and returns
 * observations; it has never needed the database. So the list of firms can be
 * exported to a file by the sweep's own rules, the archive reading can happen
 * anywhere, and the results can be applied back home. A list of public
 * careers URLs is not a secret, which means this can run on a machine that
 * has no business holding the project's credentials.
 *
 * INCREMENTAL BY DESIGN. Every firm is appended to the output as it
 * completes, hits and misses alike. A previous archive run was killed at hour
 * ten and produced nothing at all, because its script wrote only on success -
 * so here a stopped run keeps everything it had read, and --resume skips it.
 *
 *   npx tsx --conditions=react-server scripts/wayback-remote.ts \
 *     --in scripts/data/wayback-targets.json \
 *     --out scripts/data/wayback-results.json --limit 200 --resume
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { gatherObservations, deriveWindow, cdxPaceMs } from "../src/lib/monitoring/opening-history";
import type { FirmProgramCategory } from "../src/lib/firm-metadata";

type Target = {
  sourceId: string;
  firmSlug: string;
  firmName: string;
  careersUrl: string;
  connectorId: string;
  sectorCategory: string | null;
};

type Result = Target & {
  outcome: "window" | "window-too-wide" | "insufficient-history" | "no-snapshots" | "error";
  cycleYear: number | null;
  opensStart: string | null;
  opensEnd: string | null;
  method: string;
  observations: { year: number; firstSeen: string; snapshotUrl: string; matched: string }[];
  error?: string;
  /** Set when the Archive itself could not be reached, so nothing was learned
   *  about this firm and the row must not be resumed past. See isUnreadable. */
  archiveUnreachable?: boolean;
};

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const IN = arg("in") ?? "scripts/data/wayback-targets.json";
const OUT = arg("out") ?? "scripts/data/wayback-results.json";
const LIMIT = Number(arg("limit") ?? Infinity);
const YEARS = Number(arg("years") ?? 5);
const RESUME = process.argv.includes("--resume");

function loadResults(): Result[] {
  if (!RESUME || !existsSync(OUT)) return [];
  try {
    return JSON.parse(readFileSync(OUT, "utf8")).results ?? [];
  } catch {
    // A file truncated by a kill mid-write is not worth failing over; the
    // firms in it will simply be read again.
    return [];
  }
}

/**
 * A row that must NOT count as read.
 *
 * `--resume` skips every sourceId already in the file, errors included, and
 * that is right for a firm whose own board failed - the header explains that
 * recording it is what stops it being retried on every future run forever.
 *
 * It is exactly wrong for a firm we never managed to ask. Nothing was learned
 * about it, so a row saying so is a placeholder, not a result, and leaving it
 * in the file would turn a temporary network block into a permanent gap in the
 * dataset - silently, because the run after it would report the firm as
 * already read.
 *
 * So these are dropped on load and re-queued. They are still WRITTEN, because
 * a run that is killed mid-batch must not lose its place, and because a file
 * full of them is the evidence that the network was the problem.
 */
const isUnreadable = (r: Result): boolean => r.outcome === "error" && r.archiveUnreachable === true;

async function main() {
  const targets: Target[] = JSON.parse(readFileSync(IN, "utf8")).targets;
  const loaded = loadResults();
  // Firms we never reached are re-queued, not resumed past - see isUnreadable.
  const results = loaded.filter((r) => !isUnreadable(r));
  const requeued = loaded.length - results.length;
  const done = new Set(results.map((r) => r.sourceId));
  const queue = targets.filter((t) => !done.has(t.sourceId)).slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`${targets.length} target(s); ${done.size} already read; ${queue.length} to read.`);
  if (requeued) {
    console.log(`${requeued} firm(s) the Archive could not be reached for are being read again.`);
  }
  console.log(`Reading ${YEARS} years of archive history each.\n`);

  const thisYear = new Date().getUTCFullYear();
  let windows = 0;
  let unreachable = 0;
  let consecutiveUnreachable = 0;

  /**
   * Stop asking a service that is refusing us.
   *
   * The run policy already states this - "If a batch is mostly
   * errors or timeouts, stop and report rather than continuing. The Internet
   * Archive is a nonprofit; being refused is a signal to back off, not to retry
   * harder" - and nothing in the script enforced it. A run against a blocked
   * network would work through all 4,479 firms at full pace, learning nothing
   * and asking 4,479 times.
   *
   * Consecutive, not total: one firm whose board 403s in the middle of a
   * healthy batch is an ordinary miss, and the counter resets on the next firm
   * the Archive answers for. Twenty in a row is the network, not the firms.
   */
  const UNREACHABLE_STREAK_LIMIT = 20;

  const flush = () =>
    writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: results.length, results }, null, 2));

  for (const [i, t] of queue.entries()) {
    process.stdout.write(`[${i + 1}/${queue.length}] ${t.firmName.slice(0, 40).padEnd(40)} `);
    const row: Result = {
      ...t,
      outcome: "no-snapshots",
      cycleYear: null,
      opensStart: null,
      opensEnd: null,
      method: "",
      observations: [],
    };
    try {
      const { observations, method, archiveReachable, archiveError } = await gatherObservations({
        careersUrl: t.careersUrl,
        sector: (t.sectorCategory as FirmProgramCategory) ?? undefined,
        fromYear: thisYear - YEARS,
        toYear: thisYear,
      });
      row.method = method;
      row.observations = observations.map((o) => ({
        year: o.year,
        firstSeen: o.firstSeen.toISOString().slice(0, 10),
        snapshotUrl: o.snapshotUrl,
        matched: o.matched,
      }));
      if (!observations.length && !archiveReachable) {
        /**
         * Nothing found because nothing was ASKED. Not a fact about this firm.
         *
         * Recorded as an error so --resume reads it again once the Archive is
         * reachable, rather than filing a confident "no history" that a later
         * run would skip forever.
         */
        row.outcome = "error";
        row.error = archiveError ?? "the Internet Archive could not be reached";
        row.archiveUnreachable = true;
        unreachable += 1;
        consecutiveUnreachable += 1;
        console.log(`ARCHIVE UNREACHABLE ${row.error.slice(0, 80)}`);
      } else if (!observations.length) {
        consecutiveUnreachable = 0;
        console.log("no usable snapshots");
      } else if (observations.length < 2) {
        consecutiveUnreachable = 0;
        row.outcome = "insufficient-history";
        console.log(`only ${observations.length} year(s) of history`);
      } else {
        consecutiveUnreachable = 0;
        const w = deriveWindow(observations);
        if (!w) {
          row.outcome = "window-too-wide";
          console.log(`${observations.length} years, window too wide`);
        } else {
          row.outcome = "window";
          row.cycleYear = w.cycleYear;
          row.opensStart = w.opensStart.toISOString().slice(0, 10);
          row.opensEnd = w.opensEnd.toISOString().slice(0, 10);
          windows += 1;
          console.log(`${row.opensStart} to ${row.opensEnd} (${observations.length} years)`);
        }
      }
    } catch (err) {
      // A firm that fails is recorded as having failed rather than dropped:
      // otherwise --resume reads it again on every future run forever.
      row.outcome = "error";
      row.error = (err as Error).message.slice(0, 120);
      console.log(`ERROR ${row.error}`);
    }
    results.push(row);
    // Written after EVERY firm. See the header - the cost of a kill must be
    // one firm, not the whole run.
    flush();

    if (consecutiveUnreachable >= UNREACHABLE_STREAK_LIMIT) {
      console.log(
        `\nSTOPPED: ${consecutiveUnreachable} firms in a row could not reach the Internet Archive.\n` +
          `Last error: ${row.error}\n` +
          `This is the network, not the firms - nothing was learned about them and they are\n` +
          `recorded as errors, so --resume will read them again once the Archive is reachable.\n` +
          `Check that web.archive.org is allowed from this host before re-running.`,
      );
      break;
    }
  }

  flush();
  console.log(`\n${windows} window(s) found in this batch; ${results.length} firm(s) read in total.`);
  if (unreachable) {
    console.log(
      `${unreachable} firm(s) could not reach the Archive and were recorded as errors, NOT as "no history".`,
    );
  }
  console.log(`Archive pace ended at ${Math.round(cdxPaceMs() / 1000)}s between index queries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
