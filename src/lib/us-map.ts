/**
 * The geography behind External Network's contact map: an outline of the
 * lower 48, a projection onto it, and where the cities and schools we see in
 * the data actually are.
 *
 * Hand-held rather than a map library or a geocoding service. The map is a
 * small illustration on a title card, so a ~100-point outline is all the
 * detail it can show, and the cities come from a short, known list - what
 * contacts' profiles and students' schools actually say. A city that is not
 * here is simply not plotted; it is never guessed.
 *
 * Alaska and Hawaii are not drawn. At this size they would be two specks, and
 * no contact in the data lives in either.
 */

type LonLat = readonly [lon: number, lat: number];

/** The contiguous US, clockwise from Cape Flattery. The border runs through
 *  the Great Lakes, as on most small-scale maps, so they read as land. */
const OUTLINE: LonLat[] = [
  [-124.7, 48.4], [-123.3, 49.0], [-95.2, 49.0], [-95.2, 49.4], [-94.8, 48.8],
  [-93.0, 48.6], [-89.6, 48.0], [-84.8, 46.5], [-82.4, 45.3], [-82.4, 43.0],
  [-83.1, 42.3], [-78.9, 42.9], [-79.2, 43.4], [-76.4, 44.2], [-74.7, 45.0],
  [-71.5, 45.0], [-71.1, 45.3], [-70.0, 46.7], [-69.2, 47.45], [-67.8, 47.1],
  [-67.8, 45.7], [-67.0, 44.9], [-68.8, 44.4], [-70.2, 43.6], [-70.7, 42.9],
  [-70.9, 42.4], [-70.5, 41.8], [-69.95, 41.9], [-70.0, 41.6], [-70.6, 41.5],
  [-71.4, 41.4], [-72.9, 41.25], [-73.9, 40.8], [-74.0, 40.6], [-74.0, 40.0],
  [-74.9, 38.9], [-75.1, 38.4], [-75.6, 37.8], [-76.0, 37.0], [-75.9, 36.5],
  [-75.5, 35.2], [-76.5, 34.7], [-77.9, 33.9], [-79.2, 33.2], [-80.0, 32.7],
  [-81.1, 32.0], [-81.4, 30.7], [-81.3, 29.9], [-80.6, 28.4], [-80.0, 26.7],
  [-80.1, 25.8], [-80.4, 25.2], [-81.1, 25.1], [-81.8, 26.1], [-82.6, 27.5],
  [-82.7, 28.7], [-83.7, 29.9], [-84.4, 30.0], [-85.4, 29.7], [-86.5, 30.4],
  [-88.0, 30.4], [-89.4, 30.2], [-89.2, 29.3], [-90.2, 29.1], [-91.3, 29.3],
  [-92.3, 29.6], [-93.8, 29.7], [-94.8, 29.3], [-96.4, 28.4], [-97.2, 27.7],
  [-97.4, 26.5], [-97.2, 25.95], [-99.1, 26.4], [-99.5, 27.5], [-100.3, 28.3],
  [-101.0, 29.4], [-102.4, 29.8], [-103.1, 29.0], [-104.4, 29.6], [-104.9, 30.6],
  [-106.5, 31.8], [-108.2, 31.8], [-108.2, 31.33], [-111.1, 31.33], [-114.8, 32.5],
  [-114.7, 32.7], [-117.1, 32.5], [-117.3, 33.2], [-118.3, 33.7], [-118.5, 34.0],
  [-119.2, 34.2], [-120.6, 34.6], [-120.9, 35.4], [-121.9, 36.6], [-122.4, 37.2],
  [-122.5, 37.8], [-123.0, 38.2], [-123.7, 39.0], [-123.8, 39.8], [-124.4, 40.4],
  [-124.1, 41.0], [-124.2, 42.0], [-124.5, 42.8], [-124.1, 44.0], [-123.9, 45.5],
  [-124.0, 46.3], [-124.1, 47.0], [-124.6, 47.9],
];

// Albers equal-area conic, the projection US maps are usually drawn in - it is
// what makes the northern border curve and the country look like itself
// rather than a stretched rectangle. Standard parallels 29.5N and 45.5N.
const RAD = Math.PI / 180;
const PHI1 = 29.5 * RAD;
const PHI2 = 45.5 * RAD;
const PHI0 = 37.5 * RAD;
const LAM0 = -96 * RAD;
const N = (Math.sin(PHI1) + Math.sin(PHI2)) / 2;
const C = Math.cos(PHI1) ** 2 + 2 * N * Math.sin(PHI1);
const RHO0 = Math.sqrt(C - 2 * N * Math.sin(PHI0)) / N;

