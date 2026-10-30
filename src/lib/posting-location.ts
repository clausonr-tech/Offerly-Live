// Recovering a posting's city when the feed does not give one.
//
// 1,356 of 2,214 crawled listings carry a location field; the rest do not,
// because not every board publishes one - TalentLink's Atom feed, which is
// where Evercore, Jefferies, Moelis and Perella Weinberg come from, has no
// location element at all. Those firms put the city in the ROLE TITLE instead:
// "2028 Strategic Advisory: Mergers & Acquisitions Summer Analyst Program -
// Menlo Park Healthcare".
//
// This is not inference and not a guess - it is the firm's own words, read out
// of the string they wrote. It only ever matches a known city by name, so an
// unrecognised title yields null rather than a plausible-looking fragment.

/**
 * Cities these programmes actually run in, longest-first so "New York" wins
 * over "York" and "Salt Lake City" is not read as "Lake".
 */
const CITIES = [
  "New York City", "Salt Lake City", "San Francisco", "Los Angeles", "Hong Kong",
  "Jersey City", "Washington DC", "Washington, DC", "Menlo Park", "Palo Alto",
  "Kuala Lumpur", "Buenos Aires", "Sao Paulo", "São Paulo", "Mexico City",
  "Minneapolis", "Philadelphia", "Indianapolis", "Jacksonville", "Charlotte",
  "Cleveland", "Baltimore", "Pittsburgh", "Nashville", "Milwaukee", "Cincinnati",
  "Birmingham", "Manchester", "Amsterdam", "Stockholm", "Copenhagen", "Frankfurt",
  "Dusseldorf", "Düsseldorf", "Barcelona", "Singapore", "Melbourne", "Vancouver",
  "Edinburgh", "Rotterdam", "Luxembourg", "Johannesburg",
  "New York", "Richmond", "Arlington", "Stamford", "Chicago", "Houston", "Atlanta",
  "Detroit", "Seattle", "Denver", "Phoenix", "Boston", "Dallas", "Austin", "Miami",
  "Toronto", "Calgary", "Montreal", "Ottawa", "London", "Paris", "Munich", "Berlin",
  "Hamburg", "Cologne", "Zurich", "Geneva", "Madrid", "Milan", "Rome", "Dublin",
  "Brussels", "Vienna", "Warsaw", "Prague", "Lisbon", "Athens", "Istanbul", "Dubai",
  "Riyadh", "Doha", "Mumbai", "Bangalore", "Chennai", "Pune", "Tokyo", "Shanghai",
  "Beijing", "Shenzhen", "Seoul", "Taipei", "Sydney", "Auckland", "Chester",
];

const CITY_RE = new RegExp(
  `\\b(${CITIES.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

/**
 * Does a posting's location satisfy one of the student's chosen locations?
 *
 * Compared loosely in both directions, because the two sides are written by
 * different people: onboarding offers "New York City" while a board writes
 * "New York, NY" or just "New York", and neither contains the other exactly.
 *
 * No stated preference means no constraint - a student open to anywhere is not
 * served by a location filter that excludes everywhere.
 */
export function matchesLocation(
  location: string | null | undefined,
  targetLocations: string[] | null | undefined,
): boolean {
  const wanted = (targetLocations ?? []).map((l) => l.toLowerCase().trim()).filter(Boolean);
  if (wanted.length === 0) return false;
  if (!location) return false;

  const have = location.toLowerCase();
  return wanted.some((w) => {
    // Strip the qualifiers each side adds - "New York City" vs "New York, NY"
    // vs "NYC / New York" all have to meet.
    const core = w.replace(/\b(city|area|metro|region)\b/g, "").replace(/[^a-z ]/g, " ").trim();
    if (!core) return false;
    return have.includes(core) || core.includes(have.replace(/[^a-z ]/g, " ").trim());
  });
}

/** The city named in a role title, in its canonical spelling, or null. */
export function locationFromTitle(title: string): string | null {
  const m = CITY_RE.exec(title);
  if (!m) return null;
  // Return the canonical casing from the list rather than whatever casing the
  // title happened to use.
  const found = m[1].toLowerCase();
  return CITIES.find((c) => c.toLowerCase() === found) ?? m[1];
}
