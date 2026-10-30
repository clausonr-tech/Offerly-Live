import "server-only";
import { safeFetch } from "./safe-fetch";
import { TITLE_INTERNSHIP_PATTERN, sectorForText } from "./classify";
import type { FirmProgramCategory } from "@/lib/firm-metadata";
import { extractToken as greenhouseToken } from "./connectors/greenhouse";
import { parseLeverUrl } from "./connectors/lever";
import { parseAshbyOrg } from "./connectors/ashby";
import { parseWorkableAccount } from "./connectors/workable";
import { parseSmartRecruitersCompany } from "./connectors/smartrecruiters";
import { parseRecruiteeAccount } from "./connectors/recruitee";
import { parseBambooBoard } from "./connectors/bamboohr";
import { parseBreezyAccount } from "./connectors/breezy";

/**
 * When did this firm's careers page last carry internship postings?
 *
 * WHY HISTORY AND NOT A CRAWL
 * ---------------------------
 * The crawler can tell you a firm has no internship posted today. It cannot
 * tell you whether that means "never does" or "opens in three weeks", and that
 * difference is the whole question a student is asking. The announcement
 * watcher was built to answer it by diffing page text between checks, and it
 * has produced nothing: 42 opening_signals rows exist and all 42 are
 * `seen_live`, none `firm_announcement`.
 *
 * Measured 19 Sep, and not for the reason first assumed. It is not that the
 * watcher never got a second crawl to diff against - 23 of the 106 sources
 * have been checked twice or more. It ran and found nothing, which means
 * either those pages did not change in an announcement-shaped way, or the
 * detector is too strict. Worth knowing before trusting it as the timing
 * layer.
 *
 * The Internet Archive already holds those two crawls. Several years of them.
 * So instead of waiting to observe an opening, read when openings happened
 * before: if a firm's careers page carried "2026 Summer Analyst" from mid
 * September 2024 and mid September 2025, mid September is when it opens.
 *
 * This uses the CDX API, which the Archive documents for programmatic use.
 *
 * WHAT IT IS ALLOWED TO CLAIM
 * ---------------------------
 * A window, never a date, and only with at least two years of evidence behind
 * it. Both rules come from this project's own standards:
 *
 * - "Vague stays vague". Two observations a week apart support "opens in
 *   mid-September", not "opens on the 15th". Collapsing them to a mean invents
 *   a precision the archive never had.
 * - "Every claim quotes its evidence". Each window carries the dated snapshot
 *   URLs it was derived from, so a reviewer can open the actual page as it
 *   stood and disagree.
 *
 * And it writes as `source: "prediction"`, which ranks LAST in the precedence
 * list in opening-signals.ts. A firm's own announcement, a live sighting, or
 * even a student's report all beat it. That is deliberate: this is the weakest
 * kind of evidence and should lose to anything real.
 */

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
const USER_AGENT =
  "OfferlyMonitor/1.0 (internship listing monitor; contact via site) " +
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
/**
 * The Archive is slow, and slow by wildly varying amounts.
 *
 * Measured 19 Sep across a 22-firm sample: the same shape of CDX query
 * returned in 2.7s for one firm and 39.3s for another, and three of the 22
 * errored outright. A 45s timeout looked generous and still aborted a real
 * query. So: a long ceiling, and retries, because a timeout here is almost
 * always the Archive being slow rather than the URL having no history.
 */
const TIMEOUT_MS = 75000;

/**
 * The Archive rate-limits the CDX index hard, and says so with a 503.
 *
 * Measured 19 September against the critical tier: of 23 index queries fired
 * back to back, ONE succeeded and the rest returned 503. Not a outage - the
 * one that got through returned a normal answer. The index is simply a
 * shared service that refuses a client asking faster than it likes, and a
 * sweep that treats 503 as "this firm has no history" would write that
 * conclusion into the datasheet for the entire directory.
 *
 * So: a gap between index queries, and a retry schedule long enough to
 * outlast a rate-limit window rather than three tries inside one.
 */
/**
 * Three, not five.
 *
 * Retrying is for a blip. When the Archive is throttling, every extra attempt
 * is 10, 20, 40 and 80 seconds spent confirming the same refusal - one board
 * took NINE MINUTES to fail, which is how a 284-lookup sweep became a
 * 40-hour one. Three attempts cover a genuine hiccup and cost about 30
 * seconds; sustained refusal is the sweep's circuit breaker to notice, not
 * this loop's.
 */
const CDX_ATTEMPTS = 3;
const RETRY_GAP_MS = 10000;

/**
 * Minimum spacing between CDX index requests, across the whole process.
 *
 * GAP_MS below spaces the snapshot fetches WITHIN one firm's boundary search.
 * Nothing spaced the index queries BETWEEN firms, so a sweep fired one per
 * firm as fast as the loop could go - which is what produced 22 consecutive
 * 503s. Enforced here rather than in the sweep scripts because every caller
 * shares the same rate limit and none of them should have to remember.
 */
