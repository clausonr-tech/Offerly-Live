import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import { classifyEmployer } from "../financial-employer";
import { extractReadableText, needsDetail } from "./generic";
import { htmlToText } from "../html-text";

/**
 * Getro (`<fund>.getro.com`) - venture portfolio job boards.
 *
 * The only connector here where ONE fetch covers many firms. Every other
 * connector is one board per employer; a Getro board is a fund's whole
 * portfolio, and HV Capital's alone carries 2,420 open roles. Across 2,149
 * venture capital firms in the directory - of which 1,863 have a website and
 * NOT ONE has a careers URL - that property is the only shape that scales.
 *
 * WHY THIS EXISTS NOW AND DID NOT BEFORE
 * --------------------------------------
 * The previous session tried every endpoint shape it could think of and got
 * 404 or 400 from all of them, and recorded that a connector written against
 * an API nobody has seen respond is a guess with types on it. That was the
 * right call. What was missing was a real board URL to read the collection id
 * from. Found 19 September 2026 by reading `hv.getro.com/jobs`, whose Next.js
 * page state carries `network.id = 234`, and then:
 *
 *   POST https://api.getro.com/api/v2/collections/{networkId}/search/jobs
 *   { "page": 0, "filters": { "seniority": ["internship"] } }
 *
 * No key, no cookie, no token. Verified live before this file was written:
 * 2,420 jobs unfiltered, 159 with the internship filter applied.
 *
 * TWO THINGS THAT ARE EASY TO GET WRONG
 * -------------------------------------
 *  - GET on that path returns 404. It is POST or nothing, which is most of
 *    why the earlier attempts read as "no such endpoint".
 *  - `hitsPerPage` is ignored and the page size is fixed at 20. Asking for
 *    100 returns 20, so a connector that trusts the number it asked for will
 *    silently read a twentieth of the board and report the rest as closed.
 *
 * SERVER-SIDE FILTERING IS THE WHOLE COST STORY
 * ---------------------------------------------
 * Unfiltered, HV's board is 121 requests at 20 per page. With
 * `filters.seniority = ["internship"]` it is 159 jobs, or 8. The filter is
 * applied by Getro, so the saving is real rather than us discarding rows we
 * already paid for. Note `q` is NOT the search key - a top-level `q` is
 * silently ignored and returns the unfiltered board, while `query` works.
 *
 * WHOSE JOBS ARE THESE?
 * ---------------------
 * The fund's PORTFOLIO COMPANIES', not the fund's - and that is a problem
 * this connector has to solve rather than pass downstream. HV Capital's
 * board, filtered to internships, is largely German student warehouse and
 * retail shifts, because that is what a venture portfolio contains.
 *
 * The rule (19 September 2026) is that a portfolio company counts only when
 * it is itself a financial institution. So every listing is checked against
 * lib/monitoring/financial-employer.ts before it leaves this connector, and
 * the employer that justified it is recorded on the listing.
 *
 * Filtering HERE rather than in the classifier is deliberate. The classifier
 * judges a ROLE from its title, and "Operations Analyst" is a perfectly good
 * title at a warehouse company - nothing downstream can tell that the
 * employer is out of scope, because nothing downstream knows the employer is
 * not the firm the source belongs to.
 */

const API = "https://api.getro.com/api/v2/collections";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;

/** Fixed by the API, not by us - see the header note. Asking for more is
 *  accepted and ignored, which is the dangerous kind of ignored. */
const PAGE_SIZE = 20;
const MAX_PAGES = 15;
const PAGE_GAP_MS = 400;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A Getro board host, e.g. `hv.getro.com`. Funds also front these boards on
 *  their own domain by CNAME, and those are not recognisable from the URL -
 *  such a board reaches the generic connector instead, which is a miss rather
 *  than a mistake. */
export function parseGetroUrl(rawUrl: string): { host: string; networkId: string | null } | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    // Exact host or a subdomain of it - never a bare endsWith, which would
    // accept `evilgetro.com`.
    if (host !== "getro.com" && !host.endsWith(".getro.com")) return null;
    // The id can be carried on the URL once discovered, which saves the
    // resolve request on every subsequent check.
    return { host, networkId: url.searchParams.get("networkId") };
  } catch {
    return null;
  }
}

