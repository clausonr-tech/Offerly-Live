import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";

/**
 * Dayforce / Ceridian candidate portals.
 *
 * ONE REQUEST, WHOLE DESCRIPTIONS
 * -------------------------------
 * `POST /api/geo/{namespace}/jobposting/search` returns every posting on a
 * board WITH its full description inline. That is rare and worth naming: most
 * connectors here get a title and a link from the index and have to spend a
 * detail fetch per listing to learn anything a classifier can read. This one
 * needs no `enrich` at all, because eligibility, deadlines and the recruiting
 * cycle all arrive in the first response.
 *
 * THE HOST IS PART OF THE COMPLIANCE DECISION
 * -------------------------------------------
 * Dayforce serves the same tenant from two places, and they are NOT equivalent:
 *
 *   - `jobs.dayforcehcm.com/robots.txt` carries comments only - no
 *     `User-agent`, no `Disallow` - which under the standard means everything
 *     is permitted.
 *   - `us231.dayforcehcm.com/robots.txt` REDIRECTS to
 *     `www.dayforcehcm.com/robots.txt`, which is `User-agent: * / Disallow: /`.
 *
 * So the per-instance hosts are disallowed and the shared one is not. Board
 * discovery recorded Realterm at a `us231` URL, and reading it there would
 * have been a robots violation; the same tenant answers on
 * `jobs.dayforcehcm.com` with the same four postings. This connector therefore
 * parses the tenant out of WHICHEVER url shape it is handed and always talks
 * to the permitted host. Measured 19 September 2026.
 *
 * WHY THERE IS A CSRF DANCE
 * -------------------------
 * The search endpoint answers 403 "Forbidden" to any body, correct or not,
 * without an `x-csrf-token` header. The token comes from the portal's NextAuth
 * route, and the cookies set alongside it have to come back with the POST -
 * it is a double-submit check, so the header alone is not enough from a
 * cookieless client. Two requests per board, not one; still far cheaper than
 * the Chromium launch this replaces.
 */

const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;

/** The shared, robots-permitted host. Never `us231` and friends - see above. */
const API_ORIGIN = "https://jobs.dayforcehcm.com";

/** The board's own page size. Matching it means `paginationStart` lands on the
 *  boundaries the server expects rather than straddling them. */
const PAGE_SIZE = 25;

/** A board this size does not exist; the cap is here so a server that ignores
 *  `paginationStart` cannot spin this loop forever. */
const MAX_PAGES = 20;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&#(\d{2,5});/g, (_, code) => String.fromCodePoint(Number(code)))
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" and not to "<".
    .replace(/&amp;/g, "&");
}

/**
 * Dayforce descriptions are HTML with `&nbsp;` and `&rsquo;` throughout, and
 * the classifier reads phrases. Tags become spaces rather than being deleted,
 * because `<li>Intern</li><li>Analyst</li>` collapsed without them reads as
 * one word that is neither.
 */
function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export type DayforceBoardRef = { namespace: string; boardCode: string };

/**
 * The tenant and board behind either URL shape Dayforce publishes.
 *
 *   https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL
 *   https://us231.dayforcehcm.com/CandidatePortal/EN-US/Realterm/Site/Candidateportal
 *
 * Both are real, both came out of board discovery, and they nest the tenant at
 * different depths. Anchored on the `/Site/` marker rather than on a segment
 * index, because the per-instance shape carries a locale that may or may not
 * be present and counting positions gets that wrong.
 *
 * Case is preserved deliberately: the API rejects `realterm` and accepts
 * `Realterm`, so lowercasing the tenant here would silently empty the board.
 */
export function parseDayforceBoard(rawUrl: string): DayforceBoardRef | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "dayforcehcm.com" && !host.endsWith(".dayforcehcm.com")) return null;

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;

    /**
     * Per-instance shape: `.../{tenant}/Site/{boardCode}`.
     *
     * A `/Site/` marker settles which shape this is, so a TRUNCATED
     * per-instance URL returns null rather than falling through to the shared
     * branch below. It has to: `/CandidatePortal/EN-US/Acme/Site` read as the
     * shared shape yields tenant "CandidatePortal", board code "EN-US" - a
     * board that does not exist, requested confidently. Found by
     * dayforce-url.test.ts, not by reading this.
     */
    const siteAt = segments.findIndex((s) => s.toLowerCase() === "site");
    if (siteAt >= 0) {
      if (siteAt === 0 || segments.length <= siteAt + 1) return null;
      const namespace = segments[siteAt - 1];
      const boardCode = segments[siteAt + 1];
      return namespace && boardCode ? { namespace, boardCode } : null;
    }

    // Shared shape: /{locale?}/{tenant}/{boardCode}
    const isLocale = (s: string) => /^[a-z]{2}(-[a-z]{2})?$/i.test(s);
    const rest = isLocale(segments[0]) ? segments.slice(1) : segments;
    if (rest.length < 2) return null;
    // Anything after the board code is a sub-page (`/jobs/743`), not the board.
    return { namespace: rest[0], boardCode: rest[1] };
  } catch {
    return null;
  }
}

export type DayforcePosting = {
  jobPostingId?: number;
  jobReqId?: number;
  jobTitle?: string;
  jobDescription?: string;
  postingStartTimestampUTC?: string | null;
  postingExpiryTimestampUTC?: string | null;
  postingLocations?: {
    formattedAddress?: string | null;
    cityName?: string | null;
    stateCode?: string | null;
    isoCountryCode?: string | null;
  }[];
};

type DayforceSearchResponse = {
  jobPostings?: DayforcePosting[];
  maxCount?: number;
  offset?: number;
  count?: number;
};

