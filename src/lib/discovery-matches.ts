import "server-only";
import { cache } from "react";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications, contacts, directoryPeople, firms, userTopFirms } from "@/db/schema";
import type { FirmProgramCategory } from "@/lib/firm-metadata";
import type { ExpectedPosting } from "@/lib/expected-postings";
import { getExpectedPostings, getRelevantPostings, scorePosting } from "@/lib/internship-postings";
import { internshipYearFor } from "@/lib/internship-year";
import { CONTACTS_PER_FIRM, MATCHED_FIRMS, OPPORTUNITY_FIRMS } from "@/lib/match-config";
import { postingTiming, type PostingTiming } from "@/lib/posting-timing";
import { normalizeFirmName } from "@/lib/network-coverage";
import {
  scoreResponseLikelihood,
  type ResponseLikelihood,
  type ScorablePerson,
} from "@/lib/response-likelihood";
import { trackedFirmNames } from "@/lib/tracked-firms";
import { firmResolver } from "@/lib/firm-name";
import { sameRole } from "@/lib/role-name";

// The match, as one tree rather than three lists: firms the student was matched
// to, the roles inside each, and the people at each worth writing to. Discovery
// shows the whole tree; Opportunities shows its top slice. Both read this, so
// the two pages can never disagree about who was matched to what.

// firm_program_category (what postings carry) -> application_category (what the
// tracked pipeline uses). The two taxonomies don't line up 1:1, so this is a
// deliberate lossy mapping rather than a cast.
const PROGRAM_TO_APPLICATION_CATEGORY: Record<FirmProgramCategory, string> = {
  investment_banking: "investment_banking",
  private_equity: "private_equity",
  venture_capital: "private_equity",
  private_credit: "private_equity",
  real_estate: "real_estate",
  hedge_fund: "hedge_fund",
  sales_trading: "other",
  asset_wealth_management: "asset_management",
  commercial_banking: "corporate_finance",
  insurance: "other",
  fintech: "other",
  market_infrastructure: "other",
  consulting: "consulting",
  other_finance: "other",
};

export type MatchedFirm = {
  id: string;
  /** The userTopFirms row id - what removing this firm from the list needs. */
  topFirmId: string;
  slug: string;
  name: string;
  website: string;
  /** The matcher's one-line rationale; null for firms the student added themselves. */
  reason: string | null;
  categories: FirmProgramCategory[];
};

export type MatchedInternship = {
  id: string;
  firmName: string;
  firmSlug: string;
  firmWebsite: string;
  roleTitle: string;
  location: string | null;
  /** Our own paraphrase of the posting, trimmed for display. */
  summary: string;
  applyUrl: string;
  timing: PostingTiming;
  matchReasons: string[];
  categories: FirmProgramCategory[];
  /** Already in the student's pipeline - drives the card's track toggle. */
  tracked: boolean;
};

export type MatchedContact = {
  key: string;
  name: string;
  title: string | null;
  firmName: string;
  firmSlug: string;
  email: string | null;
  linkedinUrl: string | null;
  /** Set for the student's own contacts, which have a page; null for directory rows. */
  href: string | null;
  likelihood: ResponseLikelihood;
};

export type MatchedFirmGroup = {
  firm: MatchedFirm;
  internships: MatchedInternship[];
  /** Last cycle's roles here, not posted for this one yet - shown as
   *  expected, never counted as roles (lib/expected-postings). */
  expected?: ExpectedPosting[];
  /** The best few, for the card's preview. Capped at CONTACTS_PER_FIRM. */
  contacts: MatchedContact[];
  /**
   * How many there really are.
   *
   * Separate from `contacts.length` because that list is a PREVIEW - a card
   * showing "5 contacts" when the student has fifteen is reading the cap, not
   * the number. Counted before the slice.
   */
  contactCount: number;
};

export type DiscoveryMatches = {
  /** Firm-centric tree, ranked. Discovery renders all of it. */
  groups: MatchedFirmGroup[];
  /**
   * How many firms the student actually matched, before any view slices it.
   *
   * Carried explicitly because the Opportunities slice throws the total away,
   * and the copy underneath the deck needs to say how many there really are.
   * It used to print MATCHED_FIRMS, the target - so a student holding eight
   * firms was told they had fifty.
   */
  totalGroups: number;
  /** Set when the student has no sectors picked yet - nothing to match against. */
  needsProfile: boolean;
  /** Set when the matcher ran and failed; the UI offers a retry rather than a blank. */
  error: string | null;
  /** Postings newly added to the tracked pipeline by this call. */
  newlyTracked: number;
};

