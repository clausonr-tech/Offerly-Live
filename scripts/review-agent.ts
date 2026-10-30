// Re-examine rejected listings by READING THE JOB PAGE AGAIN.
//
// WHY THIS EXISTS. Removing the review queue closed the only route from "the
// machine got this wrong" back to a student. The queue was a fiction -
// `reviewed_by` was NULL on all 21,716 rows, so nothing was ever released from
// it - but nothing replaced it either, and today recovering a wrongly rejected
// internship takes an engineer changing a rule.
//
// `adjudicate-rejections.ts` was the first attempt and it reads the STORED
// description. For the rejections that matter that is a stub of 80-116
// characters, so the model is asked to judge with almost nothing. This reads
// the live page instead, which is the missing input.
//
// THE MODEL NEVER DECIDES WHAT PUBLISHES. It supplies two facts, each with a
// quote copied verbatim from the page: the real description, and the programme
// year. Then `classifyListing` and `publishableWithoutReview` decide, exactly
// as they do on a first read. A release therefore happens only when the SAME
// rules that govern every other posting say yes, on better evidence - and a
// denial is safe by construction, because it can only keep a rejection that
// already exists.
//
// SHADOW MODE IS THE DEFAULT. Nothing is written without --apply. Its accuracy
// has never been measured, so the honest first use is to let it decide, record
// what it would have done, and hand-check a sample. That sample IS the
// calibration this whole plan is blocked on.
//
// WHAT IT WILL NOT DO
//  - It never touches a row with `reviewed_by` set. A person's verdict is not
//    a machine's to revisit.
//  - It never touches a listing whose `status` is not `open`. Resurrecting a
//    closed job is the one failure this system is least allowed, and 416 of
//    them had to be retracted on 12 October 2026.
//  - It never publishes directly. The most it writes is `auto_approved`, after
//    which `promote-approved-listings.ts` applies every one of its own gates.
//  - It respects robots and the SSRF guards, because it fetches through
//    `safeFetch` rather than reaching for the network itself.
//  - It marks every row it examines, so a continuously running worker cannot
//    spend on the same listing twice.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/review-agent.ts --limit 20
//   ... --apply            write the verdicts
//   ... --redo             re-examine rows already looked at
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";

import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";
import { safeFetch } from "../src/lib/monitoring/safe-fetch";
import { isAllowedByRobots } from "../src/lib/monitoring/robots";
import {
  readableText,
  renderPage,
  closeGenericConnectorBrowser,
} from "../src/lib/monitoring/connectors/generic";
import { pooledFetch } from "../src/lib/monitoring/fetch-pool";
import { isNamedRoleTitle, isPlaceholderTitle } from "../src/lib/role-title";
import { titleAppearsIn } from "../src/lib/monitoring/page-identity";
import {
  adjudicateListing,
  extractCycleWithLlm,
  looksPromising,
  ADJUDICATION_BODY_LIMIT,
} from "../src/lib/monitoring/llm-adjudicate";
import { classifyListing, publishableWithoutReview } from "../src/lib/monitoring/classify";
import { isPortfolioBoard } from "../src/lib/monitoring/portfolio-boards";

const APPLY = process.argv.includes("--apply");
/**
 * Record what it decided, but never release anything.
 *
 * THE CHICKEN AND EGG THIS SOLVES. The hand-check in
 * `review-agent-sample.ts` draws its sample from decisions the agent has
 * RECORDED, and shadow mode records nothing - so measuring the agent appeared
 * to require `--apply`, which can also release a listing, which is the one
 * thing nobody has measured yet. Circular.
 *
 * The two halves are separable because they are not equally risky. A DENIAL
 * writes a reason onto a row that is already `rejected`: nothing a student can
 * see changes, and the reason is what makes the row recoverable at all. A
 * RELEASE writes `auto_approved`, after which the promote step publishes. So
 * this mode writes the first and refuses the second, printing what it would
 * have released so the releases can be read before any of them happen.
 *
 * It is the right default for the first real pass over the queue: it populates
 * the hand-check, costs the model calls once rather than twice, and cannot put
 * anything in front of a student.
 */
