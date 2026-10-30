// One role, however it is written: "IB Summer Analyst", "Summer Analyst, IB"
// and "Investment Banking Summer Analyst" are the same application.
//
// Its own module with no imports, so matching a tracker entry to a posting -
// for reminders, for "I applied" - reads role names one way everywhere.

/** Abbreviations students and boards use, as the words they stand for. */
const EXPANSIONS: Record<string, string> = {
  ib: "investment banking",
  ibd: "investment banking",
  "s&t": "sales trading",
  pe: "private equity",
  vc: "venture capital",
  am: "asset management",
  awm: "asset wealth management",
  wm: "wealth management",
  er: "equity research",
  rx: "restructuring",
  "m&a": "mergers acquisitions",
  lev: "leveraged",
  levfin: "leveraged finance",
  fin: "finance",
  tmt: "technology media telecom",
  fig: "financial institutions",
  quant: "quantitative",
  ecm: "equity capital markets",
  dcm: "debt capital markets",
  sa: "summer analyst",
  ft: "full time",
  analysts: "analyst",
  associates: "associate",
  programme: "program",
};

/** Words that carry no identity: "the", "and", and how boards pad a title -
 *  "Program", "Division", "Group", "Intern". */
const FILLER = new Set([
  "the", "and", "of", "for", "a", "an", "in", "at", "to", "program", "division", "group", "intern", "interns",
  "internship", "internships", "role", "position",
]);

/** Cities boards put in a title. A title that names one and a title that
 *  names none can be the same role; two different ones cannot. */
const CITIES = [
  "new york", "nyc", "london", "san francisco", "sf", "chicago", "boston", "houston", "los angeles", "la",
  "charlotte", "menlo park", "palo alto", "hong kong", "singapore", "dallas", "atlanta", "miami", "washington",
  "dc", "philadelphia", "denver", "minneapolis", "toronto", "tokyo", "paris", "frankfurt", "st louis",
  "salt lake city", "seattle", "austin", "greenwich", "stamford", "jersey city", "newark", "baltimore",
];

/**
 * A role title as an order-free set of words: lower-case, accents and
 * punctuation gone, abbreviations spelled out, filler dropped, duplicates
 * merged, sorted. Two titles with the same key are the same role; numbers
 * stay, so a 2026 programme is not the 2027 one.
 */
export function roleKey(role: string | null | undefined): string {
  if (!role) return "";
  const raw = role
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // Keep the ampersand inside "s&t" and "m&a" long enough to expand them.
    .replace(/\b([a-z])\s*&\s*([a-z])\b/g, "$1&$2")
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
  const words = raw
    .flatMap((w) => (EXPANSIONS[w] ?? w).split(" "))
    .map((w) => w.replace(/&/g, ""))
    .filter((w) => w && !FILLER.has(w));
  return [...new Set(words)].sort().join(" ");
}

/** Longest city names first, so "new york" is taken before "york". Sorted
 *  once here rather than inside roleParts, which copied and sorted the list on
 *  every call - and roleParts is called once per pair when an import is
 *  compared against a whole tracker. */
const CITIES_LONGEST_FIRST = [...CITIES].sort((x, y) => y.length - x.length);

/** A title split into what it is, which year, and where. */
export type RoleParts = { words: string; years: string; cities: string };

/** A title split into what it is, which year, and where. */
export function roleParts(role: string | null | undefined): RoleParts {
  const key = roleKey(role);
  let rest = ` ${key} `;
  const cities: string[] = [];
  for (const c of CITIES_LONGEST_FIRST) {
    // The key is sorted, so a two-word city may not be adjacent in it - look
    // for each of its words instead, and take them all or none.
    const parts = c.split(" ");
    if (parts.every((p) => rest.includes(` ${p} `))) {
      for (const p of parts) rest = rest.replace(` ${p} `, " ");
      cities.push(c === "nyc" ? "new york" : c === "sf" ? "san francisco" : c === "la" ? "los angeles" : c);
    }
  }
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const years = tokens.filter((t) => /^\d{2,4}$/.test(t)).map((t) => (t.length === 2 ? `20${t}` : t));
  return {
    words: tokens.filter((t) => !/^\d+$/.test(t)).join(" "),
    years: [...new Set(years)].sort().join(" "),
    cities: [...new Set(cities)].sort().join(" "),
  };
}

/**
 * Whether two titles are the same role - the same words in any order and any
 * abbreviation, where a year or a city named on one side and not the other is
 * not a difference ("IB Summer Analyst" is "2027 IB Summer Analyst - New
 * York"), but two different years or cities are (2026 is not 2027).
 */
export function sameRole(a: string | null | undefined, b: string | null | undefined): boolean {
  return sameRoleParts(roleParts(a), roleParts(b));
}

/**
 * The same question asked of two titles already split.
 *
 * Its own function so a caller comparing one title against many - an imported
 * file against the whole tracker - can split each title once instead of once
 * per comparison. sameRole is this, with the splitting done for you.
 */
export function sameRoleParts(x: RoleParts, y: RoleParts): boolean {
  if (!x.words || x.words !== y.words) return false;
  const fits = (p: string, q: string) => !p || !q || p === q;
  return fits(x.years, y.years) && fits(x.cities, y.cities);
}
