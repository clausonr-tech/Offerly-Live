import "server-only";
import { and, asc, count, countDistinct, desc, eq, ilike, inArray, isNotNull, isNull, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firmPrograms, firms } from "@/db/schema";
import { SHARED_CACHE_SECONDS, SHARED_CACHE_TAGS, sharedCache } from "@/lib/shared-data-cache";
import { CATEGORY_LABELS, type FirmProgramCategory } from "./firm-metadata";

// Reads only. These tables are filled, and kept in step with the firm catalog,
// by `npm run db:sync-firms` (lib/firm-sync.ts) - never from a request or at
// boot. See that file for why.

// Compiles to a LEFT JOIN LATERAL + json_agg - one aggregation per firm row -
// which stays cheap only because of the firm_programs.firm_id index. Measured
// at 9,494 firms: 173ms with that index, ~9.5s without it. Check the index
// first if this ever looks slow.
export async function getAllFirmsWithPrograms() {
  const db = await getDb();
  return db.query.firms.findMany({
    orderBy: [asc(firms.name)],
    with: { programs: true },
  });
}

// Name, slug and logo domain for every firm - and nothing else.
//
// For callers that only need to turn a firm NAME into a link and a logo.
// /tracking was using getAllFirmsWithPrograms() for exactly that, building a
// name-keyed map and reading two fields off each hit. Measured against the
// live directory that is 22,569 firm rows (11.9MB) plus 24,791 program rows
// (17.5MB) - about 29MB and eleven seconds over a remote connection - to
// populate a lookup table that needs a few hundred KB.
async function queryFirmDirectoryIndex() {
  const db = await getDb();
  return db
    .select({ name: firms.name, slug: firms.slug, website: firms.website })
    .from(firms)
    // The demo firm is for showing the firm portal, never a directory entry.
    .where(eq(firms.isDemo, false))
    .orderBy(asc(firms.name));
}

const cachedFirmDirectoryIndex = sharedCache(queryFirmDirectoryIndex, ["firm-directory-index-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.firms],
});

export async function getFirmDirectoryIndex() {
  return cachedFirmDirectoryIndex();
}

// Firms that run a programme in at least one of `categories`, with their
// programmes - and nothing outside those sectors.
//
// The matcher used to call getAllFirmsWithPrograms() and filter the result in
// JavaScript. That loads the whole directory - 22,569 firms and 24,791
// programme rows, about 29MB, measured at 9-13 seconds against the remote
// database - to keep the few hundred that run the sector the student actually
// recruits for. A student targeting investment banking has 888 eligible firms;
// the other 21,681 crossed the network so they could be discarded in a
// `.filter()`.
//
// Same shape as getAllFirmsWithPrograms so callers need no other change. The
// programmes come back whole, including ones outside `categories` - a firm's
// full programme list is what the tier and coverage predicates read.
export async function getFirmsForCategories(categories: string[]) {
  if (!categories.length) return [];
  const db = await getDb();
  return db.query.firms.findMany({
    where: inArray(
      firms.id,
      db
        .select({ id: firmPrograms.firmId })
        .from(firmPrograms)
        .where(inArray(firmPrograms.category, categories as FirmProgramCategory[])),
    ),
    orderBy: [asc(firms.name)],
    with: { programs: true },
  });
}

// Specific firms by id, with their programmes.
//
// For callers holding a handful of ids - the pruner checks the eight or so
// firms already on a student's list, and was loading all 22,569 to build a
// lookup map for them.
export async function getFirmsByIds(ids: string[]) {
  if (!ids.length) return [];
  const db = await getDb();
  return db.query.firms.findMany({
    where: inArray(firms.id, ids),
    with: { programs: true },
  });
}

/** Most rows the firm picker will ever show at once. */
const FIRM_PICKER_LIMIT = 30;

// The firm picker's rows: a bounded, filtered slice - never the directory.
//
// The picker displays at most FIRM_PICKER_LIMIT rows and filters as you type.
// It used to be handed every firm and do that filtering in the browser, which
// against the live directory means loading 22,569 rows on the server and
// shipping all of them to the client to render thirty. Measured at 1.0-9.2
// seconds on the server alone, on a page nobody had asked to search yet.
//
// `categories` scopes the search to the sectors a student actually recruits
// for, so opening the picker offers banks to someone targeting banking rather
// than an alphabetical slice of everything. A typed query searches the whole
// directory regardless, because someone looking up a specific firm by name
// knows what they are looking for better than their profile does.
type FirmNameSearch = {
  query?: string | null;
  categories?: string[] | null;
  limit?: number;
};

