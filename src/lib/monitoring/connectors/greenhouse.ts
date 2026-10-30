import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { htmlToText } from "../html-text";

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";

// Greenhouse's own public, unauthenticated job-board API - documented,
// intentionally public, no scraping involved. Real job IDs and structured
// fields, which is exactly why this connector exists instead of leaving
// Greenhouse-hosted boards to the generic HTML fallback.
function boardsApiUrl(token: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
}

/** Extracts the board token from either
 *  `job-boards.greenhouse.io/<token>/...` or `boards.greenhouse.io/<token>`. */
/** The board token from a Greenhouse URL. Exported because opening-history.ts
 *  needs to build the same board's API address to ask the Archive about it. */
export function extractToken(careersUrl: string): string | null {
  try {
    const url = new URL(careersUrl);
    /**
     * Exact host or a subdomain of it, on a DOT boundary.
     *
     * A bare `endsWith("greenhouse.io")` also accepts `evilgreenhouse.io`,
     * which is the trap every other connector in this directory documents and
     * guards - breezy, recruitee, bamboohr, dayforce and jobvite all check the
     * boundary, and this one, the oldest, never did.
     *
     * It is not only tidiness. `canHandle` decides which parser claims a
     * source, so a lookalike URL was claimed by Greenhouse, its first path
     * segment taken as a board token, and the real Greenhouse API then queried
     * with a token somebody else chose - reading another company's board and
     * filing it under this firm. Found by opening-history-api.test.ts.
     */
    const host = url.hostname.toLowerCase();
    if (host !== "greenhouse.io" && !host.endsWith(".greenhouse.io")) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[0] ?? null;
  } catch {
    return null;
  }
}

type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  updated_at: string;
  location?: { name?: string };
  departments?: { name?: string }[];
  content?: string;
};

function jobToListing(job: GreenhouseJob): NormalizedListing {
  return {
    externalJobId: String(job.id),
    title: job.title,
    division: job.departments?.[0]?.name ?? null,
    location: job.location?.name ?? null,
    descriptionRaw: htmlToText(job.content ?? ""),
    employmentType: null,
    applicationUrl: job.absolute_url,
    listingUrl: job.absolute_url,
    // Greenhouse only exposes `updated_at`, not a true post date - honest to
    // leave publishedAt null rather than imply we know when it first opened.
    publishedAt: null,
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export const greenhouseConnector: SourceConnector = {
  id: "greenhouse",
  canHandle: (source) => extractToken(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const token = extractToken(source.careersUrl);
    if (!token) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
      if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;
      response = await fetch(boardsApiUrl(token), { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 304) {
      return { listings: [], etag: source.lastEtag, contentHash: "", httpStatus: 304, notModified: true };
    }
    if (!response.ok) {
      return { listings: [], etag: null, contentHash: "", httpStatus: response.status, notModified: false };
    }

    const body = await response.text();
    const contentHash = sha256(body);
    const etag = response.headers.get("etag");
    const parsed = JSON.parse(body) as { jobs?: GreenhouseJob[] };
    const listings = (parsed.jobs ?? []).map(jobToListing);

    return { listings, etag, contentHash, httpStatus: response.status, notModified: false };
  },
};