type MatchUser = Awaited<ReturnType<typeof import("@/lib/current-user").getCurrentUser>>;

const EMPTY: Omit<DiscoveryMatches, "needsProfile" | "error"> = {
  groups: [],
  totalGroups: 0,
  newlyTracked: 0,
};

export async function getDiscoveryMatches(user: MatchUser): Promise<DiscoveryMatches> {
  // Nothing to match against. Not an error - the student just hasn't finished
  // onboarding - so the UI prompts for that instead of offering a retry.
  if (!user.preferredCategories?.length) {
    return { ...EMPTY, needsProfile: true, error: null };
  }

  const db = await getDb();
  const error: string | null = null;

  // This function READS the match. It does not run one.
  //
  // It used to: every visit counted the stored firms and, if the list was
  // short, matched on the spot. The guard was meant to stop that repeating -
  // only run if never matched, or the target rose, or the firm pool grew - but
  // a run that legitimately adds nothing (a student whose filters admit fewer
  // firms than the target, which is the normal case for anyone with specific
  // preferences) never recorded itself, so "never matched" stayed true and the
  // whole match re-ran on every single page load, forever, loading the
  // sector's firms each time to re-derive the same empty answer. Measured at
  // 34 seconds on Opportunities.
  //
  // Matching now happens where the answers change - the end of onboarding, and
  // Settings when a matching input is edited - and the matched firms simply
  // appear here. "Find more firms" remains for a manual top-up. A render path
  // that writes is a render path that can loop; this one no longer can.

  // The student's own additions first, then createdAt order, which preserves
  // the matcher's own ranking - what makes "the top 12" on Opportunities mean
  // the same thing as the first 12 here (orderTopFirms).
  const topFirmRows = orderTopFirms(
    await db.query.userTopFirms.findMany({
      where: eq(userTopFirms.userId, user.id),
      with: { firm: { with: { programs: true } } },
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    }),
  ).slice(0, MATCHED_FIRMS);

  if (!topFirmRows.length) return { ...EMPTY, needsProfile: false, error };

  const firms: MatchedFirm[] = topFirmRows.map(({ id, firm, reason }) => ({
    id: firm.id,
    topFirmId: id,
    slug: firm.slug,
    name: firm.name,
    website: firm.website,
    reason,
    categories: [...new Set(firm.programs.map((p) => p.category))] as FirmProgramCategory[],
  }));

  const [internshipsByFirm, contactsByFirm, expectedRoles] = await Promise.all([
    internshipsForFirms(user, firms),
    contactsForFirms(user, firms),
    getExpectedPostings({
      gradYear: user.gradYear,
      internshipYear: internshipYearFor(user),
      preferredCategories: null,
      firmIds: firms.map((f) => f.id),
    }).catch(() => [] as ExpectedPosting[]),
  ]);
  const expectedByFirm = new Map<string, ExpectedPosting[]>();
  for (const e of expectedRoles) expectedByFirm.set(e.firmId, [...(expectedByFirm.get(e.firmId) ?? []), e]);

  const groups: MatchedFirmGroup[] = firms.map((firm) => ({
    firm,
    internships: internshipsByFirm.get(firm.slug) ?? [],
    contacts: contactsByFirm.byFirmId.get(firm.id) ?? [],
    contactCount: contactsByFirm.countByFirmId.get(firm.id) ?? 0,
    expected: expectedByFirm.get(firm.id) ?? [],
  }));

  const newlyTracked = await autoTrackInternships(
    user.id,
    groups.flatMap((g) => g.internships),
  );

  // Read tracking state after auto-tracking, not before: everything it just
  // inserted is tracked, and everything the student previously untracked has to
  // come back as untracked rather than being silently re-added by the toggle
  // showing the wrong state.
  const tracked = await getTrackedKeys(user.id);
  for (const g of groups) {
    for (const p of g.internships) {
      p.tracked = tracked.has(`${p.firmName}|${p.roleTitle}`);
    }
  }

  return { groups, totalGroups: groups.length, needsProfile: false, error, newlyTracked };
}