/**
 * "San Francisco, CA" from the structured fields, never `formattedAddress`.
 *
 * The formatted form is the whole postal address - "Stockbridge San Francisco
 * Office, 4 Embarcadero Center, San Francisco, California, United States of
 * America" - and storing that as a location makes every posting at one office
 * look like a different place to the dedup and the city matcher.
 */
function readLocation(posting: DayforcePosting): string | null {
  const first = posting.postingLocations?.[0];
  if (!first) return null;
  const parts = [first.cityName, first.stateCode ?? first.isoCountryCode].filter(
    (p): p is string => Boolean(p && p.trim()),
  );
  return parts.length ? parts.join(", ") : (first.formattedAddress?.trim() || null);
}

/** ISO, and only when Dayforce states one - per the contract in types.ts. */
function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Exported for the fixture tests: this is where every field decision lives,
 *  and it is the half of the connector that does not need a network. */
export function dayforcePostingToListing(
  posting: DayforcePosting,
  ref: DayforceBoardRef,
): NormalizedListing | null {
  const title = posting.jobTitle?.trim();
  if (!title) return null;

  const id = posting.jobPostingId;
  if (id === undefined || id === null) return null;

  const listingUrl = `${API_ORIGIN}/en-US/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(
    ref.boardCode,
  )}/jobs/${id}`;

  return {
    externalJobId: String(id),
    title: decodeEntities(title).replace(/\s+/g, " ").trim(),
    division: null,
    location: readLocation(posting),
    descriptionRaw: stripHtml(posting.jobDescription ?? ""),
    employmentType: null,
    applicationUrl: listingUrl,
    listingUrl,
    publishedAt: toIso(posting.postingStartTimestampUTC),
    /**
     * Dayforce states an expiry outright on the postings that have one, which
     * is a real application deadline rather than our estimate of one. Left
     * null when the board does not say - see `deadlineAt` in types.ts.
     */
    deadlineAt: toIso(posting.postingExpiryTimestampUTC),
  };
}

/**
 * A CSRF token plus the cookies that validate it.
 *
 * Returned together because they only work together: the endpoint compares the
 * header against the cookie, so keeping one and dropping the other fails the
 * same way as sending neither.
 */
async function getCsrf(): Promise<{ token: string; cookie: string } | null> {
  try {
    const response = await safeFetch(`${API_ORIGIN}/api/auth/csrf`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      timeoutMs: TIMEOUT_MS,
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { csrfToken?: string } | null;
    const token = body?.csrfToken;
    if (!token) return null;

    // `getSetCookie` keeps the individual headers apart; a plain `get` folds
    // them into one string and splits wrongly on the comma inside `Expires=`.
    const jar = response.headers
      .getSetCookie?.()
      ?.map((c) => c.split(";")[0])
      .filter(Boolean) ?? [];

    return { token, cookie: jar.join("; ") };
  } catch {
    return null;
  }
}

export const dayforceConnector: SourceConnector = {
  id: "dayforce",

  canHandle: (source: SourceRef) => parseDayforceBoard(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const ref = parseDayforceBoard(source.careersUrl);
    if (!ref) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const csrf = await getCsrf();
    if (!csrf) {
      // Reported as a soft failure rather than thrown: monitor-run's backoff
      // path already knows what to do with httpStatus 0, and a portal that
      // would not hand over a token is indistinguishable here from one that
      // is briefly down.
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const listings: NormalizedListing[] = [];
    const seen = new Set<string>();
    let status = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await safeFetch(
        `${API_ORIGIN}/api/geo/${encodeURIComponent(ref.namespace)}/jobposting/search`,
        {
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-csrf-token": csrf.token,
            ...(csrf.cookie ? { Cookie: csrf.cookie } : {}),
          },
          body: JSON.stringify({
            clientNamespace: ref.namespace,
            jobBoardCode: ref.boardCode,
            cultureCode: "en-US",
            paginationStart: page * PAGE_SIZE,
          }),
          timeoutMs: TIMEOUT_MS,
        },
      );

      status = response.status;
      if (!response.ok) {
        // A failure partway through paging keeps what earlier pages returned:
        // a board read to page three is better evidence than no board at all,
        // and the content hash moves honestly either way.
        if (page === 0) {
          return { listings: [], etag: null, contentHash: "", httpStatus: status, notModified: false };
        }
        break;
      }

      const body = (await response.json()) as DayforceSearchResponse | null;
      const postings = Array.isArray(body?.jobPostings) ? body.jobPostings : [];
      if (postings.length === 0) break;

      for (const posting of postings) {
        const listing = dayforcePostingToListing(posting, ref);
        // A board that returns the same posting on two pages - which is what a
        // server ignoring `paginationStart` looks like - must not produce two
        // rows, and must not loop forever below.
        if (!listing || seen.has(listing.externalJobId!)) continue;
        seen.add(listing.externalJobId!);
        listings.push(listing);
      }

      // `maxCount` is the board's own total. Trusting it over "a short page
      // means the end" because a page can be short for reasons of filtering.
      const total = typeof body?.maxCount === "number" ? body.maxCount : null;
      if (total !== null && listings.length >= total) break;
      if (postings.length < PAGE_SIZE) break;
    }

    return {
      listings,
      // No ETag negotiation: the board is read through a POST, which has none.
      etag: null,
      // Hashed over what was EXTRACTED, per the contract in types.ts.
      contentHash: sha256(
        listings
          .map((l) => `${l.externalJobId}|${l.title}|${l.location ?? ""}|${l.descriptionRaw}`)
          .sort()
          .join("\n"),
      ),
      httpStatus: status,
      notModified: false,
    };
  },
};
