"use server";

import { searchFirms, type AumBand, type FirmSearchResult } from "@/lib/firms";
import { findBlockedLanguage } from "@/lib/content-limits";
import { getCurrentUser } from "@/lib/current-user";
import { FIRM_PROGRAM_CATEGORIES } from "@/lib/validation";
import type { FirmProgramCategory } from "@/lib/firm-metadata";

import { FIRM_PAGE_SIZE } from "./firmBrowserConfig";
const AUM_BANDS = ["mega", "large", "mid", "small", "unreported"] as const;

/** $10T - past any real AUM, and keeps a pasted number from reaching a query
 *  as something like 1e308, which Postgres rejects for a bigint column. */
const AUM_CEILING = 1e13;

function cleanAumBound(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.round(v), AUM_CEILING);
}

/**
 * Directory search for the browser component.
 *
 * Every field is re-validated here rather than trusted from the client: this is
 * a server action, so its arguments are a public entry point, and the
 * categories, bands, states and location fragments all reach a query.
 */
export async function searchFirmsAction(input: {
  categories?: string[] | null;
  query?: string;
  aumBands?: string[] | null;
  aumMin?: number | null;
  aumMax?: number | null;
  states?: string[] | null;
  locationTerms?: string[] | null;
  verifiedOnly?: boolean;
  offset?: number;
  /** Rows to return. Only raised when restoring a paged-through list on back
   *  navigation, so the whole view comes back in one request instead of N. */
  limit?: number;
}): Promise<FirmSearchResult> {
  await getCurrentUser(); // directory is behind auth like the rest of (app)

  // Every entry is checked against the known set, not just the first: this is
  // a public entry point and the list reaches a query. Unknown values are
  // dropped rather than failing the whole request.
  const categories = (input.categories ?? []).filter((c): c is FirmProgramCategory =>
    (FIRM_PROGRAM_CATEGORIES as readonly string[]).includes(c),
  );

  const aumBands = (input.aumBands ?? []).filter((b): b is AumBand =>
    (AUM_BANDS as readonly string[]).includes(b),
  );

  // A pair typed backwards ("min $10B, max $1B") matches nothing and reads as a
  // broken filter, so swap rather than return an empty page.
  let aumMin = cleanAumBound(input.aumMin);
  let aumMax = cleanAumBound(input.aumMax);
  if (aumMin !== null && aumMax !== null && aumMin > aumMax) [aumMin, aumMax] = [aumMax, aumMin];

  // A two-letter code is the only shape hqState ever holds, so anything else is
  // either a typo or someone poking at the action - either way, no filter.
  const states = (input.states ?? []).filter((s) => /^[A-Z]{2}$/.test(s));

  // Typed location fragments are free text by design, so they are bounded
  // instead of pattern-matched: short enough not to be a payload, few enough
  // not to build a hundred-clause OR. drizzle parameterises the ILIKE itself.
  const locationTerms = (input.locationTerms ?? [])
    .map((t) => t.trim().slice(0, 60))
    // Blocked language never reaches a query (lib/content-limits): the term is dropped, not searched.
    .filter((t) => t && !findBlockedLanguage(t))
    .slice(0, 10);

  const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset!)) : 0;

  // Capped: this is a public entry point and the value reaches a LIMIT clause,
  // so a restored page cannot be turned into a request for the whole table.
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(Math.floor(input.limit!), 20 * FIRM_PAGE_SIZE))
    : FIRM_PAGE_SIZE;

  return searchFirms(
    {
      categories,
      query: findBlockedLanguage(input.query) ? "" : (input.query ?? "").slice(0, 100),
      aumBands,
      aumMin,
      aumMax,
      states,
      locationTerms,
      verifiedOnly: !!input.verifiedOnly,
    },
    limit,
    offset,
  );
}
