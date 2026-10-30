/**
 * Which names a people search should accept as "this student's school".
 *
 * The provider has no school id - education.schools.school is a name and
 * nothing else (see the Crustdata person search reference). So the id lives
 * on our side: a student's `schools` row, set from their school email, owns a
 * fixed list of the names LinkedIn uses for that school, and the search asks
 * for exactly those.
 *
 * Exactly, not "contains these words". The word match on "University of
 * Pennsylvania" also returns Indiana, West Chester, Shippensburg, Kutztown,
 * Millersville and East Stroudsburg University of Pennsylvania - which is how
 * a Penn student's "same school" contacts came back from half a dozen other
 * universities.
 *
 * Where the names come from: the provider's own company records, looked up by
 * the school's email domain and by its known names, keeping only education
 * records on that domain. "The Wharton School" is on upenn.edu, so it is
 * Penn's; "Indiana University of Pennsylvania" is on iup.edu, so it is not.
 *
 * Pure: no network, no database. lib/school-search-resolution fetches and
 * persists.
 */

import { normaliseHost } from "@/lib/company-domains";
import { schoolCanonical, schoolNicknames, schoolSpellings } from "@/lib/school-name";

/** A provider company record, reduced to what deciding a school needs. */
export type SchoolCandidate = {
  name: string;
  domains: string[];
  primaryDomain: string | null;
  industries: string[];
};

/** The most names one school sends. A search filter, not a directory. */
const MAX_SCHOOL_NAMES = 20;

/** The most lookups one school's resolution makes. Free, but rate-limited. */
const MAX_SCHOOL_LOOKUPS = 8;

/**
 * `domain` is the school's email domain or beneath it: wharton.upenn.edu is
 * Penn's, but cuny.edu is not Baruch's (baruch.cuny.edu) - taking the
 * registrable domain would hand every CUNY college to each of them.
 */
export function onSchoolDomain(domain: string | null | undefined, schoolDomain: string): boolean {
  const host = normaliseHost(domain);
  const school = normaliseHost(schoolDomain);
  if (!host || !school) return false;
  return host === school || host.endsWith(`.${school}`);
}

/** A school's page, not a hospital, a club or a company on the same domain. */
function isEducation(c: SchoolCandidate): boolean {
  return c.industries.some((i) => /educat/i.test(i));
}

/** Pages that are part of a school but that nobody lists as where they studied. */
const NOT_A_SCHOOL_ENTRY =
  /\b(department|dept|center|centre|club|office|staff|council|admissions?|alumni|association|residential|auxiliar|libraries|library|athletics|press|foundation|research|institute|studio|services|program|ambassadors|conference|lab)\b/i;

/**
 * The school's domains: its email domain, plus every other domain its own
 * main page lists. Indiana's students sign up with indiana.edu, but LinkedIn
 * files "Indiana University Bloomington" under iu.edu (listing indiana.edu
 * too) and Kelley under iu.edu alone - so iu.edu is Indiana's as well.
 */
export function schoolDomains(emailDomain: string, candidates: SchoolCandidate[], officialName: string): string[] {
  const out = new Set([normaliseHost(emailDomain) ?? emailDomain]);
  const official = comparable(officialName);
  for (const c of candidates) {
    if (!isEducation(c) || comparable(c.name) !== official) continue;
    const all = [...c.domains, c.primaryDomain].filter((d): d is string => !!d);
    if (!all.some((d) => onSchoolDomain(d, emailDomain))) continue;
    for (const d of all) {
      const host = normaliseHost(d);
      if (host) out.add(host);
    }
  }
  return [...out];
}

/** Lower-case words only: "Indiana University-Bloomington" = "Indiana University Bloomington". */
function comparable(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The names to send for a school, from the candidates the provider returned.
 *
 * A candidate counts when it is an education record with ANY domain on one of
 * the school's domains (not only its primary: "Indiana University Bloomington"
 * is primary iu.edu, listing indiana.edu). Ranked so the names people put on
 * a profile come first - the school itself, then its business school, then
 * its other schools - and departments, councils and admissions pages last,
 * where the cap drops them. Deduplicated case-insensitively.
 */