async function queryFirmNames({
  query,
  categories,
  limit = FIRM_PICKER_LIMIT,
}: FirmNameSearch) {
  const db = await getDb();
  const term = query?.trim();

  const filters: SQL[] = [eq(firms.isDemo, false)];
  // ilike with a leading wildcard cannot use a btree index, but it is bounded
  // by LIMIT and runs against a single table - measured in the low hundreds of
  // ms including the network round trip, against 9-13 seconds for the load it
  // replaces.
  if (term) filters.push(ilike(firms.name, `%${term}%`));
  // Scope to sector only when nothing was typed; see above.
  if (!term && categories?.length) {
    filters.push(
      inArray(
        firms.id,
        db
          .select({ id: firmPrograms.firmId })
          .from(firmPrograms)
          .where(inArray(firmPrograms.category, categories as FirmProgramCategory[])),
      ),
    );
  }

  return db
    // website for the picker's logos.
    .select({ id: firms.id, name: firms.name, website: firms.website })
    .from(firms)
    .where(filters.length ? and(...filters) : undefined)
    // Names that START with what was typed first, then names with a word
    // starting with it, then the rest: "Laz" lists Lazard before Blazeridge.
    .orderBy(
      ...(term
        ? [
            sql`case when ${firms.name} ilike ${`${term}%`} then 0 when ${firms.name} ilike ${`% ${term}%`} then 1 else 2 end`,
          ]
        : []),
      asc(firms.name),
    )
    .limit(limit);
}

const cachedFirmNames = sharedCache(queryFirmNames, ["firm-name-search-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.firms],
});

export async function searchFirmNames(input: FirmNameSearch) {
  return cachedFirmNames({
    ...input,
    query: input.query?.trim() || null,
    categories: input.categories ? [...new Set(input.categories)].sort() : null,
  });
}

// A firm-name sample small enough to put on a checkbox list, spanning every
// sector rather than being dominated by whichever category the directory
// happens to have the most of. Same interleave-then-cap idea as the home
// page's rolodex (buildRolodex in (app)/home/page.tsx) - kept as an
// independent copy rather than a shared import, since the rolodex needs the
// slug/website too and this only ever needs the name.
const REPRESENTATIVE_FIRM_MAX = 56;

