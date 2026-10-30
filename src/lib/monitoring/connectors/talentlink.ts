import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import { renderTextWithBrowser } from "./generic";
import { htmlToText } from "../html-text";
import { deadlineFromPostingText } from "@/lib/posting-deadline";

/**
 * TalentLink (*.tal.net) - an ATS several banks on this list recruit through,
 * Evercore and Jefferies among them.
 *
 * Worth its own connector rather than leaving it to the generic one, for the
 * reason the plan gives: it publishes an Atom feed of its vacancies, and that
 * feed carries the thing nothing else in this pipeline has been able to get -
 * a real, exact application deadline, as data:
 *
 *   <title>Milan Off-Cycle Internship - Generalist Team (January - June 2027)</title>
 *   <content>Application Deadline:1 Nov 2026 12:00 PM GMT</content>
 *
 * No browser, no heuristics, no model. Two plain GETs and a parse.
 *
 * The generic connector found nothing at Evercore not because the page was
 * hostile but because the monitored URL pointed at the firm's FAQ page. Once a
 * source points at the job board, this reads 39 live vacancies off it.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function get(url: string): Promise<{ body: string; status: number } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await safeFetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/atom+xml, text/html" },
        redirect: "follow",
        signal: controller.signal,
      });
      return { body: await res.text(), status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function tagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!m) return null;
  return decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || null;
}

/**
 * "1 Nov 2026 12:00 PM GMT" -> a Date.
 *
 * Returns null rather than a guess when the shape is unfamiliar - a wrong
 * deadline is worse than no deadline, because a student acts on it.
 */
export function parseTalentLinkDeadline(text: string): Date | null {
  return parseTalentLinkDeadlineParts(text).date;
}

/**
 * The deadline broken into the part we sort by and the part we only show.
 *
 * `date` stays a CALENDAR DATE at midnight UTC, deliberately unchanged: that
 * is the convention every consumer of a deadline in this codebase already
 * follows (see formatDay in lib/posting-timing.ts), and moving to a true
 * instant would silently shift every stored deadline by a day in one
 * direction or the other depending on the reader's timezone.
 *
 * `timeText` is the firm's own words for the cut-off - "11:55 PM EST" - kept
 * as text rather than parsed. It is worth showing and not worth computing
 * with: a student wants to know the deadline is late evening Eastern and not
 * 9am, and converting that into their own timezone would be a second chance
 * to be wrong about a date for no gain. Null when the firm stated only a day.
 */
export function parseTalentLinkDeadlineParts(text: string): {
  date: Date | null;
  timeText: string | null;
} {
  // One definition of the rule, in lib/posting-deadline.ts. This used to carry
  // its own regex, which is how the same sentence could be read here and
  // ignored by savePosting: the panel that used this saw a deadline, the
  // Internships tab that reads the column saw "TBD". The widened version also
  // handles the weekday prefix PJT uses and refuses a posting that states
  // several deadlines - see that file.
  const stated = deadlineFromPostingText(text);
  return { date: stated?.date ?? null, timeText: stated?.timeText ?? null };
}

/**
 * Finds the Atom feed for a TalentLink board.
 *
 * Read off the page rather than constructed: the feed path carries brand and
 * appcentre ids ("/vx/mobile-0/appcentre-1/brand-6/...") that differ per firm
 * and cannot be derived from the board URL. A configured URL that already
 * points at a feed is used as-is.
 */
function findFeedUrl(html: string, pageUrl: string): string | null {
  if (/\/feed(\?|$)/.test(pageUrl)) return pageUrl;
  const m = /href="([^"]*\/jobboard\/vacancy\/\d+\/feed[^"]*)"/i.exec(html);
  if (!m) return null;
  return new URL(decodeEntities(m[1]), pageUrl).toString();
}

/**
 * Last resort when the board page yields no feed link: ask for the feed at
 * TalentLink's conventional path anyway.
 *
 * Worth the extra requests because of a case this connector otherwise gets
 * exactly backwards - Bank of America's board answers a browser with a bot
 * challenge instead of HTML, so there is no feed link to find and the source
 * reads as blocked. Its feed, at the conventional path, is served without any
 * challenge at all: 152 listings, every one dated. The page was protected; the
 * feed never was.
 *
 * Only reached when the page produced nothing, so a healthy board still costs
 * one request.
 */