/**
 * The collection id behind a board, read from the page's own app state.
 *
 * Getro's boards are Next.js apps and ship `__NEXT_DATA__` inline, so this is
 * a plain GET rather than a render. Costs one request per check unless the id
 * has been stored on the source URL.
 */
export async function resolveNetworkId(host: string): Promise<string | null> {
  const response = await safeFetch(`https://${host}/jobs`, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    timeoutMs: TIMEOUT_MS,
  });
  if (!response.ok) return null;
  const html = await response.text();
  const block = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!block) return null;
  try {
    const data = JSON.parse(block[1]) as {
      props?: { pageProps?: { network?: { id?: string | number } } };
    };
    const id = data.props?.pageProps?.network?.id;
    return id === undefined || id === null ? null : String(id);
  } catch {
    return null;
  }
}

type GetroJob = {
  id: number | string;
  title: string;
  url: string;
  slug?: string;
  locations?: string[];
  searchable_locations?: string[];
  /** Unix SECONDS, not milliseconds - a listing dated 1789823177 is 2026, and
   *  read as milliseconds it would be 1970. */
  created_at?: number;
  seniority?: string | null;
  work_mode?: string | null;
  organization?: {
    name?: string;
    slug?: string;
    /** The fund's own categorisation of the portfolio company. Far better
     *  evidence than its name: nothing about "Qonto" or "Upvest" says bank,
     *  and both are. */
    industry_tags?: string[];
  } | string | null;
  description?: string | null;
};

function organizationName(job: GetroJob): string | null {
  if (typeof job.organization === "string") return job.organization;
  return job.organization?.name ?? null;
}

function toListing(job: GetroJob): NormalizedListing | null {
  if (!job.title || !job.url) return null;
  const org = organizationName(job);
  const location = job.locations?.[0] ?? job.searchable_locations?.[0] ?? null;

  return {
    externalJobId: String(job.id),
    title: job.title,
    // The employer, not a department. A Getro board is a portfolio, so
    // without this a listing reads as if the fund were hiring.
    division: org,
    location,
    /**
     * Getro's search response carries no description - `has_description` is a
     * flag and the text lives behind the underlying board (the `url` field
     * points at Greenhouse, Lever and the rest).
     *
     * So the title and employer are all a classifier gets here. That is
     * survivable because relevance in this codebase is decided on the title
     * anyway, and it is exactly the case the LLM adjudicator is meant for.
     * Writing the employer in rather than leaving this empty at least keeps
     * "Analyst, Acme Fintech" distinguishable from "Analyst" alone.
     */
    descriptionRaw: org ? `${job.title} - ${org}` : job.title,
    employmentType: job.seniority === "internship" ? "INTERN" : null,
    applicationUrl: job.url,
    listingUrl: job.url,
    publishedAt: job.created_at ? new Date(job.created_at * 1000).toISOString() : null,
  };
}