/** Every eligible posting at the matched firms, grouped by firm and ranked within it. */
async function internshipsForFirms(user: MatchUser, firms: MatchedFirm[]) {
  const bySlug = new Map<string, MatchedInternship[]>();
  const slugs = new Set(firms.map((f) => f.slug));

  const eligible = await getRelevantPostings({
    gradYear: user.gradYear,
    // Cycle filtered, sector deliberately not: a role from a closed cycle is
    // wrong for this student no matter which surface shows it, but breadth
    // across sectors is the point of the matched-firm lists.
    internshipYear: internshipYearFor(user),
    preferredCategories: null,
  });

  for (const p of eligible) {
    if (!slugs.has(p.firmSlug)) continue;
    const scored = scorePosting(p, user);
    const list = bySlug.get(p.firmSlug) ?? [];
    list.push({
      id: p.id,
      firmName: p.firmName,
      firmSlug: p.firmSlug,
      firmWebsite: p.firmWebsite,
      roleTitle: p.roleTitle,
      location: p.location,
      summary: summarise(p.descriptionFull),
      applyUrl: p.applicationUrl || p.sourceUrl,
      timing: postingTiming(p),
      matchReasons: scored.matchReasons,
      categories: (p.categories ?? []) as FirmProgramCategory[],
      // Filled in after auto-tracking runs, below - doing it here would report
      // the state from before this very request added them.
      tracked: false,
    });
    bySlug.set(p.firmSlug, list);
  }

  // Deterministic down to the id. This tree writes to the student's pipeline,
  // so which postings appear cannot drift between loads: getRelevantPostings
  // orders by (deadlineStatus, firm name) with no tiebreak, and with postings
  // tied on both, two roles at one firm came back in arbitrary order - each
  // reshuffle auto-tracking a fresh set of rows.
  for (const list of bySlug.values()) {
    list.sort(
      (a, b) =>
        rank(a.timing) - rank(b.timing) ||
        a.roleTitle.localeCompare(b.roleTitle) ||
        a.id.localeCompare(b.id),
    );
  }
  return bySlug;
}

/** Actionable first: something open beats something dated beats something unknown. */
function rank(t: PostingTiming) {
  return { open: 0, upcoming: 1, unknown: 2, closed: 3 }[t.state];
}

/** First sentence or so of our paraphrase - enough to say what the role is. */
function summarise(text: string, max = 180) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return stop > 80 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

/**
 * The people at each matched firm, ranked by how likely they are to reply.
 *
 * Two sources, one ranking. The imported directory is read live so an updated
 * spreadsheet reaches every student at once; the student's own contacts at the
 * same firms are folded in so people they sourced themselves aren't pushed out
 * by it. Either source alone leaves this empty for a real population of
 * students - a directory that hasn't been imported, or a student who has added
 * nobody.
 */
async function contactsForFirms(user: MatchUser, firms: MatchedFirm[]) {
  const db = await getDb();
  const byFirmId = new Map<string, MatchedContact[]>();
  // Totals before the preview slice below throws the rest away.
  const countByFirmId = new Map<string, number>();
  if (!firms.length) return { byFirmId, countByFirmId };

  const firmIdByKey = new Map(firms.map((f) => [normalizeFirmName(f.name), f.id]));
  const firmSlugById = new Map(firms.map((f) => [f.id, f.slug]));

  const [directory, own] = await Promise.all([
    db.query.directoryPeople.findMany({
      where: and(
        inArray(
          directoryPeople.firmId,
          firms.map((f) => f.id),
        ),
        // Someone who has left the firm is not someone to cold-email about it.
        isNull(directoryPeople.delistedAt),
      ),
    }),
    db.query.contacts.findMany({ where: eq(contacts.userId, user.id) }),
  ]);

  const push = (firmId: string, c: MatchedContact) => {
    const list = byFirmId.get(firmId) ?? [];
    list.push(c);
    byFirmId.set(firmId, list);
  };

  for (const p of directory) {
    const firmId = p.firmId ?? firmIdByKey.get(normalizeFirmName(p.firmName));
    if (!firmId || !firmSlugById.has(firmId)) continue;
    const person: ScorablePerson = {
      name: p.name,
      firmName: p.firmName,
      title: p.title,
      school: p.school,
      degree: p.degree,
      gradYear: p.gradYear,
      jobHistory: p.jobHistory,
      freeText: p.schoolYears,
      email: p.email,
      linkedinUrl: p.linkedinUrl,
    };
    push(firmId, {
      key: `directory-${p.id}`,
      name: p.name,
      title: p.title,
      firmName: p.firmName,
      firmSlug: firmSlugById.get(firmId)!,
      email: p.email,
      linkedinUrl: p.linkedinUrl,
      href: null,
      likelihood: scoreResponseLikelihood(user, person),
    });
  }

  for (const c of own) {
    const firmId = firmIdByKey.get(normalizeFirmName(c.firm ?? ""));
    if (!firmId) continue;
    const person: ScorablePerson = {
      name: c.name,
      firmName: c.firm ?? "",
      title: c.role,
      school: c.school,
      // Own contacts keep their history as free text rather than structured
      // columns, so everything searchable is pooled here.
      freeText: [c.background, c.notes, c.connectionAngle].filter(Boolean).join(" ⋄ "),
      email: c.email,
      linkedinUrl: c.linkedinUrl,
    };
    push(firmId, {
      key: `contact-${c.id}`,
      name: c.name,
      title: c.role,
      firmName: c.firm ?? "",
      firmSlug: firmSlugById.get(firmId)!,
      email: c.email,
      linkedinUrl: c.linkedinUrl,
      href: `/contacts/${c.id}`,
      likelihood: scoreResponseLikelihood(user, person),
    });
  }

  for (const [firmId, list] of byFirmId) {
    list.sort(
      (a, b) =>
        b.likelihood.score - a.likelihood.score ||
        a.name.localeCompare(b.name) ||
        a.key.localeCompare(b.key),
    );
    countByFirmId.set(firmId, list.length);
    byFirmId.set(firmId, list.slice(0, CONTACTS_PER_FIRM));
  }
  return { byFirmId, countByFirmId };
}

