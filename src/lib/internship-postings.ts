import { isNamedRoleTitle, isPlaceholderTitle, PLACEHOLDER_TITLE_SQL_PATTERN } from "./role-title";
import "server-only";
import { and, asc, eq, inArray, not, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { detectedListings, firmPrograms, firms, internshipPostings } from "@/db/schema";
import { SHARED_CACHE_SECONDS, SHARED_CACHE_TAGS, sharedCache } from "@/lib/shared-data-cache";
import { EXPECTED_YEARS_AHEAD, isCarryableTitle, projectExpected, showableExpected, type ExpectedPosting, type PastPosting } from "./expected-postings";
import { HISTORICAL_RELEASES } from "./historical-releases";
import { QUIZ_CATEGORIES, type QuizCategory } from "./question-bank/types";
import {
  IB_TIER_LABELS,
  PE_TIER_LABELS,
  type FirmProgramCategory,
} from "./firm-metadata";
import { FIRM_TIER_BY_SLUG } from "./firm-content";
import { isOpenToAnywhere, locationMatchTokens } from "./locations";
import { deadlineColumnsFromText } from "./posting-deadline";
import { publicHttpUrl } from "./safe-url";

// The shape `savePosting` needs to publish a posting to the student-facing
// table. This used to be `CrawledPosting`, produced by the AI crawler
// (src/lib/internship-crawler.ts, removed) - the AI is gone but the table
// and its columns aren't, so the shape lives on here instead, unchanged.
export type PublishablePosting = {
  roleTitle: string;
  location: string | null;
  programYear: number;
  eligibleGradYears: number[];
  deadlineStatus: "tbd" | "confirmed" | "rolling" | "closed";
  deadlineText: string | null;
  deadlineDateIso: string | null;
  descriptionFull: string;
  requirementsFull?: string | null;
  sourceUrl: string;
  applicationUrl: string | null;
  recruiterName: string | null;
  recruiterTitle: string | null;
  recruiterEmail: string | null;
  recruiterPhone: string | null;
};

// A pre-existing gap, not something this change introduces: `getRelevantPostings`
// filters student.preferredCategories against the narrower 8-value QuizCategory,
// while `internshipPostings.category` (and the new monitoring classifier) use
// the full 14-value FirmProgramCategory. A posting classified into a category
// outside QuizCategory (venture_capital, private_credit, commercial_banking,
// insurance, fintech, market_infrastructure) still gets stored and still shows
// up for a student with NO preferred categories set, it just can't be matched
// by name against a preference - fixing the taxonomies to line up is a real
// change that touches onboarding and every existing QuizCategory value, out of
// scope for the monitoring foundation.

// Which summer a student is recruiting for.
//
// Undergraduate finance recruiting is front-loaded: the internship that
// matters is junior summer, which lands the summer before graduation. A
// student graduating in 2029 is therefore looking at summer 2028 — even
// though that is two cycles away from today.
// Re-exported so existing callers keep working; the definition now lives in
// lib/internship-year.ts alongside internshipYearFor, which needs the same
// offset and must never disagree with it.
export { targetProgramYear } from "@/lib/internship-year";

// A posting is relevant when the student's graduation year is one the posting
// actually accepts. Matching on grad year rather than program year alone
// handles the programs that take two class years.
/**
 * A skeleton row: a firm-level placeholder, not a real requisition.
 *
 * seed-ib-2028-skeleton.ts writes one of these per division per firm so the
 * product has something to show for a cycle nobody has opened yet. They carry
 * an invented title ("Global Risk Management - Summer Analyst"), no location,
 * deadline TBD, and an applicationUrl pointing at the firm's own programme
 * page. 120 of the 125 active 2028 rows are these.
 *
 * That is the right trade for Discovery, where the student is browsing what a
 * firm runs. It is the wrong one anywhere that claims to have found them a
 * specific posting: the row says "apply", and the link lands on
 * goldmansachs.com/careers - so the student is now doing the search we told
 * them we had already done.
 *
 * Detected by the sentinel the seeder writes, which two scripts were already
 * matching by hand; this is that string's one home.
 */
const DESCRIPTION_PENDING_PREFIX = "Program description not yet captured";

export function isSkeletonPosting(posting: { descriptionFull: string }): boolean {
  return posting.descriptionFull.startsWith(DESCRIPTION_PENDING_PREFIX);
}

/**
 * The posting itself saying applications are not open.
 *
 * Wider than isSkeletonPosting on purpose. That one matches the description
 * sentinel, and a seeded row whose description was later written by hand
 * stops matching it while remaining just as unopened - JPMorgan's summer 2028
 * row carried nine sentences about the programme above a banner reading
 * "Summer 2028 applications are not open yet", and an Apply button.
 *
 * These are OUR OWN strings, written by scripts/seed-ib-2028-skeleton.ts into
 * deadlineText, not anything a firm published. Measured against the live
 * database: 95 rows match, every one of them summer 2028, and not a single
 * 2026 or 2027 posting - so this separates the unopened cycle from the one
 * students are actually applying to, which is the whole job.
 */
const NOT_YET_OPEN_TEXT = [
  "%not open yet%",
  "%timing is not published%",
  "%applications open in the%",
];

export function saysNotYetOpen(posting: { descriptionFull: string; deadlineText?: string | null }): boolean {
  if (isSkeletonPosting(posting)) return true;
  const text = posting.deadlineText?.toLowerCase() ?? "";
  if (!text) return false;
  return NOT_YET_OPEN_TEXT.some((p) => text.includes(p.replaceAll("%", "")));
}

/**
 * Is this a posting a firm actually published?
 *
 * THE one definition of "real", and the only gate any student-facing surface
 * needs. Everything the product shows - Discovery, the internships tab, the
 * tracked pipeline, the Upcoming panel, the calendar - has to agree on this
 * answer, and the way to make that true is for there to be a single answer.
 *
 * Two clauses, and they are not the same rule twice:
 *
 *   A SKELETON IS NEVER REAL. Not under any condition, not with a date
 *   attached, not with an estimate attached. These rows are OURS - written by
 *   scripts/seed-ib-2028-skeleton.ts with an invented title and a link to the
 *   firm's front door - so no column on them can promote one into something a
 *   firm said. This clause used to be wrapped in an `includeUnopened` opt-out,
 *   and one caller opted out: the Upcoming panel, which is how a seeded
 *   Morgan Stanley row reached the home page under an "Est. opens" heading.
 *   The flag is gone rather than defaulted, because a rule with an opt-out is
 *   a rule the next surface can fail to apply.
 *
 *   A CRAWLED POSTING THAT SAYS "NOT OPEN YET" IS REAL, but only worth showing
 *   once the firm has named the day (deadlineStatus 'confirmed'). The firm
 *   published both the posting and the sentence; there is nothing invented
 *   about it, and a dated heads-up is genuinely useful. Without a date it is
 *   just noise, so it waits.
 *
 * Nothing here decides what is STORED. Every row stays in the table, and the
 * crawler keeps writing whatever it finds - `savePosting` cannot produce a
 * skeleton, so anything it picks up from here on is real by construction and
 * flows through without needing a list to be added to.
 */
export function isRealPosting(posting: {
  roleTitle: string;
  descriptionFull: string;
  deadlineText?: string | null;
  deadlineStatus?: string | null;
}): boolean {
  // A POSTING WITH NO NAME IS NOT SHOWN. A student cannot apply to what they
  // cannot identify; see isNamedRoleTitle.
  if (!isNamedRoleTitle(posting.roleTitle)) return false;
  // NOR IS A CAREERS-SITE PLACEHOLDER. "Join our Talent Community!" is not a
  // role to apply to; see isPlaceholderTitle.
  if (isPlaceholderTitle(posting.roleTitle)) return false;
  if (isSkeletonPosting(posting)) return false;
  if (!saysNotYetOpen(posting)) return true;
  return posting.deadlineStatus === "confirmed";
}

export type ScoredPosting = { matchScore: number; matchReasons: string[] };

// Ranks postings against the student's onboarding answers. Eligibility (grad
// year, sector) stays a hard SQL filter because an ineligible posting is
// useless; everything else is a soft score, so a student who said "open to
// anywhere" or is undecided on coverage group is never filtered down to
// nothing. Deliberately deterministic - no model call, so this costs nothing
// and runs on every page load.
export function scorePosting(
  posting: {
    location: string | null;
    roleTitle: string;
    categories: string[] | null;
    deadlineStatus: string | null;
    /** Needed to read the firm's tier. Postings come out of getRelevantPostings with it. */
    firmSlug?: string | null;
  },
  student: {
    targetLocations?: string[] | null;
    nicheInterests?: string[] | null;
    ibTierPreferences?: string[] | null;
    peTierPreferences?: string[] | null;
  },
): ScoredPosting {
  let matchScore = 0;
  const matchReasons: string[] = [];
  const hay = `${posting.location ?? ""} ${posting.roleTitle}`.toLowerCase();

  // "Open to anywhere" is a preference FOR everywhere, not the absence of one,
  // so it has to take the same branch as an empty list. It used to be stored
  // as an ordinary chip, which made `locs` non-empty, sent it down the
  // matching path, and found nothing - so a student who said they'd go
  // anywhere scored strictly worse than one who skipped the question, the
  // exact outcome the else-branch below exists to prevent.
  const statedCities = (student.targetLocations ?? []).filter(
    (l) => Boolean(l) && !isOpenToAnywhere(l),
  );
  if (statedCities.length) {
    const hit = statedCities.find((l) =>
      locationMatchTokens(l).some((token) => hay.includes(token)),
    );
    if (hit) {
      matchScore += 40;
      matchReasons.push(`In ${hit}`);
    }
  } else {
    matchScore += 15;
  }

  const niches = (student.nicheInterests ?? []).filter(Boolean);
  const nicheHit = niches.find((n) => hay.includes(n.toLowerCase().split("(")[0].trim()));
  if (nicheHit) {
    matchScore += 35;
    matchReasons.push(`Matches your interest in ${nicheHit}`);
  }

  // Bank/fund tier is the biggest differentiator inside a sector, and the
  // preference was already collected - it just never reached the score, which
  // left this function accepting ibTierPreferences and ignoring it. Scoped by
  // category so the "Middle-Market" label, which exists in both scales, can't
  // let a PE preference match an IB posting.
  //
  // Now that a posting can carry several industries, each scale is checked
  // against its own - a cross-listed IB/PE seat can satisfy either preference.
  // Scored once, not once per industry, so a multi-industry posting can't
  // out-rank a single-industry one just for being cross-listed.
  const postingCategories = posting.categories ?? [];
  const tierScales = [
    { category: "investment_banking", wanted: student.ibTierPreferences },
    { category: "private_equity", wanted: student.peTierPreferences },
  ] as const;
  for (const scale of tierScales) {
    if (!postingCategories.includes(scale.category)) continue;
    const tierLabel = postingTierLabel(scale.category, posting.firmSlug);
    if (tierLabel && scale.wanted?.length && scale.wanted.includes(tierLabel)) {
      matchScore += 30;
      matchReasons.push(`${tierLabel} - the type you said you wanted`);
      break;
    }
  }

  // A confirmed deadline is actionable; TBD is not.
  if (posting.deadlineStatus === "confirmed") {
    matchScore += 20;
    matchReasons.push("Deadline confirmed");
  }

  return { matchScore, matchReasons };
}

/** The tier label for a posting, in the same words the onboarding chips use. */
function postingTierLabel(category: string | null, firmSlug?: string | null): string | null {
  if (!firmSlug) return null;
  const tier = FIRM_TIER_BY_SLUG[firmSlug];
  if (!tier) return null;
  if (category === "investment_banking" && tier.ibTier) return IB_TIER_LABELS[tier.ibTier];
  if (category === "private_equity" && tier.peTier) return PE_TIER_LABELS[tier.peTier];
  return null;
}

export type RelevantPostingsInput = {
  gradYear: number | null;
  preferredCategories: string[] | null;
  /**
   * The summer the student is recruiting for (see lib/internship-year.ts).
   *
   * When set this REPLACES the grad-year eligibility check rather than adding
   * to it: it is the same question asked directly instead of inferred, and a
   * posting's own eligibleGradYears list is written by whoever approved it -
   * a looser and less trustworthy source than the student's own answer.
   */
  internshipYear?: number | null;
  limit?: number;
  /** Only these firms' postings - for a caller that must see every row at a
   *  student's own firms, whatever the overall cap cut off. */
  firmIds?: readonly string[];
  /** Include postings by demo firms. Only for a demo viewer - see users.isDemo. */
  includeDemo?: boolean;
};

async function queryRelevantPostings(input: RelevantPostingsInput) {
  // No early return on a missing grad year.
  //
  // This used to bail with [] the moment gradYear was falsy, which - combined
  // with the unconditional `= ANY` below, now fixed - meant a student who
  // never set one saw an empty product: no Discovery matches, no tracked
  // applications, no upcoming deadlines, and no error explaining why. Three of
  // the four accounts on this database are in exactly that state.
  //
  // Without a grad year we cannot check eligibility, so we don't - the student
  // sees the postings and decides for themselves, which is strictly better
  // than showing them nothing and saying nothing. The eligibility filter
  // returns as soon as they tell us the year.
  const db = await getDb();
  const categories = (input.preferredCategories ?? []).filter(
    (c): c is QuizCategory => QUIZ_CATEGORIES.includes(c as QuizCategory),
  );

  return db
    .select({
      id: internshipPostings.id,
      roleTitle: internshipPostings.roleTitle,
      location: internshipPostings.location,
      categories: internshipPostings.categories,
      programYear: internshipPostings.programYear,
      // Selected because the visibility rule reads it. It was not, so nothing
      // downstream could see who a firm said it would accept - including the
      // final check below.
      eligibleGradYears: internshipPostings.eligibleGradYears,
      deadlineStatus: internshipPostings.deadlineStatus,
      deadlineText: internshipPostings.deadlineText,
      deadlineDate: internshipPostings.deadlineDate,
      // When it drops, as opposed to when it closes. See lib/posting-timing.ts
      // for why both are needed to say anything useful about an unopened role.
      opensText: internshipPostings.opensText,
      opensAt: internshipPostings.opensAt,
      descriptionFull: internshipPostings.descriptionFull,
      // Written by the crawler since this column was added and never once
      // selected, so 374 postings' requirements sat in the database unread.
      requirementsFull: internshipPostings.requirementsFull,
      sourceUrl: internshipPostings.sourceUrl,
      applicationUrl: internshipPostings.applicationUrl,
      recruiterName: internshipPostings.recruiterName,
      recruiterTitle: internshipPostings.recruiterTitle,
      recruiterEmail: internshipPostings.recruiterEmail,
      recruiterPhone: internshipPostings.recruiterPhone,
      firmId: internshipPostings.firmId,
      firmName: firms.name,
      firmSlug: firms.slug,
      firmWebsite: firms.website,
    })
    .from(internshipPostings)
    .innerJoin(firms, eq(internshipPostings.firmId, firms.id))
    .where(
      and(
        eq(internshipPostings.isActive, true),
        /**
         * A posting is shown when it can be ACTED ON, and not before.
         *
         * scripts/seed-ib-2028-skeleton.ts writes a trackable row per program
         * for a cycle nobody has opened yet - 90 of them, every one with
         * deadline TBD, no crawled listing behind it, and a description that
         * says so in as many words. They were being listed on Discovery with
         * an Apply button next to the sentence "the summer 2028 posting is not
         * live", which is the product telling a student to apply to something
         * that does not exist.
         *
         * The rule: a row appears here only when it is real work - a listing
         * the crawler actually found - or when the exact date is known
         * (deadlineStatus 'confirmed'), which is the one case where a not-yet
         * -open program is worth putting in front of someone. An estimate is
         * not a date and does not qualify; that is what the Upcoming list is
         * for, and it opts in above.
         */
        // A SKELETON NEVER LEAVES THE TABLE. Unconditional, with no caller-side
        // opt-out: see isRealPosting for why the `includeUnopened` flag that
        // used to wrap this is gone.
        //
        // coalesce, not the bare column. `NULL like '%x%'` is NULL, `not NULL`
        // is NULL, and Postgres drops a NULL row. Written without it, this
        // filter returned ZERO postings for every cycle, because most rows
        // have no deadlineText at all. The empty string matches nothing here,
        // which is the intended reading of "the posting never said".
        not(
          sql`coalesce(${internshipPostings.descriptionFull}, '') like ${DESCRIPTION_PENDING_PREFIX + "%"}`,
        ),
        // A careers-site placeholder is not a role (see isPlaceholderTitle).
        // Filtered here as well as below so one cannot take a slot under the
        // limit from a real posting.
        not(sql`${internshipPostings.roleTitle} ~* ${PLACEHOLDER_TITLE_SQL_PATTERN}`),
        // A crawled posting that says it is not open yet waits for a date.
        // The firm wrote the sentence, so the row is real - it just has
        // nothing to act on until deadlineStatus says 'confirmed'.
        or(
          not(
            sql`(coalesce(${internshipPostings.deadlineText}, '') ilike ${NOT_YET_OPEN_TEXT[0]}
              or coalesce(${internshipPostings.deadlineText}, '') ilike ${NOT_YET_OPEN_TEXT[1]}
              or coalesce(${internshipPostings.deadlineText}, '') ilike ${NOT_YET_OPEN_TEXT[2]})`,
          ),
          eq(internshipPostings.deadlineStatus, "confirmed"),
        ),
        // The student's grad year must be in the posting's eligible list -
        // but ONLY when we actually know it.
        //
        // This was unconditional, and `NULL = ANY(...)` evaluates to NULL
        // rather than true, so a caller passing gradYear: null got back zero
        // postings instead of an unfiltered list. Silent and total: three of
        // four accounts on this database have no grad year set, and for every
        // one of them the whole postings pipeline - Discovery matches, tracked
        // applications, the Upcoming list - came back empty with no error
        // raised anywhere. A caller passing null wants the eligibility check
        // skipped, not every row dropped.
        // The recruiting cycle. This is the filter that decides relevance more
        // than any other: a 2029 grad is recruiting for Summer 2028, and the
        // Summer 2027 postings filling every board right now are not a weaker
        // match for them - that cycle is closed. Matched on the posting's own
        // programYear, exactly.
        /**
         * BOTH filters, not one or the other.
         *
         * These two were a single ternary: when `internshipYear` was set it
         * matched the cycle and skipped the eligibility check entirely, and
         * only a caller with NO cycle ever reached the eligibility branch.
         * Every signed-in student has a cycle - `internshipYearFor` derives
         * one from their grad year - so in practice the eligibility list was
         * never consulted at all.
         *
         * They answer different questions and a posting has to pass both:
         *
         *   programYear      WHICH SUMMER the internship runs
         *   eligibleGradYears  WHO the firm will accept
         *
         * D.A. Davidson posts "Class of 2028 Equity Capital Markets Research
         * Intern". A student graduating in 2029 recruits for Summer 2028, so
         * the cycle matches - and the firm has said it wants the class of
         * 2028, who are a year ahead of them. With only the cycle checked, it
         * was shown to them as something to apply to. It is not.
         *
         * Nothing is dropped from storage by this: every posting stays in the
         * table for whoever it IS for. This only decides what one student is
         * shown.
         */
        input.internshipYear != null
          ? eq(internshipPostings.programYear, input.internshipYear)
          : undefined,
        /**
         * An empty eligibility list means "the posting did not say", not
         * "nobody is eligible".
         *
         * A crawled posting that never states a graduation year stores an
         * empty array rather than an invented one - we do not make up who a
         * firm will accept. But `= ANY(empty)` is false for every student, so
         * that honesty would have made every such posting invisible, which is
         * the opposite of what leaving it blank is for. Unknown restricts
         * nobody.
         *
         * And `NULL = ANY(...)` evaluates to NULL rather than true, so a
         * caller passing gradYear: null must skip this check rather than run
         * it - three of four accounts on this database have no grad year set,
         * and running it unconditionally emptied the whole pipeline for them.
         */
        input.gradYear == null
          ? undefined
          : sql`(cardinality(${internshipPostings.eligibleGradYears}) = 0 OR ${input.gradYear} = ANY(${internshipPostings.eligibleGradYears}))`,
        // Overlap, not equality: the posting matches if ANY of its industries
        // is one the student picked. inArray can't express this now that the
        // left-hand side is itself an array.
        //
        // Spelled out as ARRAY[...] with one bound parameter per value:
        // interpolating the JS array directly makes drizzle emit a `($1, $2)`
        // tuple, which Postgres reads as a record and refuses to cast to an
        // enum array ("cannot cast type record to firm_program_category[]").
        categories.length > 0
          ? sql`${internshipPostings.categories} && ARRAY[${sql.join(
              categories.map((c) => sql`${c}`),
              sql`, `,
            )}]::firm_program_category[]`
          : undefined,
        input.firmIds ? inArray(internshipPostings.firmId, [...input.firmIds]) : undefined,
        // A demo firm's postings reach demo accounts and nobody else.
        input.includeDemo ? undefined : eq(internshipPostings.isDemo, false),
      ),
    )
    .orderBy(
      // Confirmed deadlines first — those are the ones a student can act on.
      asc(internshipPostings.deadlineStatus),
      asc(firms.name),
    )
    // Default high rather than 50: this list is also the review surface for
    // checking crawl accuracy, and a silent cap hides rows that need fixing.
    .limit(input.limit ?? 500)
    /**
     * The same rule again, in TypeScript, as a guarantee rather than a filter.
     *
     * The SQL above is what lets Postgres use its indexes, and it is where
     * the two conditions drifted apart into a ternary that ran one or the
     * other. `postingIsForStudent` is the single readable statement of the
     * rule, it is what the tests exercise, and running it here means a
     * posting can only reach a student by satisfying the version a person can
     * check. If the two ever disagree again, this one wins and the student
     * sees the correct list.
     */
    /**
     * `isRealPosting` runs here too, for the same reason postingIsForStudent
     * does: the SQL above is what lets Postgres use its indexes, and this is
     * the version a person can read and the tests can exercise. A posting can
     * only reach a student by satisfying BOTH, so if the two ever drift apart
     * the student sees the stricter - and correct - list.
     */
    .then((rows) => rows.filter((r) => postingIsForStudent(r, input) && isRealPosting(r)));
}

const cachedRelevantPostings = sharedCache(queryRelevantPostings, ["relevant-internship-postings-v1"], {
  revalidate: SHARED_CACHE_SECONDS.liveCatalog,
  tags: [SHARED_CACHE_TAGS.internships],
});

/**
 * Shared posting catalogue, filtered by student eligibility inputs.
 *
 * No user id or private state enters this cache. The inputs only describe a
 * cohort (graduation year, cycle, sectors and optional firm ids), so students
 * with the same eligibility can safely reuse the same Supabase result.
 */
export async function getRelevantPostings(input: RelevantPostingsInput) {
  const normalized: RelevantPostingsInput = {
    ...input,
    preferredCategories: input.preferredCategories
      ? [...new Set(input.preferredCategories)].sort()
      : null,
    firmIds: input.firmIds ? [...new Set(input.firmIds)].sort() : undefined,
  };
  const rows = await cachedRelevantPostings(normalized);

  // unstable_cache stores JSON. Restore database timestamps so callers see
  // the exact same types on a cache hit as they do on the first query.
  return rows.map((row) => ({
    ...row,
    deadlineDate: row.deadlineDate ? new Date(row.deadlineDate) : null,
    opensAt: row.opensAt ? new Date(row.opensAt) : null,
  }));
}

/**
 * Roles from past cycles, carried into the student's cycle because they have
 * not been posted for it yet - see lib/expected-postings for the rules.
 *
 * The same category, firm and demo filters as getRelevantPostings, and the
 * same eligibility rule on the carried-forward grad years. Only for a cycle
 * up to EXPECTED_YEARS_AHEAD out, carried from at most that many cycles back.
 * Kept apart from getRelevantPostings on purpose: nothing that lists real
 * postings - auto-tracking, reminders, "open now" - can pick these up by
 * accident.
 */
export async function getExpectedPostings(input: {
  gradYear: number | null;
  preferredCategories: string[] | null;
  internshipYear: number | null | undefined;
  firmIds?: readonly string[];
  includeDemo?: boolean;
  now?: Date;
}): Promise<ExpectedPosting[]> {
  const targetYear = input.internshipYear;
  const now = input.now ?? new Date();
  if (targetYear == null || targetYear > now.getUTCFullYear() + EXPECTED_YEARS_AHEAD) return [];
  if (input.firmIds && input.firmIds.length === 0) return [];

  const db = await getDb();
  const categories = (input.preferredCategories ?? []).filter(
    (c): c is QuizCategory => QUIZ_CATEGORIES.includes(c as QuizCategory),
  );
  const pastRows = await db
    .select({
      id: internshipPostings.id,
      firmId: internshipPostings.firmId,
      firmName: firms.name,
      firmSlug: firms.slug,
      firmWebsite: firms.website,
      roleTitle: internshipPostings.roleTitle,
      location: internshipPostings.location,
      categories: internshipPostings.categories,
      programYear: internshipPostings.programYear,
      eligibleGradYears: internshipPostings.eligibleGradYears,
      deadlineStatus: internshipPostings.deadlineStatus,
      deadlineText: internshipPostings.deadlineText,
      deadlineDate: internshipPostings.deadlineDate,
      opensAt: internshipPostings.opensAt,
      createdAt: internshipPostings.createdAt,
      descriptionFull: internshipPostings.descriptionFull,
      requirementsFull: internshipPostings.requirementsFull,
    })
    .from(internshipPostings)
    .innerJoin(firms, eq(internshipPostings.firmId, firms.id))
    .where(
      and(
        sql`${internshipPostings.programYear} < ${targetYear}`,
        sql`${internshipPostings.programYear} >= ${targetYear - EXPECTED_YEARS_AHEAD}`,
        // Taken down by Offerly is not a role that repeats; closed is.
        sql`${internshipPostings.takenDownAt} is null`,
        not(sql`coalesce(${internshipPostings.descriptionFull}, '') like ${DESCRIPTION_PENDING_PREFIX + "%"}`),
        categories.length > 0
          ? sql`${internshipPostings.categories} && ARRAY[${sql.join(
              categories.map((c) => sql`${c}`),
              sql`, `,
            )}]::firm_program_category[]`
          : undefined,
        input.firmIds ? inArray(internshipPostings.firmId, [...input.firmIds]) : undefined,
        input.includeDemo ? undefined : eq(internshipPostings.isDemo, false),
      ),
    )
    .limit(2000);

  const sources = pastRows.filter((r) => isNamedRoleTitle(r.roleTitle) && isCarryableTitle(r.roleTitle));
  if (sources.length === 0) return [];
  const firmIds = [...new Set(sources.map((r) => r.firmId))];

  const [existing, programs, detected] = await Promise.all([
    // Every posting already in the system for the target cycle, open or not:
    // a role with one is not projected.
    db
      .select({ firmId: internshipPostings.firmId, roleTitle: internshipPostings.roleTitle, location: internshipPostings.location })
      .from(internshipPostings)
      .where(and(eq(internshipPostings.programYear, targetYear), inArray(internshipPostings.firmId, firmIds))),
    db
      .select({ firmId: firmPrograms.firmId, category: firmPrograms.category, careersUrl: firmPrograms.careersUrl })
      .from(firmPrograms)
      .where(inArray(firmPrograms.firmId, firmIds)),
    // When the crawler first found each source - only for the rows being
    // carried, not an aggregate over every listing ever detected.
    db
      .select({
        postingId: detectedListings.promotedPostingId,
        firstAt: sql<Date>`min(${detectedListings.firstDetectedAt})`,
      })
      .from(detectedListings)
      .where(inArray(detectedListings.promotedPostingId, sources.map((r) => r.id)))
      .groupBy(detectedListings.promotedPostingId),
  ]);
  const firstDetectedAt = new Map(detected.map((d) => [d.postingId, d.firstAt ? new Date(d.firstAt) : null]));
  const careers = new Map(programs.map((p) => [`${p.firmId}:${p.category}`, p.careersUrl]));

  const past: PastPosting[] = sources.map((r) => {
    const seen = firstDetectedAt.get(r.id) ?? null;
    return {
      ...r,
      deadlineStatus: r.deadlineStatus,
      firstSeenAt: seen && seen < r.createdAt ? seen : r.createdAt,
      careersUrl: r.categories.map((c) => careers.get(`${r.firmId}:${c}`)).find(Boolean) ?? null,
    };
  });

  return projectExpected({ past, existing, targetYear, history: HISTORICAL_RELEASES }).filter(
    (e) =>
      (input.gradYear == null || e.eligibleGradYears.length === 0 || e.eligibleGradYears.includes(input.gradYear)) &&
      // Only what is about to open: a month out at most (showableExpected).
      showableExpected(e, now),
  );
}

// Descriptions must be our own paraphrase, never the firm's posting text.
// We never store the source page, so we can't diff against it — this is a
// heuristic that catches the boilerplate which only survives copy-paste.
// A warning rather than a hard reject: a false positive shouldn't silently
// drop a real posting, but a genuine paste should be visible in the log.
const COPY_MARKERS = [
  /equal opportunity employer/i,
  /all qualified applicants will receive consideration/i,
  /\bresponsibilities\s*:/i,
  /\bqualifications\s*:/i,
  /\bwhat you'?ll do\b/i,
  /\babout (us|the (role|team|firm))\b/i,
  /reasonable accommodation/i,
  /without regard to race/i,
];

function warnIfLikelyCopied(firmName: string, roleTitle: string, text: string) {
  const hit = COPY_MARKERS.find((re) => re.test(text));
  if (hit) {
    console.warn(
      `[crawler] Possible copied posting text for ${firmName} — ${roleTitle} (matched ${hit}). Descriptions must be paraphrased; review this row.`,
    );
  }
}

function toDeadlineDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Upsert on (firm, role, program year) so re-publishing a firm's posting
// updates it in place instead of duplicating it. This is the seam between
// raw detection (detected_listings, see src/lib/monitoring/) and the
// student-facing table Discovery reads from - an approved detection is
// published by calling this exactly the way the old AI crawler did.
/**
 * Is this posting one THIS student could actually apply to?
 *
 * The same rule the SQL in getRelevantPostings expresses, as a predicate the
 * tests can exercise directly and the query can apply as a final guarantee.
 * Two facts, and a posting has to pass both:
 *
 *   programYear        WHICH SUMMER the internship runs
 *   eligibleGradYears  WHO the firm said it will accept
 *
 * They were a single ternary for a while, which meant whichever one the
 * caller supplied was checked and the other was skipped entirely. Since every
 * signed-in student has a cycle derived from their grad year, the effect was
 * that eligibility was never consulted: D.A. Davidson's "Class of 2028 Equity
 * Capital Markets Research Intern" was shown to students graduating in 2029,
 * who are a year behind the class the firm asked for.
 *
 * UNKNOWN RESTRICTS NOBODY, in both directions. A posting with an empty
 * eligibility list did not say who may apply, and an empty list is not a
 * statement that nobody may - most crawled postings never name a class, and
 * hiding all of them would empty Discovery. Equally, a student with no grad
 * year on file has told us nothing to filter by, and three of four accounts
 * on this database are in exactly that position.
 *
 * This decides what one student is SHOWN. It never decides what is stored:
 * every posting stays in the table for whoever it is for.
 */
export function postingIsForStudent(
  posting: { programYear: number; eligibleGradYears: number[] | null },
  // `internshipYear` is optional as well as nullable because callers omit it
  // entirely - an absent cycle and a null one both mean "do not filter by
  // cycle", and treating them differently is how the caller above ended up
  // silently unfiltered.
  student: { internshipYear?: number | null; gradYear: number | null },
): boolean {
  if (student.internshipYear != null && posting.programYear !== student.internshipYear) {
    return false;
  }
  const eligible = posting.eligibleGradYears ?? [];
  if (student.gradYear == null || eligible.length === 0) return true;
  return eligible.includes(student.gradYear);
}

export async function savePosting(
  firmId: string,
  categories: FirmProgramCategory[],
  p: PublishablePosting,
): Promise<"inserted" | "updated" | "skipped"> {
  // Never store a posting without a real title. Whatever produced it - a
  // connector that read the wrong field, a board that left it blank - the row
  // would reach students as an unnamed Apply button. Refused and logged, so a
  // connector that starts doing this shows up in the crawl output.
  if (!isNamedRoleTitle(p.roleTitle)) {
    console.warn(`[savePosting] skipped a posting with no usable title: ${JSON.stringify(p.roleTitle)} (${p.sourceUrl})`);
    return "skipped";
  }
  // Nor a careers-site placeholder ("Join our Talent Community!"): the board
  // lists it beside its roles, but there is no role behind it.
  if (isPlaceholderTitle(p.roleTitle)) {
    console.warn(`[savePosting] skipped a careers-site placeholder: ${JSON.stringify(p.roleTitle)} (${p.sourceUrl})`);
    return "skipped";
  }
  /**
   * The last gate before the table every student-facing surface reads.
   *
   * `sourceUrl` becomes "Read the full posting" and `applicationUrl` becomes
   * "Apply", both as plain hrefs, and both arrive from a careers page the
   * crawler does not control - the generic connector copies a JSON-LD `url`
   * or a matching anchor href verbatim. Nothing between the connector and
   * this line checked the scheme or the host, so `javascript:`, `data:`, a
   * scheme-less string or a loopback address could be stored and rendered
   * (security review, 10 October 2026).
   *
   * Refused, not sanitised, and refused as a whole posting: a role whose only
   * address is unusable is not a role a student can apply to, and storing it
   * with the link stripped would put a dead Apply button in Discovery. The
   * promote step holds such a row for review instead; this is the floor under
   * it, covering the admin approval path and anything added later.
   */
  const sourceUrl = publicHttpUrl(p.sourceUrl);
  if (!sourceUrl) {
    console.warn(`[savePosting] skipped a posting whose source URL is not a public http(s) URL: ${JSON.stringify(p.sourceUrl)}`);
    return "skipped";
  }
  // An absent application URL is normal - Discovery falls back to the source
  // URL. A present one that fails the policy is dropped rather than failing
  // the posting, because the advert is still reachable.
  const applicationUrl = p.applicationUrl == null ? null : publicHttpUrl(p.applicationUrl);
  if (p.applicationUrl != null && !applicationUrl) {
    console.warn(`[savePosting] dropped an application URL that is not a public http(s) URL: ${JSON.stringify(p.applicationUrl)} (${sourceUrl})`);
  }

  const db = await getDb();
  warnIfLikelyCopied(firmId, p.roleTitle, p.descriptionFull);

  const existing = await db.query.internshipPostings.findFirst({
    where: and(
      eq(internshipPostings.firmId, firmId),
      eq(internshipPostings.roleTitle, p.roleTitle),
      eq(internshipPostings.programYear, p.programYear),
    ),
    columns: { id: true, origin: true },
  });

  // A posting the firm wrote itself on the firm portal is the firm's to
  // change. The crawler finding the same (firm, role, year) on the careers
  // site must not overwrite what the firm said, so it is left exactly as is.
  if (existing?.origin === "firm") return "updated";

  /**
   * The deadline the posting states in its own text, when the caller supplied
   * none.
   *
   * Every publisher goes through this function, which is why the fallback
   * belongs here rather than in any one of them. promote-approved-listings.ts
   * hard-codes `deadlineStatus: "tbd"` on every row it publishes, because
   * detected_listings never carried a closing date across from the connector -
   * and the comment there says so. But the deadline was never actually
   * missing: it was sitting in descriptionFull the whole time, in the firm's
   * own sentence, because that is the text the crawler captured.
   *
   * The visible cost of not reading it was the product contradicting itself.
   * The Top applications panel parsed that same sentence and rendered
   * "Due in 54d · Nov 15, 2026 · 11:55 PM EST" for Evercore; the Internships
   * tab read this column and said "Deadline TBD" for the identical role.
   *
   * A caller that states a deadline still wins - an explicit
   * `deadlineDateIso`, or any status other than "tbd", is a decision somebody
   * made and this does not overrule it.
   */
  const stated =
    !p.deadlineDateIso && p.deadlineStatus === "tbd"
      ? deadlineColumnsFromText(p.descriptionFull)
      : null;

  const values = {
    firmId,
    categories,
    roleTitle: p.roleTitle,
    location: p.location,
    programYear: p.programYear,
    eligibleGradYears: p.eligibleGradYears,
    deadlineStatus: stated?.deadlineStatus ?? p.deadlineStatus,
    deadlineText: p.deadlineText,
    deadlineDate: stated?.deadlineDate ?? toDeadlineDate(p.deadlineDateIso),
    descriptionFull: p.descriptionFull,
    requirementsFull: p.requirementsFull ?? null,
    sourceUrl,
    applicationUrl,
    recruiterName: p.recruiterName,
    recruiterTitle: p.recruiterTitle,
    recruiterEmail: p.recruiterEmail,
    recruiterPhone: p.recruiterPhone,
    isActive: true,
    lastCheckedAt: new Date(),
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(internshipPostings)
      .set(values)
      .where(eq(internshipPostings.id, existing.id));
    return "updated";
  }

  await db.insert(internshipPostings).values(values);
  return "inserted";
}

/**
 * The student's best-matching open internships, for the main dashboard's Top
 * applications: every real posting for their cycle in the industries they
 * chose at onboarding (all industries when they chose none), ranked by the
 * same onboarding-based score the Internships page sorts by - their cities,
 * specialties and firm tiers. Not limited to their firm shortlist, and nothing
 * to tick off: the owner asked for "their top applications, found from their
 * onboarding answers" in place of the "Applied yet?" list (5 October 2026).
 */
export async function getTopMatchedPostings(
  user: Parameters<typeof scorePosting>[1] & {
    gradYear: number | null;
    preferredCategories: string[] | null;
    isDemo?: boolean | null;
    internshipYear: number | null;
  },
  limit = 6,
) {
  const base = { gradYear: user.gradYear, internshipYear: user.internshipYear, includeDemo: Boolean(user.isDemo) };
  let postings = await getRelevantPostings({ ...base, preferredCategories: user.preferredCategories });
  if (postings.length === 0 && (user.preferredCategories ?? []).length > 0) {
    postings = await getRelevantPostings({ ...base, preferredCategories: null });
  }
  const ranked = postings
    .filter((p) => p.deadlineStatus !== "closed")
    .map((p) => ({ ...p, ...scorePosting(p, user) }))
    .sort(
      (a, b) =>
        b.matchScore - a.matchScore ||
        (a.deadlineDate?.getTime() ?? Infinity) - (b.deadlineDate?.getTime() ?? Infinity) ||
        a.firmName.localeCompare(b.firmName),
    );
  // At most two roles per firm, so the list is the student's best options and
  // not one firm's offices (the first build showed six Evercore desks).
  const perFirm = new Map<string, number>();
  const top: typeof ranked = [];
  for (const p of ranked) {
    const n = perFirm.get(p.firmName) ?? 0;
    if (n >= TOP_PER_FIRM) continue;
    perFirm.set(p.firmName, n + 1);
    top.push(p);
    if (top.length >= limit) break;
  }
  return top;
}

const TOP_PER_FIRM = 2;
