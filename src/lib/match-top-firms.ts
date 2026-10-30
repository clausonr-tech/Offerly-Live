import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { behavioralAnswers, users, userTopFirms } from "@/db/schema";
import { countFirmsForCategories, getFirmsByIds, getFirmsForCategories } from "@/lib/firms";
import {
  CATEGORY_LABELS,
  IB_TIER_LABELS,
  PE_TIER_LABELS,
  type FirmProgramCategory,
} from "@/lib/firm-metadata";
import { FIRM_TIER_BY_SLUG, VERIFIED_PROGRAM_SLUGS } from "@/lib/firm-content";
import { FIRM_COVERAGE_BY_SLUG } from "@/lib/firm-profiles";
import { interestGroups } from "@/lib/coverage-match";
import { findTopFirms } from "@/lib/find-top-firms";
import { MATCHED_FIRMS } from "@/lib/match-config";

// The firm matcher, lifted out of dashboard/actions.ts so it has two callers
// rather than one: the "Find my top firms" button, and Discovery, which runs
// the same match automatically the first time a student opens it. Two copies
// of this would be two prompts, two candidate rankings, and two lists of
// "your" firms that quietly disagreed.

// The whole candidate list is pasted into the matcher prompt, so its length is
// a direct cost and quality problem, not just a formatting one. Since the bulk
// firm import, "other finance" alone holds over a thousand firms - roughly
// 70k tokens of list per click, asking the model to pick five firms out of a
// thousand near-identical lines, most of which are community banks nobody
// verified as taking interns.
//
// So rank before truncating: firms confirmed to run a student programme go
// first, then the rest by size for a stable, reproducible list. Every firm
// still appears in Discovery - this only bounds what one prompt carries.
// Sized against the number of picks, not in isolation. Asking for 100 firms out
// of 150 candidates is not matching - it is copying two thirds of the list - so
// the pool has to grow with the target to leave the model anything to choose
// between. Derived from the target so the ratio holds if the target moves,
// rather than a literal that silently becomes 12:1 when the target halves.
const MAX_CANDIDATE_FIRMS = MATCHED_FIRMS * 6;

/**
 * Does this firm satisfy the tier the student actually asked for?
 *
 * Onboarding asks "what type of investment bank?" and "what size of fund?",
 * calls them the biggest lever for narrowing firms, and stores the answers -
 * and until now nothing read them except the prompt, as one soft line among
 * thirty. So a student who said "Bulge Bracket" got Bulge Brackets plus
 * whatever else filled the quota.
 *
 * The test is per-category, not per-firm: a student targeting IB *and*
 * consulting should still get consultancies, which have no tier question, and
 * should not have their consultancies judged against a bank tier.
 *
 * A firm whose tier we do not know fails a stated tier constraint. That is
 * deliberate - we cannot assert an untiered firm is bulge bracket - and it is
 * why tier coverage in the seeds bounds how large a precise list can get.
 */
export function satisfiesTierPreferences(
  firm: { slug: string; programs: { category: string }[] },
  preferredCategories: string[],
  ibTierPreferences: string[],
  peTierPreferences: string[],
): boolean {
  const served = new Set(firm.programs.map((p) => p.category));
  const tier = FIRM_TIER_BY_SLUG[firm.slug];

  for (const category of preferredCategories) {
    if (!served.has(category)) continue;

    if (category === "investment_banking" && ibTierPreferences.length) {
      const label = tier?.ibTier ? IB_TIER_LABELS[tier.ibTier] : null;
      if (label && ibTierPreferences.includes(label)) return true;
      continue;
    }

    if (category === "private_equity" && peTierPreferences.length) {
      const label = tier?.peTier ? PE_TIER_LABELS[tier.peTier] : null;
      if (label && peTierPreferences.includes(label)) return true;
      continue;
    }

    // No tier question for this sector, or the student skipped it: serving a
    // category they chose is enough.
    return true;
  }

  return false;
}