export async function getRepresentativeFirmNames(max = REPRESENTATIVE_FIRM_MAX): Promise<string[]> {
  const db = await getDb();
  const categories = Object.keys(CATEGORY_LABELS) as FirmProgramCategory[];

  // Ordering, not just bucketing, is what makes these "representative".
  //
  // This took the first firm per category from an alphabetically sorted load of
  // every firm. Against the curated list that happened to surface known names;
  // against the SEC directory it surfaced "010118 Management, L.P." and "1031
  // Securities INC." - alphabetically first, and nobody a student is filtering
  // for. Firms with a known student programme come first, then the largest by
  // AUM, which is the same prominence rule Discovery ranks on.
  //
  // Per-category queries with a small limit also mean this no longer loads
  // 22.7k firms and their programs to return 56 strings.
  const perCategory = Math.ceil(max / categories.length) + 2;
  const buckets = await Promise.all(
    categories.map(async (category) => {
      // Two steps rather than a DISTINCT ON join. Postgres requires DISTINCT ON
      // to lead its ORDER BY with the distinct expression, so ordering by
      // firms.id came first and the ranking below only broke ties within a
      // single id - which is to say it did nothing, and the list came back
      // looking arbitrary again.
      const ids = await db
        .selectDistinct({ firmId: firmPrograms.firmId })
        .from(firmPrograms)
        .where(eq(firmPrograms.category, category));
      if (!ids.length) return [];

      const rows = await db
        .select({ name: firms.name })
        .from(firms)
        .where(inArray(firms.id, ids.map((r) => r.firmId)))
        .orderBy(desc(firms.hasVerifiedProgram), sql`${firms.aum} DESC NULLS LAST`, asc(firms.name))
        .limit(perCategory * 4);
      return rows.map((r) => r.name);
    }),
  );

  // Interleave so no one sector dominates the list.
  const out: string[] = [];
  const seen = new Set<string>();
  const deepest = Math.max(0, ...buckets.map((b) => b.length));
  for (let round = 0; round < deepest && out.length < max; round++) {
    for (const bucket of buckets) {
      if (out.length >= max) break;
      const name = bucket[round];
      // A firm in two sectors would otherwise appear twice on the checkbox list.
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

async function queryFirmBySlug(slug: string) {
  const db = await getDb();
  return db.query.firms.findFirst({
    where: eq(firms.slug, slug),
    with: { programs: true },
  });
}

const cachedFirmBySlug = sharedCache(queryFirmBySlug, ["firm-by-slug-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.firms],
});

export async function getFirmBySlug(slug: string) {
  return cachedFirmBySlug(slug);
}

// ---------- filterable, paged directory search ----------

export type AumBand = "any" | "mega" | "large" | "mid" | "small" | "unreported";

// Thresholds chosen to separate the household names from the long tail rather
// than to be round: at $10B+ you are looking at roughly a thousand firms, which
// is a browsable directory, and below $1B it is mostly single-office shops.
const AUM_BANDS: Record<Exclude<AumBand, "any">, { min?: number; max?: number; unreported?: boolean }> = {
  mega: { min: 100_000_000_000 },
  large: { min: 10_000_000_000, max: 100_000_000_000 },
  mid: { min: 1_000_000_000, max: 10_000_000_000 },
  small: { max: 1_000_000_000 },
  unreported: { unreported: true },
};

export type FirmSearchFilters = {
  /** Sectors to include. Empty or omitted means every sector. Multiple
   *  sectors are OR-ed: a firm matches if it runs a program in ANY of them,
   *  which is what picking "IB, PE, RE" off the filter means. */
  categories?: FirmProgramCategory[] | null;
  query?: string;
  /** Preset size bands. Empty or omitted means every size. OR-ed with each
   *  other and with the custom range below, so "Under $1B" plus "$100B+" is
   *  the barbell a student actually means rather than an empty result. */
  aumBands?: AumBand[] | null;
  /** Custom size range in dollars, for the numbers typed into the filter.
   *  Either end may stand alone; `aumMax` is exclusive, matching the bands. */
  aumMin?: number | null;
  aumMax?: number | null;
  /** Two-letter HQ state codes, OR-ed. */
  states?: string[] | null;
  /** Free-text location fragments matched against the HQ string, OR-ed with
   *  each other and with `states`. This is how a typed "Chicago" or "London"
   *  filters, since hqState only ever holds a US two-letter code. */
  locationTerms?: string[] | null;
  verifiedOnly?: boolean;
};

export type FirmSearchRow = {
  slug: string;
  name: string;
  headquarters: string;
  website: string;
  aum: number | null;
  hasVerifiedProgram: boolean;
  categories: FirmProgramCategory[];
};

export type FirmSearchResult = { rows: FirmSearchRow[]; total: number };

/** One AUM window as a single predicate, so windows can be OR-ed together. */
function aumWindow(spec: { min?: number; max?: number; unreported?: boolean }) {
  if (spec.unreported) return isNull(firms.aum);
  const parts: SQL[] = [isNotNull(firms.aum)];
  if (spec.min !== undefined) parts.push(gte(firms.aum, spec.min));
  if (spec.max !== undefined) parts.push(lt(firms.aum, spec.max));
  // Non-empty by construction, so `and` cannot return undefined here.
  return and(...parts) as SQL;
}

function buildFirmWhere(filters: FirmSearchFilters) {
  // A demo firm (scripts/seed-firm-demo.ts) is for showing the firm portal,
  // never a real result in the directory.
  const clauses: SQL[] = [eq(firms.isDemo, false)];
  const q = filters.query?.trim();
  if (q) {
    // Name and HQ both, because "Chicago" and "Citadel" are equally likely
    // things to type into one box.
    clauses.push(or(ilike(firms.name, `%${q}%`), ilike(firms.headquarters, `%${q}%`)) as SQL);
  }
  if (filters.verifiedOnly) clauses.push(eq(firms.hasVerifiedProgram, true));

  // Picked states and typed fragments are alternatives, not extra constraints:
  // "NY, or anything with Chicago in the HQ" is one filter, and AND-ing them
  // would return nothing every time both were set.
  const locationParts: SQL[] = [];
  if (filters.states?.length) locationParts.push(inArray(firms.hqState, filters.states));
  for (const term of filters.locationTerms ?? []) {
    const t = term.trim();
    if (t) locationParts.push(ilike(firms.headquarters, `%${t}%`));
  }
  if (locationParts.length) clauses.push(or(...locationParts) as SQL);

  // Same shape for size: each checked band and the typed range are alternatives.
  const aumParts: SQL[] = [];
  for (const b of filters.aumBands ?? []) {
    if (b !== "any" && AUM_BANDS[b]) aumParts.push(aumWindow(AUM_BANDS[b]));
  }
  if (filters.aumMin != null || filters.aumMax != null) {
    aumParts.push(
      aumWindow({ min: filters.aumMin ?? undefined, max: filters.aumMax ?? undefined }),
    );
  }
  if (aumParts.length) clauses.push(or(...aumParts) as SQL);

  return clauses.length ? and(...clauses) : undefined;
}

/**
 * One page of the directory, filtered and counted in SQL.
 *
 * This exists because the category pages used to hand the client every firm in
 * a sector - 9,000 of them for asset & wealth management - so the browser paid
 * for the whole sector on first paint even though a student reads the first
 * screenful. Both the filtering and the slicing now happen in Postgres, and the
 * page ships one page of rows plus a total.
 */
async function queryFirms(
  filters: FirmSearchFilters,
  limit = 60,
  offset = 0,
): Promise<FirmSearchResult> {
  const db = await getDb();

  // A category filter is a join against firm_programs, which is index-backed.
  // selectDistinct because a firm can hold two programs in one category.
  let idFilter;
  const categories = filters.categories?.length ? filters.categories : null;
  if (categories) {
    const ids = await db
      .selectDistinct({ firmId: firmPrograms.firmId })
      .from(firmPrograms)
      // inArray, not eq: several sectors can be selected at once, and a firm
      // qualifies by matching any one of them.
      .where(inArray(firmPrograms.category, categories));
    if (!ids.length) return { rows: [], total: 0 };
    idFilter = inArray(firms.id, ids.map((r) => r.firmId));
  }

  const where = buildFirmWhere(filters);
  const combined = idFilter && where ? and(idFilter, where) : (idFilter ?? where);

  const [countRow] = await db
    .select({ n: count() })
    .from(firms)
    .where(combined);

  const rows = await db
    .select({
      id: firms.id,
      slug: firms.slug,
      name: firms.name,
      headquarters: firms.headquarters,
      website: firms.website,
      aum: firms.aum,
      hasVerifiedProgram: firms.hasVerifiedProgram,
    })
    .from(firms)
    .where(combined)
    // Largest first, unreported AUM last, then alphabetical - the same order
    // the category pages use, so paging through matches what the page shows.
    .orderBy(sql`${firms.aum} DESC NULLS LAST`, asc(firms.name))
    .limit(limit)
    .offset(offset);

  if (!rows.length) return { rows: [], total: Number(countRow?.n ?? 0) };

  const programRows = await db
    .select({ firmId: firmPrograms.firmId, category: firmPrograms.category })
    .from(firmPrograms)
    .where(inArray(firmPrograms.firmId, rows.map((r) => r.id)));
  const byFirm = new Map<string, Set<FirmProgramCategory>>();
  for (const p of programRows) {
    const set = byFirm.get(p.firmId) ?? new Set<FirmProgramCategory>();
    set.add(p.category);
    byFirm.set(p.firmId, set);
  }

  return {
    total: Number(countRow?.n ?? 0),
    rows: rows.map(({ id, ...r }) => ({ ...r, categories: [...(byFirm.get(id) ?? [])] })),
  };
}

const cachedFirmSearch = sharedCache(queryFirms, ["firm-directory-search-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.firms],
});

function normalizedFirmFilters(filters: FirmSearchFilters): FirmSearchFilters {
  return {
    ...filters,
    query: filters.query?.trim() || undefined,
    categories: filters.categories ? [...new Set(filters.categories)].sort() : null,
    aumBands: filters.aumBands ? [...new Set(filters.aumBands)].sort() : null,
    states: filters.states ? [...new Set(filters.states)].sort() : null,
    locationTerms: filters.locationTerms
      ? [...new Set(filters.locationTerms.map((term) => term.trim()).filter(Boolean))].sort()
      : null,
  };
}

export async function searchFirms(
  filters: FirmSearchFilters,
  limit = 60,
  offset = 0,
): Promise<FirmSearchResult> {
  return cachedFirmSearch(normalizedFirmFilters(filters), limit, offset);
}

/** States present in the directory, for the location filter's options. */
async function queryFirmStates(): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ state: firms.hqState })
    .from(firms)
    .where(isNotNull(firms.hqState))
    .orderBy(asc(firms.hqState));
  return rows.map((r) => r.state).filter((s): s is string => !!s);
}

