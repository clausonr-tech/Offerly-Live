import "server-only";
import { safeFetch } from "../safe-fetch";
import { listingsContentHash } from "./scrape-helpers";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";

/**
 * Oracle Recruiting Cloud (`*.fa.*oraclecloud.com/hcmUI/CandidateExperience`).
 *
 * The second most common ATS in this firm set after Workday, and the one
 * behind several of the largest names here - JPMorgan, Lazard, Cantor
 * Fitzgerald, BGC and BDO all run their candidate site on it.
 *
 * Like Workday it renders client-side, so the careers page itself is unreadable
 * to a crawler, and like Workday it has a plain REST endpoint underneath:
 *
 *   GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *       ?onlyData=true
 *       &expand=requisitionList.secondaryLocations
 *       &finder=findReqs;siteNumber={site},limit={n},offset={o}
 *
 * Two things about that URL are load-bearing and easy to get wrong:
 *
 *  - `expand` is not optional. Without it the response still arrives with a
 *    correct TotalJobsCount and an EMPTY requisitionList, which reads as a
 *    board with no jobs rather than as a malformed request.
 *  - the `finder` value must keep its literal semicolons and commas. URL
 *    encoding them returns 400.
 *
 * THE LIST RESPONSE IS NOT ALWAYS ENOUGH. This file used to say the list
 * carries the description "so unlike Workday this connector needs no second
 * request per listing". That is true of some tenants and false of others, and
 * nothing distinguished the two.
 *
 * Measured against Lazard's tenant on 20 September 2026: every one of
 * `ShortDescriptionStr`, `ExternalResponsibilitiesStr` and
 * `ExternalQualificationsStr` - the three fields `toListing` reads - comes
 * back EMPTY, so `descriptionRaw` fell to its `|| req.Title` fallback and the
 * stored description was the title again, around 64 characters. 49 real
 * Lazard internships sat in the review queue unjudgeable, plus 10 at BDO on
 * the same connector, because a thin description is held rather than guessed
 * at.
 *
 * The text is there; it is on the DETAIL endpoint, in a field the list does
 * not return at all:
 *
 *   GET /hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
 *       ?onlyData=true&expand=all&finder=ById;Id={reqId},siteNumber={site}
 *
 * which answers with `ExternalDescriptionStr` - 4,509 characters for Lazard's
 * "2027 - M&A Internship Brussels". Hence `enrich` below. Tenants that DO
 * populate the list fields still pay nothing for it: monitor-run only calls
 * `enrich` for listings `isThinDescription` has already judged thin.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
const PAGE_SIZE = 50;
/** Caps a check at 250 requisitions. The largest tenant here lists thousands
 *  globally and the classifier discards all but the student programmes. */
const MAX_PAGES = 5;
/** Detail requests per check, and the gap between them. Same shape and the
 *  same numbers as the Workday connector: one request per thin listing is
 *  affordable precisely because only thin ones are asked for. */
const MAX_DETAIL = 60;
const DETAIL_GAP_MS = 400;

type OracleRef = { origin: string; site: string };

/** The detail endpoint's fields, which are a superset of the list's. */
type OracleDetail = {
  ExternalDescriptionStr?: string | null;
  ShortDescriptionStr?: string | null;
  ExternalResponsibilitiesStr?: string | null;
  ExternalQualificationsStr?: string | null;
};

/**
 * Pulls the tenant origin and site number out of a candidate-experience URL.
 *
 * Shapes seen across this firm set:
 *   https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions
 *   https://icbpjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/LazardStudentCareers/jobs
 *   https://hdow.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1003
 */
function parseOracleUrl(rawUrl: string): OracleRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/\.oraclecloud\.com$/.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const at = segments.indexOf("sites");
  const site = at === -1 ? null : segments[at + 1];
  if (!site) return null;

  return { origin: url.origin, site };
}

type OracleReq = {
  Id?: string;
  Title?: string;
  PostedDate?: string;
  PostingEndDate?: string | null;
  PrimaryLocation?: string;
  ShortDescriptionStr?: string;
  ExternalResponsibilitiesStr?: string;
  ExternalQualificationsStr?: string;
  JobFamily?: string | null;
  JobFunction?: string | null;
  JobType?: string | null;
};

function stripHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchPage(
  ref: OracleRef,
  offset: number,
): Promise<{ total: number; list: OracleReq[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Built by hand rather than with URLSearchParams: the finder syntax uses
    // bare ";" and "," which URLSearchParams would percent-encode, and Oracle
    // answers an encoded finder with 400.
    const query =
      `onlyData=true&expand=requisitionList.secondaryLocations` +
      `&finder=findReqs;siteNumber=${encodeURIComponent(ref.site)},limit=${PAGE_SIZE},offset=${offset}`;
    const res = await safeFetch(
      `${ref.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${query}`,
      {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;

    const body = (await res.json()) as {
      items?: { TotalJobsCount?: number; requisitionList?: OracleReq[] }[];
    };
    const item = body.items?.[0];
    if (!item) return null;
    return { total: item.TotalJobsCount ?? 0, list: item.requisitionList ?? [] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toListing(req: OracleReq, ref: OracleRef): NormalizedListing | null {
  if (!req.Title || !req.Id) return null;
  const listingUrl = `${ref.origin}/hcmUI/CandidateExperience/en/sites/${ref.site}/job/${req.Id}`;
  const description = [
    stripHtml(req.ShortDescriptionStr),
    stripHtml(req.ExternalResponsibilitiesStr),
    stripHtml(req.ExternalQualificationsStr),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    externalJobId: req.Id,
    title: req.Title,
    division: req.JobFamily ?? req.JobFunction ?? null,
    location: req.PrimaryLocation ?? null,
    descriptionRaw: description || req.Title,
    employmentType: req.JobType ?? null,
    applicationUrl: listingUrl,
    listingUrl,
    // The day the requisition was posted - a real observation of when the
    // role opened, the same field Workday's startDate provides.
    publishedAt: req.PostedDate ?? null,
    // Oracle exposes a real closing date on tenants that set one; most here
    // leave it null, and null stays null rather than becoming a guess.
    deadlineAt: req.PostingEndDate ?? null,
  };
}

export const oracleHcmConnector: SourceConnector = {
  id: "oracle-hcm",

  canHandle(source: SourceRef): boolean {
    return parseOracleUrl(source.careersUrl) !== null;
  },

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const ref = parseOracleUrl(source.careersUrl);
    if (!ref) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const listings: NormalizedListing[] = [];
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES && page * PAGE_SIZE < total; page++) {
      const body = await fetchPage(ref, page * PAGE_SIZE);
      if (!body) {
        // First-page failure is a dead source; a later-page failure is a
        // partial read whose listings are still real.
        if (page === 0) {
          return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
        }
        break;
      }
      total = body.total;
      for (const req of body.list) {
        const listing = toListing(req, ref);
        if (listing) listings.push(listing);
      }
      if (body.list.length === 0) break;
    }

    const contentHash = listingsContentHash(listings);

    return { listings, etag: null, contentHash, httpStatus: 200, notModified: false };
  },

  /**
   * Fetch the real posting text for listings the list response left bare.
   *
   * Best-effort by contract: a listing whose detail request fails, times out
   * or returns nothing recognisable is passed through untouched rather than
   * blanked, so a bad request can never turn a thin description into no
   * description.
   *
   * `ExternalDescriptionStr` first because it is the field Lazard actually
   * populates, then the three the list endpoint uses, so a tenant that splits
   * its text across responsibilities and qualifications is still read whole.
   */
  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    const out = [...listings];
    let fetched = 0;

    for (let i = 0; i < out.length && fetched < MAX_DETAIL; i++) {
      const listing = out[i];
      // The site and origin come from the listing's own URL, which `toListing`
      // built in exactly the shape parseOracleUrl reads.
      const ref = parseOracleUrl(listing.listingUrl);
      if (!ref || !listing.externalJobId) continue;

      if (fetched > 0) await new Promise((r) => setTimeout(r, DETAIL_GAP_MS));
      fetched += 1;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        // Same rule as the list finder: the semicolon and comma are literal,
        // and encoding them returns 400.
        const query =
          `onlyData=true&expand=all` +
          `&finder=ById;Id=${encodeURIComponent(listing.externalJobId)},siteNumber=${encodeURIComponent(ref.site)}`;
        const res = await safeFetch(
          `${ref.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?${query}`,
          {
            headers: { accept: "application/json", "user-agent": USER_AGENT },
            signal: controller.signal,
          },
        );
        if (!res.ok) continue;

        const body = (await res.json()) as { items?: OracleDetail[] };
        const detail = body.items?.[0];
        if (!detail) continue;

        const text = [
          stripHtml(detail.ExternalDescriptionStr),
          stripHtml(detail.ShortDescriptionStr),
          stripHtml(detail.ExternalResponsibilitiesStr),
          stripHtml(detail.ExternalQualificationsStr),
        ]
          .filter(Boolean)
          .join(" ");

        // Only an improvement is written. Equal-or-worse text is not worth
        // replacing a stored description with.
        if (text.length > listing.descriptionRaw.trim().length) {
          out[i] = { ...listing, descriptionRaw: text };
        }
      } catch {
        // Best-effort: leave this listing as it was.
      } finally {
        clearTimeout(timer);
      }
    }

    return out;
  },
};
