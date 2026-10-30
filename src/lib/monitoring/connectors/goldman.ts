import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";

/**
 * Goldman Sachs (`higher.gs.com`).
 *
 * The only firm-specific connector here, and it earns the exception: Goldman
 * is the single most-searched employer in this product's category, and it runs
 * its own board rather than any shared ATS.
 *
 * The page is a React app that renders nothing useful without script, and the
 * careers site links to `recruiting360.avature.net/candidates`, which is a
 * candidate LOGIN portal - so both the obvious routes are dead ends. Behind
 * the app is a public GraphQL endpoint that needs no key, no cookie and no
 * token, only a normal JSON POST:
 *
 *   POST https://api-higher.gs.com/gateway/api/v1/graphql
 *   { operationName: "GetRoles", variables: { searchQueryInput: {...} } }
 *
 * `experiences: ["EARLY_CAREER"]` is Goldman's own flag for student-facing
 * roles, so the filtering happens on their side and this connector transfers
 * a few kilobytes instead of their entire global requisition list.
 *
 * Being an undocumented internal API, the operation name or schema can change
 * without notice. That failure mode is a clean zero-listing result rather than
 * a crash, and the audit script will show it as a source that stopped
 * producing - which is the honest way for this to break.
 */

const ENDPOINT = "https://api-higher.gs.com/gateway/api/v1/graphql";
const BOARD_ORIGIN = "https://higher.gs.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
const PAGE_SIZE = 20;
const MAX_PAGES = 10;

/** Trimmed from the query the board itself sends - same operation name and
 *  shape, minus the __typename fields a non-Apollo client has no use for. */
const GET_ROLES = `query GetRoles($searchQueryInput: RoleSearchQueryInput!) {
  roleSearch(searchQueryInput: $searchQueryInput) {
    totalCount
    items {
      roleId
      corporateTitle
      jobTitle
      jobFunction
      locations { primary state country city }
      status
      division
      skills
      jobType { code description }
    }
  }
}`;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type GsLocation = { primary?: boolean; city?: string; state?: string; country?: string };
type GsRole = {
  roleId?: string;
  jobTitle?: string;
  corporateTitle?: string;
  jobFunction?: string;
  division?: string;
  status?: string;
  skills?: string[];
  locations?: GsLocation[];
  jobType?: { description?: string };
};

function isGoldmanBoard(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname;
    return host === "higher.gs.com" || host === "api-higher.gs.com";
  } catch {
    return false;
  }
}

function locationOf(role: GsRole): string | null {
  const list = role.locations ?? [];
  const chosen = list.find((l) => l.primary) ?? list[0];
  if (!chosen) return null;
  return [chosen.city, chosen.state, chosen.country].filter(Boolean).join(", ") || null;
}

async function fetchRoles(pageNumber: number): Promise<{ total: number; items: GsRole[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        operationName: "GetRoles",
        query: GET_ROLES,
        variables: {
          searchQueryInput: {
            page: { pageSize: PAGE_SIZE, pageNumber },
            sort: { sortStrategy: "RELEVANCE", sortOrder: "DESC" },
            filters: [],
            experiences: ["EARLY_CAREER"],
            searchTerm: "",
          },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const body = (await res.json()) as {
      errors?: unknown[];
      data?: { roleSearch?: { totalCount?: number; items?: GsRole[] } };
    };
    // A GraphQL error arrives with HTTP 200, so the status check above is not
    // enough on its own.
    if (body.errors?.length) return null;
    const search = body.data?.roleSearch;
    if (!search) return null;
    return { total: search.totalCount ?? 0, items: search.items ?? [] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toListing(role: GsRole): NormalizedListing | null {
  if (!role.roleId || !role.jobTitle) return null;
  // roleId is "162057_GS_EARLY_CAREER"; the board's own page URLs use just the
  // numeric prefix.
  const numeric = role.roleId.split("_")[0];
  const listingUrl = `${BOARD_ORIGIN}/roles/${numeric}`;

  return {
    externalJobId: role.roleId,
    title: role.jobTitle,
    division: role.division ?? role.jobFunction ?? null,
    location: locationOf(role),
    // The search response carries no prose. Everything descriptive it does
    // have is joined here so the classifier has more than a title to read,
    // rather than fetching a detail page per role.
    descriptionRaw: [role.jobTitle, role.division, role.corporateTitle, ...(role.skills ?? [])]
      .filter(Boolean)
      .join(" - "),
    employmentType: role.jobType?.description ?? null,
    applicationUrl: listingUrl,
    listingUrl,
    // Goldman publishes no posting date on this endpoint. Left null rather
    // than filled with the time we happened to look.
    publishedAt: null,
    deadlineAt: null,
  };
}

export const goldmanConnector: SourceConnector = {
  id: "goldman",

  canHandle(source: SourceRef): boolean {
    return isGoldmanBoard(source.careersUrl);
  },

  async fetch(): Promise<ConnectorFetchResult> {
    const listings: NormalizedListing[] = [];
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES && page * PAGE_SIZE < total; page++) {
      const body = await fetchRoles(page);
      if (!body) {
        if (page === 0) {
          return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
        }
        break;
      }
      total = body.total;
      for (const role of body.items) {
        const listing = toListing(role);
        if (listing) listings.push(listing);
      }
      if (body.items.length === 0) break;
    }

    const contentHash = listings.length
      ? sha256(listings.map((l) => `${l.externalJobId}|${l.title}`).sort().join("\n"))
      : sha256("empty");

    return { listings, etag: null, contentHash, httpStatus: 200, notModified: false };
  },
};