async function probeFeedPath(pageUrl: string): Promise<string | null> {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }
  // Board index 1 then 2 - tenants number their boards from either.
  for (const index of [1, 2]) {
    const candidate = `${origin}/candidate/jobboard/vacancy/${index}/feed`;
    const res = await get(candidate);
    if (res && res.status < 400 && /<entry[\s>]/i.test(res.body)) return candidate;
  }
  return null;
}

/**
 * The board page itself, when the tenant publishes no feed.
 *
 * Not every TalentLink tenant enables the Atom feed, and this connector had
 * exactly one way in. Morgan Stanley is the case that exposed it: the board is
 * real and server-rendered - "Global Programs - Morgan Stanley Campus", 154KB,
 * 125 live vacancies - and every feed path 404s. With no feed link to find,
 * `fetch` returned a clean empty result and the source read as a firm with no
 * openings, indefinitely and without erroring.
 *
 * The rows are structured data rather than prose, which is why this is a parse
 * and not a heuristic:
 *
 *   <tr class="opp_22202 search_res details_row" data-oppid="22202"
 *       data-title="2026 Human Resources Off Cycle Internship (Milan)">
 *     <td><a class="subject" href="...opp/22202-.../en-GB">...</a></td>
 *     <td>Milan</td>
 *   </tr>
 *
 * `data-oppid` gives a real external id - which matters beyond tidiness, since
 * a listing without one fails `verifiable` and can never be auto-approved.
 */
type BoardRow = { oppid: string; title: string; href: string | null; location: string | null };

/**
 * Which column holds the location, read from the header rather than assumed.
 *
 * Tenants choose their own columns; Morgan Stanley's are Title and City, but
 * the position of anything after the title is not a constant. Taking "the
 * second cell" would file a department as a location on the first board that
 * orders them differently.
 */
function locationColumnIndex(html: string): number | null {
  const head = /<thead[\s\S]*?<\/thead>/i.exec(html)?.[0];
  if (!head) return null;
  const labels = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().toLowerCase(),
  );
  const at = labels.findIndex((l) => /\b(city|location|office|site|country|region)\b/.test(l));
  return at >= 0 ? at : null;
}

