import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firmMatchCriteria, firms, schools, userTopFirms, users } from "@/db/schema";
import { countLabel, visibleCount } from "@/lib/firm-analytics-rules";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { SHARED_PROFILE, sharedWithFirmsWhere } from "@/lib/firm-sharing";
import { safeHttpUrl } from "@/lib/safe-url";
import { EMPTY_CRITERIA, matchStudent, type FirmCriteria } from "@/lib/firm-matching-rules";

/**
 * Student matching for a firm: its saved requirements, the choices the form
 * offers, and the ranked students who meet them.
 *
 * Every read of a student here goes through sharedWithFirmsWhere() and selects
 * SHARED_PROFILE - the one gate in lib/firm-sharing.ts. A student who has not
 * opted in, or opted in under an older policy, is never selected, so they
 * cannot appear in results, options or counts.
 */

/** Whether this is the public demo firm, which only ever sees demo students. */
export async function isDemoFirm(firmId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ isDemo: firms.isDemo }).from(firms).where(eq(firms.id, firmId));
  return Boolean(row?.isDemo);
}

export async function getFirmCriteria(firmId: string): Promise<FirmCriteria> {
  const db = await getDb();
  const row = await db.query.firmMatchCriteria.findFirst({ where: eq(firmMatchCriteria.firmId, firmId) });
  if (!row) return EMPTY_CRITERIA;
  return {
    gradYears: row.gradYears,
    schoolIds: row.schoolIds,
    majors: row.majors,
    categories: row.categories,
    locations: row.locations,
    degreeLevels: row.degreeLevels,
  };
}

export async function saveFirmCriteria(firmId: string, userId: string, criteria: FirmCriteria): Promise<void> {
  const db = await getDb();
  await db
    .insert(firmMatchCriteria)
    .values({ firmId, updatedByUserId: userId, ...criteria, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: firmMatchCriteria.firmId,
      set: { ...criteria, updatedByUserId: userId, updatedAt: new Date() },
    });
}

export type MatchOptions = {
  gradYears: number[];
  schools: { id: string; name: string }[];
  majors: string[];
  degreeLevels: string[];
  categories: { value: string; label: string }[];
  locations: string[];
  /**
   * Students sharing with firms at all - the pool the filters narrow - as a
   * firm may read it: the exact number from MIN_GROUP up, null below it.
   *
   * Zero is kept as zero rather than hidden, because "nobody is sharing yet"
   * is the page's own empty state and says nothing about any person. What is
   * floored is the count in between: three sharing students at one school is
   * the same disclosure the Analytics breakdowns fold into "Other".
   */
  pool: number | null;
  /** `pool` as the words to print: "12", "0", or "Fewer than 5". */
  poolLabel: string;
};

/**
 * What the requirements form offers: drawn from the students who are sharing,
 * so every choice can actually match someone. Sectors are the full list.
 */
export async function getMatchOptions(forDemoFirm: boolean): Promise<MatchOptions> {
  const db = await getDb();
  const rows = await db
    .select({
      gradYear: users.gradYear,
      schoolId: users.schoolId,
      major: users.major,
      degreeLevel: users.degreeLevel,
      targetLocations: users.targetLocations,
    })
    .from(users)
    .where(sharedWithFirmsWhere({ forDemoFirm }));

  const schoolIds = [...new Set(rows.map((r) => r.schoolId).filter((v): v is string => !!v))];
  const schoolRows = schoolIds.length
    ? await db.select({ id: schools.id, name: schools.name }).from(schools).where(inArray(schools.id, schoolIds))
    : [];
  const sorted = (xs: (string | null | undefined)[]) =>
    [...new Set(xs.filter((v): v is string => !!v?.trim()).map((v) => v.trim()))].sort((a, b) => a.localeCompare(b));

  return {
    gradYears: [...new Set(rows.map((r) => r.gradYear).filter((v): v is number => v !== null))].sort(),
    schools: schoolRows.sort((a, b) => a.name.localeCompare(b.name)),
    majors: sorted(rows.map((r) => r.major)),
    degreeLevels: sorted(rows.map((r) => r.degreeLevel)),
    categories: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
    locations: sorted(rows.flatMap((r) => r.targetLocations ?? [])),
    pool: visibleCount(rows.length),
    poolLabel: countLabel(rows.length),
  };
}

