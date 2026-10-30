// How Student matching ranks students against a firm's requirements. Pure, so
// the rules are tested on their own (scripts/test/firm-matching.test.ts).
//
// A requirement the firm left empty means "any" and neither filters nor
// scores. A requirement it set is a hard filter: a student outside it is not
// shown. Among those who pass, students are ranked by how much more they
// line up with the firm than the filters demand - most of all, whether the
// student put this firm on their own shortlist, which is the single best
// signal that an email from the firm will be welcome.

export type FirmCriteria = {
  gradYears: number[];
  schoolIds: string[];
  majors: string[];
  categories: string[];
  locations: string[];
  degreeLevels: string[];
};

export const EMPTY_CRITERIA: FirmCriteria = {
  gradYears: [],
  schoolIds: [],
  majors: [],
  categories: [],
  locations: [],
  degreeLevels: [],
};

export type MatchableStudent = {
  gradYear: number | null;
  schoolId: string | null;
  major: string | null;
  degreeLevel: string | null;
  preferredCategories: string[] | null;
  targetLocations: string[] | null;
  /** The student has this firm on their own top-firms list. */
  shortlistedFirm: boolean;
};

export type MatchResult = { passes: boolean; score: number; reasons: string[] };

const norm = (s: string) => s.trim().toLowerCase();
const overlap = (a: string[] | null, b: string[]) => (a ?? []).filter((x) => b.some((y) => norm(y) === norm(x)));

/** Whether a student meets every requirement the firm set, and how strongly. */
export function matchStudent(
  student: MatchableStudent,
  criteria: FirmCriteria,
  labels: { category?: (c: string) => string } = {},
): MatchResult {
  const reasons: string[] = [];
  let score = 0;

  if (criteria.gradYears.length) {
    if (student.gradYear === null || !criteria.gradYears.includes(student.gradYear)) return fail();
    reasons.push(`Class of ${student.gradYear}`);
  }
  if (criteria.schoolIds.length) {
    if (!student.schoolId || !criteria.schoolIds.includes(student.schoolId)) return fail();
    reasons.push("Your target school");
  }
  if (criteria.degreeLevels.length) {
    if (!student.degreeLevel || !criteria.degreeLevels.some((d) => norm(d) === norm(student.degreeLevel!))) return fail();
  }
  if (criteria.majors.length) {
    if (!student.major || !criteria.majors.some((m) => norm(m) === norm(student.major!))) return fail();
    reasons.push(`Majors in ${student.major}`);
  }

  // Sectors and cities: required to overlap when set, and scored by how much.
  const sectors = overlap(student.preferredCategories, criteria.categories);
  if (criteria.categories.length) {
    if (sectors.length === 0) return fail();
    score += 2 * sectors.length;
    reasons.push(`Recruiting for ${sectors.map((c) => labels.category?.(c) ?? c).join(", ")}`);
  }
  const cities = overlap(student.targetLocations, criteria.locations);
  if (criteria.locations.length) {
    if (cities.length === 0) return fail();
    score += cities.length;
    reasons.push(`Wants ${cities.join(", ")}`);
  }

  if (student.shortlistedFirm) {
    score += 5;
    reasons.unshift("Has your firm on their shortlist");
  }
  // A complete profile is easier to judge and to reach.
  if (student.gradYear !== null) score += 0.5;
  if (student.major) score += 0.5;

  return { passes: true, score, reasons };
}

function fail(): MatchResult {
  return { passes: false, score: 0, reasons: [] };
}

/** Cleans criteria posted from the form: known shapes only, deduped, bounded. */
export function parseCriteria(input: {
  gradYears: string[];
  schoolIds: string[];
  majors: string[];
  categories: string[];
  locations: string[];
  degreeLevels: string[];
}): FirmCriteria {
  const uniq = (xs: string[], max: number) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, max);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    gradYears: uniq(input.gradYears, 12)
      .map(Number)
      .filter((y) => Number.isInteger(y) && y >= 2000 && y <= 2100),
    schoolIds: uniq(input.schoolIds, 200).filter((id) => uuid.test(id)),
    majors: uniq(input.majors, 100).filter((m) => m.length <= 100),
    categories: uniq(input.categories, 30).filter((c) => /^[a-z_]{2,40}$/.test(c)),
    locations: uniq(input.locations, 50).filter((l) => l.length <= 80),
    degreeLevels: uniq(input.degreeLevels, 10).filter((d) => d.length <= 40),
  };
}
