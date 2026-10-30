import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";

/**
 * Lever (`jobs.lever.co/{account}`).
 *
 * The simplest ATS in this set: one documented, public, unauthenticated
 * endpoint that returns the whole board in a single response.
 *
 *   GET https://api.lever.co/v0/postings/{account}?mode=json
 *
 * Used by the smaller advisory firms here (D.A. Davidson, Seaport Global).
 * No paging - Lever returns every published posting at once, and these boards
 * are tens of roles rather than thousands.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Account handle from `jobs.lever.co/{account}` (with or without a trailing
 *  path or slash). */
export function parseLeverUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "jobs.lever.co" && url.hostname !== "api.lever.co") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    // api.lever.co paths are /v0/postings/{account}
    const account = url.hostname === "api.lever.co" ? segments[2] : segments[0];
    return account ?? null;
  } catch {
    return null;
  }
}

type LeverPosting = {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  categories?: { location?: string; team?: string; commitment?: string };
};

export const leverConnector: SourceConnector = {
  id: "lever",

  canHandle(source: SourceRef): boolean {
    return parseLeverUrl(source.careersUrl) !== null;
  },

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const account = parseLeverUrl(source.careersUrl);
    if (!account) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let postings: LeverPosting[];
    try {
      const res = await fetch(`https://api.lever.co/v0/postings/${account}?mode=json`, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: controller.signal,
      });
      // 404 means the account handle is wrong or the board was taken down -
      // a real, reportable state rather than an exception.
      if (!res.ok) {
        return {
          listings: [],
          etag: null,
          contentHash: "",
          httpStatus: res.status,
          notModified: false,
        };
      }
      postings = (await res.json()) as LeverPosting[];
    } catch {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    } finally {
      clearTimeout(timer);
    }

    const listings: NormalizedListing[] = [];
    for (const p of postings) {
      if (!p.text || !p.hostedUrl) continue;
      listings.push({
        externalJobId: p.id ?? sha256(p.hostedUrl),
        title: p.text,
        division: p.categories?.team ?? null,
        location: p.categories?.location ?? null,
        descriptionRaw: [p.descriptionPlain, p.additionalPlain].filter(Boolean).join(" ") || p.text,
        employmentType: p.categories?.commitment ?? null,
        applicationUrl: p.applyUrl ?? p.hostedUrl,
        listingUrl: p.hostedUrl,
        // Lever's createdAt is epoch milliseconds, and it is the real posting
        // date rather than a first-seen time.
        publishedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
        deadlineAt: null,
      });
    }

    const contentHash = listings.length
      ? sha256(
          listings
            .map((l) => `${l.externalJobId}|${l.title}|${l.location ?? ""}`)
            .sort()
            .join("\n"),
        )
      : sha256("empty");

    return { listings, etag: null, contentHash, httpStatus: 200, notModified: false };
  },
};
