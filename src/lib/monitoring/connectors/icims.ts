import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";

/**
 * iCIMS (`*.icims.com/jobs/search`).
 *
 * Unlike Workday and Oracle, iCIMS has no public JSON endpoint - but it does
 * something better for our purposes: it renders the whole result list
 * server-side, so a plain GET returns every job row as an ordinary anchor.
 * No browser, no API reverse-engineering, just markup:
 *
 *   <a href=".../jobs/{id}/{slug}/job">Title Commercial Banking Compliance Officer</a>
 *
 * `&in_iframe=1` asks for the bare results fragment rather than the full
 * portal chrome, and `&pr={n}` pages through it.
 *
 * Used here by Stifel, whose board also covers Miller Buckfire.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
/**
 * Pages per read.
 *
 * Was 5. iCIMS boards in this directory run to 150 requisitions, so 5 pages
 * was a ceiling real boards cleared - and the caller CLOSES anything it does
 * not see, so the tail was not merely unread, it was recorded as ended. The
 * loop already stops as soon as a page adds nothing new, so a small board
 * still costs one or two requests; this only raises the point at which a
 * large one gets cut off. Paired with `truncated` on the result for the case
 * where it still is.
 */
const MAX_PAGES = 20;
const PAGE_GAP_MS = 400;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function parseIcimsUrl(rawUrl: string): { origin: string } | null {
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.endsWith(".icims.com")) return null;
    return { origin: url.origin };
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Pulls (id, url, title) out of the rendered results fragment.
 *
 * The anchor text carries a visually-hidden "Title" label in front of the real
 * title, which has to come off or every stored role is named "Title Summer
 * Analyst".
 */
function parseRows(html: string, origin: string): NormalizedListing[] {
  const re = /<a[^>]+href="([^"]*?\/jobs\/(\d+)\/[^"]*?\/job[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const out: NormalizedListing[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(re)) {
    const [, rawHref, id, inner] = match;
    if (seen.has(id)) continue;

    const title = decodeEntities(inner.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .replace(/^\s*Title\s+/i, "")
      .trim();
    if (!title) continue;

    seen.add(id);
    // Strip in_iframe so the stored link opens the real portal page for a
    // student who clicks it, not a bare fragment.
    const listingUrl = new URL(decodeEntities(rawHref), origin).toString().replace(/[?&]in_iframe=1/, "");

    out.push({
      externalJobId: id,
      title,
      division: null,
      location: null,
      // The results fragment carries titles only; `enrich` below fills this
      // in for the listings the caller has decided are new. The old comment
      // here claimed the classifier only needed the title, and that stopped
      // being true when eligibility and requirements moved into the
      // classifier - both are read out of the description, so a title-only
      // listing can be seen but never published.
      descriptionRaw: title,
      employmentType: null,
      applicationUrl: listingUrl,
      listingUrl,
      publishedAt: null,
      deadlineAt: null,
    });
  }
  return out;
}