function rankCandidateFirms<T extends { slug: string; name: string; aum?: number | null }>(
  firms: T[],
): T[] {
  return [...firms]
    .sort((a, b) => {
      const av = VERIFIED_PROGRAM_SLUGS.has(a.slug) ? 0 : 1;
      const bv = VERIFIED_PROGRAM_SLUGS.has(b.slug) ? 0 : 1;
      // Among unverified firms the alphabetical tiebreak decided which 150 of
      // several thousand the model ever saw, so a sector's candidates were
      // whatever sorted earliest. AUM is a far better proxy for "a student has
      // heard of this firm". Unreported AUM sorts last, not as zero.
      return av - bv || (b.aum ?? -1) - (a.aum ?? -1) || a.name.localeCompare(b.name);
    })
    .slice(0, MAX_CANDIDATE_FIRMS);
}

export type MatchTopFirmsResult = { error?: string; matchedFirmIds: string[] };

type MatchUser = Awaited<ReturnType<typeof import("@/lib/current-user").getCurrentUser>>;

/**
 * Runs the LLM firm match for one student and records the picks in
 * userTopFirms. Idempotent in the sense that matters: a firm already on the
 * student's list is never added twice, and their manual picks are untouched.
 *
 * Returns `error` rather than throwing - both callers render the failure in
 * place, and a failed match should never take down the page it ran from.
 */
/**
 * Does this firm cover the industry the student asked for?
 *
 * Deliberately the OPPOSITE default to the tier test above. An unknown tier
 * fails a stated tier, because we cannot assert an untiered firm is bulge
 * bracket. An unknown coverage PASSES a stated coverage, because the firms
 * with no coverage tag are the generalists - Goldman does have a healthcare
 * group, it just isn't a healthcare bank. Excluding untagged firms would hand
 * a healthcare student an empty list while removing every bank that could
 * actually place them.
 *
 * What it does remove is the specialist that cannot serve them: a healthcare
 * student should not be matched to a fintech-only boutique, and until now was.
 */
export function satisfiesCoveragePreferences(
  firm: { slug: string },
  nicheInterests: string[] | null | undefined,
): boolean {
  const wanted = interestGroups(nicheInterests);
  if (!wanted.length) return true;

  const focus = FIRM_COVERAGE_BY_SLUG[firm.slug];
  if (!focus?.length) return true; // generalist, or simply not researched yet

  return focus.some((group) => wanted.includes(group));
}

/**
 * Drops matched firms that no longer satisfy the student's answers.
 *
 * The matcher only ever tops a list UP - it computes how many firms are
 * missing and asks for that many. Nothing ever reconsidered a firm already on
 * the list, so changing an answer did nothing: a student who switched from
 * bulge bracket to elite boutique kept every bulge bracket they had, and
 * because the list was already at target, the matcher added nothing either.
 * The answer changed and the list did not.
 *
 * Only `ai_matched` rows are touched. A firm the student added themselves is
 * their choice, and no change of preference should quietly delete it.
 *
 * Returns how many were removed, so the caller can decide whether to re-match.
 */
export async function pruneUnmatchedTopFirms(userId: string): Promise<number> {
  const db = await getDb();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const preferredCategories = user?.preferredCategories ?? [];
  // With no sectors chosen there is nothing to judge a firm against, and
  // deleting the whole list on that basis would be worse than leaving it.
  if (!user || !preferredCategories.length) return 0;

  const rows = await db.query.userTopFirms.findMany({
    where: and(eq(userTopFirms.userId, userId), eq(userTopFirms.source, "ai_matched")),
    columns: { id: true, firmId: true },
  });
  if (!rows.length) return 0;

  // Just the firms on this student's list. This used to load the entire
  // directory to look up the handful of ids in `rows`.
  const byId = new Map(
    (await getFirmsByIds(rows.map((r) => r.firmId))).map((f) => [f.id, f]),
  );
  const ibTierPreferences = user.ibTierPreferences ?? [];
  const peTierPreferences = user.peTierPreferences ?? [];

  const stale = rows
    .filter((row) => {
      const firm = byId.get(row.firmId);
      // An unknown firm is a merge/prune concern, not a preference one.
      if (!firm) return false;
      return (
        !firm.programs.some((p) => preferredCategories.includes(p.category)) ||
        !satisfiesTierPreferences(firm, preferredCategories, ibTierPreferences, peTierPreferences) ||
        !satisfiesCoveragePreferences(firm, user.nicheInterests)
      );
    })
    .map((row) => row.id);

  if (stale.length) {
    await db.delete(userTopFirms).where(inArray(userTopFirms.id, stale));
  }
  return stale.length;
}

