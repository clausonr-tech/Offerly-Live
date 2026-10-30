import "server-only";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import { sha256, humanize, enrichThinListings } from "./scrape-helpers";

/**
 * Kroll (`careers.kroll.com`).
 *
 * A firm-specific connector, deliberately. The September 2026 census probed
 * 40 firms that yield nothing and asked whether a GENERAL sitemap connector
 * was worth building: 29 publish a sitemap, only three list real vacancies,
 * and of those three one was already reachable via TalentLink. Two new firms
 * for a general connector is not worth it.
 *
 * Kroll on its own is. It publishes all 381 open requisitions in one sitemap,
 * 28 of them internships, and the firm currently yields zero - the single
 * largest coverage gap on the monitored list.
 *
 * TWO THINGS MAKE THIS CHEAP
 * --------------------------
 * The sitemap is 82KB and carries `lastmod` per job, so the index costs one
 * request per check and the content hash moves only when a requisition is
 * added, removed, or edited.
 *
 * And the detail pages are, unusually, structured: Kroll emits the whole
 * requisition as `<meta name="job-*">` tags - id, title, function, city,
 * country, posted date, working mode, and `job-requisitiontype` which says
 * "Internship" outright. So enrichment reads stated fields rather than
 * scraping prose out of a 140KB page.
 *
 * WHY NOT AN API
 * --------------
 * There isn't one we may use. Both `www.kroll.com/robots.txt` and
 * `careers.kroll.com/robots.txt` disallow `/api/`. The sitemap is explicitly
 * advertised in robots.txt and the job pages are not disallowed, so this path
 * is the one the site actually offers.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
const SITEMAP_URL = "https://careers.kroll.com/en/sitemap.xml";

/**
 * Detail fetches per pass.
 *
 * Sized against the board rather than guessed: 28 of the 381 requisitions are
 * internship-shaped, and monitor-run puts those at the front of the queue, so
 * one pass covers every internship on the board with room to spare. The other
 * 353 are not worth a request - they are rejected on title alone, and a
 * listing that will never be published does not need its description.
 */
const MAX_DETAIL = 40;
const DETAIL_GAP_MS = 500;

// Kroll's own decoder, kept private on purpose: unlike the shared
// scrape-helpers version it does not decode `&#160;` or numeric character
// references, and the content hashes fed by stripHtml depend on that.
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" and not to "<".
    .replace(/&amp;/g, "&");
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export type KrollJobRef = { listingUrl: string; city: string; slug: string; jobId: string };

/**
 * A job URL, or null for the ~11 non-job pages the same sitemap carries.
 *
 * Anchored on the `/en/job/{city}/{slug}/{id}` shape rather than on "does the
 * path contain the word job", because that looser test is the one this
 * codebase has already got wrong twice - once counting a news article at
 * `/opening-doors-to-a-more-secure-future/`, once counting nothing at all
 * because Kroll nests the location and title between `/job/` and the
 * requisition id. The id being numeric is what makes the shape unambiguous.
 */
export function parseKrollJobUrl(raw: string): KrollJobRef | null {
  try {
    const url = new URL(raw);
    if (url.hostname !== "careers.kroll.com") return null;
    const m = /^\/en\/job\/([^/]+)\/([^/]+)\/(\d+)\/?$/.exec(url.pathname);
    if (!m) return null;
    return { listingUrl: `${url.origin}${url.pathname}`, city: m[1], slug: m[2], jobId: m[3] };
  } catch {
    return null;
  }
}

/** `<meta name="job-title" content="...">`, in whatever attribute order. */
function readMeta(html: string, name: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]*\\bname=["']${name}["'][^>]*\\bcontent=["']([\\s\\S]*?)["']\\s*/?>`,
    "i",
  );
  const m = pattern.exec(html);
  if (!m) return null;
  const value = decodeEntities(m[1]).trim();
  return value.length ? value : null;
}

/** ISO, and only when Kroll states one. An unparseable date is dropped rather
 *  than approximated - `publishedAt` is load-bearing for season logic. */