const CDX_GAP_MS = 5000;
/**
 * The ceiling the gap may widen to while the Archive is refusing us.
 *
 * A minute between index queries is slow, and it is still enormously faster
 * than the alternative measured on 22 September: at a FIXED five-second gap,
 * a throttled sweep managed 13 firms in 1h57m - about nine minutes each,
 * against 2.7s to 39s when the Archive is answering. Almost all of that was
 * spent on 503s and the retry ladder behind them. Asking less often and being
 * answered beats asking constantly and being refused.
 */
const CDX_GAP_MAX_MS = 60000;

/**
 * How fast we are currently allowed to ask, found rather than assumed.
 *
 * The fixed gap above was the whole problem. It is a guess at someone else's
 * rate limit, and when that guess is wrong the client has no way to discover
 * it: every refusal is followed by another request at exactly the same pace,
 * so a throttled sweep stays throttled until a human notices. The Archive
 * never publishes the limit, and it plainly varies with how busy the service
 * is, so the only reliable way to know it is to be told - by being refused -
 * and to respond.
 *
 * Widen hard on refusal, narrow gently on success: the cost of being slightly
 * too slow is a longer sweep, and the cost of being too fast is a sweep that
 * makes no progress at all AND deepens the block. Those are not symmetric,
 * so neither is the adjustment.
 */
let cdxGapMs = CDX_GAP_MS;
let cdxStreak = 0;

/** The Archive refused us; ask less often. `retryAfterMs` is its own answer
 *  to how long to wait, which beats any multiplier we would pick. */
function cdxRefused(retryAfterMs = 0): void {
  cdxStreak = 0;
  cdxGapMs = Math.min(CDX_GAP_MAX_MS, Math.max(Math.round(cdxGapMs * 1.5), retryAfterMs));
}

/** It answered. Creep back toward the floor, but only after a run of
 *  successes - one answer during a throttle is not the throttle lifting. */
function cdxAccepted(): void {
  cdxStreak += 1;
  if (cdxStreak >= 5 && cdxGapMs > CDX_GAP_MS) {
    cdxGapMs = Math.max(CDX_GAP_MS, Math.round(cdxGapMs * 0.8));
    cdxStreak = 0;
  }
}

/** The pace in use, for a sweep that wants to report why it is slow. */
export function cdxPaceMs(): number {
  return cdxGapMs;
}

/**
 * Test seams. The pacing rule decides how hard this code leans on somebody
 * else's public service, so it is worth pinning directly rather than inferring
 * from a sweep's wall-clock - which is exactly how the fixed gap went wrong
 * unnoticed for so long.
 */
export function __setCdxPaceForTests(ms: number): void {
  cdxGapMs = ms;
  cdxStreak = 0;
}
export function __cdxRefusedForTests(retryAfterMs = 0): void {
  cdxRefused(retryAfterMs);
}
export function __cdxAcceptedForTests(): void {
  cdxAccepted();
}
/** Politeness gap. Every request here hits one host, so this is the whole
 *  rate limit rather than a per-domain one. */
const GAP_MS = 1200;
/**
 * Snapshot fetches per year per firm.
 *
 * Two go on the year's endpoints - the last capture, to confirm there is a
 * boundary at all, and the first, to confirm it is not before our window -
 * and the rest bisect between them. A year of weekly captures needs about six
 * to land the boundary, so nine leaves room without letting one firm's history
 * cost a hundred requests.
 */
const MAX_PROBES_PER_YEAR = 9;

export type Snapshot = { timestamp: string; original: string; digest: string };

export type YearObservation = {
  year: number;
  /** First snapshot in that year whose text carried internship language. */
  firstSeen: Date;
  /** The archive URL, so the claim can be checked by opening it. */
  snapshotUrl: string;
  /** The matched phrase, for the evidence string. */
  matched: string;
};

export type OpeningWindow = {
  /** The cycle this window is about, by the convention below. */
  cycleYear: number;
  opensStart: Date;
  opensEnd: Date;
  observations: YearObservation[];
  evidence: string;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One queue for every CDX request this process makes.
 *
 * A promise chain rather than a timestamp check, so concurrent callers queue
 * behind each other instead of all observing "the last request was long ago"
 * at the same moment and firing together.
 */
let cdxTurn: Promise<void> = Promise.resolve();
function nextCdxSlot(): Promise<void> {
  // Read at the moment the turn comes up, not when it was queued: a refusal
  // in between must slow the requests already waiting behind it, which is the
  // whole point of a shared queue.
  const mine = cdxTurn.then(() => sleep(cdxGapMs));
  cdxTurn = mine;
  return mine;
}

/** `20250918143000` -> Date. CDX timestamps are UTC, 14 digits. */
export function parseCdxTimestamp(ts: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m.map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(d.getTime())) return null;

  /**
   * Reject components that ROLLED OVER rather than failing.
   *
   * `Date.UTC` does not validate: month 13 becomes January of the next year,
   * day 32 becomes the 1st of the next month, hour 25 becomes tomorrow. None
   * of those is NaN, so the check above waved them through and this function
   * returned a confident date up to a YEAR away from what it was given -
   * while its own contract, and its own test, say "null, not a wrong date".
   *
   * It matters beyond tidiness: this date becomes an observation's firstSeen,
   * which becomes a window, which becomes the day the crawler starts watching
   * a firm. A silent twelve-month error there is indistinguishable from a
   * correct answer. Found by opening-history-search.test.ts.
   */
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute ||
    d.getUTCSeconds() !== second
  ) {
    return null;
  }
  return d;
}