function albers([lon, lat]: LonLat): [number, number] {
  const theta = N * (lon * RAD - LAM0);
  const rho = Math.sqrt(C - 2 * N * Math.sin(lat * RAD)) / N;
  // y grows downward in SVG, so north is negated.
  return [rho * Math.sin(theta), -(RHO0 - rho * Math.cos(theta))];
}

const RAW = OUTLINE.map(albers);
const MIN_X = Math.min(...RAW.map((p) => p[0]));
const MAX_X = Math.max(...RAW.map((p) => p[0]));
const MIN_Y = Math.min(...RAW.map((p) => p[1]));
const MAX_Y = Math.max(...RAW.map((p) => p[1]));

/** The map's drawing size, in SVG units. */
export const MAP_WIDTH = 240;
const MAP_HEIGHT = Math.round((MAP_WIDTH * (MAX_Y - MIN_Y)) / (MAX_X - MIN_X));
/** Room at the edges so a dot on the coast is not clipped. */
const PAD = 6;

/** A longitude/latitude as a point on the drawn map. */
export function project(at: LonLat): { x: number; y: number } {
  const [x, y] = albers(at);
  const scale = (MAP_WIDTH - PAD * 2) / (MAX_X - MIN_X);
  return {
    x: +(PAD + (x - MIN_X) * scale).toFixed(1),
    y: +(PAD + (y - MIN_Y) * scale).toFixed(1),
  };
}

export const US_OUTLINE_PATH =
  OUTLINE.map((p, i) => {
    const { x, y } = project(p);
    return `${i === 0 ? "M" : "L"}${x} ${y}`;
  }).join(" ") + " Z";

export const MAP_VIEW_HEIGHT = MAP_HEIGHT + PAD * 2;

/**
 * US cities, by the name a profile gives them. Keys are lowercase; the state,
 * when a profile carries one, is checked separately (see locateCity).
 *
 * Only unambiguous names. "Columbia" (SC? MO? MD?) and "Portland" (OR? ME?)
 * are left out rather than put on the wrong side of the country - a dot in
 * the wrong state is worse than a missing one.
 */
const CITIES: Record<string, LonLat> = {
  "new york": [-74.0, 40.71],
  "new york city": [-74.0, 40.71],
  nyc: [-74.0, 40.71],
  manhattan: [-73.97, 40.78],
  brooklyn: [-73.95, 40.65],
  "jersey city": [-74.08, 40.73],
  hoboken: [-74.03, 40.74],
  "short hills": [-74.33, 40.74],
  greenwich: [-73.63, 41.03],
  stamford: [-73.54, 41.05],
  boston: [-71.06, 42.36],
  cambridge: [-71.11, 42.37],
  waltham: [-71.24, 42.38],
  philadelphia: [-75.17, 39.95],
  washington: [-77.04, 38.91],
  "washington dc": [-77.04, 38.91],
  "washington, d.c.": [-77.04, 38.91],
  baltimore: [-76.61, 39.29],
  charlottesville: [-78.48, 38.03],
  richmond: [-77.44, 37.54],
  charlotte: [-80.84, 35.23],
  atlanta: [-84.39, 33.75],
  miami: [-80.19, 25.76],
  "west palm beach": [-80.05, 26.71],
  nashville: [-86.78, 36.16],
  chicago: [-87.63, 41.88],
  columbus: [-82.99, 39.96],
  cleveland: [-81.69, 41.5],
  cincinnati: [-84.51, 39.1],
  "terrace park": [-84.31, 39.16],
  detroit: [-83.05, 42.33],
  "ann arbor": [-83.74, 42.28],
  minneapolis: [-93.27, 44.98],
  "st. louis": [-90.2, 38.63],
  "saint louis": [-90.2, 38.63],
  "kansas city": [-94.58, 39.1],
  omaha: [-95.93, 41.26],
  dallas: [-96.8, 32.78],
  houston: [-95.37, 29.76],
  austin: [-97.74, 30.27],
  "san antonio": [-98.49, 29.42],
  denver: [-104.99, 39.74],
  "salt lake city": [-111.89, 40.76],
  boise: [-116.2, 43.62],
  mccall: [-116.1, 44.91],
  phoenix: [-112.07, 33.45],
  scottsdale: [-111.93, 33.49],
  "las vegas": [-115.14, 36.17],
  "los angeles": [-118.24, 34.05],
  "santa monica": [-118.49, 34.02],
  "beverly hills": [-118.4, 34.07],
  "el segundo": [-118.42, 33.92],
  irvine: [-117.83, 33.68],
  "newport beach": [-117.93, 33.62],
  "san diego": [-117.16, 32.72],
  "santa barbara": [-119.7, 34.42],
  "san francisco": [-122.42, 37.77],
  burlingame: [-122.35, 37.58],
  "san mateo": [-122.33, 37.56],
  "palo alto": [-122.14, 37.44],
  "menlo park": [-122.18, 37.45],
  "redwood city": [-122.24, 37.49],
  "san jose": [-121.89, 37.34],
  oakland: [-122.27, 37.8],
  berkeley: [-122.27, 37.87],
  seattle: [-122.33, 47.61],
  bellevue: [-122.2, 47.61],
  "new haven": [-72.93, 41.31],
  providence: [-71.41, 41.82],
  hanover: [-72.29, 43.7],
  princeton: [-74.66, 40.35],
  ithaca: [-76.5, 42.44],
  "south bend": [-86.25, 41.68],
  "notre dame": [-86.24, 41.7],
  bloomington: [-86.53, 39.17],
  durham: [-78.9, 35.99],
  "chapel hill": [-79.06, 35.91],
  evanston: [-87.69, 42.05],
  stanford: [-122.17, 37.43],
};