export const icimsConnector: SourceConnector = {
  id: "icims",

  canHandle(source: SourceRef): boolean {
    return parseIcimsUrl(source.careersUrl) !== null;
  },

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const ref = parseIcimsUrl(source.careersUrl);
    if (!ref) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const listings: NormalizedListing[] = [];
    const seen = new Set<string>();
    let status = 0;
    // True only if the LAST allowed page was still adding rows - which is the
    // one case where the board certainly continued past where we stopped.
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0) await new Promise((r) => setTimeout(r, PAGE_GAP_MS));

      const url = new URL(`${ref.origin}/jobs/search`);
      url.searchParams.set("mode", "job");
      url.searchParams.set("in_iframe", "1");
      url.searchParams.set("pr", String(page));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let html: string;
      try {
        const res = await safeFetch(url.toString(), {
          headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
          signal: controller.signal,
        });
        status = res.status;
        if (!res.ok) break;
        html = await res.text();
      } catch {
        break;
      } finally {
        clearTimeout(timer);
      }

      const rows = parseRows(html, ref.origin);
      // iCIMS answers an out-of-range page with the last page again rather
      // than an empty one, so stop when a page adds nothing new instead of
      // when it comes back empty - otherwise this loops to MAX_PAGES every
      // time and stores the same tail repeatedly.
      const added = rows.filter((r) => !seen.has(r.externalJobId!));
      if (added.length === 0) break;
      for (const r of added) {
        seen.add(r.externalJobId!);
        listings.push(r);
      }
      if (page === MAX_PAGES - 1) truncated = true;
    }

    const contentHash = listings.length
      ? sha256(listings.map((l) => `${l.externalJobId}|${l.title}`).sort().join("\n"))
      : sha256("empty");

    return {
      listings,
      etag: null,
      contentHash,
      httpStatus: status || 200,
      notModified: false,
      truncated,
    };
  },

  /**
   * Fetches each new listing's own iCIMS page for the real description.
   *
   * Added after the first live crawl stored 150 Stifel listings with 2
   * descriptions between them - the search fragment carries titles only, and
   * without a body the classifier cannot read eligibility or requirements, so
   * every one of them was unpublishable.
   *
   * iCIMS detail pages are server-rendered, so a plain GET is enough; no
   * browser. Sequential with a gap, inside the slot the fetch pool already
   * granted for this source, so one polite request does not become a burst.
   */
  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    const out = [...listings];
    let fetched = 0;

    for (let i = 0; i < out.length && fetched < MAX_DETAIL; i++) {
      const listing = out[i];
      // Only the ones that still have nothing but their title.
      if (listing.descriptionRaw.trim() !== listing.title.trim()) continue;

      if (fetched > 0) await new Promise((r) => setTimeout(r, DETAIL_GAP_MS));
      fetched += 1;

      try {
        /**
         * Fetched WITH in_iframe=1, stored without it.
         *
         * iCIMS serves the posting only to the embedded view; request the same
         * URL without that parameter and it redirects to the employer's own
         * marketing site - Stifel's returns their Wealth Tracker product page,
         * which is 28KB of content about something else entirely. The stored
         * listingUrl stays clean so a student clicking it gets the real portal
         * page; only this fetch adds the parameter.
         */
        const detailUrl = new URL(listing.listingUrl);
        detailUrl.searchParams.set("in_iframe", "1");

        const response = await safeFetch(detailUrl.toString(), {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
          timeoutMs: TIMEOUT_MS,
        });
        if (!response.ok) continue;
        const html = await response.text();

        const description = readDetailText(html);
        if (description && description.length > listing.descriptionRaw.length) {
          out[i] = { ...listing, descriptionRaw: description, location: readLocation(html) ?? listing.location };
        }
      } catch {
        // A detail page that fails keeps the title it already had - the
        // contract for enrich is best-effort.
      }
    }

    return out;
  },
};

/** Detail fetches per enrich pass. iCIMS boards here run to 150 rows, so this
 *  takes several cycles to cover one fully - which is correct: a board does not
 *  turn over 150 new postings between checks, and the cap only ever applies to
 *  listings that are new. */
const MAX_DETAIL = 40;
const DETAIL_GAP_MS = 500;

/** The job body from an iCIMS detail page. iCIMS wraps the posting in a
 *  predictable container; falling back to the whole stripped document would
 *  return the site's navigation, which is worse than the title it replaces. */
function readDetailText(html: string): string | null {
  // Everything from the job-content container onward. Anchoring on the opening
  // marker and cutting at the footer is deliberate: the container's own closing
  // tag cannot be found by regex (iCIMS nests divs several deep inside it), and
  // a pattern that guesses at the nesting silently returns a fragment.
  const marker = html.search(/class="[^"]*iCIMS_JobContent[^"]*"/i);
  // Advance past the rest of the opening tag, or its own attribute text lands
  // at the front of every description.
  const start = marker === -1 ? -1 : html.indexOf(">", marker) + 1;
  const body = start <= 0 ? html : html.slice(start);

  const text = decodeEntities(
    body
      .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

  // Site chrome that iCIMS renders around every posting. Cutting at the first
  // of these keeps the employer's own words and drops ours-look-alike
  // boilerplate that would otherwise make every listing read the same.
  const cuts = [
    "Please Enable Cookies to Continue",
    "Application FAQs",
    "Software Powered by iCIMS",
    "Need help finding the right job",
    "Connect With Us",
    "Share on your newsfeed",
    "Equal Opportunity Employer",
  ];
  let out = text;
  for (const c of cuts) {
    const i = out.indexOf(c);
    if (i > 200) out = out.slice(0, i);
  }
  // Also drop the leading cookie notice when it precedes the posting.
  const notice = out.indexOf("Please enable cookies in your browser");
  if (notice !== -1 && notice < 400) {
    const resume = out.indexOf("Overview", notice);
    const resume2 = out.indexOf("Responsibilities", notice);
    const from = [resume, resume2].filter((n) => n > -1).sort((a, b) => a - b)[0];
    if (from !== undefined) out = out.slice(from);
  }

  out = out.trim();
  return out.length >= 150 ? out.slice(0, 6000) : null;
}

function readLocation(html: string): string | null {
  // "IB Analyst - Real Estate in Saint Louis, Missouri | Careers at ..." - the
  // document title states it plainly and survives markup changes better than
  // any field selector on the page.
  const title = /<title>([\s\S]{0,200}?)<\/title>/i.exec(html)?.[1];
  if (!title) return null;
  const m = /\sin\s+([^|<]{3,60}?)\s*(?:\||$)/.exec(decodeEntities(title));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}
