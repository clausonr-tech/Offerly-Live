import "server-only";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import {
  sha256,
  decodeEntities,
  stripHtml,
  humanize,
  extractJsonLd,
  findJobPosting,
  readJsonLdLocation,
  enrichThinListings,
} from "./scrape-helpers";

/**
 * Robert W. Baird (`bairdcareers.com`).
 *
 * WHY THIS EXISTS: A 403 THAT WAS NOT A REFUSAL
 * ---------------------------------------------
 * Baird's careers board answered 403 to the generic connector, and that was
 * recorded as "a real investment bank actively refusing the crawler". Reading
 * `bairdcareers.com/robots.txt` says otherwise. It opens with:
 *
 *   User-agent: *
 *   Allow: /
 *   Disallow: /cdn-cgi/
 *
 * and closes with `sitemap:https://bairdcareers.com/sitemap.xml`. The only
 * disallowed path is Cloudflare's own endpoint. So the site permits this
 * crawler and advertises a sitemap TO it; the 403 is Cloudflare bot
 * management on the rendered board, which is a different thing from a policy
 * refusal and has a permitted answer sitting in robots.txt.
 *
 * That answer is the same one Kroll got: read the sitemap the site publishes
 * for crawlers instead of fighting the page built for humans. See kroll.ts,
 * which this follows closely.
 *
 * WHAT THE SITEMAP GIVES
 * ----------------------
 * 176 URLs, 119 of them jobs, regenerated hourly. Each job URL carries both
 * the requisition id and the role name:
 *
 *   https://www.bairdcareers.com/jobs/r20261002/internship-marketing-year-round/
 *
 * The id makes `externalJobId` real rather than synthesised - which is the
 * difference between a posting the quality gate can verify and one it cannot
 * (see posting-quality.ts) - and the slug puts internship-shaped titles at the
 * front of monitor-run's enrichment queue without a single detail fetch.
 *
 * And the detail pages carry a clean `JobPosting` JSON-LD block, so enrichment
 * reads stated fields rather than scraping prose.
 *
 * ONE CAUTION FOR WHOEVER READS THIS NEXT
 * ---------------------------------------
 * Baird's robots.txt separately names `ClaudeBot` and `anthropic-ai` under
 * `Disallow: /`. That does not apply to this crawler, which identifies as
 * OfferlyMonitor - but it does mean this host must not be bulk-read from
 * inside an AI agent session. Verify it by running the crawler, not by
 * pointing an assistant at it.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
const SITEMAP_URL = "https://www.bairdcareers.com/sitemap.xml";

/**
 * Detail fetches per pass.
 *
 * Sized against the board: 119 jobs, of which the internship-shaped ones are a
 * minority and sort to the front. The rest are rejected on title alone and a
 * listing that will never be published does not need its description.
 */
const MAX_DETAIL = 40;
const DETAIL_GAP_MS = 500;

export type BairdJobRef = { listingUrl: string; jobId: string; slug: string };

/**
 * A job URL, or null for the ~57 non-job pages the same sitemap carries.
 *
 * Anchored on the `/jobs/{id}/{slug}/` shape with a requisition-shaped id,
 * rather than on "the path contains the word jobs". That looser test is one
 * this codebase has already got wrong on this exact host: discover-boards.ts
 * counted Baird's `/newsroom/news/2020/12/opening-doors-to-a-more-secure-future/`
 * as a board. Here it would also swallow `/jobs/`, the index page itself.
 */
export function parseBairdJobUrl(raw: string): BairdJobRef | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host !== "bairdcareers.com" && host !== "www.bairdcareers.com") return null;
    const m = /^\/jobs\/(r\d{4,})\/([^/]+)\/?$/i.exec(url.pathname);
    if (!m) return null;
    return {
      // Normalised to the host the sitemap itself uses, so the same posting
      // reached from `bairdcareers.com` and `www.bairdcareers.com` is one row.
      listingUrl: `https://www.bairdcareers.com${url.pathname}`,
      jobId: m[1].toLowerCase(),
      slug: m[2],
    };
  } catch {
    return null;
  }
}

/** ISO, and only when Baird states one - an unparseable date is dropped
 *  rather than approximated, because `publishedAt` feeds season logic. */
function toIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The sitemap's job entries as listings, plus the lines the content hash is
 * built from.
 *
 * Exported for the fixture tests: this is the half of the connector that does
 * not need a network, and the half that decides what counts as a job URL.
 */
export function parseBairdSitemap(xml: string): {
  listings: NormalizedListing[];
  hashLines: string[];
} {
  // <lastmod> is optional in the schema, so it is captured per entry rather
  // than assumed - it feeds the hash only, never a date we publish.
  const entries = [
    ...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]*)<\/lastmod>)?/g),
  ];

  const listings: NormalizedListing[] = [];
  const hashLines: string[] = [];
  const seen = new Set<string>();

  for (const [, loc, lastmod] of entries) {
    const ref = parseBairdJobUrl(decodeEntities(loc.trim()));
    if (!ref || seen.has(ref.jobId)) continue;
    seen.add(ref.jobId);

    hashLines.push(`${ref.listingUrl}|${(lastmod ?? "").trim()}`);

    listings.push({
      externalJobId: ref.jobId,
      // Provisional, from Baird's own slug - replaced by the stated title on
      // enrichment. See humanize above for what it loses.
      title: humanize(ref.slug),
      division: null,
      location: null,
      descriptionRaw: "",
      employmentType: null,
      applicationUrl: ref.listingUrl,
      listingUrl: ref.listingUrl,
      publishedAt: null,
      deadlineAt: null,
    });
  }

  return { listings, hashLines };
}

export const bairdConnector: SourceConnector = {
  id: "baird",

  canHandle(source: SourceRef): boolean {
    try {
      const host = new URL(source.careersUrl).hostname.toLowerCase();
      return host === "bairdcareers.com" || host === "www.bairdcareers.com";
    } catch {
      return false;
    }
  },

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/xml" };
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const response = await safeFetch(SITEMAP_URL, { headers, timeoutMs: TIMEOUT_MS });

    if (response.status === 304) {
      return { listings: [], etag: source.lastEtag, contentHash: "", httpStatus: 304, notModified: true };
    }
    if (!response.ok) {
      // Includes the 403 case. If Cloudflare ever closes the sitemap too, this
      // reports as an unreadable source in the audit rather than as an empty
      // board - which is the distinction that got this firm misdiagnosed once
      // already.
      return { listings: [], etag: null, contentHash: "", httpStatus: response.status, notModified: false };
    }

    const { listings, hashLines } = parseBairdSitemap(await response.text());

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
          publishedAt: toIso(node.datePosted) ?? listing.publishedAt,
          deadlineAt: toIso(node.validThrough) ?? listing.deadlineAt ?? null,
        };
      },
    );
  },
};