/**
 * Which recruiting cycle a posting seen at this date is about.
 *
 * Deliberately the same convention as `defaultCycleForAnnouncement` in
 * monitor-run.ts - April onward is two cycles ahead, before that one - because
 * finance recruits roughly 18 months out and a posting appearing in the autumn
 * of Y is for the summer of Y+2. Duplicating the rule with a different answer
 * would be worse than duplicating it at all.
 */
export function cycleYearForDate(d: Date): number {
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() + 2 : d.getUTCFullYear() + 1;
}

/**
 * Every archived capture of a URL, newest last.
 *
 * `collapse=digest` drops consecutive captures whose content is byte-identical,
 * which is most of them - a careers page that did not change does not need
 * fetching to tell us nothing changed.
 */
export async function fetchSnapshots(
  url: string,
  fromYear: number,
): Promise<Snapshot[]> {
  return cdxQuery({
    url,
    from: fromYear,
    collapse: "digest",
  });
}

/**
 * Every archived URL BENEATH a board, with its first capture.
 *
 * The other half of this file reads archived page CONTENT, and that is why it
 * is blind to half the directory: a Workday, Oracle or Eightfold board is a
 * JavaScript application, so the Archive holds an empty shell and there is
 * nothing in the capture to read. No amount of parsing fixes a page that has
 * no listings in it.
 *
 * The URL INDEX has no such problem. `matchType=prefix` returns every URL the
 * Archive holds under a board, job pages included, whether or not their
 * contents were ever rendered. And a job URL routinely names the role in its
 * own slug - Baird writes
 * `/jobs/r20261002/internship-marketing-year-round/`, Raymond James writes
 * `XMLNAME-2026-Summer-Internship-Program-Finance` on a WORKDAY board. That
 * last one matters: observed-openings.ts got its six dates this way, and every
 * one came from a board the content method cannot read.
 *
 * `collapse=urlkey` returns one row per URL, which CDX orders by urlkey then
 * timestamp - so the row kept is that URL's FIRST capture, which is the date
 * we want.
 *
 * One request per board instead of the eighteen-odd snapshot fetches a content
 * search costs, so this is cheaper as well as wider.
 */
export async function fetchJobUrlSnapshots(
  boardUrl: string,
  fromYear: number,
  limit = 2000,
): Promise<Snapshot[]> {
  return cdxQuery({
    url: boardUrl,
    from: fromYear,
    collapse: "urlkey",
    matchType: "prefix",
    limit,
  });
}