export type MatchedStudent = {
  id: string;
  name: string | null;
  email: string;
  school: string | null;
  gradYear: number | null;
  degree: string | null;
  major: string | null;
  sectors: string[];
  locations: string[];
  linkedinUrl: string | null;
  hasResume: boolean;
  score: number;
  reasons: string[];
};

const categoryLabel = (c: string) => CATEGORY_LABELS[c as FirmProgramCategory] ?? c;

/** The students who meet the firm's requirements, best match first. */
export async function findMatchingStudents(
  firmId: string,
  criteria: FirmCriteria,
  forDemoFirm: boolean,
  limit = 50,
): Promise<MatchedStudent[]> {
  const db = await getDb();

  // Which students put THIS firm on their own list.
  //
  // user_top_firms also holds the app's own suggestions (source "ai_matched",
  // written by matchTopFirmsForUser). With no predicate on source, a firm was
  // told "has your firm on their shortlist" - and the student ranked +5 for
  // it - on the strength of a row the student may never have seen, let alone
  // chosen. A suggestion is not a preference.
  //
  // Read as its own query rather than an EXISTS built from a template: that
  // form interpolated a table object and a bound id, and the two drivers
  // (postgres-js, PGlite) did not agree on it, so the flag read false under
  // one of them. One indexed read of this firm's rows means the same thing
  // everywhere - the same divergence lib/contact-credits.ts documents for dates.
  const shortlistedIds = new Set(
    (
      await db
        .select({ userId: userTopFirms.userId })
        .from(userTopFirms)
        .where(and(eq(userTopFirms.firmId, firmId), ne(userTopFirms.source, "ai_matched")))
    ).map((r) => r.userId),
  );

  const rows = await db
    .select(SHARED_PROFILE)
    .from(users)
    .where(sharedWithFirmsWhere({ forDemoFirm }));

  return rows
    .map((r) => {
      const m = matchStudent(
        {
          gradYear: r.gradYear,
          schoolId: r.schoolId,
          major: r.major,
          degreeLevel: r.degreeLevel,
          preferredCategories: r.preferredCategories,
          targetLocations: r.targetLocations,
          shortlistedFirm: shortlistedIds.has(r.id),
        },
        criteria,
        { category: categoryLabel },
      );
      return { r, m };
    })
    .filter(({ m }) => m.passes)
    .sort((a, b) => b.m.score - a.m.score || (a.r.name ?? "").localeCompare(b.r.name ?? ""))
    .slice(0, limit)
    .map(({ r, m }) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      school: r.school,
      gradYear: r.gradYear,
      degree: [r.degreeLevel, r.degreeProgram].filter(Boolean).join(", ") || null,
      major: r.major,
      sectors: (r.preferredCategories ?? []).map(categoryLabel),
      locations: r.targetLocations ?? [],
      // The student typed this, and it becomes a link a recruiter clicks: only
      // http(s) survives, never a javascript: or data: URL.
      linkedinUrl: safeHttpUrl(r.linkedinUrl),
      hasResume: Boolean(r.resumeStoragePath),
      score: m.score,
      reasons: m.reasons,
    }));
}

/** One sharing student, for the profile a firm opens - null if not sharing. */
export async function getSharedStudent(studentId: string, forDemoFirm: boolean) {
  const db = await getDb();
  const [row] = await db
    .select(SHARED_PROFILE)
    .from(users)
    .where(and(eq(users.id, studentId), sharedWithFirmsWhere({ forDemoFirm })));
  return row ?? null;
}