export function selectSchoolSearchNames(
  domains: string | string[],
  candidates: SchoolCandidate[],
  officialName?: string,
): string[] {
  const schoolDomainList = Array.isArray(domains) ? domains : [domains];
  const official = officialName ? comparable(officialName) : null;
  const seen = new Set<string>();
  const ranked: { name: string; rank: number; order: number }[] = [];
  for (const [order, c] of candidates.entries()) {
    const name = c.name.trim();
    if (!name || !isEducation(c)) continue;
    const all = [...c.domains, c.primaryDomain].filter((d): d is string => !!d);
    if (!all.some((d) => schoolDomainList.some((sd) => onSchoolDomain(d, sd)))) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rank =
      official && comparable(name) === official
        ? 0
        : businessSchoolNames([name]).length
          ? 1
          : NOT_A_SCHOOL_ENTRY.test(name)
            ? 3
            : 2;
    ranked.push({ name, rank, order });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_SCHOOL_NAMES)
    .map((r) => r.name);
}

/**
 * Names worth looking up for a school, beyond its domain.
 *
 * The domain lookup returns only the provider's top few records, and a
 * business school is often not among them - upenn.edu brings back Nursing,
 * Law and Education but not Wharton. So the school's own name and the long
 * forms of its known nicknames are looked up too. Short nicknames ("Penn")
 * are not: a name lookup on them returns everything.
 */
export function schoolLookupNames(officialName: string, studentTyped: string | null): string[] {
  // The directory's names are the government's ("Indiana University-
  // Bloomington"); LinkedIn writes the hyphen as a space.
  const official = officialName.trim().replace(/\s*-\s*/g, " ");
  const out = new Set<string>([official]);
  for (const raw of [officialName, studentTyped]) {
    for (const spelling of schoolSpellings(raw)) {
      if (spelling.split(" ").length >= 2) out.add(spelling);
    }
  }
  // A business school is often not among the domain lookup's top records, and
  // its own name rarely says "business" the same way twice: Tippie is a
  // "College of Business", Rutgers a "Business School", Tulane a "School of
  // Business". Each wording is looked up; the domain check keeps only this
  // school's.
  for (const phrase of ["business school", "school of business", "college of business"]) {
    out.add(`${official} ${phrase}`);
  }
  // Brands the nickname table knows ("Questrom", "Tippie" is not in it) -
  // single words, safe here because the result must still be on the domain.
  for (const raw of [officialName, studentTyped]) {
    for (const nick of schoolNicknames(raw)) {
      if (!nick.includes(" ") && nick.length > 3 && BUSINESS_SCHOOL_BRANDS.test(nick)) out.add(`${official} ${nick}`);
    }
  }
  return [...out].filter(Boolean).slice(0, MAX_SCHOOL_LOOKUPS);
}

/**
 * Business schools known by their own name rather than by "business" - the
 * business-school entries of lib/school-name's SCHOOL_GROUPS. Safe as bare
 * words here, unlike in prose, because every name tested is already one of
 * the school's own records: on usc.edu, "Marshall" can only be USC Marshall.
 */
const BUSINESS_SCHOOL_BRANDS =
  /\b(?:wharton|marshall|stern|ross|mcintire|darden|kenan[- ]flagler|haas|anderson|sloan|dyson|sc johnson|johnson|mcdonough|mendoza|carroll school|questrom|kellogg|fuqua|booth|goizueta|owen|mccombs|kelley|olin|tepper|tuck|jones|scheller|gies|fisher|warrington|mays|zicklin|gabelli|carlson|foster|smith school|smeal|broad|leventhal|som)\b/i;

/**
 * The school's business-school names, searched before the rest of the
 * university: a Penn student's first contacts should be Wharton alumni. The
 * rest of Penn is still searched next, before any other school.
 */
export function businessSchoolNames(names: string[]): string[] {
  return names.filter((n) => /\b(?:business|mba)\b/i.test(n) || BUSINESS_SCHOOL_BRANDS.test(n));
}

/**
 * What to send when the school's names could not be resolved: the name the
 * student typed and the full name our nickname table gives it. Still exact,
 * so still never another school - it just finds fewer people.
 */
export function fallbackSchoolNames(...raw: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    for (const name of [r?.trim(), schoolCanonical(r)]) {
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}
