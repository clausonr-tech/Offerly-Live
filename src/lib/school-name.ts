// One school, however a student or a profile writes it: "Penn", "UPenn",
// "Wharton" and "University of Pennsylvania" are the same place.
//
// Its own module with no imports, so every comparison of schools - the
// relevance score, the contact search's similarity, the drafter's common
// ground - folds names the same way.
//
// Only real, unambiguous nicknames are folded - not "U of M" (Michigan or
// Minnesota), "UW" (Washington or Wisconsin) or "OSU" (Ohio, Oklahoma or
// Oregon State). "Miami University" and the
// "University of Miami" are different schools, as are the "University of
// Washington" and "Washington University in St. Louis", and "Penn State" is
// not Penn - so nothing looser than this table and a trailing "University" is
// safe.

/**
 * Nicknames, and the schools within a university, grouped: every name in a
 * group means the group's first. Written lower-case, with punctuation as
 * spaces and "&" as "and" - the form schoolKey reduces a name to.
 */
const SCHOOL_GROUPS: string[][] = [
  ["university of pennsylvania", "penn", "upenn", "u penn", "wharton", "the wharton school", "wharton school"],
  ["university of southern california", "usc", "marshall", "usc marshall", "marshall school of business"],
  ["new york university", "nyu", "stern", "nyu stern", "stern school of business"],
  ["university of michigan", "umich", "michigan", "ross", "michigan ross", "ross school of business", "university of michigan ann arbor"],
  ["university of virginia", "uva", "mcintire", "uva mcintire", "darden"],
  ["university of north carolina at chapel hill", "unc", "unc chapel hill", "kenan flagler", "unc kenan flagler"],
  ["university of california berkeley", "uc berkeley", "berkeley", "cal", "cal berkeley", "haas", "berkeley haas"],
  ["university of california los angeles", "ucla", "anderson"],
  ["harvard university", "harvard", "harvard college", "hbs", "harvard business school"],
  ["massachusetts institute of technology", "mit", "sloan", "mit sloan"],
  ["columbia university", "columbia", "columbia business school", "cbs"],
  ["cornell university", "cornell", "dyson", "cornell dyson", "johnson", "sc johnson"],
  ["georgetown university", "georgetown", "mcdonough", "georgetown mcdonough"],
  ["university of notre dame", "notre dame", "nd", "mendoza"],
  ["boston college", "bc", "carroll school", "carroll school of management"],
  ["boston university", "bu", "questrom"],
  ["northwestern university", "northwestern", "kellogg"],
  ["duke university", "duke", "fuqua"],
  ["stanford university", "stanford", "stanford gsb", "gsb"],
  ["university of chicago", "uchicago", "chicago booth", "booth"],
  ["emory university", "emory", "goizueta"],
  ["vanderbilt university", "vanderbilt", "vandy", "owen"],
  ["university of texas at austin", "ut austin", "mccombs", "ut mccombs"],
  ["indiana university", "iu", "kelley", "indiana kelley", "indiana university bloomington"],
  ["washington university in st louis", "washu", "wash u", "wustl", "olin"],
  ["carnegie mellon university", "cmu", "carnegie mellon", "tepper"],
  ["yale university", "yale", "yale som"],
  ["princeton university", "princeton"],
  ["brown university", "brown"],
  ["dartmouth college", "dartmouth", "tuck"],
  ["rice university", "rice", "jones"],
  ["georgia institute of technology", "georgia tech", "gatech", "scheller"],
  ["university of wisconsin madison", "uw madison", "wisconsin"],
  ["university of illinois urbana champaign", "uiuc", "illinois", "gies"],
  ["ohio state university", "ohio state", "fisher"],
  ["university of florida", "uf", "warrington"],
  ["texas a and m university", "texas a and m", "tamu", "mays"],
  ["london school of economics", "lse"],
  ["baruch college", "baruch", "zicklin"],
  ["villanova university", "villanova"],
  ["fordham university", "fordham", "gabelli"],
  ["university of miami", "umiami"],
  ["babson college", "babson"],
  ["bentley university", "bentley"],
  ["university of minnesota", "umn", "carlson"],
  ["university of washington", "foster"],
  ["university of maryland", "umd", "smith school"],
  ["penn state university", "penn state", "smeal", "pennsylvania state university"],
  ["michigan state university", "michigan state", "broad"],
];

const ALIASES: Record<string, string> = Object.fromEntries(
  SCHOOL_GROUPS.flatMap(([canonical, ...rest]) => [canonical, ...rest].map((n) => [n, canonical])),
);

/**
 * A school's name as one key: lower-case, punctuation as spaces, "&" as "and",
 * "Univ." as "university", nicknames folded (see SCHOOL_GROUPS), and a
 * trailing "University" dropped - "Duke University" and "Duke" are one, but
 * "University of X" keeps its "University".
 */
export function schoolKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\buniv\.?(?=\s|$)/g, "university")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the\s+/, "")
    .trim();
  return (ALIASES[s] ?? s).replace(/ university$/, "");
}

/**
 * The full name the table gives a school - "university of pennsylvania" for
 * "Wharton" - or null when the name is not one of the table's, so nothing is
 * folded that the table does not know.
 */
export function schoolCanonical(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\buniv\.?(?=\s|$)/g, "university")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the\s+/, "")
    .trim();
  return ALIASES[s] ?? null;
}