/**
 * Puts every surfaced posting into the student's tracked pipeline so they never
 * have to remember to press Track on something we already told them to care
 * about. The pipeline lives on /schedule.
 *
 * Idempotent on (firm, role) - the same pair the pipeline itself treats as one
 * application - and that is now enforced by `applications_user_firm_role_key`
 * rather than by the read below. The read stays because it is what makes the
 * RETURNED COUNT honest and keeps the common case to one query instead of one
 * per posting; the conflict clause is what makes the invariant true.
 *
 * It was not true before. A read-then-insert cannot survive two of these
 * overlapping - two Discovery renders, a match running while a page loads, a
 * double-click - because both read the same "already have" set before either
 * writes. Measured on Supabase: demo@offerly.test held 41 rows covering 22
 * distinct pairs, every duplicate at Evercore, each role drawn twice in the
 * tracking panel. See the index's own comment in db/schema.ts.
 */
/** Only the fields the insert below actually reads. Narrower than
 *  MatchedInternship on purpose: the match-time caller has postings, not the
 *  display-ready tree Discovery builds, and widening it would mean inventing
 *  summary/timing fields that nothing here looks at. */
type TrackableInternship = Pick<
  MatchedInternship,
  "firmName" | "roleTitle" | "applyUrl" | "categories"
>;

async function autoTrackInternships(userId: string, postings: TrackableInternship[]) {
  if (!postings.length) return 0;
  const db = await getDb();

  // Everything already on the tracker, compared as the same application -
  // the firm by any name it goes by, the role in any spelling - so a row the
  // student typed as "Evercore Partners / IB Summer Analyst" is not tracked a
  // second time as the posting's own title.
  const [existing, known] = await Promise.all([
    db.query.applications.findMany({
      where: eq(applications.userId, userId),
      columns: { firm: true, role: true },
    }),
    trackedFirmNames(userId),
  ]);
  const resolve = firmResolver(known);
  const tracked = existing.map((r) => ({ firm: resolve(r.firm), role: r.role }));
  const isTracked = (firm: string, role: string) =>
    tracked.some((t) => t.firm === resolve(firm) && sameRole(t.role, role));

  let added = 0;
  for (const p of postings) {
    if (isTracked(p.firmName, p.roleTitle)) continue;

    await db
      .insert(applications)
      .values({
        userId,
        firm: p.firmName,
        role: p.roleTitle,
        applicationUrl: p.applyUrl,
        // A cross-listed posting picks its first industry: the pipeline's
        // category is a single column, so something has to win, and the
        // posting's own ordering is a better guess than leaving it blank and
        // making the row invisible to every category filter.
        category: applicationCategoryFor(p.categories),
        // Says plainly where the row came from, so a student scanning their
        // pipeline can tell what they added from what we added for them.
        notes: "Auto-tracked from your Discovery matches.",
      })
      // The constraint decides, not the read above. A row inserted by a
      // concurrent run between that read and this write is skipped here
      // instead of becoming a duplicate.
      .onConflictDoNothing();
    added += 1;
    tracked.push({ firm: resolve(p.firmName), role: p.roleTitle });
  }
  return added;
}

/**
 * Auto-tracks every eligible posting at a set of just-matched firms.
 *
 * Exists because autoTrackInternships above only ever ran as a side effect of
 * RENDERING the Discovery page. That made a student's pipeline depend on
 * whether they happened to open a particular tab: a real account here had 109
 * matched firms and 94 eligible postings sitting at them, and zero tracked
 * applications, purely because nobody had visited Discovery since matching.
 * Everything downstream - the Upcoming list, the schedule reminders - reads
 * the pipeline, so all of it was empty for a reason that had nothing to do
 * with the student.
 *
 * Matching is the moment the decision is made, so this runs there too (see
 * match-top-firms.ts). Still idempotent on (firm, role), so a later Discovery
 * visit re-tracks nothing.
 */
