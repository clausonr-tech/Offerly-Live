import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";

/**
 * Breezy HR (`<account>.breezy.hr`).
 *
 * One documented, public, unauthenticated endpoint returning the whole board
 * in a single response:
 *
 *   GET https://<account>.breezy.hr/json
 *
 * Verified 19 September 2026 by scripts/ats-probe-live-check.ts, which is the
 * standard this repo holds connectors to: a known-good account returned its
 * postings and all six nonsense control tokens returned 404. That second half
 * is why Breezy is probeable and SmartRecruiters is not - SmartRecruiters
 * accepts any company id and answers 200 with an empty list.
 *
 * WHY IT IS HERE BEFORE ANY FIRM USES IT
 * --------------------------------------
 * No firm in the 22,575-row directory is currently known to run Breezy, so
 * this connector reads nothing today. It exists because the board PROBE can
 * find Breezy accounts, and a probe hit we cannot read is a source registered
 * against the generic connector - a Chromium launch per check to re-scrape a
 * page whose JSON is one request away. The probe and the connector are the
 * same feature; shipping one without the other wastes what the other finds.
 *
 * Breezy is a small-team ATS, so the boards are tens of roles rather than
 * thousands and there is no paging to do.
 */

const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 15000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The account from `<account>.breezy.hr`. */
export function parseBreezyAccount(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    // Exact host or a subdomain of it - never a bare endsWith, which would
    // accept `evilbreezy.hr` as this vendor.
    if (host !== "breezy.hr" && !host.endsWith(".breezy.hr")) return null;
    const account = host === "breezy.hr" ? null : host.slice(0, host.length - ".breezy.hr".length);
    if (!account || account === "www" || account.includes(".")) return null;
    return account;
  } catch {
    return null;
  }
}

type BreezyJob = {
  id: string;
  friendly_id?: string;
  name: string;
  url: string;
  published_date?: string;
  department?: string | null;
  type?: { id?: string; name?: string } | null;
  location?: { name?: string; city?: string; state?: { name?: string } | null; is_remote?: boolean } | null;
};

function toListing(job: BreezyJob, account: string): NormalizedListing | null {
  if (!job.name) return null;

  const location =
    job.location?.name ??
    [job.location?.city, job.location?.state?.name].filter(Boolean).join(", ") ??
    null;

  return {
    externalJobId: String(job.id ?? job.friendly_id ?? job.name),
    title: job.name,
    division: job.department ?? null,
    location: location || null,
    /**
     * Breezy's board listing carries no description - the text lives on the
     * posting page. Title plus department is what a classifier gets, which is
     * the same position the Getro connector is in, and the same case the LLM
     * adjudicator exists for.
     */
    descriptionRaw: job.department ? `${job.name} - ${job.department}` : job.name,
    employmentType: job.type?.name ?? null,
    applicationUrl: job.url ?? `https://${account}.breezy.hr`,
    listingUrl: job.url ?? `https://${account}.breezy.hr`,
    // Stated by the source, never inferred - per the contract in types.ts.
    publishedAt: job.published_date ?? null,
  };
}

export const breezyConnector: SourceConnector = {
  id: "breezy",

  canHandle: (source: SourceRef) => parseBreezyAccount(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const account = parseBreezyAccount(source.careersUrl);
    if (!account) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const response = await safeFetch(`https://${encodeURIComponent(account)}.breezy.hr/json`, {
      headers,
      timeoutMs: TIMEOUT_MS,
    });

    if (response.status === 304) {
      return { listings: [], etag: source.lastEtag, contentHash: "", httpStatus: 304, notModified: true };
    }
    if (!response.ok) {
      return { listings: [], etag: null, contentHash: "", httpStatus: response.status, notModified: false };
    }

    const body = (await response.json()) as BreezyJob[] | null;
    // The endpoint returns a bare array. Anything else means the account
    // moved or the shape changed, and an empty result is the honest way for
    // that to show up - as a source that stopped producing.
    const jobs = Array.isArray(body) ? body : [];
    const listings = jobs
      .map((job) => toListing(job, account))
      .filter((listing): listing is NormalizedListing => listing !== null);

    return {
      listings,
      etag: response.headers.get("etag"),
      // Hashed over what was EXTRACTED, per the contract in types.ts.
      contentHash: sha256(
        listings
          .map((l) => `${l.externalJobId}|${l.title}|${l.location}|${l.listingUrl}`)
          .sort()
          .join("\n"),
      ),
      httpStatus: response.status,
      notModified: false,
    };
  },
};