/** The retry, parse and empty-body handling every CDX call needs. */
async function cdxQuery(options: {
  url: string;
  from: number;
  collapse: string;
  matchType?: string;
  limit?: number;
}): Promise<Snapshot[]> {
  const q = new URL(CDX_ENDPOINT);
  q.searchParams.set("url", options.url);
  q.searchParams.set("output", "json");
  q.searchParams.set("fl", "timestamp,original,digest");
  q.searchParams.set("filter", "statuscode:200");
  q.searchParams.set("collapse", options.collapse);
  q.searchParams.set("from", String(options.from));
  if (options.matchType) q.searchParams.set("matchType", options.matchType);
  // A prefix search over a large board can return tens of thousands of rows.
  // Capped rather than streamed: this is a backfill, not a mirror.
  if (options.limit) q.searchParams.set("limit", String(options.limit));

  let lastError = "";
  let retryAfterMs = 0;
  for (let attempt = 1; attempt <= CDX_ATTEMPTS; attempt++) {
    await nextCdxSlot();
    try {
      const res = await safeFetch(q.toString(), {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        timeoutMs: TIMEOUT_MS,
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // The server's own answer to "how long should I wait" beats our guess.
        const retryAfter = Number(res.headers.get("retry-after"));
        retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
        // Being refused is the only signal the Archive gives about its rate
        // limit, so it has to change the pace rather than just this attempt.
        if (res.status >= 500 || res.status === 429) cdxRefused(retryAfterMs);
        // A 4xx will not improve on retry; a 5xx or 429 might.
        if (res.status < 500 && res.status !== 429) break;
      } else {
        cdxAccepted();
        const text = await res.text();
        // An empty body means "no captures", which is a real answer and not an
        // error. JSON.parse would throw on it and look like a failure.
        if (text.trim() === "") return [];
        const body = JSON.parse(text) as string[][];
        // First row is the header when output=json.
        return body
          .slice(1)
          .map(([timestamp, original, digest]) => ({ timestamp, original, digest }))
          .filter((s) => s.timestamp && s.original);
      }
    } catch (err) {
      lastError = (err as Error).message.slice(0, 80);
      // A request that hangs until the timeout is the same signal as a 503 -
      // measured on 22 September, a throttled CDX answered some queries with
      // 503 in 5s and simply never answered others. Treating only the explicit
      // refusal as a refusal would leave half the evidence on the floor.
      cdxRefused();
    }
    if (attempt < CDX_ATTEMPTS) {
      // Exponential, not linear: a rate-limit window outlasts 2s and 4s, and
      // retrying inside it spends attempts confirming the same refusal.
      await sleep(Math.max(retryAfterMs, RETRY_GAP_MS * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`CDX unavailable after ${CDX_ATTEMPTS} attempts: ${lastError}`);
}

/**
 * The board's API address, when its vendor publishes one.
 *
 * A third thing to ask the Archive about, and the cheapest of the three to
 * try. The human board page is what a crawler visits, so it is what gets
 * captured - but plenty of these API endpoints were captured too, and an
 * archived API response is JSON. JSON does not care whether the board renders
 * in JavaScript: the titles are simply in the bytes.
 *
 * So for a Greenhouse or Lever board this is a third chance at a firm the
 * other two methods missed, at one request. Lower hit rate than either, and
 * near-zero cost, which is the right shape for a long shot.
 *
 * Built from the connectors' own URL parsers rather than a second set of
 * rules, so a board this repo can read is a board this can ask about.
 */
export function atsApiUrl(boardUrl: string): string | null {
  const greenhouse = greenhouseToken(boardUrl);
  if (greenhouse && !["embed", "boards"].includes(greenhouse)) {
    return `https://boards-api.greenhouse.io/v1/boards/${greenhouse}/jobs`;
  }

  const lever = parseLeverUrl(boardUrl);
  if (lever) return `https://api.lever.co/v0/postings/${lever}?mode=json`;

  const ashby = parseAshbyOrg(boardUrl);
  if (ashby) return `https://api.ashbyhq.com/posting-api/job-board/${ashby}`;

  const workable = parseWorkableAccount(boardUrl);
  if (workable) return `https://apply.workable.com/api/v1/widget/accounts/${workable}`;

  const smart = parseSmartRecruitersCompany(boardUrl);
  if (smart) return `https://api.smartrecruiters.com/v1/companies/${smart}/postings`;

  const recruitee = parseRecruiteeAccount(boardUrl);
  if (recruitee) return `https://${recruitee}.recruitee.com/api/offers/`;

  const bamboo = parseBambooBoard(boardUrl);
  if (bamboo) return `https://${bamboo.host}/careers/list`;

  const breezy = parseBreezyAccount(boardUrl);
  if (breezy) return `https://${breezy}.breezy.hr/json`;

  return null;
}

/**
 * Internship titles in an archived body, whether it is a page or an API reply.
 *
 * The anchor scan below is right for HTML and useless for JSON: an API
 * response has no `<a>` tags, so a perfectly readable list of postings reads
 * as an empty board. This tries JSON first - walking for the string fields
 * these APIs actually use for a role name - and falls back to the anchor scan
 * when the body is not JSON, which is the overwhelmingly common case.
 */
const TITLE_KEYS = new Set(["title", "text", "name", "joboepningname", "jobopeningname", "jobtitle", "position"]);

function titlesFromJson(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // not JSON - the caller falls back to HTML
  }

  const found: string[] = [];
  const visit = (value: unknown, depth: number) => {
    // A bounded walk: an archived API reply can nest, and a runaway recursion
    // on a hostile body is not a risk worth taking for a long-shot method.
    if (depth > 8 || found.length > 500) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (typeof inner === "string" && TITLE_KEYS.has(key.toLowerCase())) {
          found.push(inner);
        } else {
          visit(inner, depth + 1);
        }
      }
    }
  };
  visit(parsed, 0);
  return found;
}

/**
 * What a job URL's own slug says about the posting behind it.
 *
 * Reading the URL rather than the page is what makes a JavaScript board
 * legible: the Archive stores an empty shell for the page, but it indexes the
 * address, and the address routinely carries the role. Baird writes
 * `/jobs/r20261002/internship-marketing-year-round/`; Raymond James writes
 * `XMLNAME-2026-Summer-Internship-Program-Finance` on a Workday board.
 *
 * NO attempt is made to decide whether a URL is "a job page" by its shape.
 * Every ATS numbers and nests differently, and a heuristic for that would be
 * wrong in a new way per vendor. Instead the slug is turned into words and
 * put through the SAME internship test the live classifier uses: if the
 * address says "summer analyst", it is an internship posting, and if it says
 * nothing it is ignored. Assets, search pages and opaque requisition ids all
 * fall out for free because none of them names a role.
 *
 * That is also the honest limit. A board whose URLs are pure ids -
 * `/job/R-123456` with no slug - yields nothing here, and should: we would be
 * inventing the role.
 */
export type JobUrlReading = {
  /** The slug as words, for evidence. */
  text: string;
  isInternship: boolean;
  industry: FirmProgramCategory | null;
  /** A cycle year named in the URL itself, e.g. "2026-Summer-Internship". */
  cycleYearInSlug: number | null;
};

export function readJobUrl(rawUrl: string): JobUrlReading | null {
  let path: string;
  try {
    const url = new URL(rawUrl);
    /**
     * The PATH only. Never the query string.
     *
     * A query string is what somebody TYPED, not what the employer published,
     * and the Archive captures search-result pages like any other. Including
     * it read
     *
     *   /hcmUI/CandidateExperience/en/sites/CX_1001/requisitions/preview/
     *     210141614/?keyword=%2522summer+analyst%2522&location=Hong+Kong
     *
     * as an internship posting, on the strength of a search box. Two such
     * captures - one for "summer analyst", one for "intern" - were enough to
     * give JPMorgan a confident opening window of 13 January to 8 February,
     * derived entirely from other people's searches, which would then have
     * told the crawler when to watch.
     *
     * This codebase already draws the line elsewhere: posting-quality.ts
     * refuses a title that is a search control. The same rule belongs here.
     * A role name lives in the path; if it is only in the query, there is no
     * posting being named.
     */
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  // Separators become spaces so the phrase rules see words. Digits are kept:
  // the cycle year is one of the things worth reading out of a slug.
  const text = path
    .replace(/[/_+\-.,?&=]+/g, " ")
    .replace(/%[0-9a-f]{2}/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  /**
   * An archived path can be long enough to match something by accident - a
   * search query string listing every filter a board offers, for instance.
   * A real job slug is a role name.
   */
  if (text.length > 200) return null;

  const isInternship = TITLE_INTERNSHIP_PATTERN.test(text);
  if (!isInternship) return null;

  // Same industry rule as everywhere else - see sectorForText.
  const industry = sectorForText(text)?.category ?? null;

  /**
   * A plausible cycle year, not any four digits.
   *
   * Requisition ids swallow years whole - Baird's `r20261002` contains
   * "2026", and so does a numeric id that means nothing. Bounded to the
   * range a recruiting cycle can occupy, and required to stand as its own
   * word so an id is not mined for one.
   */
  const yearMatch = /(?<![0-9])(20[2-4][0-9])(?![0-9])/.exec(text);
  const cycleYearInSlug = yearMatch ? Number(yearMatch[1]) : null;

  return { text, isInternship, industry, cycleYearInSlug };
}

/**
 * Turn archived job URLs into one observation per year.
 *
 * The shape the rest of this file already speaks: for each calendar year, the
 * earliest date on which an internship URL for that industry was captured.
 * That is the same claim the content search makes - "by this day, this firm
 * had internships up" - arrived at from the index instead of the page, and it
 * is a LATE BOUND for exactly the same reason.
 *
 * Given an industry, URLs naming a different one are excluded and URLs naming
 * NONE are excluded too. The second half matters: a slug that does not say
 * which desk it belongs to is not evidence about any particular desk, and
 * counting it everywhere would give every industry the same date.
 */
export function observationsFromJobUrls(
  snapshots: Snapshot[],
  sector?: FirmProgramCategory,
): YearObservation[] {
  const earliestByYear = new Map<number, YearObservation>();

  for (const snap of snapshots) {
    const when = parseCdxTimestamp(snap.timestamp);
    if (!when) continue;

    const reading = readJobUrl(snap.original);
    if (!reading) continue;
    if (sector && reading.industry !== sector) continue;

    const year = when.getUTCFullYear();
    const existing = earliestByYear.get(year);
    if (existing && existing.firstSeen <= when) continue;

    earliestByYear.set(year, {
      year,
      firstSeen: when,
      snapshotUrl: `https://web.archive.org/web/${snap.timestamp}/${snap.original}`,
      matched: reading.text.slice(0, 120),
    });
  }

  return [...earliestByYear.values()].sort((a, b) => a.year - b.year);
}

/**
 * The page as the Archive held it, with the Archive's own toolbar suppressed.
 *
 * `id_` after the timestamp asks for the original bytes rather than the
 * rewritten, banner-injected version. Without it, every snapshot carries
 * archive.org navigation chrome, and phrase matching against chrome is how you
 * conclude that every firm posted internships every day since 2013.
 */
/**
 * How a snapshot's bytes are obtained.
 *
 * A seam, so the boundary search below can be exercised without the Internet
 * Archive. That search carries the subtlest rules in this file - the probe
 * cap, the refusal when a year's first capture already has postings - and
 * every one of them was learned from a wrong window in production. They had
 * no tests at all, because the only way to reach them was over the network.
 */
export type SnapshotFetcher = (snap: Snapshot) => Promise<string | null>;

async function fetchSnapshotHtml(snap: Snapshot): Promise<string | null> {
  const archiveUrl = `https://web.archive.org/web/${snap.timestamp}id_/${snap.original}`;
  try {
    const res = await safeFetch(archiveUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      timeoutMs: TIMEOUT_MS,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * How many LINKS on this page look like individual internship postings.
 *
 * Counting links, not matching page text, and the difference is the whole
 * measurement. The first version searched the stripped text for an internship
 * phrase, and on Kroll it matched "opportunities for recent graduates and
 * interns to gain initial work experience" - marketing prose that sits on that
 * page all year - plus a "Featured Jobs" widget. The phrase was therefore
 * present in every capture, the search for a boundary found the year's first
 * capture, and the derived window came out five months wide and confidently
 * wrong.
 *
 * A posting is a LINK whose own text names a role. Prose is not a link, and a
 * nav item is too short to be a role title. That distinction is what makes the
 * signal move when a board opens instead of sitting permanently true.
 */
export function countInternshipPostings(html: string): {
  count: number;
  sample: string | null;
  /**
   * Every distinct internship title on the page, not just one.
   *
   * The sample alone answers "was this firm posting internships on this day".
   * It cannot answer "was this firm posting BANKING internships on this day",
   * and a firm running several programmes opens them on different dates -
   * Morgan Stanley's markets programme and its banking programme are not the
   * same event. Carrying the titles is what lets a window be derived per
   * industry instead of one blurred across all of them.
   */
  titles: string[];
} {
  /**
   * An archived API reply is JSON and has no anchors at all - read as HTML it
   * looks like an empty board, which is exactly the wrong answer for a body
   * that lists every posting in plain text.
   */
  const fromJson = titlesFromJson(html);
  if (fromJson) {
    const hits = fromJson.filter(
      (t) => t.length >= 8 && t.length <= 120 && TITLE_INTERNSHIP_PATTERN.test(t),
    );
    const distinctJson = [...new Set(hits)];
    return { count: distinctJson.length, sample: distinctJson[0] ?? null, titles: distinctJson };
  }

  const anchors = [
    ...html.matchAll(/<a\b[^>]*>([\s\S]{0,300}?)<\/a>/gi),
  ].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim(),
  );

  const hits = anchors.filter(
    (t) => t.length >= 8 && t.length <= 120 && TITLE_INTERNSHIP_PATTERN.test(t),
  );
  // Distinct, so a board repeating one role in three places counts once.
  const distinct = [...new Set(hits)];
  return { count: distinct.length, sample: distinct[0] ?? null, titles: distinct };
}

/**
 * Which industries were being recruited for on this archived page.
 *
 * Read off the internship titles themselves rather than the firm's directory
 * entry, because the question is what was OPEN on that day - a firm with four
 * programmes rarely opens all four at once, and its directory entry says
 * nothing about which came first.
 *
 * A title naming no industry is not forced into one. It is dropped from the
 * per-industry view and still counted by the firm-wide pass, so a page of
 * unclassifiable titles produces a firm window and no industry windows rather
 * than a wrong industry window.
 */
export function sectorsInHtml(html: string): Map<FirmProgramCategory, string> {
  const found = new Map<FirmProgramCategory, string>();
  for (const title of countInternshipPostings(html).titles) {
    const hit = sectorForText(title);
    // First title wins per industry - it is the evidence quoted later.
    if (hit && !found.has(hit.category)) found.set(hit.category, title);
  }
  return found;
}

/**
 * The first snapshot in a year whose page carried internship language.
 *
 * Binary search rather than a scan. The signal is monotonic within a season -
 * once a board carries internships it keeps carrying them for months - so the
 * year splits cleanly into "not yet" and "yes", and ~6 fetches find the
 * boundary in a year of weekly captures. A linear scan would cost 52 and
 * answer the same question.
 *
 * Monotonicity is an assumption, not a fact: a board can flicker. It is the
 * right assumption anyway, because being a week early or late on a window we
 * deliberately widen changes nothing, and paying 8x the requests to be exact
 * about a range is the wrong trade.
 */
export async function findFirstInternshipSnapshot(
  snapshots: Snapshot[],
  year: number,
  /**
   * Narrow the question to one industry.
   *
   * Omitted, this asks "was this firm posting ANY internship" - the firm-wide
   * window. Given an industry, it asks "was this firm posting a BANKING
   * internship", which is a different date: a firm with four programmes
   * rarely opens them together, and a single blurred window is wrong for
   * every one of them.
   *
   * Deliberately the same function rather than a parallel one. Everything
   * around the predicate - the probe cap, the boundary rules, the refusal to
   * report a year whose first capture already had postings - was learned the
   * hard way, and a copy would only have to learn it again.
   */
  sector?: FirmProgramCategory,
  /**
   * Test seam. `gapMs` is separate from the fetcher on purpose: the politeness
   * delay is a property of talking to the Archive, not of the algorithm, and a
   * test that had to wait 1.2 seconds a probe would be a test nobody runs.
   */
  options: { fetchHtml?: SnapshotFetcher; gapMs?: number } = {},
): Promise<YearObservation | null> {
  const fetchHtml = options.fetchHtml ?? fetchSnapshotHtml;
  const gap = options.gapMs ?? GAP_MS;
  const inYear = snapshots
    .filter((s) => s.timestamp.startsWith(String(year)))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (inYear.length === 0) return null;

  let lo = 0;
  let hi = inYear.length - 1;
  let best: { snap: Snapshot; matched: string } | null = null;
  let probes = 0;

  const postingsIn = async (s: Snapshot) => {
    const html = await fetchHtml(s);
    if (!html) return { count: 0, sample: null };
    if (!sector) {
      const all = countInternshipPostings(html);
      return { count: all.count, sample: all.sample };
    }
    const matched = sectorsInHtml(html).get(sector);
    // An industry that is not on the page is a zero, exactly as an empty page
    // is - which is what makes the boundary search mean the same thing.
    return matched ? { count: 1, sample: matched } : { count: 0, sample: null };
  };

  // Confirm the year ends with postings present, or there is no boundary to
  // find at all.
  const last = await postingsIn(inYear[hi]);
  probes++;
  if (last.count === 0) return null;

  /**
   * If the year's FIRST capture already has postings, the opening happened
   * before anything we can see - so this year yields no observation.
   *
   * Without this rule the search returns the first capture of the year and
   * calls it the opening date, which is how Kroll produced "opens 2 January".
   * A boundary you cannot see inside your window is not a boundary you get to
   * report. Costs one extra fetch per year and removes a whole class of
   * confident nonsense.
   */
  await sleep(gap);
  const first = await postingsIn(inYear[lo]);
  probes++;
  if (first.count > 0) return null;

  best = { snap: inYear[hi], matched: last.sample ?? "" };

  while (lo < hi - 1 && probes < MAX_PROBES_PER_YEAR) {
    const mid = Math.floor((lo + hi) / 2);
    await sleep(gap);
    const got = await postingsIn(inYear[mid]);
    probes++;
    if (got.count > 0) {
      best = { snap: inYear[mid], matched: got.sample ?? "" };
      hi = mid;
    } else {
      lo = mid;
    }
  }

  const when = parseCdxTimestamp(best.snap.timestamp);
  if (!when) return null;

  return {
    year,
    firstSeen: when,
    snapshotUrl: `https://web.archive.org/web/${best.snap.timestamp}/${best.snap.original}`,
    matched: best.matched.slice(0, 180),
  };
}

/**
 * Turn observations into a window for the next cycle.
 *
 * Requires TWO years. One observation is an anecdote: a single September
 * sighting cannot distinguish a firm that opens every September from a firm
 * that happened to be archived once while a posting was up. Reporting it and
 * refusing to store it is the honest handling.
 *
 * The window spans the observed days-of-year, widened by a week either side.
 * Two firms opening on the 12th and the 18th get "5th to 25th", which is what
 * the evidence supports - not the 15th, which is arithmetic pretending to be
 * knowledge.
 */
/**
 * Every way of asking the Archive about one board, in cost order.
 *
 * ONE DEFINITION, because there were two and only one of them worked.
 *
 * `tiered-opening-dates.ts` asks three ways - the URL index, the vendor's API,
 * then the archived page contents. `opening-windows-sweep.ts`, the job that
 * actually ran across every industry, asked only the third. The difference is
 * the whole result. Measured from the datasheet it produced for 144 boards on
 * 20 September 2026:
 *
 *    79  the Archive HAD captures, and not one carried a readable internship
 *    31  no captures of that URL at all
 *    19  CDX error (13 of them HTTP 403)
 *    13  exactly one year of evidence, where two are required
 *     1  a usable window
 *
 * Those 79 are the tell. A Workday, Oracle or Greenhouse careers page is
 * archived as an empty JavaScript shell - the titles were never in the HTML,
 * so no amount of reading it will find them. But the job URLs BENEATH that
 * board are indexed, and they routinely name the role; and an archived API
 * response is JSON, where the titles are simply in the bytes. The sweep was
 * using the one method that cannot see the boards most of these firms run.
 *
 * So the orchestration moves here, where both callers can have it, rather
 * than staying inside whichever script happened to be written second.
 *
 * Order is by cost, not by quality. The prefix query is a SINGLE CDX request
 * against the index; the page search is roughly eighteen snapshot fetches.
 * Neither dominates on accuracy - a board with opaque numeric job URLs gives
 * the index nothing to read, and there the page content is the only evidence
 * there is - so the cheap one runs first and the expensive one covers what it
 * missed. Each layer stops early once two years are in hand, because two is
 * what `deriveWindow` requires.
 */
export async function gatherObservations(opts: {
  careersUrl: string;
  /** Narrow to one industry, or omit for the firm-wide window. */
  sector?: FirmProgramCategory;
  fromYear: number;
  toYear: number;
}): Promise<{
  observations: YearObservation[];
  method: string;
  /**
   * Whether the Archive answered AT ALL - separately from whether it held
   * anything.
   *
   * "No captures of this board" and "we never reached the Archive" are two
   * different facts and this function returned the same value for both: an
   * empty list. Every layer below catches its own failure, reasonably, because
   * one layer failing is not a finding. But when they ALL fail the caller got
   * `{ observations: [], method: "none" }` - byte for byte what a firm with
   * genuinely no archive history returns - and wrote it down as fact.
   *
   * Measured 22 September 2026: this cloud session's network policy denies
   * web.archive.org outright, answering 403 to the CONNECT. Five firms read
   * that way, Société Générale among them, were all recorded `no-snapshots`
   * with `error: null`. Left running over the 4,479-firm target list it would
   * have produced 4,479 confident false negatives, and
   * `opening-windows-sweep.ts` writes that same verdict to Supabase with the
   * note "no archived capture of this board named an internship, by URL index,
   * API or page" - a positive claim about the Archive's holdings, made without
   * having reached it.
   *
   * That is the one thing this pipeline is not allowed to do. `evidence` is
   * required on every opening_signal and blank beats a plausible guess; a
   * network refusal laundered into a finding about a firm is the failure those
   * rules exist to prevent.
   *
   * True the moment any CDX query returns - including one that returns zero
   * captures, which is a real answer from a reachable Archive.
   */
  archiveReachable: boolean;
  /** The first transport failure, for the caller to report. Null when none. */
  archiveError: string | null;
}> {
  const { careersUrl, sector, fromYear, toYear } = opts;
  let observations: YearObservation[] = [];
  let method = "";
  let archiveReachable = false;
  let archiveError: string | null = null;

  const failed = (err: unknown) => {
    archiveError ??= (err as Error)?.message?.slice(0, 200) ?? String(err).slice(0, 200);
  };

  const mergeByYear = (found: YearObservation[], label: string) => {
    const known = new Set(observations.map((o) => o.year));
    const added = found.filter((o) => !known.has(o.year));
    if (!added.length) return;
    method = method ? `${method}+${label}` : label;
    observations = [...observations, ...added].sort((a, b) => a.year - b.year);
  };

  // 1. The URL index. One request, and it reads the names of the job pages
  //    beneath the board rather than the board itself.
  try {
    const jobUrls = await fetchJobUrlSnapshots(careersUrl, fromYear);
    archiveReachable = true;
    mergeByYear(observationsFromJobUrls(jobUrls, sector), "url-index");
  } catch (err) {
    // A prefix query that fails is not a firm without history - but it is also
    // not evidence that the firm has none. Recorded, not discarded.
    failed(err);
  }

  // 2. The vendor's API. One request, and JSON does not care whether the
  //    board renders in JavaScript.
  const apiUrl = atsApiUrl(careersUrl);
  if (observations.length < 2 && apiUrl) {
    try {
      const snaps = await fetchSnapshots(apiUrl, fromYear);
      archiveReachable = true;
      const found: YearObservation[] = [];
      for (let y = fromYear; y <= toYear; y++) {
        const hit = await findFirstInternshipSnapshot(snaps, y, sector);
        if (hit) found.push(hit);
      }
      mergeByYear(found, "api");
    } catch (err) {
      // A long shot that misses is not a finding, and a long shot that could
      // not be taken is not a miss.
      failed(err);
    }
  }

  // 3. The archived page contents. The expensive one, and the only one that
  //    works on a server-rendered careers page with unreadable job URLs.
  if (observations.length < 2) {
    try {
      const snaps = await fetchSnapshots(careersUrl, fromYear);
      archiveReachable = true;
      const found: YearObservation[] = [];
      for (let y = fromYear; y <= toYear; y++) {
        const hit = await findFirstInternshipSnapshot(snaps, y, sector);
        if (hit) found.push(hit);
      }
      mergeByYear(found, "pages");
    } catch (err) {
      // "Left to the caller to report as an error outcome" is what this said,
      // and there was nothing for the caller to report it FROM. That is what
      // `archiveReachable` is now for.
      failed(err);
    }
  }

  return { observations, method: method || "none", archiveReachable, archiveError };
}

export function deriveWindow(
  observations: YearObservation[],
  today = new Date(),
): OpeningWindow | null {
  if (observations.length < 2) return null;

  const days = observations.map((o) => dayOfYear(o.firstSeen));
  const earliest = Math.min(...days);
  const latest = Math.max(...days);

  /**
   * Refuse a window too wide to act on.
   *
   * Kroll's first run produced 26 December to 17 May - technically derived
   * from evidence, and useless to a student deciding when to check. A range
   * that wide is not a prediction, it is a shrug with dates on it, and storing
   * it would push a real signal down the precedence list for nothing.
   *
   * 75 days is deliberately generous: firms open across a few weeks and the
   * observations are only as precise as the capture schedule.
   */
  const MAX_SPAN_DAYS = 75;
  if (latest - earliest > MAX_SPAN_DAYS) return null;

  const PAD_DAYS = 7;
  // The cycle this window predicts: the next one after today, by the same
  // convention the observations were read under.
  const cycleYear = cycleYearForDate(today);

  // Anchor the window on the year whose opening is still ahead of us.
  const anchorYear =
    dayOfYear(today) <= latest + PAD_DAYS ? today.getUTCFullYear() : today.getUTCFullYear() + 1;

  const opensStart = fromDayOfYear(anchorYear, earliest - PAD_DAYS);
  const opensEnd = fromDayOfYear(anchorYear, latest + PAD_DAYS);

  const dates = observations
    .sort((a, b) => a.year - b.year)
    .map((o) => `${o.firstSeen.toISOString().slice(0, 10)} (${o.snapshotUrl})`)
    .join("; ");

  return {
    cycleYear,
    opensStart,
    opensEnd,
    observations,
    evidence:
      `Internship postings were archived on this careers page from ${dates}. ` +
      `Window widened to ±${PAD_DAYS} days around those dates; derived from ` +
      `archive history, not stated by the firm.`,
  };
}

/**
 * Day-of-year, which drifts by one across a leap boundary.
 *
 * 12 September is day 256 in a leap year and 255 otherwise, so a window built
 * from observations spanning one can sit a day off. Left as-is deliberately:
 * the window is padded by a week either side precisely because the archive's
 * capture schedule is coarser than that, and a one-day shift is well inside
 * the noise this is already admitting to. Worth knowing before someone
 * "fixes" a date that looks one out.
 */
function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86400000) + 1;
}

function fromDayOfYear(year: number, day: number): Date {
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86400000);
}