export async function autoTrackForMatchedFirms(
  user: MatchUser,
  firmIds: string[],
): Promise<number> {
  if (firmIds.length === 0) return 0;
  const db = await getDb();

  const firmRows = await db
    .select({ slug: firms.slug })
    .from(firms)
    .where(inArray(firms.id, firmIds));
  const slugs = new Set(firmRows.map((f) => f.slug));
  if (slugs.size === 0) return 0;

  const eligible = await getRelevantPostings({
    gradYear: user.gradYear,
    // Auto-tracking writes into the student's own application list, so it has
    // to respect the same cycle and sector answers the dashboard does.
    // Otherwise it quietly fills that list with roles from a closed cycle in
    // sectors they never picked, and every surface downstream inherits them.
    internshipYear: internshipYearFor(user),
    preferredCategories: user.preferredCategories ?? null,
  });

  const postings: TrackableInternship[] = eligible
    .filter((p) => p.firmSlug && slugs.has(p.firmSlug))
    .map((p) => ({
      firmName: p.firmName,
      roleTitle: p.roleTitle,
      applyUrl: p.applicationUrl ?? p.sourceUrl,
      categories: p.categories,
    }));

  return autoTrackInternships(user.id, postings);
}

function applicationCategoryFor(
  categories: FirmProgramCategory[],
): (typeof applications.$inferInsert)["category"] {
  for (const c of categories) {
    const mapped = PROGRAM_TO_APPLICATION_CATEGORY[c];
    if (mapped) return mapped as (typeof applications.$inferInsert)["category"];
  }
  return null;
}

/**
 * Request-scoped. Discovery renders all three tab panels at once (they are
 * hidden, not unmounted), so three shelves ask for matches on every load.
 * Without this that is three concurrent runs of the matcher on a student's
 * first visit - three LLM calls, three sets of inserts racing each other, and a
 * triple-billed page view. React's cache() collapses them into one.
 */
export const getDiscoveryMatchesForCurrentUser = cache(async (): Promise<DiscoveryMatches> => {
  const { getCurrentUser } = await import("@/lib/current-user");
  return getDiscoveryMatches(await getCurrentUser());
});

/**
 * The Opportunities view: the top slice of the same tree, in the same order.
 * A slice rather than a second query - the whole point is that the twelve firms
 * here are the first twelve of Discovery's twenty-four, not a different ranking
 * that happens to overlap.
 */
export const getOpportunityMatches = cache(async (): Promise<DiscoveryMatches> => {
  const matches = await getDiscoveryMatchesForCurrentUser();
  // totalGroups deliberately survives the slice.
  return { ...matches, groups: matches.groups.slice(0, OPPORTUNITY_FIRMS) };
});

/**
 * `firm|role` for everything already in the student's pipeline.
 *
 * The same key the pipeline treats as one application, so a posting card can
 * tell whether it is tracked without knowing which row it produced. One query
 * for the page rather than one per card.
 */
export const getTrackedKeys = cache(async (userId: string): Promise<Set<string>> => {
  const db = await getDb();
  const rows = await db.query.applications.findMany({
    where: eq(applications.userId, userId),
    columns: { firm: true, role: true },
  });
  return new Set(rows.map((r) => `${r.firm}|${r.role}`));
});

export { MATCHED_FIRMS, OPPORTUNITY_FIRMS, CONTACTS_PER_FIRM } from "@/lib/match-config";
/**
 * The order firms are shown in: the ones the student added themselves first,
 * newest first, then the matcher's picks in the matcher's own order.
 *
 * A firm added from the deck's "+" card used to go to the END - after up to
 * fifty matched firms, where the twelve-card deck and even the fifty-firm
 * list never reached it - so adding a firm looked like it did nothing. The
 * student's own choice is the strongest signal on the list; it leads.
 */
export function orderTopFirms<T extends { source: string; createdAt: Date; position?: number | null }>(rows: readonly T[]): T[] {
  // The student's own order first: firms they have dragged into place, by the
  // position they gave them. Everything never moved follows in the default
  // order below.
  const placed = rows.filter((r) => typeof r.position === "number").sort((a, b) => a.position! - b.position!);
  const rest = rows.filter((r) => typeof r.position !== "number");
  const mine = rest.filter((r) => r.source === "manual").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const matched = rest.filter((r) => r.source !== "manual").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return [...placed, ...mine, ...matched];
}