const RECORD_ONLY = process.argv.includes("--record-only");
const WRITES = APPLY || RECORD_ONLY;
const REDO = process.argv.includes("--redo");
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
/**
 * Examine a NAMED set of listings, for a measurement rather than a sweep.
 *
 * `scripts/recall-sample.ts` draws a stratified sample and writes the ids to a
 * JSON file. Without a way to hand that file over, the sample could be drawn
 * and never labelled, which is where it sat.
 *
 * It INTERSECTS with the normal candidate query rather than replacing it, so
 * every gate still applies - still open, still machine-rejected, still not a
 * portfolio board, still bounded by MAX_SKIPS. The sample is drawn through
 * those same gates precisely so the intersection loses nothing: a first version
 * drew from the whole stratum and only 104 of 451 rows would have been
 * examined, which would have measured open listings while claiming to describe
 * all of them.
 *
 * Accepts either the sample file's shape (`{drawn: [{id}]}`) or a plain array
 * of ids, so a hand-written list works too.
 */
const IDS_FROM = arg("ids-from");
function idsFromFile(path: string): Set<string> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { drawn?: unknown }).drawn ?? []);
  if (!Array.isArray(list)) {
    throw new Error(`${path}: expected an array of ids, or {"drawn": [{"id": ...}]}`);
  }
  const ids = list.map((x) => (typeof x === "string" ? x : (x as { id?: string }).id)).filter(Boolean);
  if (ids.length === 0) throw new Error(`${path}: no ids in it`);
  return new Set(ids as string[]);
}
const WANTED_IDS = IDS_FROM ? idsFromFile(IDS_FROM) : null;

/** With a named set, the default is "all of them" rather than the sweep's 20. */
const LIMIT = Number(arg("limit") ?? (WANTED_IDS ? WANTED_IDS.size : 20));
/**
 * Examine one COHORT of rejections rather than whatever comes first.
 *
 * Matched against `reasonForUncertainty`, which is why that field being
 * written matters: the rejections worth re-reading are not spread evenly.
 * "recruiting-cycle" is the group where a page re-read most often supplies the
 * one missing fact; the title-phrase group is the biggest and least measured.
 * Unordered selection spends the budget on page furniture, which is correct to
 * deny and tells you nothing you did not know.
 */
const REASON = arg("reason");
/**
 * How many times a listing that could not be READ is tried again.
 *
 * Three, because the common cause is a board that renders with JavaScript and
 * that does not change between runs; a transient 503 or a slow page does.
 */
const MAX_SKIPS = 3;

/**
 * A page read is bounded - but generously, because a job posting is not a
 * small document any more.
 *
 * 400_000 was the first guess and it was wrong: a 200-listing run on
 * 12 October 2026 lost nine pages to `BodyTooLargeError`, among them every
 * D. A. Davidson and Seaport Global posting and D. E. Shaw's careers page.
 * Modern boards inline their fonts, styles and a serialised copy of the whole
 * page state, so two megabytes of HTML behind four kilobytes of job text is
 * ordinary. A read that aborts is a listing that cannot be re-examined, which
 * costs more than the bytes do.
 *
 * Still bounded: `safe-fetch` caps at MAX_BODY_BYTES regardless, and this sits
 * under it.
 */
