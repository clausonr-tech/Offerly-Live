import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";
import { htmlToText } from "../html-text";

/**
 * Recruitee (`<account>.recruitee.com`).
 *
 * One public, unauthenticated endpoint returning the whole board, with the
 * description included - so unlike Getro or Breezy there is nothing to enrich
 * afterwards:
 *
 *   GET https://<account>.recruitee.com/api/offers/
 *
 * Verified by the six-control probe check: a known account returns its offers
 * and six nonsense tokens all return 404.
 *
 * WHY IT WAS WRITTEN
 * ------------------
 * The private equity sweep found three Recruitee boards, and one of them is
 * BC Partners' - carrying "French Intern | July 2026" in PE Investment,
 * London. Without this connector that board registers against the generic
 * connector, which means launching Chromium every check to scrape a page
 * whose JSON is one request away, and probably still missing the posting.
 *
 * A found board with no parser is not coverage. It is a more expensive way of
 * having no coverage.
 */

const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 15000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The account from `<account>.recruitee.com`. */
export function parseRecruiteeAccount(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    // Exact host or a dotted subdomain - never a bare endsWith, which would
    // accept `evilrecruitee.com` as this vendor.
    if (host !== "recruitee.com" && !host.endsWith(".recruitee.com")) return null;
    if (host === "recruitee.com") return null;
    const account = host.slice(0, host.length - ".recruitee.com".length);
    if (!account || account === "www" || account.includes(".")) return null;
    return account;
  } catch {
    return null;
  }
}

type RecruiteeOffer = {
  id: number | string;
  slug?: string;
  title: string;
  department?: string | null;
  location?: string | null;
  city?: string | null;
  country?: string | null;
  careers_url?: string | null;
  careers_apply_url?: string | null;
  description?: string | null;
  requirements?: string | null;
  employment_type_code?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  status?: string | null;
};

/** Recruitee returns HTML in `description` and `requirements`. */
function stripHtml(value: string | null | undefined): string {
  // Structure-preserving, and one entity table instead of the six inline
  // replaces this used to carry - which between them missed every numeric
  // entity the API returns.
  return htmlToText(value ?? "");
}

function toListing(offer: RecruiteeOffer, account: string): NormalizedListing | null {
  if (!offer.title) return null;

  const url =
    offer.careers_url ??
    (offer.slug ? `https://${account}.recruitee.com/o/${offer.slug}` : `https://${account}.recruitee.com`);

  const location =
    offer.location ?? [offer.city, offer.country].filter(Boolean).join(", ") ?? null;

  // Requirements carry the eligibility sentences the deterministic parser
  // reads, so both halves go in rather than the description alone.
  const description = [stripHtml(offer.description), stripHtml(offer.requirements)]
    .filter(Boolean)
    .join("\n\n");

  return {
    externalJobId: String(offer.id),
    title: offer.title,
    division: offer.department ?? null,
    location: location || null,
    descriptionRaw: description || offer.title,
    employmentType: offer.employment_type_code ?? null,
    applicationUrl: offer.careers_apply_url ?? url,
    listingUrl: url,
    /**
     * `published_at` when the board states one, never `created_at` as a
     * substitute - per the contract in types.ts, this field is only ever what
     * the SOURCE says about publication. created_at is when the row was made
     * in their system, which is a different fact.
     */
    publishedAt: offer.published_at ?? null,
  };
}

export const recruiteeConnector: SourceConnector = {
  id: "recruitee",

  canHandle: (source: SourceRef) => parseRecruiteeAccount(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const account = parseRecruiteeAccount(source.careersUrl);
    if (!account) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const response = await safeFetch(
      `https://${encodeURIComponent(account)}.recruitee.com/api/offers/`,
      { headers, timeoutMs: TIMEOUT_MS },
    );

    if (response.status === 304) {
      return { listings: [], etag: source.lastEtag, contentHash: "", httpStatus: 304, notModified: true };
    }
    if (!response.ok) {
      return { listings: [], etag: null, contentHash: "", httpStatus: response.status, notModified: false };
    }

    const body = (await response.json()) as { offers?: RecruiteeOffer[] } | null;
    const offers = body?.offers ?? [];
    const listings = offers
      // A board can carry closed offers; only published ones are openings.
      .filter((offer) => !offer.status || offer.status === "published")
      .map((offer) => toListing(offer, account))
      .filter((listing): listing is NormalizedListing => listing !== null);

    return {
      listings,
      etag: response.headers.get("etag"),
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