/** Whether two names are the same school, by the table above. */
export function sameSchoolName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = schoolKey(a);
  return x.length > 0 && x === schoolKey(b);
}

/**
 * Acronyms safe to look for in free text: distinctive, three letters or more.
 * Not "BC" or "BU" (abbreviations of everything), and not the business
 * schools' surnames ("Stern", "Ross", "Jones", "Olin") - in a banker's
 * background those are people as often as schools.
 */
const TEXT_ACRONYMS = new Set([
  "upenn", "usc", "nyu", "umich", "uva", "unc", "ucla", "hbs", "mit", "uchicago", "washu", "wustl", "cmu",
  "gatech", "uiuc", "tamu", "umd", "umn",
]);

/**
 * Every way the table writes this school that is safe to find in free text (a
 * background, a job history): names of two or more words, and the acronyms
 * above. Never a single ordinary word - "Duke" is also an energy company,
 * "Rice" a grain.
 */
export function schoolSpellings(raw: string | null | undefined): string[] {
  const key = schoolKey(raw);
  if (!key) return [];
  const group = SCHOOL_GROUPS.find(([canonical]) => schoolKey(canonical) === key);
  // A school the table does not know is looked for by its own name, when that
  // is long enough to be a name and not a fragment ("U of M").
  if (!group) return key.replace(/ /g, "").length >= 6 ? [key] : [];
  // "SC Johnson" is also a company; "CBS" and "LSE" are a network and an
  // exchange - left out of what is looked for in prose.
  return [...new Set(group)].filter((n) => (n.includes(" ") && n !== "sc johnson") || TEXT_ACRONYMS.has(n));
}

/** Words that can sit around a school's name without making it another
 *  school: "... School of Business", "The ... University". */
const SCHOOL_PARTS = new Set([
  "the", "of", "at", "and", "in", "school", "business", "college", "university", "management", "graduate",
  "undergraduate", "program", "arts", "sciences", "engineering", "campus",
]);

/** A school's name as plain words, for comparing whole names. */
function plain(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the\s+/, "")
    .trim();
}

/**
 * Whether `long` is one of `names` with only school-part words around it -
 * "usc marshall school of business" for USC (Marshall is USC's own), but not
 * "unc charlotte" for UNC or "indiana university of pennsylvania" for Penn:
 * a word that is not part of THAT school makes it another one.
 */
function withinSchool(long: string, names: readonly string[], own: ReadonlySet<string>): boolean {
  const L = long.split(" ").filter(Boolean);
  for (const name of names) {
    const N = name.split(" ").filter(Boolean);
    for (let i = 0; i + N.length <= L.length; i++) {
      if (!N.every((w, j) => L[i + j] === w)) continue;
      const rest = [...L.slice(0, i), ...L.slice(i + N.length)];
      if (rest.every((w) => SCHOOL_PARTS.has(w) || own.has(w))) return true;
    }
  }
  return false;
}

/** Every name the nickname table gives this school, or [] when it has none. */
export function schoolNicknames(raw: string | null | undefined): string[] {
  return raw ? (groupOf(raw) ?? []) : [];
}

function groupOf(raw: string): string[] | null {
  const canonical = schoolCanonical(raw);
  return canonical ? (SCHOOL_GROUPS.find(([c]) => c === canonical) ?? null) : null;
}

/**
 * Whether two schools, as anyone wrote them, are the same school - THE
 * comparison, used by the relevance score, the contact search and the drafter.
 *
 * The same key; a nickname in the table; one written out in full around a
 * name the table knows ("NYU Stern School of Business" and "NYU"); or, for
 * schools the table does not know, one inside the other with only school-part
 * words around it ("Bentley" and "Bentley University"). Never across campuses
 * or lookalikes: "Penn State", "UNC Charlotte", "Central Michigan", "Indiana
 * University of Pennsylvania" are other schools.
 */
export function sameSchool(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (sameSchoolName(a, b)) return true;
  const [pa, pb] = [plain(a), plain(b)];
  if (!pa || !pb) return false;
  if (pa === pb) return true;
  const [ga, gb] = [groupOf(a), groupOf(b)];
  const ownWords = (g: string[] | null) => new Set((g ?? []).flatMap((n) => n.split(" ")));
  if (gb && withinSchool(pa, gb, ownWords(gb))) return true;
  if (ga && withinSchool(pb, ga, ownWords(ga))) return true;
  // Neither known to the table: one inside the other, with only school-part
  // words around it, and never a fragment of three letters or fewer.
  if (!ga && !gb) {
    const [short, long] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
    if (short.replace(/ /g, "").length > 3 && withinSchool(long, [short], new Set())) return true;
  }
  return false;
}

/**
 * Other schools whose names contain a better-known one, blanked before prose
 * is searched: "Indiana University of Pennsylvania" is not Penn, "Central
 * Michigan" is not Michigan.
 */
export const LOOKALIKE_SCHOOLS =
  /\b(?:indiana university of pennsylvania|(?:central|eastern|western|northern) michigan(?: university)?|george washington(?: university)?|unc (?:charlotte|wilmington|greensboro|asheville|pembroke)|cal poly|cal state|penn state|michigan state|university of michigan dearborn|university of michigan flint)\b/g;