const PAGE_BYTES = 4_000_000;
/**
 * How many listings are examined at once.
 *
 * Politeness is NOT this number's job - `pooledFetch` already holds a global
 * cap and a per-domain gap, which is why the flat 700ms sleep this replaced
 * was both slower and worse behaved: it waited between every listing even when
 * consecutive ones were on different hosts, and it did nothing at all to stop
 * two listings on the SAME host being read back to back.
 *
 * A CORRECTION TO WHAT THIS FILE USED TO SAY. The first version claimed "every
 * slot this agent holds is a slot the hourly crawl is waiting for". That is
 * false: `const shared = createFetchPool()` in fetch-pool.ts is MODULE-level,
 * and this agent runs as its own `tsx` process. Two processes have two pools.
 * The agent never takes the crawler's slots, and the refusal-to-run that was
 * built on that reasoning was protecting nothing.
 *
 * WHAT IS ACTUALLY SHARED, which is a shorter list and a real one:
 *
 *   - The BOARDS. Two processes reading the same host have no idea about each
 *     other, so each one's polite per-domain gap is only half of the rate the
 *     host actually sees. This is the one that matters, because a 429 the agent
 *     earns is inherited by the crawler as an inconclusive read, which pushes
 *     that source's `next_check_at` out toward a day.
 *   - The machine: two Chromium processes, and this one only launches on a GET
 *     that already failed.
 *   - The Supabase connection count and the Anthropic rate limit.
 *
 * So the agent runs whenever it likes and HALVES ITSELF while a crawl is in
 * flight, rather than refusing. One request at a time is the same rate a single
 * crawler worker uses, so the host sees at most two instead of thirteen.
 *
 * THE REAL FIX, not done here: per-host politeness that spans processes - a
 * shared record of the last request per host that both the crawl and this agent
 * read and write. That needs the crawler to participate, so it is its own
 * change; `backedOffHosts` and this halving are what hold until then.
 */
const CONCURRENCY_IDLE = Number(arg("concurrency") ?? 2);
const CONCURRENCY_WHILE_CRAWLING = 1;

/**
 * The most releases one run may make.
 *
 * A cap on blast radius, not on throughput. The agent has never been measured,
 * and the failure that matters is not one wrong release but a SYSTEMATIC one -
 * a prompt change or a rule change that makes it release a whole class of
 * listing. Twenty-five wrong postings is a bad afternoon; four thousand is the
 * zero-non-internships record gone, and that record is the one property this
 * system has never broken. Reached, the run stops examining.
 */
const MAX_RELEASES = Number(arg("max-releases") ?? 25);

/** Where the crawl keeps its own lock, so this can stay out of its way. */
const STATE_DIR = path.join(os.homedir(), "offerly-audit");
const CRAWL_LOCK = path.join(STATE_DIR, "crawl.lock");
const AGENT_LOCK = path.join(STATE_DIR, "review-agent.lock");
const IGNORE_LOCK = process.argv.includes("--ignore-lock");

/**
 * Below this many characters of readable text, a plain GET has told us nothing
 * and the browser is worth its cost.
 */
const THIN_PAGE_CHARS = 200;

/**
 * Hosts that have told us to back off, for the rest of this run.
 *
 * A 429 is the one answer that must change this agent's behaviour rather than
 * just its verdict. The crawler reads the same boards, and when one answers
 * 429 it records an inconclusive run and pushes `next_check_at` out, doubling
 * toward a day - so an agent that keeps knocking after a 429 does not just
 * fail its own read, it gets a healthy source demoted in the crawler's
 * schedule. One is enough to stop asking.
 */
const backedOffHosts = new Set<string>();

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

type Verdict =
  | { kind: "released"; why: string; quote: string | null; read: ReadVia }
  | { kind: "denied"; why: string; read: ReadVia }
  | { kind: "skipped"; why: string; read: ReadVia };

/** How the evidence was obtained - recorded because it changes how much the
 *  verdict is worth, and because "needed a browser" is a fact about the board
 *  worth counting across a run. */
/**
 * How the page was read, and - for a render - WHICH route rendered it.
 *
 * `render` and `render-escalated` both mean Chromium, and the distinction is
 * the only thing that makes the escalation measurable. A thin GET has always
 * fallen back to a render; the escalation added a second route, for a GET that
 * was long enough to accept but did not carry the posting. Both set the same
 * value until this split, so a `get -> render` flip proved nothing: either
 * route could have produced it and neither recorded which. That made the one
 * claim the change exists to support unfalsifiable, which a logic test of the
 * measurement caught before the measurement was run.
 */
type ReadVia = "none" | "get" | "render" | "render-escalated" | "title-only";