/** US state names and postal codes - what tells "Paris, TX" from Paris. */
const US_STATES = new Set([
  ..."al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc us usa".split(" "),
  ..."alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|united states".split("|"),
]);

/**
 * Where a free-text city is, or null when it is not a US city we know.
 *
 * "New York", "Boise, ID" and "Greater Boston Area" all resolve; "London",
 * "Paris" and "Toronto, ON" do not, because they are not on this map. A
 * profile that names a state we can check has to name a US one.
 */
export function locateCity(raw: string | null | undefined): LonLat | null {
  if (!raw) return null;
  const [cityPart, ...rest] = raw.toLowerCase().split(",").map((s) => s.trim());
  // "Boise, ID", "Austin, TX, United States": every part after the city has
  // to be a US state or the country itself.
  if (rest.some((part) => part && !US_STATES.has(part.replace(/\./g, "")))) return null;
  const city = cityPart
    .replace(/^greater\s+/, "")
    .replace(/\s+(metropolitan|metro|bay)?\s*area$/, "")
    .trim();
  return CITIES[city] ?? null;
}

/**
 * Each school's city. The student's own dot is their school - where they are
 * while they recruit - not their hometown. Keyed on the schools table's name.
 */
const SCHOOLS: Record<string, string> = {
  "university of pennsylvania": "philadelphia",
  "university of notre dame": "notre dame",
  "university of california, los angeles": "los angeles",
  "university of michigan": "ann arbor",
  "university of southern california": "los angeles",
  "new york university": "new york",
  "indiana university bloomington": "bloomington",
  "university of texas at austin": "austin",
  "boston college": "boston",
  "duke university": "durham",
  "georgetown university": "washington",
  "university of virginia": "charlottesville",
  "columbia university": "new york",
  "princeton university": "princeton",
  "emory university": "atlanta",
  "harvard university": "cambridge",
  "fordham university": "new york",
  "stanford university": "stanford",
  "university of chicago": "chicago",
  "yale university": "new haven",
  "rice university": "houston",
  "cornell university": "ithaca",
  "boston university": "boston",
  "vanderbilt university": "nashville",
  "university of california, berkeley": "berkeley",
  "northwestern university": "evanston",
  "university of north carolina at chapel hill": "chapel hill",
  "washington university in st. louis": "st. louis",
  "massachusetts institute of technology": "cambridge",
  "brown university": "providence",
  "dartmouth college": "hanover",
};

/** The school's city on the map, or null for a school not listed above. */
export function locateSchool(name: string | null | undefined): { city: string; at: LonLat } | null {
  const city = name ? SCHOOLS[name.trim().toLowerCase()] : undefined;
  const at = city ? CITIES[city] : undefined;
  return city && at ? { city, at } : null;
}
