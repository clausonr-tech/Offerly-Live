import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import { htmlToText } from "../html-text";

/**
 * Ashby (`jobs.ashbyhq.com/<org>`).
 *
 * Built for the rest of the directory rather than for investment banking.
 * Investment banking is 888 of 22,569 firms - 4% - and the bulge brackets are
 * all on Workday or TalentLink. Ashby is what venture capital, growth equity
 * and fintech firms use, which between them are several thousand rows of that
 * directory and currently unreadable.
 *
 * Ashby documents a public posting API needing no key:
 *   https://api.ashbyhq.com/posting-api/job-board/<org>
 *
 * Verified 19 September 2026 before this file was written - 148 postings for
 * one org, 128 for another, 200 in under 200ms both times. That check is the
 * reason this connector exists and Getro's does not: Getro's endpoint
 * answered 404 to every shape tried, and a connector written against an API
 * nobody has seen respond is a guess with types on it.
 */

const TIMEOUT_MS = 15000;
const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The org slug from `jobs.ashbyhq.com/<org>` or `ashbyhq.com/<org>/...`. */
export function parseAshbyOrg(careersUrl: string): string | null {
  try {
    const url = new URL(careersUrl);
    /**
     * Exact host, or a subdomain of it - never a bare `endsWith`.
     *
     * `"evilashbyhq.com".endsWith("ashbyhq.com")` is true, so the loose form would accept a
     * lookalike domain as this vendor. It does not reach an SSRF here, because
     * the org slug is then used against the vendor's own API host rather than
     * the URL supplied - but a connector that mis-identifies its own platform
     * is wrong on its face, and the careersUrl comes from a discovery pass
     * rather than only from a human.
     *
     * Note greenhouse.ts and workday.ts still use the loose form. Left alone
     * here rather than changed blind alongside unrelated work.
     */
    if (url.hostname !== "ashbyhq.com" && !url.hostname.endsWith(".ashbyhq.com")) return null;
    const first = url.pathname.split("/").filter(Boolean)[0];
    return first && first.length <= 80 ? first : null;
  } catch {
    return null;
  }
}

type AshbyJob = {
  id?: string;
  title?: string;
  location?: string;
  department?: string;
  team?: string;
  employmentType?: string;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
};

function toListing(job: AshbyJob, org: string): NormalizedListing | null {
  if (!job.title) return null;
  const url = job.jobUrl ?? job.applyUrl ?? `https://jobs.ashbyhq.com/${org}`;
  // descriptionPlain is Ashby's own plain-text rendering, so it is preferred
  // over stripping the HTML ourselves and getting it subtly wrong.
  // htmlToText on descriptionPlain is a no-op for tags but keeps Ashby's own
  // line breaks, which the old \s+ collapse threw away.
  const description = htmlToText(job.descriptionPlain ?? job.descriptionHtml ?? "");

  return {
    externalJobId: job.id ?? null,
    // Trimmed: Ashby returns some titles with leading whitespace (" Security
    // Engineer, Cloud" on the board this was verified against), and an
    // untrimmed title reaches students that way and breaks title matching at
    // the word boundary.
    title: job.title.replace(/\s+/g, " ").trim(),
    division: job.department ?? job.team ?? null,
    location: job.location ?? null,
    descriptionRaw: description,
    employmentType: job.employmentType ?? null,
    applicationUrl: job.applyUrl ?? url,
    listingUrl: url,
    // Only when Ashby states one. Never inferred.
    publishedAt: job.publishedAt ?? null,
    deadlineAt: null,
  };
}

export const ashbyConnector: SourceConnector = {
  id: "ashby",

  canHandle: (source: SourceRef) => parseAshbyOrg(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const org = parseAshbyOrg(source.careersUrl);
    if (!org) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const response = await safeFetch(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`,
      { headers, timeoutMs: TIMEOUT_MS },
    );

    if (response.status === 304) {
      return { listings: [], etag: source.lastEtag, contentHash: "", httpStatus: 304, notModified: true };
    }
    if (!response.ok) {
      return { listings: [], etag: null, contentHash: "", httpStatus: response.status, notModified: false };
    }

    const body = (await response.json()) as { jobs?: AshbyJob[] };
    const listings = (body.jobs ?? [])
      .map((j) => toListing(j, org))
      .filter((l): l is NormalizedListing => l !== null);

    return {
      listings,
      etag: response.headers.get("etag"),
      // Hashed over what was EXTRACTED, per the contract in types.ts - the raw
      // payload carries fields that move without the board moving.
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