async function main() {
  /**
   * IT RUNS WHENEVER IT LIKES - just more slowly while a crawl is in flight.
   *
   * See CONCURRENCY_IDLE for why the earlier refusal was built on a mistake:
   * the fetch pool is per-process, so the agent was never competing for the
   * crawl's slots. What the two really share is the BOARDS, and the answer to
   * that is a lower request rate, not a closed door - the queue is supposed to
   * be clearable at any hour.
   *
   * `scheduled-crawl.sh` holds a mkdir lock, which is read here as a signal
   * rather than as a gate.
   */
  const crawlRunning = fs.existsSync(CRAWL_LOCK);
  const concurrency = crawlRunning ? CONCURRENCY_WHILE_CRAWLING : CONCURRENCY_IDLE;
  if (crawlRunning) {
    console.log(
      `A scheduled crawl is in flight, so this run reads one page at a time\n` +
        `(instead of ${CONCURRENCY_IDLE}) to keep the rate the boards see closer to one crawler's.\n`,
    );
  }

  // Not twice at once, though: two agents would double the rate with none of
  // the halving above, and neither would know about the other.
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    fs.mkdirSync(AGENT_LOCK);
  } catch {
    if (!IGNORE_LOCK) {
      console.log(`Another review agent is running (lock at ${AGENT_LOCK}).`);
      return;
    }
  }
  const releaseLock = () => {
    try {
      fs.rmdirSync(AGENT_LOCK);
    } catch {
      // Already gone, which is the state we wanted.
    }
  };
  process.on("exit", releaseLock);

  const { db, close: closeDb } = await openScriptDb();

  try {
    const rows = await db
      .select({
        id: schema.detectedListings.id,
        title: schema.detectedListings.title,
        division: schema.detectedListings.division,
        location: schema.detectedListings.location,
        descriptionRaw: schema.detectedListings.descriptionRaw,
        employmentType: schema.detectedListings.employmentType,
        listingUrl: schema.detectedListings.listingUrl,
        applicationUrl: schema.detectedListings.applicationUrl,
        externalJobId: schema.detectedListings.externalJobId,
        publishedAt: schema.detectedListings.publishedAt,
        deadlineAt: schema.detectedListings.deadlineAt,
        classification: schema.detectedListings.classification,
        sectorCategory: schema.firmMonitoringSources.sectorCategory,
        connectorId: schema.firmMonitoringSources.connectorId,
        firmName: schema.firms.name,
      })
      .from(schema.detectedListings)
      .innerJoin(
        schema.firmMonitoringSources,
        eq(schema.firmMonitoringSources.id, schema.detectedListings.sourceId),
      )
      .innerJoin(schema.firms, eq(schema.firms.id, schema.firmMonitoringSources.firmId))
      .where(
        and(
          eq(schema.detectedListings.reviewStatus, "rejected"),
          // A person's verdict is not a machine's to revisit.
          isNull(schema.detectedListings.reviewedBy),
          // Never resurrect a job that has closed.
          eq(schema.detectedListings.status, "open"),
          // An address to go and read is the whole premise.
          sql`${schema.detectedListings.listingUrl} ILIKE 'http%'`,
        ),
      );

    const candidates = rows.filter((r) => {
      const c = (r.classification ?? {}) as Record<string, unknown>;
      /**
       * Already examined, unless asked again - but a SKIP is not an answer.
       *
       * A skipped row was never judged: robots refused, the page would not
       * read, the quote could not be verified. Those are worth another try
       * later, and a decided row is not. Bounded at MAX_SKIPS so a page that
       * will never read cannot be paid for forever - the unbounded-retry bug
       * this codebase has now fixed twice.
       */
      const seen = c.reviewAgent as { verdict?: string; skips?: number } | undefined;
      if (!REDO && seen) {
        if (seen.verdict !== "skipped") return false;
        if ((seen.skips ?? 1) >= MAX_SKIPS) return false;
      }
      // A portfolio board's jobs are another company's whatever the page says.
      if (isPortfolioBoard(r.connectorId)) return false;
      // Narrowing to a named set - see IDS_FROM. Applied here, after the gates
      // above, so a named id cannot smuggle a listing past them.
      if (WANTED_IDS && !WANTED_IDS.has(r.id)) return false;
      if (REASON) {
        const reason = String(c.reasonForUncertainty ?? "");
        if (!reason.toLowerCase().includes(REASON.toLowerCase())) return false;
      }
      return true;
    });

    console.log(
      `${rows.length} open machine-rejected listings with an address; ${candidates.length} not yet examined` +
        `${REASON ? ` matching reason "${REASON}"` : ""}.`,
    );
    const batch = candidates.slice(0, LIMIT);
    if (batch.length === 0) {
      console.log("Nothing to examine.");
      return;
    }
    console.log(
      `Examining ${batch.length}${
        APPLY
          ? ""
          : RECORD_ONLY
            ? " in RECORD-ONLY mode - verdicts written, releases withheld"
            : " in SHADOW MODE - deciding, writing nothing"
      }.\n`,
    );

    /**
     * DEDUPED BEFORE ANYTHING IS SPENT.
     *
     * The first shadow run paid twice for "View internship programmes" and
     * four times for "Branch Intern" - the same vacancy carried by two sources
     * for one firm, or listed twice on one board. Identical title and address
     * means identical evidence, so it is one page read, one model call, and
     * one verdict written to every row in the group.
     *
     * Keyed on title plus address rather than on `external_job_id`, because
     * the duplicates that matter are precisely the ones whose ids differ.
     */
    const groups = new Map<string, typeof batch>();
    for (const row of batch) {
      const key = `${row.title.trim().toLowerCase()}|${(row.listingUrl ?? "").trim()}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    const duplicates = batch.length - groups.size;
    if (duplicates > 0) {
      console.log(`  (${duplicates} duplicate listing(s) folded into ${groups.size} examinations)\n`);
    }

    const decided: {
      id: string;
      firm: string;
      title: string;
      verdict: Verdict;
      wasReason: string | null;
      sharedWith: number;
    }[] = [];
    let released = 0;
    let denied = 0;
    let skipped = 0;
    const byRead = new Map<ReadVia, number>();

    /**
     * Examined a few at a time. `pooledFetch` owns politeness - the per-domain
     * gap and the global cap - so this number is only about how many model
     * calls are in flight.
     */
    const work = [...groups.values()];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= work.length) return;
        if (released >= MAX_RELEASES) {
          // Blast-radius cap reached - see MAX_RELEASES. Stop examining rather
          // than keep spending on listings that cannot be released anyway.
          return;
        }
        const group = work[i];
        const row = group[0];
        const was = ((row.classification ?? {}) as { reasonForUncertainty?: string })
          .reasonForUncertainty;

        const verdict = await examine(row);
        byRead.set(verdict.read, (byRead.get(verdict.read) ?? 0) + 1);

        const mark =
          verdict.kind === "released" ? "RELEASE" : verdict.kind === "denied" ? "deny   " : "skip   ";
        const dupe = group.length > 1 ? ` (x${group.length})` : "";
        console.log(`  ${mark} ${row.firmName}: ${row.title.slice(0, 50)}${dupe}`);
        console.log(`          [${verdict.read}] ${verdict.why}`);
        if (verdict.kind === "released" && verdict.quote) {
          console.log(`          "${verdict.quote.slice(0, 110)}"`);
        }

        if (verdict.kind === "released") released += group.length;
        else if (verdict.kind === "denied") denied += group.length;
        else skipped += group.length;

        for (const member of group) {
          decided.push({
            id: member.id,
            firm: member.firmName,
            title: member.title.slice(0, 60),
            verdict,
            wasReason: was ?? null,
            sharedWith: group.length - 1,
          });
          if (!WRITES) continue;

          const existing = (member.classification ?? {}) as Record<string, unknown>;
          await db
            .update(schema.detectedListings)
            .set({
              // `--record-only` writes the verdict and withholds the release.
              ...(verdict.kind === "released" && !RECORD_ONLY
                ? { reviewStatus: "auto_approved" as const }
                : {}),
              classification: {
                ...existing,
                // The evidence, where a person can audit it. Never replaces
                // what the classifier recorded.
                reviewAgent: {
                  at: new Date().toISOString(),
                  verdict: verdict.kind,
                  why: verdict.why,
                  read: verdict.read,
                  quote: verdict.kind === "released" ? verdict.quote : null,
                  // Counted so a page that will never read is given up on.
                  ...(verdict.kind === "skipped"
                    ? {
                        skips:
                          ((existing.reviewAgent as { skips?: number } | undefined)?.skips ?? 0) + 1,
                      }
                    : {}),
                },
                ...(verdict.kind === "denied" ? { reasonForUncertainty: verdict.why } : {}),
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.detectedListings.id, member.id),
                // Re-checked in SQL: an admin may have decided this row
                // between the read above and this write.
                isNull(schema.detectedListings.reviewedBy),
                eq(schema.detectedListings.status, "open"),
              ),
            );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));

    if (released >= MAX_RELEASES) {
      console.log(
        `\n!! stopped at the ${MAX_RELEASES}-release cap. ${work.length - next + 1} examination(s) not made.\n` +
          `   Raise it with --max-releases once the agent's accuracy has been measured.`,
      );
    }
    if (backedOffHosts.size > 0) {
      console.log(
        `\nbacked off from ${backedOffHosts.size} host(s) after a 429/503: ` +
          [...backedOffHosts].slice(0, 5).join(", "),
      );
    }

    console.log(
      `\nhow the evidence was read: ` +
        [...byRead].map(([k, n]) => `${k}=${n}`).join(", "),
    );
    console.log(`\n${released} released, ${denied} denied, ${skipped} skipped.`);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const out = path.join(process.cwd(), "scripts/data", `review-agent-${stamp}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        { at: new Date().toISOString(), applied: APPLY, recordOnly: RECORD_ONLY, decided },
        null,
        2,
      ),
    );
    console.log(`Decisions recorded to ${out}`);
    if (RECORD_ONLY) {
      console.log(
        `\nRECORD-ONLY: ${denied} denial(s) recorded with their reasons; ` +
          `${released} release(s) WITHHELD and listed above.\n` +
          "Draw the hand-check next:\n" +
          "  npx tsx --env-file=.env.local --conditions=react-server \\\n" +
          "    scripts/review-agent-sample.ts --draw 40",
      );
    } else if (!APPLY) {
      console.log(
        "\nSHADOW MODE: nothing was written. Use --record-only to write the verdicts\n" +
          "without releasing anything - that is what populates the hand-check.",
      );
    }
  } finally {
    // Chromium keeps the process alive otherwise - see
    // closeGenericConnectorBrowser.
    await closeGenericConnectorBrowser().catch(() => {});
    await closeDb();
    releaseLock();
  }
}

/**
 * Read the page again - with a browser if a GET will not do - then let the
 * DETERMINISTIC rules decide.
 *
 * The model's only outputs are a description it quoted from the page and a
 * year it quoted from the page. Everything after that is the same code path a
 * first read takes.
 */
async function examine(row: {
  title: string;
  division: string | null;
  location: string | null;
  descriptionRaw: string;
  employmentType: string | null;
  listingUrl: string | null;
  applicationUrl: string | null;
  externalJobId: string | null;
  publishedAt: Date | null;
  deadlineAt: Date | null;
  sectorCategory: string | null;
}): Promise<Verdict> {
  const url = row.listingUrl;
  if (!url) return { kind: "skipped", why: "no address to read", read: "none" };

  /**
   * THE FREE FILTERS FIRST. A fetch and a model call cost money; a title test
   * costs nothing.
   *
   * These are the shapes the first shadow run spent real requests on: "View
   * internship programmes" is a navigation link, "2. YOU HAVE A VISION, YOU
   * NEED A ROADMAP." is a page heading, "ecocoinc.com" is a stray anchor.
   * `isNamedRoleTitle` and `isPlaceholderTitle` are the same predicates the
   * student-facing gate already uses, so this agrees with what would happen
   * downstream rather than inventing a second opinion.
   */
  if (!isNamedRoleTitle(row.title)) {
    return { kind: "denied", why: "not a named role - page furniture, not a posting", read: "title-only" };
  }
  if (isPlaceholderTitle(row.title)) {
    return { kind: "denied", why: "a careers-site placeholder, not a specific opening", read: "title-only" };
  }

  if (!(await isAllowedByRobots(url))) {
    return { kind: "skipped", why: "robots disallows reading this page", read: "none" };
  }

  // Asked to back off earlier in this run - see backedOffHosts.
  if (backedOffHosts.has(hostOf(url))) {
    return { kind: "skipped", why: "host asked us to back off earlier in this run", read: "none" };
  }

  /**
   * A GET first, a browser only if it told us nothing.
   *
   * Both go through `pooledFetch`, which holds the per-domain gap and the
   * global concurrency cap - so this agent queues behind the crawler's own
   * politeness rules rather than inventing its own.
   */
  let text = "";
  let read: ReadVia = "none";
  try {
    text = await pooledFetch(url, async () => {
      const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: PAGE_BYTES });
      if (res.status === 429 || res.status === 503) {
        // Stop asking this host at all, not just for this listing.
        backedOffHosts.add(hostOf(url));
        return "";
      }
      if (!res.ok) return "";
      return readableText(await res.text());
    });
    if (text.trim().length >= THIN_PAGE_CHARS) read = "get";
  } catch {
    // Fall through to the browser: a GET that threw is exactly the case
    // `shouldEscalateToRender` exists for.
  }

  if (read === "none" && backedOffHosts.has(hostOf(url))) {
    // A 429 is not an invitation to try again with a browser.
    return { kind: "skipped", why: "host answered 429/503 - backing off", read: "none" };
  }

  /**
   * A 200 IS NOT THE POSTING.
   *
   * Escalation used to depend only on the GET being THIN - under
   * THIN_PAGE_CHARS. A client-rendered board defeats that completely: the
   * shell carries nav, a footer and a cookie banner, comfortably over the
   * threshold, and none of the job. So the GET was accepted and the checks
   * below judged a page that never contained the posting.
   *
   * Measured 13 October 2026 on the two real internships Kai found by hand in
   * a 318-row sample, both of which this agent had already examined and got
   * wrong:
   *
   *   Point72 "Academy Investment Analyst Program" - DENIED, read via get,
   *     "the page shows no student or internship language". The stored body
   *     from the crawl says "The Point72 Academy Summer Internship - Japan ...
   *     A current student who will". careers.point72.com renders its detail
   *     pages with script; the GET returned the frame.
   *   Jefferies "2027 Finance Controllers Analyst Programme" - SKIPPED, read
   *     via get, "the page no longer carries this posting". The posting is
   *     there; jefferies.tal.net serves it to a browser.
   *
   * Both failures were the same mistake, and both landed on the side that
   * loses a real internship. So a GET that does not carry the posting, or
   * carries it with no student language, is escalated rather than judged - and
   * the browser's text is only adopted if it is actually better, so a render
   * that comes back worse cannot make things worse.
   */
  if (read === "get") {
    const bodySoFar = text.slice(0, ADJUDICATION_BODY_LIMIT);
    const looksLikeAFrame =
      !titleAppearsIn(row.title, text) || !looksPromising(row.title, bodySoFar);
    if (looksLikeAFrame) {
      try {
        const rendered = await pooledFetch(url, async () =>
          readableText((await renderPage(url)).html),
        );
        const better =
          rendered.trim().length >= THIN_PAGE_CHARS &&
          titleAppearsIn(row.title, rendered) &&
          (looksPromising(row.title, rendered.slice(0, ADJUDICATION_BODY_LIMIT)) ||
            !titleAppearsIn(row.title, text));
        if (better) {
          text = rendered;
          read = "render-escalated";
        }
      } catch {
        // The browser could not do better either. Keep the GET text and let
        // the checks below reach their own conclusion on it.
      }
    }
  }

  if (read === "none") {
    try {
      text = await pooledFetch(url, async () => {
        const rendered = await renderPage(url);
        return readableText(rendered.html);
      });
      if (text.trim().length >= THIN_PAGE_CHARS) read = "render";
    } catch (err) {
      return {
        kind: "skipped",
        why: `page could not be read by GET or browser: ${err instanceof Error ? err.name : "unknown"}`,
        read: "none",
      };
    }
  }

  /**
   * UNREADABLE IS NOT A VERDICT.
   *
   * `decideClosure` keeps a listing when the fetch failed because there is "no
   * board to be absent from", and the render escalation exists because "we
   * could not name the failure is not evidence the page is unreachable". A
   * page that returned nothing says nothing about the job - so this skips, and
   * the skip is retried a bounded number of times.
   */
  if (read === "none") {
    return { kind: "skipped", why: "page carried no readable text, even rendered", read: "none" };
  }

  const body = text.slice(0, ADJUDICATION_BODY_LIMIT);

  /**
   * IS THIS EVEN THE POSTING?
   *
   * A listing URL that has since gone dead often redirects to the board index
   * or a generic "no longer available" page, and both read as perfectly good
   * text. Judging one of those judges the wrong document: a board index full
   * of other internships could get a listing RELEASED on somebody else's
   * words, and a takedown page could get a real internship denied.
   *
   * The cheap test is whether the posting's own title survived the trip. Two
   * distinctive words rather than the whole string, because boards reformat
   * titles - case, dashes, a location suffix, "(m/w/d)".
   */
  if (!titleAppearsIn(row.title, text)) {
    return {
      kind: "skipped",
      why: "the page no longer carries this posting - probably a board index or a takedown",
      read,
    };
  }

  if (!looksPromising(row.title, body)) {
    return { kind: "denied", why: "the page shows no student or internship language", read };
  }

  // 1. Is it an internship? Quote-verified, or discarded.
  const judged = await adjudicateListing({ title: row.title, descriptionRaw: body });
  if (judged.outcome === "not-internship") {
    return { kind: "denied", why: "re-read the page: it does not describe an internship", read };
  }
  if (judged.outcome !== "internship") {
    return { kind: "skipped", why: `adjudicator ${judged.outcome}`, read };
  }

  // 2. Re-run the REAL classifier on the fresh text. This, not the model, is
  //    what decides whether a student sees it.
  const listing = {
    externalJobId: row.externalJobId,
    title: row.title,
    division: row.division,
    location: row.location,
    descriptionRaw: body,
    employmentType: row.employmentType,
    applicationUrl: row.applicationUrl,
    // Non-null: the query selects only `listing_url ILIKE 'http%'` and `url`
    // is checked above, so this is the address that was just read.
    listingUrl: url,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
  };
  let fresh = classifyListing(listing, row.sectorCategory as Parameters<typeof classifyListing>[1]);

  if (!fresh.relevant) {
    return {
      kind: "denied",
      why: `re-read the page: still not relevant (${fresh.reasonForUncertainty ?? "no reason given"})`,
      read,
    };
  }

  // 3. Only a MISSING YEAR gets a second model call, and only to supply that
  //    one fact. The rule that reads it is unchanged.
  if (fresh.recruitingCycle === null) {
    const found = await extractCycleWithLlm({ title: row.title, descriptionRaw: body });
    if (found) {
      /**
       * RE-CLASSIFIED with the year, not patched after the fact.
       *
       * This used to spread the year onto the classification already returned -
       * and `needsHumanReview` is the negation of a conjunction that includes
       * having a year, so it stayed true and `publishableWithoutReview` stayed
       * false. The recovery could never complete. Measured on Egeria's
       * "Stagiair Private Equity June/July 2027": the model found 2027, quoted
       * the title it came from, and the listing still could not be released.
       *
       * Handing the year to `classifyListing` recomputes the whole conjunction
       * with it known - including the conditions the reason chain never
       * reached while the year was missing. The model supplies a fact; the
       * deterministic rule still decides.
       */
      fresh = classifyListing(
        listing,
        row.sectorCategory as Parameters<typeof classifyListing>[1],
        found.year,
      );
      if (publishableWithoutReview(fresh)) {
        return {
          kind: "released",
          why: `re-read the page: an internship, programme year ${found.year} read from its own words`,
          quote: found.quote,
          read,
        };
      }
    }
  }

  if (publishableWithoutReview(fresh)) {
    return {
      kind: "released",
      why: "re-read the page: the full description clears the same gate a first read uses",
      quote: judged.adjudication.quote,
      read,
    };
  }

  return {
    kind: "denied",
    why: `re-read the page: an internship, but still short of publishable (${
      fresh.reasonForUncertainty ?? "no programme year"
    })`,
    read,
  };
}


main();