function cellText(cell: string): string {
  return decodeEntities(cell.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function boardRows(html: string): BoardRow[] {
  const locationAt = locationColumnIndex(html);
  const rows: BoardRow[] = [];

  for (const m of html.matchAll(/<tr([^>]*\bdata-oppid="(\d+)"[^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const [, attrs, oppid, body] = m;
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
    const anchor = /<a[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(body);

    // `data-title` is the source's own title, unwrapped and unabbreviated;
    // the anchor text is the same string with layout whitespace in it. Prefer
    // the attribute, fall back to the link.
    const title =
      decodeEntities(/\bdata-title="([^"]*)"/i.exec(attrs)?.[1] ?? "").trim() ||
      (anchor ? cellText(anchor[2]) : "");
    if (!title) continue;

    rows.push({
      oppid,
      title,
      href: anchor ? decodeEntities(anchor[1]) : null,
      location: locationAt !== null ? cells[locationAt] || null : null,
    });
  }

  return rows;
}

/**
 * How many rows a board page serves before it needs asking again.
 *
 * Measured, not chosen: Morgan Stanley returns exactly 50 and `?start=50`
 * returns 50 entirely different ones. A board whose page size is smaller than
 * this still terminates correctly, because paging stops when a request adds
 * no new vacancy rather than when it returns fewer than expected.
 */
const BOARD_PAGE_SIZE = 50;
/** 100 pages is 5,000 vacancies - past any real campus board, and a stop. */
const MAX_BOARD_PAGES = 100;

function entriesOf(xml: string): string[] {
  return xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
}

/**
 * The content hash, shared by both routes into this connector.
 *
 * Sorted, so the board reordering its rows - which it does, by recency - is
 * not mistaken for the board changing.
 */
function hashListingIdentity(listings: NormalizedListing[]): string {
  if (!listings.length) return sha256("empty");
  return sha256(
    listings
      .map((l) => `${l.externalJobId}|${l.title}|${l.descriptionRaw}`)
      .sort()
      .join("\n"),
  );
}

function rowToListing(row: BoardRow, pageUrl: string): NormalizedListing {
  let url: string;
  try {
    url = row.href ? new URL(row.href, pageUrl).toString() : pageUrl;
  } catch {
    url = pageUrl;
  }
  return {
    externalJobId: row.oppid,
    title: row.title,
    division: null,
    location: row.location,
    // The board row carries a title and a location and nothing else. `enrich`
    // fetches each vacancy's own page, which is where the description and the
    // application deadline live - the same route the feed path already takes.
    descriptionRaw: "",
    employmentType: null,
    applicationUrl: url,
    listingUrl: url,
    publishedAt: null,
  };
}

/**
 * Page through the board, stopping when it stops offering anything new.
 *
 * Termination is on NEW vacancies rather than on row count, because a board
 * that ignores `start` answers every request with page one - and a loop that
 * trusted the count would fetch the same fifty rows a hundred times. Measured
 * on Morgan Stanley: 50, 50, 25, 0 -> 125 distinct.
 */
export async function readBoardPages(
  pageUrl: string,
  firstPageHtml: string,
  // Injected so the paging rule can be tested without a network. The default
  // is the connector's own GET.
  fetchPage: (url: string) => Promise<{ body: string; status: number } | null> = get,
): Promise<{ listings: NormalizedListing[]; truncated: boolean; pagesRead: number }> {
  const seen = new Map<string, NormalizedListing>();

  const absorb = (html: string): number => {
    const before = seen.size;
    for (const row of boardRows(html)) {
      if (!seen.has(row.oppid)) seen.set(row.oppid, rowToListing(row, pageUrl));
    }
    return seen.size - before;
  };

  if (absorb(firstPageHtml) === 0) {
    return { listings: [], truncated: false, pagesRead: 1 };
  }

  let pagesRead = 1;
  for (let start = BOARD_PAGE_SIZE; pagesRead < MAX_BOARD_PAGES; start += BOARD_PAGE_SIZE) {
    let next: string;
    try {
      const u = new URL(pageUrl);
      u.searchParams.set("start", String(start));
      next = u.toString();
    } catch {
      break;
    }

    const res = await fetchPage(next);
    pagesRead += 1;
    // A failed page is not an empty board. Stopping here keeps what was read;
    // calling it complete would let the tail be closed as though it ended.
    if (!res || res.status >= 400) {
      return { listings: [...seen.values()], truncated: true, pagesRead };
    }
    if (absorb(res.body) === 0) {
      return { listings: [...seen.values()], truncated: false, pagesRead };
    }
  }

  // Left the loop on the page cap rather than on a natural end.
  return { listings: [...seen.values()], truncated: true, pagesRead };
}

function entryToListing(entry: string, feedUrl: string): NormalizedListing | null {
  const title = tagText(entry, "title");
  if (!title) return null;

  const href =
    /<link[^>]+rel="alternate"[^>]+href="([^"]+)"/i.exec(entry)?.[1] ??
    /<id[^>]*>([\s\S]*?)<\/id>/i.exec(entry)?.[1]?.trim();
  /**
   * The vacancy's own page, with the apply parameters stripped.
   *
   * The feed's alternate link carries `?instant=apply`, which is the APPLY
   * action rather than the posting - it serves the sign-in and
   * account-creation form on every vacancy, identically. That one parameter is
   * why the description looked unreadable and why 34 Evercore internships were
   * published with no detail: the content was public the whole time, one query
   * string away.
   *
   * Stripped for what we store as well as what we fetch, so a student
   * following the link lands on the posting and chooses whether to apply,
   * rather than being dropped straight into a registration form.
   */
  const url = href ? stripApplyParams(new URL(decodeEntities(href), feedUrl)) : feedUrl;

  const content = tagText(entry, "content") ?? "";
  const published = tagText(entry, "published") ?? tagText(entry, "updated");
  const deadline = parseTalentLinkDeadline(content);

  return {
    // The opportunity id inside the URL is TalentLink's own stable identifier
    // ("/opp/3293-Milan-Off-Cycle.../"), which survives a retitled vacancy.
    externalJobId: /\/opp\/(\d+)/.exec(url)?.[1] ?? sha256(url),
    title,
    division: null,
    location: null,
    // The deadline is kept in the text, not just parsed out, so the classifier
    // and any human reviewing the row can both see the sentence it came from.
    descriptionRaw: content || title,
    employmentType: null,
    applicationUrl: url,
    listingUrl: url,
    publishedAt: published,
    deadlineAt: deadline ? deadline.toISOString() : null,
  };
}

export const talentLinkConnector: SourceConnector = {
  id: "talentlink",

  canHandle(source: SourceRef): boolean {
    try {
      // Dot boundary, not a bare endsWith: `eviltal.net` ends with "tal.net".
      // Same trap fixed in greenhouse.ts and workday.ts - see either for what
      // accepting a lookalike host actually costs.
      const host = new URL(source.careersUrl).hostname.toLowerCase();
      return host === "tal.net" || host.endsWith(".tal.net");
    } catch {
      return false;
    }
  },

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const page = await get(source.careersUrl);
    // A page that fails or errors is no longer the end of the story: the feed
    // can be readable when the board page is not. See probeFeedPath.
    const fromPage =
      page && page.status < 400 ? findFeedUrl(page.body, source.careersUrl) : null;
    const feedUrl = fromPage ?? (await probeFeedPath(source.careersUrl));
    if (!feedUrl) {
      /**
       * No feed does not mean no jobs.
       *
       * This branch used to return empty unconditionally, on the reasoning
       * that a tal.net URL with no feed is a landing page or an FAQ. That is
       * often true and was not true of Morgan Stanley, whose board is
       * server-rendered with 125 live vacancies and no feed anywhere - so the
       * firm read as having no openings, cleanly, with a 200, for as long as
       * it was monitored.
       *
       * Asking the page itself is the difference between "this is not a job
       * board" and "this job board does not publish a feed". Only the rows
       * decide which.
       */
      if (page && page.status < 400) {
        const board = await readBoardPages(source.careersUrl, page.body);
        if (board.listings.length) {
          return {
            listings: board.listings,
            etag: null,
            contentHash: hashListingIdentity(board.listings),
            httpStatus: page.status,
            notModified: false,
            truncated: board.truncated,
          };
        }
      }

      // Genuinely not a board: no feed, and no vacancy rows on the page.
      // Reported as a clean empty result rather than an error, because
      // nothing is broken.
      return {
        listings: [],
        etag: null,
        contentHash: "",
        httpStatus: page?.status ?? 0,
        notModified: false,
      };
    }

    const feed = page && feedUrl === source.careersUrl ? page : await get(feedUrl);
    if (!feed || feed.status >= 400) {
      return {
        listings: [],
        etag: null,
        contentHash: "",
        httpStatus: feed?.status ?? 0,
        notModified: false,
      };
    }

    const listings = entriesOf(feed.body)
      .map((e) => entryToListing(e, feedUrl))
      .filter((l): l is NormalizedListing => l !== null);

    return {
      listings,
      etag: null,
      contentHash: hashListingIdentity(listings),
      httpStatus: feed.status,
      notModified: false,
    };
  },

  /**
   * Fetches each new vacancy's own page for the description.
   *
   * The Atom feed carries a title and an application deadline and almost
   * nothing else - measured across Evercore's board, the average entry gave
   * 133 characters, most of it the deadline line. That is enough to know a
   * posting exists and nothing like enough to say who may apply or what is
   * required, so all 39 of Evercore's auto-approved internships carried blank
   * eligibility and no requirements.
   *
   * Server-rendered, so a plain GET is enough. Best-effort by contract: a
   * vacancy whose page fails keeps the feed text it already had.
   */
  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    const out = [...listings];
    let fetched = 0;
    let rendered = 0;

    for (let i = 0; i < out.length && fetched < MAX_DETAIL; i++) {
      const listing = out[i];
      if (listing.descriptionRaw.trim().length >= 400) continue;

      if (fetched > 0) await new Promise((r) => setTimeout(r, DETAIL_GAP_MS));
      fetched += 1;

      try {
        const response = await safeFetch(listing.listingUrl, {
          headers: { "user-agent": USER_AGENT, accept: "text/html" },
          timeoutMs: TIMEOUT_MS,
        });
        if (!response.ok) continue;
        let text = readVacancyText(await response.text());

        /**
         * The static fetch hit a sign-in form - render the page instead.
         *
         * TalentLink returns the registration shell to a plain GET and loads
         * the vacancy client-side, so the description IS public; it just is
         * not in the served HTML. Verified against Evercore: a fetch returns
         * 1,362 characters of sign-in chrome, identical on every posting,
         * while the rendered page gives region, location, group, programme
         * type, level and the full job description.
         *
         * Nothing is being circumvented here. There is no credential, no
         * account and no bypass - it is the same page a student sees, read
         * the same way a browser reads it.
         *
         * Capped hard because a render costs about a second of CPU against a
         * few milliseconds for a fetch. The listings that get one are the ones
         * whose descriptions we could not otherwise read at all.
         */
        if (!text && rendered < MAX_BROWSER_DETAIL) {
          rendered += 1;
          const viaBrowser = await renderTextWithBrowser(listing.listingUrl);
          if (viaBrowser && !/create a new online application account/i.test(viaBrowser)) {
            text = viaBrowser;
          }
        }

        if (text && text.length > listing.descriptionRaw.length) {
          // The feed's own text is kept in front: it carries the application
          // deadline, which the rendered page often states less precisely.
          out[i] = { ...listing, descriptionRaw: `${listing.descriptionRaw} ${text}`.trim() };
        }
      } catch {
        /* keep what the feed gave */
      }
    }

    return out;
  },
};

function stripApplyParams(url: URL): string {
  for (const p of ["instant", "apply", "action", "mode"]) {
    const v = url.searchParams.get(p);
    if (v && /^(apply|instant)$/i.test(v)) url.searchParams.delete(p);
  }
  if (url.searchParams.get("instant") === "apply") url.searchParams.delete("instant");
  return url.toString();
}

/** Detail fetches per pass. TalentLink boards here run to 60 vacancies and
 *  turn over slowly, so this covers a board in a cycle or two. */
const MAX_DETAIL = 40;
const DETAIL_GAP_MS = 500;
/** Browser renders per pass. Far lower than MAX_DETAIL: this is the expensive
 *  path, and it only fires for pages a fetch genuinely cannot read. */
const MAX_BROWSER_DETAIL = 15;

/**
 * The vacancy body from a TalentLink page.
 *
 * TalentLink renders the posting inside a handful of well-known containers
 * depending on the tenant's template, so this tries each and falls back to the
 * whole stripped document. The length floor is what makes the fallback safe: a
 * page that yields only chrome comes back under it and is discarded rather
 * than stored as a description.
 */
function readVacancyText(html: string): string | null {
  const candidates = [
    /<div[^>]+class="[^"]*(?:vacancy|job)[-_]?(?:description|details?|content)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    /<div[^>]+id="[^"]*(?:vacancyDescription|jobDescription)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<section[^>]+class="[^"]*vacancy[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
  ];

  let raw: string | null = null;
  for (const re of candidates) {
    const m = re.exec(html);
    if (m?.[1]) { raw = m[1]; break; }
  }
  if (!raw) {
    raw = html.replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, " ");
  }

  let text = htmlToText(raw);

  /**
   * A sign-in or account-creation wall, not the vacancy.
   *
   * Several TalentLink tenants put the vacancy body behind a login. What comes
   * back is the registration form - "Sign in with LinkedIn", "To create a new
   * online application account, enter your personal details below", First
   * Name, Last Name, Choose Password - and it is byte-similar on every posting,
   * so storing it makes all of a firm's listings look identical to the
   * classifier while looking like real content to a reviewer.
   *
   * Returning null keeps the short feed text, which is accurate as far as it
   * goes. Getting past this would mean creating an account, which is the one
   * thing this system does not do: an account is where terms get accepted, and
   * that is the line between reading public data and agreeing to somebody's
   * contract.
   */
  const wall = /\b(sign in with|create a new online application account|choose password|confirm password|login with facebook|forgotten your password)\b/i;
  if (wall.test(text)) return null;

  // Drop the sign-in header that TalentLink renders above every vacancy - it
  // is identical on all of them, so leaving it in makes every description look
  // alike to the classifier and pads the length check with chrome.
  const bodyStart = text.search(/\b(Job Description|Role Description|About the (Role|Programme|Program)|Overview|Responsibilities|The Opportunity)\b/i);
  if (bodyStart > 0) text = text.slice(bodyStart);

  // Cut the application machinery that follows every posting.
  for (const stop of ["Apply now", "Share this vacancy", "Back to search", "Cookie", "Privacy Policy"]) {
    const i = text.indexOf(stop);
    if (i > 300) return text.slice(0, i).trim().slice(0, 6000);
  }

  return text.length >= 300 ? text.slice(0, 6000) : null;
}