const cachedFirmStates = sharedCache(queryFirmStates, ["firm-states-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.firms],
});

export async function getFirmStates(): Promise<string[]> {
  return cachedFirmStates();
}

/**
 * Firm count per category, counted in SQL.
 *
 * Discovery used to derive these by loading every firm with its programs and
 * filtering the array once per category - 22k rows and their programs pulled
 * into memory to produce fourteen integers, on a page a student opens first.
 */
async function queryFirmCountsByCategory(): Promise<Record<FirmProgramCategory, number>> {
  const db = await getDb();
  const rows = await db
    .select({ category: firmPrograms.category, n: countDistinct(firmPrograms.firmId) })
    .from(firmPrograms)
    .groupBy(firmPrograms.category);

  const counts = {} as Record<FirmProgramCategory, number>;
  for (const r of rows) counts[r.category] = Number(r.n);
  return counts;
}

const cachedFirmCountsByCategory = sharedCache(queryFirmCountsByCategory, ["firm-counts-by-category-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.firms],
});

export async function getFirmCountsByCategory(): Promise<Record<FirmProgramCategory, number>> {
  return cachedFirmCountsByCategory();
}

/**
 * How many distinct firms recruit for any of these sectors.
 *
 * Distinct, not a sum of per-category counts: a firm with an IB desk and an S&T
 * desk is one firm to a student, and summing would report it twice and make the
 * directory look like it grew when it did not.
 */
