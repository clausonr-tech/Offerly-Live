import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import { htmlToText } from "../html-text";

/**
 * SmartRecruiters (`jobs.smartrecruiters.com/<CompanyId>`).
 *
 * Another mid-market platform built for the directory beyond investment
 * banking. SmartRecruiters documents a public posting API with no key:
 *   https://api.smartrecruiters.com/v1/companies/<CompanyId>/postings
 *
 * Verified 19 September 2026: the endpoint answers 200 with the documented
 * `{offset, limit, totalFound, content[]}` envelope. The company identifier
 * is case-sensitive and is NOT the display name - it is the segment in the
 * board URL, which is exactly what `discover-boards.ts` already fingerprints,
 * so it is taken from there rather than guessed.
 *
 * THE LIST ENDPOINT HAS NO DESCRIPTIONS
 * -------------------------------------
 * `/postings` returns titles, locations, departments and ids, and no body
 * text. The description lives at `/postings/<id>`, one request each. So this
 * follows the same split as iCIMS and Kroll: the list is the cheap index, and
 * `enrich` pays for detail only on the listings monitor-run has decided are
 * new - with internship-shaped titles sorted to the front of that queue.
 */

const TIMEOUT_MS = 15000;
const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const PAGE_SIZE = 100;
const MAX_PAGES = 6;
const PAGE_GAP_MS = 250;
/** Detail fetches per pass. Same reasoning as the iCIMS cap: a board does not
 *  turn over this many NEW postings between checks. */
const MAX_DETAIL = 40;
const DETAIL_GAP_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The company identifier from `jobs.smartrecruiters.com/<CompanyId>/...`.
 *  Case is preserved: the API rejects a lowercased identifier. */
export function parseSmartRecruitersCompany(careersUrl: string): string | null {
  try {
    const url = new URL(careersUrl);
    /**
     * Exact host, or a subdomain of it - never a bare `endsWith`.
     *
     * `"evilsmartrecruiters.com".endsWith("smartrecruiters.com")` is true, so the loose form would accept a
     * lookalike domain as this vendor. It does not reach an SSRF here, because
     * the org slug is then used against the vendor's own API host rather than
     * the URL supplied - but a connector that mis-identifies its own platform
     * is wrong on its face, and the careersUrl comes from a discovery pass
     * rather than only from a human.
     *
     * Note greenhouse.ts and workday.ts still use the loose form. Left alone
     * here rather than changed blind alongside unrelated work.
     */
    if (url.hostname !== "smartrecruiters.com" && !url.hostname.endsWith(".smartrecruiters.com")) return null;
    const first = url.pathname.split("/").filter(Boolean)[0];
    return first && first.length <= 80 ? first : null;
  } catch {
    return null;
  }
}

type SrPosting = {
  id?: string;
  name?: string;
  releasedDate?: string;
  department?: { label?: string };
  location?: { city?: string; region?: string; country?: string };
  typeOfEmployment?: { label?: string };
};

function toListing(p: SrPosting, company: string): NormalizedListing | null {
  if (!p.name || !p.id) return null;
  const loc = [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(", ");
  return {
    externalJobId: p.id,
    title: p.name,
    division: p.department?.label ?? null,
    location: loc || null,
    // Filled by enrich; the list endpoint carries no body.
    descriptionRaw: "",
    employmentType: p.typeOfEmployment?.label ?? null,
    applicationUrl: `https://jobs.smartrecruiters.com/${company}/${p.id}`,
    listingUrl: `https://jobs.smartrecruiters.com/${company}/${p.id}`,
    publishedAt: p.releasedDate ?? null,
    deadlineAt: null,
  };
}

function stripHtml(value: string): string {
  // Structure-preserving now: this feeds the description and requirements
  // only (see its call sites), where a list that arrives as one welded
  // paragraph can never be recovered afterwards.
  return htmlToText(value);
}

export const smartRecruitersConnector: SourceConnector = {
  id: "smartrecruiters",

  canHandle: (source: SourceRef) => parseSmartRecruitersCompany(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const company = parseSmartRecruitersCompany(source.careersUrl);
    if (!company) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const listings: NormalizedListing[] = [];
    let status = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0) await sleep(PAGE_GAP_MS);
      const url =
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings` +
        `?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;

      const res = await safeFetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        timeoutMs: TIMEOUT_MS,
      });
      status = res.status;
      if (!res.ok) break;

      const body = (await res.json()) as { content?: SrPosting[]; totalFound?: number };
      const batch = (body.content ?? [])
        .map((p) => toListing(p, company))
        .filter((l): l is NormalizedListing => l !== null);
      listings.push(...batch);

      if (batch.length < PAGE_SIZE) break;
    }

    return {
      listings,
      etag: null,
      contentHash: sha256(
        listings.map((l) => `${l.externalJobId}|${l.title}|${l.location}`).sort().join("\n"),
      ),
      httpStatus: status,
      notModified: false,
    };
  },

  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    const out = [...listings];
    let fetched = 0;

    for (let i = 0; i < out.length && fetched < MAX_DETAIL; i++) {
      const listing = out[i];
      if (listing.descriptionRaw.trim().length >= 120) continue;
      const company = parseSmartRecruitersCompany(listing.listingUrl);
      if (!company || !listing.externalJobId) continue;

      if (fetched > 0) await sleep(DETAIL_GAP_MS);
      fetched += 1;

      try {
        const res = await safeFetch(
          `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(listing.externalJobId)}`,
          { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, timeoutMs: TIMEOUT_MS },
        );
        if (!res.ok) continue;
        const detail = (await res.json()) as {
          jobAd?: { sections?: Record<string, { text?: string; title?: string }> };
        };
        // The body is split across named sections - companyDescription,
        // jobDescription, qualifications, additionalInformation. Joined in
        // the order SmartRecruiters returns them so the text reads as the
        // posting did.
        const sections = detail.jobAd?.sections ?? {};
        const text = Object.values(sections)
          .map((s) => stripHtml(s?.text ?? ""))
          .filter(Boolean)
          .join("\n\n");
        if (text.length > listing.descriptionRaw.length) {
          out[i] = { ...listing, descriptionRaw: text };
        }
      } catch {
        // Best-effort by contract: a failed detail keeps the index-page stub
        // and is re-queued next pass by monitor-run's still-thin check.
      }
    }
    return out;
  },
};