function readPostedAt(html: string): string | null {
  const raw = readMeta(html, "job-posteddate");
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export const krollConnector: SourceConnector = {
  id: "kroll",

  canHandle(source: SourceRef): boolean {
    try {
      return new URL(source.careersUrl).hostname === "careers.kroll.com";
    } catch {
      return false;
    }
  },

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/xml" };
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const response = await safeFetch(SITEMAP_URL, { headers, timeoutMs: TIMEOUT_MS });

    if (response.status === 304) {
      return {
        listings: [],
        etag: source.lastEtag,
        contentHash: "",
        httpStatus: 304,
        notModified: true,
      };
    }
    if (!response.ok) {
      return {
        listings: [],
        etag: null,
        contentHash: "",
        httpStatus: response.status,
        notModified: false,
      };
    }

    const xml = await response.text();

    // <lastmod> is optional in the schema, so it is captured per entry rather
    // than assumed - it feeds the hash only, never a date we publish.
    const entries = [
      ...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]*)<\/lastmod>)?/g),
    ];

    const listings: NormalizedListing[] = [];
    const hashLines: string[] = [];
    const seen = new Set<string>();

    for (const [, loc, lastmod] of entries) {
      const ref = parseKrollJobUrl(loc.trim());
      if (!ref || seen.has(ref.jobId)) continue;
      seen.add(ref.jobId);

      hashLines.push(`${ref.listingUrl}|${(lastmod ?? "").trim()}`);

      /**
       * Title and location come from the URL slug here and are PROVISIONAL.
       *
       * The sitemap carries no titles, and fetching 381 detail pages to learn
       * them would spend the whole request budget re-reading a board that
       * barely changes. The slug is Kroll's own rendering of the title, so
       * this loses punctuation ("Intern, Valuation Services" arrives as
       * "Intern Valuation Services") and nothing else - and `enrich` replaces
       * both with the stated `job-title` and `job-city` before anything is
       * classified or shown.
       *
       * It matters that the slug survives this intact, because monitor-run
       * decides enrichment ORDER by testing the title for internship words.
       * Kroll writes "intern-valuation-services" into the path, so the 28
       * internships sort to the front of the queue without a single detail
       * fetch having happened yet.
       */
      listings.push({
        externalJobId: ref.jobId,
        title: humanize(ref.slug),
        division: null,
        location: humanize(ref.city),
        descriptionRaw: "",
        employmentType: null,
        applicationUrl: ref.listingUrl,
        listingUrl: ref.listingUrl,
        publishedAt: null,
        deadlineAt: null,
      });
    }

    return {
      listings,
      etag: response.headers.get("etag"),
      // Over the listings, not the XML: the sitemap also lists marketing pages
      // whose lastmod moves on every content edit, and hashing those would
      // report a changed board every check and run the diff for nothing.
      contentHash: sha256(hashLines.sort().join("\n")),
      httpStatus: response.status,
      notModified: false,
    };
  },

  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    return enrichThinListings(
      listings,
      { userAgent: USER_AGENT, timeoutMs: TIMEOUT_MS, maxDetail: MAX_DETAIL, gapMs: DETAIL_GAP_MS },
      (html, listing) => {
        const description = stripHtml(readMeta(html, "job-description") ?? "");
        if (!description) return null;

        const city = readMeta(html, "job-city");
        const country = readMeta(html, "job-country");
        const location = [city, country].filter(Boolean).join(", ") || listing.location;

        return {
          ...listing,
          title: readMeta(html, "job-title") ?? listing.title,
          division: readMeta(html, "job-function") ?? listing.division,
          location,
          descriptionRaw: description,
          // "Internship", "Experienced Hire", "Campus" - Kroll's own word for
          // what this requisition is, not our reading of the title.
          employmentType: readMeta(html, "job-requisitiontype") ?? listing.employmentType,
          publishedAt: readPostedAt(html) ?? listing.publishedAt,
        };
      },
    );
  },
};