export async function matchTopFirmsForUser(
  user: MatchUser,
  /** How many firms the student should end up with. */
  target = MATCHED_FIRMS,
): Promise<MatchTopFirmsResult> {
  const preferredCategories = user.preferredCategories ?? [];
  if (!preferredCategories.length) {
    return { error: "Set your preferred sectors in your profile first.", matchedFirmIds: [] };
  }

  const db = await getDb();

  // Already on their list. Excluded from the candidates below rather than
  // filtered out of the picks afterwards: a top-up that leaves them in spends
  // its budget re-picking firms the student already has, and lands short of the
  // target through no fault of the model.
  const existing = await db.query.userTopFirms.findMany({
    where: eq(userTopFirms.userId, user.id),
    columns: { firmId: true },
  });
  const existingFirmIds = new Set(existing.map((e) => e.firmId));

  const needed = target - existingFirmIds.size;
  if (needed <= 0) return { matchedFirmIds: [] };

  const ibTierPreferences = user.ibTierPreferences ?? [];
  const peTierPreferences = user.peTierPreferences ?? [];

  // Only the student's sectors, filtered in SQL. The category test below is
  // now redundant for correctness - every row already runs one of these
  // programmes - but it is left in because it is the readable statement of
  // the rule, and it costs one array scan over a few hundred firms rather
  // than the 22,000 it used to run over.
  const allFirms = await getFirmsForCategories(preferredCategories);
  const eligible = allFirms.filter(
    (f) =>
      !existingFirmIds.has(f.id) &&
      f.programs.some((p) => preferredCategories.includes(p.category)) &&
      satisfiesTierPreferences(f, preferredCategories, ibTierPreferences, peTierPreferences) &&
      satisfiesCoveragePreferences(f, user.nicheInterests),
  );
  if (!eligible.length) {
    // "Everything that fits your filters is already on your list" is a
    // COMPLETED run, not a failed one, and it has to be recorded as such.
    //
    // This was the live bug behind the slow Opportunities page. A student with
    // narrow filters - say Bulge Bracket plus one coverage group - holds every
    // firm that qualifies within a few picks. From then on every visit found
    // `eligible` empty, returned here without setting topFirmsMatchedAt, and
    // so the next visit ran the entire match again: the sector's firms loaded
    // with their programmes, the tier and coverage predicates re-applied, to
    // re-derive the same empty answer. Nothing was ever shown to the student,
    // because nothing had gone wrong from their point of view.
    //
    // Recording it ends that. topFirmsEligibleCount is what re-opens matching
    // later: when the directory grows, the pool grows with it and the caller's
    // `poolGrew` check fires on its own.
    await db
      .update(users)
      .set({
        topFirmsEligibleCount: await countFirmsForCategories(preferredCategories),
        topFirmsMatchedAt: new Date(),
        topFirmsTarget: target,
      })
      .where(eq(users.id, user.id));

    return { matchedFirmIds: [] };
  }
  const candidates = rankCandidateFirms(eligible);

  // The student's own background answers from their profile. Richer signal than
  // the dropdowns, so the matcher gets them alongside the structured fields.
  const backgroundRows = await db.query.behavioralAnswers.findMany({
    where: eq(behavioralAnswers.userId, user.id),
    with: { question: { columns: { prompt: true } } },
  });
  const studentBackground = backgroundRows
    .filter((r) => r.answerText?.trim())
    .map((r) => ({ prompt: r.question.prompt, answer: r.answerText }));

  // When the student's own answers already narrow the field to at or below the
  // target, there is nothing for a model to choose between - asking it to pick
  // 8 firms out of 8 is a paid call whose answer is "all of them". Take them
  // directly. This is the normal case for a student with specific targets,
  // which is exactly the student the tier filter was added for.
  /**
   * Take firms straight off the deterministic ranking, no model involved.
   *
   * Used in two situations. When the student's own answers already narrow the
   * field to at or below the target there is nothing to choose between -
   * asking a model to pick 8 firms out of 8 is a paid call whose answer is
   * "all of them". And when the ranked path cannot deliver, this is the
   * fallback: the section is supposed to fill itself, so a student whose
   * matching run failed should still find their sector's strongest firms
   * there rather than an error and an empty deck.
   */
  const takeDirectly = async (picks: typeof candidates) => {
    const stated = [
      preferredCategories.length === 1 ? CATEGORY_LABELS[preferredCategories[0] as FirmProgramCategory] : null,
      ibTierPreferences.length ? ibTierPreferences.join("/") : null,
      interestGroups(user.nicheInterests).join("/") || null,
    ]
      .filter(Boolean)
      .join(" - ");

    const reason = stated
      ? `Matches every filter you set: ${stated}.`
      : "Matches the sectors you chose.";

    const directIds: string[] = [];
    for (const firm of picks) {
      const inserted = await db
        .insert(userTopFirms)
        .values({ userId: user.id, firmId: firm.id, source: "ai_matched", reason })
        .onConflictDoNothing()
        .returning();
      if (inserted.length) directIds.push(firm.id);
    }

    // Record the run, exactly as the ranked path below does.
    //
    // This was missing, and it was expensive. `topFirmsMatchedAt` doubles as
    // the "has this student been matched at all" flag that getDiscoveryMatches
    // reads to decide whether to match on arrival. Leaving it null on this
    // path meant a student whose pool is smaller than their shortfall - the
    // normal case for anyone with specific targets, which is precisely the
    // student this shortcut exists for - was matched again on EVERY page load,
    // and each of those runs pulls the entire firm directory with its programs
    // (measured at ~29MB and 9-13 seconds against the remote database) to
    // re-derive the same answer. It also meant the "firms added since you
    // matched" notice could never fire for them, because there was no run to
    // compare against.
    //
    // Set after the inserts, so a failure above leaves the flag clear and the
    // next load genuinely does need to try again.
    await db
      .update(users)
      // The same helper the dashboard compares against, deliberately: two ways
      // of counting "eligible firms" would drift and report phantom new firms.
      .set({
        topFirmsEligibleCount: await countFirmsForCategories(preferredCategories),
        topFirmsMatchedAt: new Date(),
        topFirmsTarget: target,
      })
      .where(eq(users.id, user.id));

    return { matchedFirmIds: directIds };
  };

  if (candidates.length <= needed) {
    return takeDirectly(candidates);
  }

  try {
    const picks = await findTopFirms({
      userId: user.id,
      pickCount: Math.min(needed, candidates.length),
      studentBackground,
      studentSchool: user.school,
      studentGradYear: user.gradYear,
      studentSponsorshipNeeded: user.sponsorshipNeeded,
      studentInterests: user.interests,
      studentMotivations: user.motivations,
      studentWorkStyle: user.workStyle,
      studentNicheInterests: user.nicheInterests,
      studentTargetLocations: user.targetLocations,
      studentRecruitingStage: user.recruitingStage,
      studentPriorExperience: user.priorExperience,
      studentClubs: user.clubsAndActivities,
      studentProudExperience: user.proudExperience,
      studentHometown: user.hometown,
      studentUnsure: user.onboardingUnsure,
      candidateFirms: candidates.map((f) => ({
        slug: f.slug,
        name: f.name,
        headquarters: f.headquarters,
        description: f.description,
        categories: [...new Set(f.programs.map((p) => p.category))],
      })),
    });

    // No picks is not an error the student can do anything about, and
    // returning one left the section empty AND left topFirmsMatchedAt unset -
    // so the whole run, directory load included, repeated on every single page
    // load, forever. Fall back to the ranking we already computed.
    if (!picks.length) {
      return takeDirectly(candidates.slice(0, needed));
    }

    const slugToFirmId = new Map(candidates.map((f) => [f.slug, f.id]));

    const newlyMatchedFirmIds: string[] = [];
    for (const pick of picks) {
      const firmId = slugToFirmId.get(pick.slug);
      if (!firmId || existingFirmIds.has(firmId)) continue;
      // onConflictDoNothing against the unique (userId, firmId) index: the
      // read above narrows the work, this is what makes it correct when two
      // runs overlap.
      const inserted = await db
        .insert(userTopFirms)
        .values({
          userId: user.id,
          firmId,
          source: "ai_matched",
          reason: pick.reason,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) continue;
      newlyMatchedFirmIds.push(firmId);
    }

    // Matching a firm no longer writes a dated reminder for it. The reminder
    // was an estimate built from prose timing guidance, and a firm on a
    // shortlist is not a deadline; what the student gets instead is the firm's
    // real postings, tracked below, carrying whatever dates those postings
    // actually state.
    // Tracking the roles at a firm we just matched belongs HERE, at the moment
    // the decision is made - not as a side effect of RENDERING Discovery,
    // which is the only place it used to happen. A student who matched and
    // then went to their schedule saw an empty pipeline, because the page that
    // fills it was never opened.
    try {
      // Imported dynamically, not at the top: discovery-matches already
      // imports this module (it calls matchTopFirmsForUser), so a static
      // import here would close the cycle. Deferring it to call time keeps
      // the dependency one-directional at module load.
      const { autoTrackForMatchedFirms } = await import("@/lib/discovery-matches");
      await autoTrackForMatchedFirms(user, newlyMatchedFirmIds);
    } catch (err) {
      console.error("auto-track matched postings failed:", err);
    }

    // Record the size of the pool this run considered. The dashboard compares
    // it against the pool today to tell the student when the directory has
    // grown since - which is the only way they learn a new firm exists without
    // re-running matching blind.
    //
    // topFirmsMatchedAt doubles as the "has this student been matched at all"
    // flag Discovery reads to decide whether to run the match on arrival, so
    // it must be set even when every pick was already on their list.
    await db
      .update(users)
      // The same helper the dashboard compares against, deliberately: two ways
      // of counting "eligible firms" would drift and report phantom new firms.
      .set({
        topFirmsEligibleCount: await countFirmsForCategories(preferredCategories),
        topFirmsMatchedAt: new Date(),
        // What this run was aiming for. Raising the product target later has to
        // re-open matching for students who were filled to the old one, and
        // without this there is no way to tell "already tried for 100 and this
        // is all the pool has" from "filled to 24 back when 24 was the target".
        topFirmsTarget: target,
      })
      .where(eq(users.id, user.id));

    return { matchedFirmIds: newlyMatchedFirmIds };
  } catch (err) {
    // Same reasoning as the empty-picks branch above: the ranked path failing
    // must not mean the student gets nothing and we retry the whole thing on
    // their next page load. Log it - this is the only place the real cause is
    // visible - and fill the section from the deterministic ranking.
    console.error("ranked firm matching failed, using deterministic ranking:", err);
    try {
      return await takeDirectly(candidates.slice(0, needed));
    } catch (fallbackErr) {
      return {
        error: fallbackErr instanceof Error ? fallbackErr.message : "Failed to research firms",
        matchedFirmIds: [],
      };
    }
  }
}
