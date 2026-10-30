// The directory's filter state, expressed as URL search params.
//
// It used to live purely in React state inside FirmBrowser. That made the back
// button useless: opening a firm and returning re-mounted the browser with no
// filters and only the first page, so a student who had filtered to PE in
// Chicago and paged three times landed back at an unfiltered page one. Scroll
// restoration alone could not fix that - there was nothing to scroll back to.
//
// Keeping it in the URL means the browser's own history does the work, and the
// filtered view becomes shareable and bookmarkable as a side effect.
//
// Plain module, not "use server": imported by both the server pages that seed
// the first render and the client component that owns the controls.

import { FIRM_PROGRAM_CATEGORIES } from "@/lib/validation";
import type { AumBand } from "@/lib/firms";
import type { FirmProgramCategory } from "@/lib/firm-metadata";

const AUM_BAND_VALUES: readonly string[] = ["mega", "large", "mid", "small", "unreported"];

export type FirmFilterState = {
  query: string;
  categories: string[];
  aumBands: string[];
  /** Kept as typed text, not numbers, so a half-typed "1." survives a round
   *  trip through the URL the same way it survives a re-render. */
  aumMinText: string;
  aumMaxText: string;
  states: string[];
  locationTerms: string[];
  verifiedOnly: boolean;
  /** How many rows were on screen, so "show more" survives going back. */
  shown: number;
};

export const EMPTY_FIRM_FILTERS: FirmFilterState = {
  query: "",
  categories: [],
  aumBands: [],
  aumMinText: "",
  aumMaxText: "",
  states: [],
  locationTerms: [],
  verifiedOnly: false,
  shown: 0,
};

/** Accepts what people type into a money box: "2b", "$1.5B", "750m",
 *  "2,000,000,000". Null for empty or unparseable, which reads as "no bound"
 *  rather than as an error - a half-typed "1." should not clear the results. */
export function parseAum(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)([kmbt])?$/i.exec(s);
  if (!m) return null;
  const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  return Math.round(parseFloat(m[1]) * (mult[m[2]?.toLowerCase() ?? ""] ?? 1));
}

type RawParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

// Commas separate every list except places, which are free text a student types
// and may well contain one ("Austin, TX").
function list(v: string | string[] | undefined, sep = ","): string[] {
  const raw = one(v);
  return raw ? raw.split(sep).map((s) => s.trim()).filter(Boolean) : [];
}

export function parseFirmFilters(params: RawParams): FirmFilterState {
  const shown = Number(one(params.shown));
  return {
    query: one(params.q).slice(0, 100),
    categories: list(params.sectors),
    aumBands: list(params.sizes),
    aumMinText: one(params.min),
    aumMaxText: one(params.max),
    states: list(params.st),
    locationTerms: list(params.place, "|"),
    verifiedOnly: one(params.verified) === "1",
    shown: Number.isFinite(shown) ? Math.max(0, Math.min(Math.floor(shown), 2000)) : 0,
  };
}

/**
 * The query string for a filter state. Defaults are omitted so an untouched
 * directory keeps a clean `/discovery` URL rather than a wall of empty params.
 */
export function firmFiltersToQuery(s: FirmFilterState, pageSize: number): string {
  const p = new URLSearchParams();
  if (s.query.trim()) p.set("q", s.query.trim());
  if (s.categories.length) p.set("sectors", s.categories.join(","));
  if (s.aumBands.length) p.set("sizes", s.aumBands.join(","));
  if (s.aumMinText.trim()) p.set("min", s.aumMinText.trim());
  if (s.aumMaxText.trim()) p.set("max", s.aumMaxText.trim());
  if (s.states.length) p.set("st", s.states.join(","));
  if (s.locationTerms.length) p.set("place", s.locationTerms.join("|"));
  if (s.verifiedOnly) p.set("verified", "1");
  // Only worth recording once the student has paged past the first screen.
  if (s.shown > pageSize) p.set("shown", String(s.shown));
  return p.toString();
}

/**
 * The shape searchFirms takes, with every value re-checked.
 *
 * These come straight off the URL and reach a SQL query, so they get the same
 * treatment as the server action's arguments: unknown bands and malformed state
 * codes are dropped rather than trusted, and the free-text place fragments are
 * bounded in length and count.
 */
export function toSearchFilters(s: FirmFilterState) {
  return {
    query: s.query.slice(0, 100),
    aumBands: s.aumBands.filter((b): b is AumBand => AUM_BAND_VALUES.includes(b)),
    aumMin: parseAum(s.aumMinText),
    aumMax: parseAum(s.aumMaxText),
    states: s.states.filter((x) => /^[A-Z]{2}$/.test(x)),
    locationTerms: s.locationTerms.map((t) => t.trim().slice(0, 60)).filter(Boolean).slice(0, 10),
    verifiedOnly: s.verifiedOnly,
  };
}

/**
 * Writes the filter keys onto an existing param set, leaving everything else
 * alone.
 *
 * The URL may carry params this module doesn't own. Rebuilding the query from
 * scratch here would silently drop them.
 */
const OWNED_KEYS = ["q", "sectors", "sizes", "min", "max", "st", "place", "verified", "shown"];

export function applyFirmFilters(
  base: URLSearchParams,
  state: FirmFilterState,
  pageSize: number,
): URLSearchParams {
  const out = new URLSearchParams(base.toString());
  for (const k of OWNED_KEYS) out.delete(k);
  for (const [k, v] of new URLSearchParams(firmFiltersToQuery(state, pageSize))) out.set(k, v);
  return out;
}

/** `?sectors=all` - the student chose every firm type on purpose. */
export const ALL_FIRM_TYPES = "all";

/**
 * The one firm type the Firms directory is showing.
 *
 * The directory opens on the type the student is recruiting for - the first of
 * their saved preferences that is a real category - rather than on all
 * twenty-thousand-odd firms at once. `?sectors=` overrides it: a category shows
 * that type, `all` shows everything, and anything unknown falls back to the
 * default as if it were absent. An older multi-type link keeps its first type.
 */
export function resolveFirmType(
  sectorsParam: string | string[] | undefined,
  preferred: readonly string[] | null | undefined,
): FirmProgramCategory | typeof ALL_FIRM_TYPES {
  const isCategory = (c: string): c is FirmProgramCategory =>
    (FIRM_PROGRAM_CATEGORIES as readonly string[]).includes(c);
  const asked = list(sectorsParam);
  if (asked[0] === ALL_FIRM_TYPES) return ALL_FIRM_TYPES;
  const fromUrl = asked.find(isCategory);
  if (fromUrl) return fromUrl;
  return (preferred ?? []).find(isCategory) ?? ALL_FIRM_TYPES;
}
