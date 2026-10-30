import { TARGET_LOCATIONS, locationMatchTokens } from "./locations";

/**
 * Spelling help for a typed city.
 *
 * The "Other" chip lets a student type a place the option list does not offer.
 * That is the point of it - so this corrects TYPOS and leaves everything else
 * alone. A matcher that snapped every unrecognised answer to the nearest of
 * ten chips would turn "Salt Lake City" into "Los Angeles", which is worse
 * than not correcting at all.
 *
 * So a correction only happens when the typed text is genuinely close to a
 * city we know. Anything else is returned untouched.
 */

/**
 * Cities a finance student might plausibly name. Not exhaustive geography -
 * it is the list a typo is checked against, so its job is to cover the places
 * these roles actually sit, and to RECOGNISE a correctly spelled city so it is
 * left alone.
 */
const KNOWN_CITIES: readonly string[] = [
  // US - the money centres first
  "New York City", "Chicago", "San Francisco", "Boston", "Los Angeles", "Charlotte",
  "Dallas", "Houston", "Atlanta", "Miami", "Washington DC", "Philadelphia", "Seattle",
  "Denver", "Minneapolis", "Detroit", "Cleveland", "Columbus", "Pittsburgh", "Baltimore",
  "Phoenix", "San Diego", "San Jose", "Austin", "Nashville", "Charlotte", "Raleigh",
  "Richmond", "Salt Lake City", "Portland", "Las Vegas", "Kansas City", "St. Louis",
  "Cincinnati", "Indianapolis", "Milwaukee", "New Orleans", "Tampa", "Orlando",
  "Jacksonville", "Sacramento", "San Antonio", "Fort Worth", "Omaha", "Des Moines",
  "Hartford", "Stamford", "Greenwich", "Jersey City", "Newark", "Menlo Park",
  "Palo Alto", "Santa Monica", "Irvine", "Boulder", "Madison", "Ann Arbor",
  "Chapel Hill", "Durham", "Birmingham", "Memphis", "Louisville", "Buffalo",
  "Rochester", "Albany", "Providence", "Portland Maine", "Honolulu", "Anchorage",
  // Global financial centres
  "London", "Hong Kong", "Singapore", "Tokyo", "Shanghai", "Sydney", "Melbourne",
  "Toronto", "Vancouver", "Montreal", "Calgary", "Mexico City", "Sao Paulo",
  "Buenos Aires", "Frankfurt", "Paris", "Zurich", "Geneva", "Amsterdam", "Dublin",
  "Madrid", "Milan", "Stockholm", "Copenhagen", "Oslo", "Brussels", "Luxembourg",
  "Dubai", "Abu Dhabi", "Doha", "Riyadh", "Tel Aviv", "Mumbai", "Bengaluru",
  "Delhi", "Seoul", "Taipei", "Bangkok", "Jakarta", "Kuala Lumpur", "Manila",
  "Johannesburg", "Cape Town", "Lagos", "Nairobi", "Edinburgh", "Manchester",
];

/** Lowercased, punctuation-light, and without any ", ST" / ", Country" tail. */
function normalise(value: string): string {
  return value
    .split(",")[0]
    .toLowerCase()
    .replace(/[.'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Standard Levenshtein distance. Small inputs, so the simple matrix is fine. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1, // deletion
        row[j - 1] + 1, // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * How wrong a spelling may be before we stop guessing.
 *
 * Scaled to length, because one wrong letter in "Oslo" is a different kind of
 * mistake from one wrong letter in "Philadelphia". Capped so a long string is
 * never rewritten into something the student plainly did not type.
 */
function tolerance(length: number): number {
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * The typed value, corrected to a known city when it is clearly a misspelling
 * of one, and returned unchanged otherwise.
 *
 * When the result is one of the offered chips under another name ("new york"
 * -> "New York City"), the chip's own wording wins, so a typed answer and a
 * clicked one are stored identically rather than as two spellings of the same
 * place.
 */
/**
 * Every spelling we recognise, mapped to the wording we store.
 *
 * Built from the chip options and their existing aliases as well as the city
 * list, because "new york" is five edits from "New York City" - far past any
 * sane typo tolerance - yet is obviously the same place. locations.ts already
 * knew that; this reuses it rather than keeping a second opinion.
 */
const CANDIDATES: { text: string; store: string }[] = (() => {
  const out = new Map<string, string>();
  for (const option of TARGET_LOCATIONS) {
    out.set(normalise(option), option);
    for (const alias of locationMatchTokens(option)) out.set(normalise(alias), option);
  }
  for (const city of KNOWN_CITIES) {
    const key = normalise(city);
    if (!out.has(key)) out.set(key, canonical(city));
  }
  return [...out].map(([text, store]) => ({ text, store }));
})();

export function correctCity(input: string): string {
  const typed = input.trim();
  if (!typed) return typed;

  const target = normalise(typed);
  if (!target) return typed;

  let best: { store: string; distance: number } | null = null;
  for (const candidate of CANDIDATES) {
    const distance = editDistance(target, candidate.text);
    if (distance === 0) return candidate.store;
    if (!best || distance < best.distance) best = { store: candidate.store, distance };
  }

  if (best && best.distance <= tolerance(target.length)) return best.store;

  // Nothing close. Keep what they typed - it may be a real place this list
  // simply does not carry.
  return typed;
}

/** Prefer the wording of an offered chip when one means the same place. */
function canonical(city: string): string {
  const lower = city.toLowerCase();
  const option = TARGET_LOCATIONS.find((o) => o.toLowerCase().split(" / ").includes(lower));
  return option ?? city;
}

/**
 * Our city labels in a data provider's vocabulary.
 *
 * Our chips say what a student would say - "New York City", "Washington DC",
 * "Bay Area". A people-data provider stores the administrative city name, so
 * "New York City" matches nobody while "New York" matches everyone. Measured
 * against Crustdata: our spelling returned 0 where theirs returned 6.
 *
 * Only genuine mismatches are listed. Note what is NOT here: "Kansas City",
 * "Salt Lake City" and "Jersey City" are all really called that, so a rule
 * like "strip a trailing City" would quietly break three real cities to fix
 * one. An explicit list cannot make that mistake.
 */
const PROVIDER_CITY_NAMES: Record<string, string> = {
  "new york city": "New York",
  "washington dc": "Washington",
  "bay area": "San Francisco",
  "san francisco bay area": "San Francisco",
  "sao paulo": "São Paulo",
  "portland maine": "Portland",
  "st. louis": "St. Louis",
};

/**
 * One of our location chips, as a provider is likely to have stored it.
 * Unknown values pass through unchanged - the chip's own wording is usually
 * the city's real name.
 */
export function providerCityName(label: string): string {
  const key = label.trim().toLowerCase().replace(/\s+/g, " ");
  return PROVIDER_CITY_NAMES[key] ?? label.trim();
}
