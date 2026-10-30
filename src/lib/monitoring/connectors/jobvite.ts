import "server-only";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import {
  sha256,
  decodeEntities,
  stripHtml,
  extractJsonLd,
  findJobPosting,
  readJsonLdLocation,
  enrichThinListings,
} from "./scrape-helpers";

/**
 * Jobvite (`jobs.jobvite.com/<company>`).
 *
 * TWO PAGES, TWO DIFFERENT PROBLEMS
 * ---------------------------------
 * The board at `/<company>/jobs` is server-rendered HTML and carries NO
 * structured data - so a plain fetch can read it, but only by looking at
 * anchors. The posting pages DO carry a full `JobPosting` JSON-LD block. So
 * the index is scraped and the detail is parsed, which is the reverse of the
 * usual split and the reason this is a connector rather than a generic source.
 *
 * Left to the generic connector, the board's lack of JSON-LD would send it
 * down the Chromium path on every single check, to rediscover anchors that
 * were already in the served bytes. Verified 19 September 2026 against
 * Starwood Capital Group, whose board carries two real internships under a
 * "Campus" heading.
 *
 * `jobs.jobvite.com` serves no robots.txt at all - it answers 404 - which
 * under the standard is permission. See lib/monitoring/robots.ts on failing
 * open deliberately.
 */

const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;

/** Detail fetches per pass. Jobvite boards are tens of roles, not thousands,
 *  and monitor-run puts internship-shaped titles at the front of the queue. */
const MAX_DETAIL = 25;
const DETAIL_GAP_MS = 500;

/**
 * The company slug from any Jobvite board or posting URL.
 *
 * Jobvite answers on two path shapes for the same board - `/<company>/jobs`
 * and `/careers/<company>/jobs` - and board discovery recorded the second.
 * Both are accepted and normalised to the first, so a source registered from
 * either reads the same board.
 */
export function parseJobviteCompany(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "jobvite.com" && !host.endsWith(".jobvite.com")) return null;

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;

    const company = segments[0].toLowerCase() === "careers" ? segments[1] : segments[0];
    if (!company) return null;
    // `/jobs` and `/job` are page names, never a company - a bare
    // `jobs.jobvite.com/jobs` is not a board we can read.
    if (["jobs", "job", "careers"].includes(company.toLowerCase())) return null;
    return company;
  } catch {
    return null;
  }
}

/** A posting id from `/<company>/job/<id>`, or null for any other link.
 *  Anchored on the `/job/` segment rather than on "the path contains job",
 *  because the board's own `/jobs` link would pass that looser test. */
export function parseJobviteJobId(rawHref: string, company: string): string | null {
  try {
    const url = new URL(rawHref, "https://jobs.jobvite.com");
    const segments = url.pathname.split("/").filter(Boolean);
    const at = segments.findIndex((s) => s.toLowerCase() === "job");
    if (at < 0 || at + 1 >= segments.length) return null;
    // The company must match the board being read - a Jobvite page can link
    // out to another employer's posting, and that is not this firm's opening.
    const owner = segments[0].toLowerCase() === "careers" ? segments[1] : segments[0];
    if (!owner || owner.toLowerCase() !== company.toLowerCase()) return null;
    const id = segments[at + 1];
    return id || null;
  } catch {
    return null;
  }
}

/**
 * The board page's anchors as listings.
 *
 * Exported for the fixture tests: the board is HTML, so this is the part most
 * likely to break when Jobvite changes its markup, and it needs no network.
 */
export function parseJobviteBoardHtml(html: string, company: string): NormalizedListing[] {
  const listings: NormalizedListing[] = [];
  const seen = new Set<string>();

  const anchor = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html))) {
    const [, rawHref, inner] = match;
    const id = parseJobviteJobId(decodeEntities(rawHref).trim(), company);
    if (!id || seen.has(id)) continue;

    const title = stripHtml(inner);
    /**
     * The same posting is linked twice on some boards - once from the title
     * and once from a bare "Apply" or an icon - and only one of those names
     * the role. Skipping the text-free one WITHOUT marking the id as seen
     * leaves the real link to be found further down the page; marking it
     * would lose the posting entirely whenever the icon link comes first.
     */
    if (!title) continue;

    seen.add(id);
    const url = `https://jobs.jobvite.com/${company}/job/${id}`;

    listings.push({
      externalJobId: id,
      title,
      division: null,
      location: null,
      /**
       * The board page carries no description - it is a table of titles. This
       * starts as the title and `enrich` replaces it from the posting page's
       * JSON-LD, which is where the real text lives.
       */
      descriptionRaw: title,
      employmentType: null,
      applicationUrl: url,
      listingUrl: url,
      // Stated only on the detail page; never inferred here.
      publishedAt: null,
    });
  }

  return listings;
}

export const jobviteConnector: SourceConnector = {
  id: "jobvite",

  canHandle: (source: SourceRef) => parseJobviteCompany(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const company = parseJobviteCompany(source.careersUrl);
    if (!company) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    };
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const boardUrl = `https://jobs.jobvite.com/${encodeURIComponent(company)}/jobs`;
    const response = await safeFetch(boardUrl, { headers, timeoutMs: TIMEOUT_MS });

    if (response.status === 304) {
      return { listings: [], etag: source.lastEtag, contentHash: "", httpStatus: 304, notModified: true };
    }
    if (!response.ok) {
      return { listings: [], etag: null, contentHash: "", httpStatus: response.status, notModified: false };
    }

    const listings = parseJobviteBoardHtml(await response.text(), company);

    return {
      listings,
      etag: response.headers.get("etag"),
      // Hashed over what was EXTRACTED, per the contract in types.ts - the
      // board page carries rotating markup that a page hash would trip on.
      contentHash: sha256(
        listings.map((l) => `${l.externalJobId}|${l.title}`).sort().join("\n"),
      ),
      httpStatus: response.status,
      notModified: false,
    };
  },

  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    return enrichThinListings(
      listings,
      { userAgent: USER_AGENT, timeoutMs: TIMEOUT_MS, maxDetail: MAX_DETAIL, gapMs: DETAIL_GAP_MS },
      (html, listing) => {
        const node = findJobPosting(extractJsonLd(html));
        if (!node) return null;

        const description = stripHtml(
          typeof node.description === "string" ? node.description : "",
        );
        if (!description) return null;

        return {
          ...listing,
          title:
            typeof node.title === "string" && node.title.trim()
              ? decodeEntities(node.title).replace(/\s+/g, " ").trim()
              : listing.title,
          location: readJsonLdLocation(node) ?? listing.location,
          descriptionRaw: description,
          employmentType:
            typeof node.employmentType === "string" ? node.employmentType : listing.employmentType,
          publishedAt:
            typeof node.datePosted === "string" ? node.datePosted : listing.publishedAt,
        };
      },
    );
  },
};
