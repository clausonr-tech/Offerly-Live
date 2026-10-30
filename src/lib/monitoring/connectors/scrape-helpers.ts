import "server-only";
import { createHash } from "crypto";
import { safeFetch } from "../safe-fetch";
import type { NormalizedListing } from "./types";

/**
 * Helpers shared by the hand-written board scrapers (Baird, Jobvite, Kroll).
 *
 * Each of these started as a private copy inside one connector and was
 * duplicated verbatim as the next connector was written. They are extracted
 * unchanged; a connector that needs different behavior (Kroll's deliberately
 * narrower entity decoding, for one) keeps its own private version.
 */

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#(\d{2,5});/g, (_, code) => String.fromCodePoint(Number(code)))
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" and not to "<".
    .replace(/&amp;/g, "&");
}

export function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** "internship-marketing-year-round" -> "Internship Marketing Year Round".
 *  Presentation of the board's own slug, not a fact added to it, and replaced
 *  by the stated title on enrichment. */
export function humanize(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The contract in types.ts: hash over what was EXTRACTED, not the page bytes,
 *  so rotating markup never reports a changed board. Sorted so order is free. */
export function listingsContentHash(listings: NormalizedListing[]): string {
  return listings.length
    ? sha256(
        listings
          .map((l) => `${l.externalJobId}|${l.title}|${l.location ?? ""}`)
          .sort()
          .join("\n"),
      )
    : sha256("empty");
}

/** Pulls every `<script type="application/ld+json">` block out of the page
 *  without a full HTML parser - a plain scan is enough for this one tag. */
export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // Malformed JSON-LD is common enough on real sites to just skip.
    }
  }
  return blocks;
}

/** A `JobPosting` node can arrive bare, inside an array, or nested in a
 *  `@graph` - this walks all three shapes rather than assuming one. */
export function findJobPosting(blocks: unknown[]): Record<string, unknown> | null {
  const queue = [...blocks];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const type = obj["@type"];
      const isPosting =
        type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
      if (isPosting) return obj;
      if (Array.isArray(obj["@graph"])) queue.push(...obj["@graph"]);
    }
  }
  return null;
}

export function readJsonLdLocation(node: Record<string, unknown>): string | null {
  const raw = node.jobLocation;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const address = (first as { address?: Record<string, unknown> } | undefined)?.address;
  if (!address) return null;
  const parts = [address.addressLocality, address.addressRegion].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length ? parts.join(", ") : null;
}

/**
 * The detail-fetch loop every scraper's `enrich` runs: take listings whose
 * description is still a stub, fetch each detail page politely, and let the
 * connector's own `enrichOne` read the page. `enrichOne` returns the updated
 * listing, or null for a page it did not understand - keeping the stub is
 * honest; storing an empty description is not.
 *
 * Sequential with a gap rather than parallel: this runs inside the slot
 * fetch-pool already granted for this source, so it must not turn one
 * polite request into a burst against the same host.
 */
export async function enrichThinListings(
  listings: NormalizedListing[],
  opts: { userAgent: string; timeoutMs: number; maxDetail: number; gapMs: number },
  enrichOne: (html: string, listing: NormalizedListing) => NormalizedListing | null,
): Promise<NormalizedListing[]> {
  const out = [...listings];
  let fetched = 0;

  for (let i = 0; i < out.length && fetched < opts.maxDetail; i++) {
    const listing = out[i];
    if (listing.descriptionRaw.trim().length >= 120) continue;

    if (fetched > 0) await new Promise((r) => setTimeout(r, opts.gapMs));
    fetched += 1;

    try {
      const response = await safeFetch(listing.listingUrl, {
        headers: { "User-Agent": opts.userAgent, Accept: "text/html" },
        timeoutMs: opts.timeoutMs,
      });
      if (!response.ok) continue;

      const updated = enrichOne(await response.text(), listing);
      if (updated) out[i] = updated;
    } catch {
      // Best-effort by contract: a detail page that fails keeps its stub and
      // is re-queued next pass by monitor-run's still-thin check.
    }
  }

  return out;
}