async function queryFirmCountForCategories(categories: string[]): Promise<number> {
  if (categories.length === 0) return 0;
  const db = await getDb();
  const rows = await db
    .selectDistinct({ firmId: firmPrograms.firmId })
    .from(firmPrograms)
    .where(
      inArray(
        firmPrograms.category,
        categories as (typeof firmPrograms.$inferSelect)["category"][],
      ),
    );
  return rows.length;
}

const cachedFirmCountForCategories = sharedCache(queryFirmCountForCategories, ["firm-count-for-categories-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.firms],
});

export async function countFirmsForCategories(categories: string[]): Promise<number> {
  return categories.length
    ? cachedFirmCountForCategories([...new Set(categories)].sort())
    : 0;
}

/**
 * Major cities per state, derived from the HQ strings the directory already
 * holds ("New York, NY" -> New York under NY).
 *
 * Derived rather than a hardcoded list of "major cities": the point is to offer
 * places that actually have firms in them. A static list would offer Sacramento
 * under CA and return nothing, and would miss whichever town a boutique is
 * headquartered in.
 *
 * The floor of three firms keeps the dropdown to places worth clicking - below
 * that the free-text "add a place" box is the better tool.
 */
async function queryFirmCitiesByState(): Promise<Record<string, string[]>> {
  const db = await getDb();
  const rows = await db
    .select({
      state: firms.hqState,
      city: sql<string>`btrim(split_part(${firms.headquarters}, ',', 1))`,
      n: count(),
    })
    .from(firms)
    .where(isNotNull(firms.hqState))
    .groupBy(firms.hqState, sql`btrim(split_part(${firms.headquarters}, ',', 1))`)
    .having(sql`count(*) >= 3`)
    .orderBy(desc(count()));

  const out: Record<string, string[]> = {};
  for (const r of rows) {
    if (!r.state || !r.city) continue;
    (out[r.state] ??= []).push(r.city);
  }
  // Alphabetical within a state - the query ordered by size to apply the floor,
  // but a student scanning for a city wants it where they expect it.
  for (const s of Object.keys(out)) out[s].sort((a, b) => a.localeCompare(b));
  return out;
}

const cachedFirmCitiesByState = sharedCache(queryFirmCitiesByState, ["firm-cities-by-state-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.firms],
});

export async function getFirmCitiesByState(): Promise<Record<string, string[]>> {
  return cachedFirmCitiesByState();
}
