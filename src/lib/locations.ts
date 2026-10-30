export const TARGET_LOCATIONS = [
  "New York City",
  "Chicago",
  "San Francisco / Bay Area",
  "Boston",
  "Los Angeles",
  "Charlotte",
  "Dallas / Houston",
  "London",
  "Hong Kong",
  "Singapore",
  "No preference / open to relocating",
];

/** The "any city is fine" chip. Not a city - see scorePosting. */
const OPEN_TO_ANYWHERE = "No preference / open to relocating";

export function isOpenToAnywhere(location: string): boolean {
  return location === OPEN_TO_ANYWHERE;
}

// What a stored preference actually has to find inside a posting's
// "location + role title" text.
//
// These have to live next to TARGET_LOCATIONS because the two drifted apart
// once already: scoring used to search for the option string itself, which
// meant a student who picked "New York City" scored ZERO against every posting
// listed as "New York, NY" - the single most important city in this market.
// The two slash-compounds could never match anything at all, since no posting
// is located in "dallas / houston". Any option added above needs an entry here.
const LOCATION_ALIASES: Record<string, string[]> = {
  "New York City": ["new york", "nyc"],
  "Chicago": ["chicago"],
  "San Francisco / Bay Area": ["san francisco", "bay area", "menlo park", "palo alto"],
  "Boston": ["boston"],
  "Los Angeles": ["los angeles"],
  "Charlotte": ["charlotte"],
  "Dallas / Houston": ["dallas", "houston"],
  "London": ["london"],
  "Hong Kong": ["hong kong"],
  "Singapore": ["singapore"],
};

/** Lowercase substrings that mean "this posting is in that place". */
export function locationMatchTokens(location: string): string[] {
  const known = LOCATION_ALIASES[location];
  if (known) return known;
  // A city typed or seeded outside the list above: fall back to its own text,
  // minus any state/country suffix, so "Austin, TX" still matches "Austin".
  return [location.toLowerCase().split(",")[0].trim()].filter(Boolean);
}
