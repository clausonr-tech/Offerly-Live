import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import { retryAfterMs } from "../http-outcome";
import { htmlToText } from "../html-text";

/**
 * Workable (`apply.workable.com/<account>` or `<account>.workable.com`).
 *
 * The third of the mid-market platforms, and like the other two it exists for
 * the directory beyond investment banking rather than for it. Workable's
 * public widget endpoint needs no key:
 *   https://apply.workable.com/api/v1/widget/accounts/<account>?details=true
 *
 * Verified 19 September 2026 against several real accounts: 200 with the
 * company name, description and a `jobs` array, including full descriptions
 * when `details=true`. Accounts that have moved off Workable answer 200 with
 * an empty array, and accounts that never existed answer 404 - which is the
 * distinction a health check needs, so both are passed through as-is rather
 * than flattened into "no listings".
 *
 * `details=true` returns descriptions inline, so unlike SmartRecruiters this
 * connector needs no enrich pass at all.
 */

const TIMEOUT_MS = 15000;
const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The account slug, from either URL shape Workable serves.
 *
 * `apply.workable.com/acme/...` puts it in the path; `acme.workable.com` puts
 * it in the hostname. Both appear in the wild and `discover-boards.ts`
 * fingerprints the hostname form, so both are handled.
 */
export function parseWorkableAccount(careersUrl: string): string | null {
  try {
    const url = new URL(careersUrl);
    /**
     * Exact host, or a subdomain of it - never a bare `endsWith`.
     *
     * `"evilworkable.com".endsWith("workable.com")` is true, so the loose form would accept a
     * lookalike domain as this vendor. It does not reach an SSRF here, because
     * the org slug is then used against the vendor's own API host rather than
     * the URL supplied - but a connector that mis-identifies its own platform
     * is wrong on its face, and the careersUrl comes from a discovery pass
     * rather than only from a human.
     *
     * Note greenhouse.ts and workday.ts still use the loose form. Left alone
     * here rather than changed blind alongside unrelated work.
     */
    if (url.hostname !== "workable.com" && !url.hostname.endsWith(".workable.com")) return null;

    const sub = url.hostname.replace(/\.workable\.com$/, "");
    if (sub && sub !== "apply" && sub !== "www" && sub !== "jobs") return sub;

    const first = url.pathname.split("/").filter(Boolean)[0];
    return first && first.length <= 80 ? first : null;
  } catch {
    return null;
  }
}

type WorkableJob = {
  id?: string | number;
  shortcode?: string;
  title?: string;
  department?: string;
  city?: string;
  state?: string;
  country?: string;
  employment_type?: string;
  published_on?: string;
  url?: string;
  application_url?: string;
  description?: string;
  requirements?: string;
};

function stripHtml(value: string): string {
  // Structure-preserving now: this feeds the description and requirements
  // only (see its call sites), where a list that arrives as one welded
  // paragraph can never be recovered afterwards.
  return htmlToText(value);
}

function toListing(job: WorkableJob, account: string): NormalizedListing | null {
  if (!job.title) return null;
  const id = job.shortcode ?? (job.id != null ? String(job.id) : null);
  const url = job.url ?? job.application_url ?? `https://apply.workable.com/${account}/`;
  const location = [job.city, job.state, job.country].filter(Boolean).join(", ");

  // Requirements are a separate field and are exactly what the eligibility and
  // requirements readers want, so they are appended rather than dropped.
  const body = [stripHtml(job.description ?? ""), stripHtml(job.requirements ?? "")]
    .filter(Boolean)
    .join("\n\n");

  return {
    externalJobId: id,
    title: job.title,
    division: job.department ?? null,
    location: location || null,
    descriptionRaw: body,
    employmentType: job.employment_type ?? null,
    applicationUrl: job.application_url ?? url,
    listingUrl: url,
    publishedAt: job.published_on ?? null,
    deadlineAt: null,
  };
}

export const workableConnector: SourceConnector = {
  id: "workable",

  canHandle: (source: SourceRef) => parseWorkableAccount(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const account = parseWorkableAccount(source.careersUrl);
    if (!account) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const response = await safeFetch(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`,
      { headers, timeoutMs: TIMEOUT_MS },
    );

    if (response.status === 304) {
      return { listings: [], etag: source.lastEtag, contentHash: "", httpStatus: 304, notModified: true };
    }
    if (!response.ok) {
      return {
        listings: [],
        etag: null,
        contentHash: "",
        httpStatus: response.status,
        notModified: false,
        // Workable answers 429 with a real Retry-After - nine hours, measured
        // 20 September 2026. Passing it up lets the scheduler wait that long
        // instead of spending nine more requests inside a closed window.
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")) ?? undefined,
      };
    }

    const body = (await response.json()) as { jobs?: WorkableJob[] };
    const listings = (body.jobs ?? [])
      .map((j) => toListing(j, account))
      .filter((l): l is NormalizedListing => l !== null);

    return {
      listings,
      etag: response.headers.get("etag"),
      contentHash: sha256(
        listings.map((l) => `${l.externalJobId}|${l.title}|${l.location}`).sort().join("\n"),
      ),
      httpStatus: response.status,
      notModified: false,
    };
  },
};