export const getroConnector: SourceConnector = {
  id: "getro",

  canHandle: (source: SourceRef) => parseGetroUrl(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const parsed = parseGetroUrl(source.careersUrl);
    if (!parsed) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const networkId = parsed.networkId ?? (await resolveNetworkId(parsed.host));
    if (!networkId) {
      // A board whose id cannot be read is reported as an empty result rather
      // than thrown, so the audit shows a source that stopped producing -
      // which is the honest shape for "their page changed".
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const listings: NormalizedListing[] = [];
    let httpStatus = 200;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0) await new Promise((r) => setTimeout(r, PAGE_GAP_MS));

      const response = await safeFetch(`${API}/${encodeURIComponent(networkId)}/search/jobs`, {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
          "content-type": "application/json",
          // Getro's API is fronted for its own boards; sending the board as
          // the origin is what a browser on that board would send.
          origin: `https://${parsed.host}`,
          referer: `https://${parsed.host}/`,
        },
        // The filter is applied on their side, which is the difference between
        // 8 requests and 121 for one board.
        body: JSON.stringify({ page, filters: { seniority: ["internship"] } }),
        timeoutMs: TIMEOUT_MS,
      });

      httpStatus = response.status;
      if (!response.ok) break;

      const body = (await response.json()) as { results?: { jobs?: GetroJob[]; count?: number } };
      const jobs = body.results?.jobs ?? [];
      for (const job of jobs) {
        const org = organizationName(job);
        const tags = typeof job.organization === "object" && job.organization
          ? job.organization.industry_tags
          : undefined;
        // No employer name means no way to show it is in scope. A portfolio
        // board is the one place where an unattributed listing cannot be
        // given the benefit of the doubt.
        if (!org) continue;
        if (!classifyEmployer(org, tags).financial) continue;

        const listing = toListing(job);
        if (listing) listings.push(listing);
      }

      // The page size is theirs, so the end of the board is "fewer than a full
      // page came back" rather than any number we chose.
      if (jobs.length < PAGE_SIZE) break;
    }

    return {
      listings,
      etag: null,
      contentHash: sha256(
        listings
          .map((l) => `${l.externalJobId}|${l.title}|${l.division}|${l.location}|${l.listingUrl}`)
          .sort()
          .join("\n"),
      ),
      httpStatus,
      notModified: false,
    };
  },

  /**
   * Fetch the real posting text from the employer's own page.
   *
   * Getro has no description to give. Its search result carries a title, an
   * organisation and a URL, so `fetch` synthesises "Title - Org" as a
   * placeholder - 79 characters at best, and `isThinDescription` rightly
   * calls that thin.
   *
   * That was costing the entire venture capital review queue. Measured 20
   * September 2026: of 53 VC listings awaiting human review, 53 had a thin
   * description, and every one of them came from Getro. A listing with no
   * description cannot be judged, so it can never be auto-approved - so no
   * amount of classifier work would have moved them. The board was simply
   * never read past its index.
   *
   * WHY THIS IS DIFFERENT FROM EVERY OTHER `enrich` HERE
   * ----------------------------------------------------
   * The other connectors fetch a detail page on the SAME vendor they just
   * read. A Getro board is a fund's whole portfolio, so each listing URL
   * belongs to a different company on a different ATS - careers.munichre.com,
   * a Greenhouse board, someone's own Rails app. There is no one shape to
   * parse, which is exactly the problem the generic connector already solves,
   * so this reuses its reader rather than inventing a second one.
   *
   * Best-effort by contract: a page that fails keeps the placeholder it had.
   */
  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    const out = [...listings];
    let fetched = 0;

    for (const [i, listing] of out.entries()) {
      // Bounded per run. A portfolio board can carry thousands of roles, and
      // this reaches out to a different company's server for each one.
      if (fetched >= MAX_ENRICH_PER_RUN) break;
      if (!needsDetail(listing)) continue;

      const html = await getDetailHtml(listing.listingUrl);
      fetched += 1;
      if (!html) continue;

      const text = descriptionFromJsonLd(html) ?? extractReadableText(html, listing.title);
      // Only replace the placeholder with something genuinely better.
      if (text && text.trim().length > listing.descriptionRaw.trim().length) {
        out[i] = { ...listing, descriptionRaw: text.trim() };
      }
    }

    return out;
  },
};

/** One portfolio board can carry thousands of roles; each detail page is a
 *  request to a different company's server. */
const MAX_ENRICH_PER_RUN = 40;

async function getDetailHtml(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
    } as Parameters<typeof safeFetch>[1]);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // A portfolio company's own site is allowed to be down, slow, or to
    // refuse us. None of that is a reason to lose the listing.
    return null;
  }
}

/**
 * The description out of a JobPosting, when the page publishes one.
 *
 * Preferred over reading the rendered text because it is the employer's own
 * statement of the role rather than whatever survived stripping the chrome
 * off their page.
 */
function descriptionFromJsonLd(html: string): string | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      const n = node as { "@type"?: unknown; description?: unknown };
      const type = Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]];
      if (!type.some((t) => String(t).toLowerCase() === "jobposting")) continue;
      if (typeof n.description !== "string") continue;
      // JSON-LD descriptions are HTML fragments more often than not.
      const text = htmlToText(n.description);
      if (text.length >= 120) return text;
    }
  }
  return null;
}
