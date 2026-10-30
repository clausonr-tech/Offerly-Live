import "server-only";
import { safeFetch } from "../safe-fetch";
import { listingsContentHash } from "./scrape-helpers";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { htmlToText } from "../html-text";

/**
 * Workday (*.myworkdayjobs.com) - by a distance the most common ATS in this
 * firm set. 19 of the 108 investment banks monitored here run their careers
 * site on it, against 5 on TalentLink and one or two apiece on everything else.
 *
 * Worth a connector because Workday has a real JSON API behind the rendered
 * page, and the rendered page is the exact kind of client-side React app the
 * generic connector cannot read:
 *
 *   POST /wday/cxs/{tenant}/{site}/jobs   -> { total, jobPostings[] }
 *   GET  /wday/cxs/{tenant}/{site}{path}  -> { jobPostingInfo }
 *
 * The list gives titles, locations and stable paths; the detail gives the full
 * description, the requisition id, and `startDate` - the day the posting went
 * live, which is a real observation about when a programme opened rather than
 * an inference from one.
 *
 * No browser, no model. The same "structured sources parse directly" rule the
 * Greenhouse and TalentLink connectors follow.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
const PAGE_SIZE = 20;
/** At most 100 postings per source per check. A handful of tenants list
 *  thousands of roles globally; this pipeline wants the student programmes,
 *  and paging forever to find them would be a burst of requests at one host
 *  for information the classifier discards anyway. */
const MAX_PAGES = 5;
/**
 * Detail fetches per enrich pass - see SourceConnector.enrich.
 *
 * Raised from 8 after the first live crawl: Workday boards here return 40-100
 * listings, so a cap of 8 left the other 90% with nothing but a title. The
 * classifier reads eligibility and requirements out of the description, so a
 * title-only listing cannot be judged and cannot be published - the cap was
 * silently deciding that most real postings would never reach a student.
 *
 * A Workday detail call is a JSON GET, not a browser render, and this runs
 * twice a day per source behind the fetch pool's per-domain gap. 60 requests
 * on that schedule is a rounding error to the host and the difference between
 * a usable pipeline and an empty one.
 */
const MAX_DETAIL = 60;
const DETAIL_GAP_MS = 400;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type WorkdayRef = { origin: string; tenant: string; site: string };

/**
 * Pulls the tenant and site out of a careers URL.
 *
 * Shapes seen in the wild across this firm set:
 *   https://pjtpartners.wd1.myworkdayjobs.com/Students
 *   https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers
 *   https://mizuho.wd1.myworkdayjobs.com/mizuhoamericas
 *   https://cibc.wd3.myworkdayjobs.com/search?q=...        <- no site at all
 *
 * The tenant is the first hostname label. The site is the first path segment
 * that is not a locale. Returns null when there is no site segment - some
 * firms link straight at a search page, and guessing a site id would just
 * produce 404s against someone else's server.
 */
function parseWorkdayUrl(rawUrl: string): WorkdayRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  /**
   * Exact host or a subdomain of it, on a DOT boundary.
   *
   * A bare endsWith also accepts `evilmyworkdayjobs.com`. Workday is by a
   * distance the most common ATS here, so this is the widest-reaching version
   * of a trap the newer connectors all guard explicitly. Found by
   * connector-registry.test.ts alongside the same bug in Greenhouse.
   */
  const host = url.hostname.toLowerCase();
  if (host !== "myworkdayjobs.com" && !host.endsWith(".myworkdayjobs.com")) return null;

  const tenant = url.hostname.split(".")[0];
  if (!tenant) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  // Locale segments ("en-US", "fr-CA") sit in front of the site id on some
  // tenants and are not part of it.
  const site = segments.find((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s));
  if (!site || site === "search" || site === "job") return null;

  return { origin: url.origin, tenant, site };
}

type WorkdayPosting = {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
};

