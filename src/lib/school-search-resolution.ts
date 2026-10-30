import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { schools } from "@/db/schema";
import { identifyCompanyCandidates } from "@/lib/crustdata-client";
import {
  fallbackSchoolNames,
  schoolDomains,
  schoolLookupNames,
  selectSchoolSearchNames,
  type SchoolCandidate,
} from "@/lib/school-search-names";

/**
 * A student's school, as the contact search sends it: the label a student
 * reads, and the exact names the provider is asked for.
 *
 * The service half of lib/school-search-names. Resolved once per SCHOOL, not
 * per student or per search: the names are stored on the `schools` row, so
 * every student who signed up with an @upenn.edu address shares Penn's list,
 * and a search reads it with no lookup at all.
 */
export type SchoolSearch = { label: string; names: string[] };

/** Name lookups a student's own request may make for an unresolved school. */
const REQUEST_NAME_LOOKUPS = 3;

/** How long a resolved list is trusted. Schools rarely rename. */
const FRESH_MS = 90 * 24 * 60 * 60 * 1000;

type StudentSchoolFields = {
  school: string | null;
  schoolId: string | null;
  claimedSchoolId: string | null;
};

/**
 * The names to search for this student's school, or null when they gave none.
 *
 * The verified school (from a school email) wins over a claimed one, which
 * wins over free text. Never throws: a provider outage falls back to exact
 * matches on the typed and official names, which finds fewer people but still
 * never someone from another school.
 */
export async function schoolSearchFor(user: StudentSchoolFields): Promise<SchoolSearch | null> {
  const schoolId = user.schoolId ?? user.claimedSchoolId;
  if (!schoolId) {
    const names = fallbackSchoolNames(user.school);
    return user.school && names.length ? { label: user.school, names } : null;
  }

  const db = await getDb();
  const row = await db.query.schools.findFirst({ where: eq(schools.id, schoolId) });
  if (!row) {
    const names = fallbackSchoolNames(user.school);
    return user.school && names.length ? { label: user.school, names } : null;
  }

  const label = user.school?.trim() || row.name;
  const fresh =
    row.searchNamesCheckedAt && Date.now() - row.searchNamesCheckedAt.getTime() < FRESH_MS;
  // Inside a student's request, a light lookup: the domain and the school's
  // own long names (three), not every business-school wording. Measured: the
  // full nine, run just before the firm's own lookup, spent the provider's
  // allowance and the firm failed "temporarily unavailable". The sweep
  // (scripts/resolve-school-search-names) does the full set.
  const stored = fresh
    ? (row.searchNames ?? [])
    : await resolveSchoolSearchNames(row, user.school, { maxNameLookups: REQUEST_NAME_LOOKUPS });

  const names = stored.length ? stored : fallbackSchoolNames(row.name, user.school);
  return names.length ? { label, names } : null;
}

/**
 * Look the school up and store what was found.
 *
 * Free: /company/identify bills zero credits. Up to nine lookups - the domain,
 * then the school's own names and its business school's wordings - once per
 * school per 90 days.
 *
 * Writes only when every lookup completed. A rate limit is not evidence about
 * a school, and storing a partial list would pin it for 90 days.
 */
export async function resolveSchoolSearchNames(
  row: { id: string; name: string; emailDomain: string },
  studentTyped: string | null,
  /** Wait between lookups - for a sweep of every school, which would
   *  otherwise run into the provider's rate limit. */
  opts: { pauseMs?: number; maxNameLookups?: number } = {},
): Promise<string[]> {
  const pause = () => (opts.pauseMs ? new Promise((r) => setTimeout(r, opts.pauseMs)) : Promise.resolve());
  const candidates: SchoolCandidate[] = [];
  let failed = false;

  const ask = async (name: string, domain: string | null) => {
    const r = await identifyCompanyCandidates(name, domain);
    if (r.failure) failed = true;
    candidates.push(...r.candidates);
  };

  // The email domain and the school's own name first: together they find the
  // school's main page, whose other domains are the school's too.
  const lookups = schoolLookupNames(row.name, studentTyped);
  await ask(row.name, row.emailDomain);
  await pause();
  await ask(lookups[0], null);

  // Indiana: students on indiana.edu, LinkedIn's Indiana and Kelley on iu.edu.
  const domains = schoolDomains(row.emailDomain, candidates, lookups[0]);
  for (const extra of domains.filter((d) => d !== row.emailDomain).slice(0, 2)) {
    await pause();
    await ask(row.name, extra);
  }

  for (const name of lookups.slice(1, 1 + (opts.maxNameLookups ?? Infinity))) {
    await pause();
    await ask(name, null);
  }

  const names = selectSchoolSearchNames(domains, candidates, lookups[0]);
  if (failed) return names;

  const db = await getDb();
  // A light lookup (a student's request) is trusted for a day, not ninety:
  // it has not looked for every business-school wording, so the sweep, or
  // the next request after tomorrow, fills in the rest.
  const light = opts.maxNameLookups != null && opts.maxNameLookups < Infinity;
  const checkedAt = light ? new Date(Date.now() - FRESH_MS + 24 * 60 * 60 * 1000) : new Date();
  await db
    .update(schools)
    .set({ searchNames: names, searchNamesCheckedAt: checkedAt })
    .where(eq(schools.id, row.id));
  return names;
}