async function postJobs(
  ref: WorkdayRef,
  offset: number,
): Promise<{ total: number; jobPostings: WorkdayPosting[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await safeFetch(`${ref.origin}/wday/cxs/${ref.tenant}/${ref.site}/jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: "" }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as { total: number; jobPostings: WorkdayPosting[] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toListing(p: WorkdayPosting, ref: WorkdayRef): NormalizedListing | null {
  if (!p.title || !p.externalPath) return null;
  const listingUrl = `${ref.origin}/${ref.site}${p.externalPath}`;
  return {
    // The requisition id trailing the path ("..._R0003510") is Workday's own
    // stable identifier and survives a retitled posting.
    externalJobId: /_([A-Za-z0-9-]+)$/.exec(p.externalPath)?.[1] ?? sha256(listingUrl),
    title: p.title,
    division: null,
    location: p.locationsText ?? null,
    // The list endpoint carries no description. enrich() fills it from the
    // detail endpoint for listings that turn out to be new.
    descriptionRaw: [p.title, ...(p.bulletFields ?? [])].join(" - "),
    employmentType: null,
    applicationUrl: listingUrl,
    listingUrl,
    publishedAt: null,
    deadlineAt: null,
  };
}

export const workdayConnector: SourceConnector = {
  id: "workday",

  canHandle(source: SourceRef): boolean {
    return parseWorkdayUrl(source.careersUrl) !== null;
  },

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const ref = parseWorkdayUrl(source.careersUrl);
    if (!ref) {
      // A Workday host with no identifiable site - reported as a clean empty
      // result rather than an error. Nothing is broken; we just cannot tell
      // which board this URL means.
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const listings: NormalizedListing[] = [];
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES && page * PAGE_SIZE < total; page++) {
      const body = await postJobs(ref, page * PAGE_SIZE);
      if (!body) {
        // A failure on the first page is a dead source; on a later page it is
        // a partial read, and the listings already collected are still real.
        if (page === 0) {
          return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
        }
        break;
      }
      total = body.total ?? 0;
      for (const p of body.jobPostings ?? []) {
        const listing = toListing(p, ref);
        if (listing) listings.push(listing);
      }
      if (!body.jobPostings?.length) break;
    }

    const contentHash = listingsContentHash(listings);

    return { listings, etag: null, contentHash, httpStatus: 200, notModified: false };
  },

  /**
   * Fills in the real description and posting date from each new listing's
   * detail endpoint.
   *
   * `startDate` is the useful field: the day Workday published the posting. It
   * is recorded as publishedAt rather than as a deadline, because it says when
   * the role opened, not when it closes - most tenants here publish no closing
   * date at all, and inventing one from a start date would be exactly the
   * guess this pipeline refuses to make.
   */
  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    const out = [...listings];
    let fetched = 0;

    for (let i = 0; i < out.length && fetched < MAX_DETAIL; i++) {
      const listing = out[i];
      const ref = parseWorkdayUrl(listing.listingUrl);
      if (!ref) continue;

      const path = new URL(listing.listingUrl).pathname.replace(`/${ref.site}`, "");
      if (fetched > 0) await new Promise((r) => setTimeout(r, DETAIL_GAP_MS));
      fetched += 1;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const res = await safeFetch(`${ref.origin}/wday/cxs/${ref.tenant}/${ref.site}${path}`, {
          headers: { accept: "application/json", "user-agent": USER_AGENT },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) continue;

        const info = ((await res.json()) as { jobPostingInfo?: Record<string, unknown> })
          .jobPostingInfo;
        if (!info) continue;

        const description =
          typeof info.jobDescription === "string"
            ? htmlToText(info.jobDescription)
            : "";

        out[i] = {
          ...listing,
          descriptionRaw: description.length > listing.descriptionRaw.length
            ? description
            : listing.descriptionRaw,
          location: typeof info.location === "string" ? info.location : listing.location,
          publishedAt: typeof info.startDate === "string" ? info.startDate : listing.publishedAt,
          externalJobId:
            typeof info.jobReqId === "string" ? info.jobReqId : listing.externalJobId,
        };
      } catch {
        // Detail is a bonus; the index-page listing stands on its own.
      }
    }

    return out;
  },
};
