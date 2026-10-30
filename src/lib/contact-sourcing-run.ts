/**
 * One contact-sourcing run, from a click to saved people.
 *
 * Everything the server action used to do EXCEPT authentication and cache
 * revalidation, which need a Next request context. It lives here so it can be
 * driven against a real database in tests - the concurrency, the unique
 * constraint and the transaction are the whole point, and none of them can be
 * exercised through a mock.
 *
 * THE BILLING MODEL, stated once:
 *
 *   - A click is an INTENT, keyed (user, firm, mode). Two presses of the same
 *     button are one intent; the second joins the first.
 *   - The pending row is a LOCK, not a debit. It is inserted with zero credits.
 *   - The charge and the contacts are written in ONE transaction, at the end,
 *     from the outcome. A run that returned nobody, failed, or re-read a
 *     cached set costs the student nothing.
 *   - A student pays for people, not for attempts.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, contactSourcingRuns, firmEmailPatterns, firms } from "@/db/schema";
import {
  CONTACTS_PER_RUN,
  NoContactCreditsError,
  assertContactCredit,
  runIsWithinAllowance,
  getContactCredits,
  isInternalAccount,
} from "@/lib/contact-credits";
import {
  buildSourcingPlan,
  interestHooks,
  SourcingContextError,
  type ContactSearchQuery,
} from "@/lib/contact-sourcing-agent";
import { clubGroups, clubSignals } from "@/lib/club-signals";
import {
  CONTACT_ALGORITHM_VERSION,
  buildAffinitySignals,
  buildCandidatePool,
  rankPool,
  selectFinal,
  sourcingRecord,
  summarizeRun,
  type PoolCandidate,
  type Ranked,
  type SearchLog,
} from "@/lib/contact-pool";
import { CRUSTDATA_CAPABILITIES, affinitySearchEnabled } from "@/lib/contact-search-provider";
import {
  PATTERN_DERIVE_MIN_SAMPLES,
  detectPattern,
  domainBelongsToFirm,
  isPatternConfirmed,
  recordObservation,
  winnerOf,
  type PatternShape,
  type PatternTally,
} from "@/lib/email-patterns";
import { juniorFirst } from "@/lib/contact-seniority";
import { isProbableDuplicate, type DuplicateFingerprint } from "@/lib/contact-tiers";
import {
  CompanyIdentityRequiredError,
  CompanyResolutionUnavailableError,
  ensureVerifiedIdentity,
} from "@/lib/company-resolution";
import {
  canLearnPattern,
  hasCompleteUnambiguousName,
  preferFirmAddress,
  resolveContactEmail,
  type ContactEmailConfidence,
  type ContactEmailResult,
  type FirmEmailDomains,
  type ProviderEmailStatus,
} from "@/lib/contact-email-gate";
import {
  CrustdataError,
  enrichBusinessEmails,
  searchPeopleForPatternProbe,
  searchVerifiedEmailSchoolmate,
  resolveCompany,
  searchTiersExcludingSeen,
  searchPeopleForAffinity,
  ENRICH_CREDITS,
  SEARCH_CREDITS_PER_RESULT,
  type EnrichedEmail,
  type SourcedContact,
} from "@/lib/crustdata-client";
import { DEFAULT_TIERS } from "@/lib/contact-tiers";
import { confirmEmployment, isAdmissibleContact, type EmploymentEvidence } from "@/lib/employment";
import { rateLimit } from "@/lib/rate-limit";
import {
  chargeModeFor,
  creditsForOutcome,
  decideServe,
  idempotencyKey,
  isChargeable,
  type RequestMode,
  type ServeDecision,
} from "@/lib/sourcing-run-policy";

/**
 * How many free top-ups one student may take on one firm in a day.
 *
 * A legitimate fill completes a partial set once. The set stays "partial"
 * while it has fewer than five people, though, so a client could keep asking
 * to fill a set the provider has no more people for - each one a free search.
 * Over the cap the existing set is served as it stands.
 */
const FILL_LIMIT = 3;
const FILL_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The most one generation spends at the provider, in dollars - EVERYTHING:
 * the searches for the five, the email anchor, enrichment and the hidden
 * pattern search. Every paid call checks its worst-case cost against what is
 * left BEFORE it is made, so a run cannot go over.
 */
const PATTERN_PROBE_BUDGET_USD = 2;
/** And the most hidden people it tries, whatever the budget - a bound on time. */
const MAX_PATTERN_PROBES = 40;

/**
 * The generation's budget in provider credits, or 0 when the price per credit
 * is not configured - in which case the hidden search does not run, and the
 * rest of the run is not capped (it cannot be, without a price).
 */
function patternProbeBudgetCredits(env: NodeJS.ProcessEnv = process.env): number {
  const usdPerCredit = Number(env.CRUSTDATA_USD_PER_CREDIT);
  return Number.isFinite(usdPerCredit) && usdPerCredit > 0 ? PATTERN_PROBE_BUDGET_USD / usdPerCredit : 0;
}

export type SourcingActor = { id: string; email: string | null };

type SourcedContactView = {
  id: string;
  name: string;
  title: string | null;
  linkedinUrl: string | null;
  /** Their work email, from the provider or derived from the firm's pattern.
   *  Null whenever nothing survived the relevance gate. */
  email: string | null;
  emailConfidence: ContactEmailConfidence;
  /** The frontend must check this too. A non-null `email` is not enough. */
  emailDomainRelevant: boolean;
  /** Why this person - the shared-background line. Empty when nothing matched. */
  memo: string;
  score: number;
};

export type GenerateContactsResult =
  | {
      ok: true;
      /**
       * `sourced`      the provider ran and these people are new
       * `cached`       this intent already ran; these are its saved people,
       *                and NOTHING was called or charged
       * `in_progress`  another press of the same intent is still running
       */
      status: "not_connected" | "sourced" | "cached" | "in_progress";
      contacts: SourcedContactView[];
      /** What the provider actually billed, straight off their response
       *  header. Zero on a cached or joined click, because nothing was sent. */
      creditsUsed: number;
      /** How many people match the search in total, not just the five returned. */
      totalMatching: number;
      summary: string;
      willRequest: number;
      hasResume: boolean;
      hasLinkedin: boolean;
      /** Inputs that would sharpen the search, e.g. "resume", "LinkedIn profile". */
      missing: string[];
      /**
       * Exactly what would be sent to the provider - INTERNAL ACCOUNTS ONLY.
       *
       * Gated on the server rather than in the component, because hiding a
       * field the server already sent is not hiding it - it would still be
       * sitting in the response. Absent for everyone else.
       */
      query?: ContactSearchQuery;
      /** What was read back out of the stored resume, so the student can see
          it was understood - not sent anywhere by itself. */
      resumeRead: { interests: string[]; employers: string[]; activities: string[]; skills: string[] };
      /** Whether the student has opted into sharing hometown / interests. */
      consent: { shareHometown: boolean; shareInterests: boolean };
      credits: { used: number; limit: number; remaining: number; unlimited: boolean };
      /** Paths the caller should revalidate. Returned rather than revalidated
       *  here, because `revalidatePath` needs a request context and this
       *  function is meant to be runnable without one. */
      revalidate: string[];
      /** Which branch ran, for the run log and for tests. */
      decision: ServeDecision["action"];
    }
  | { ok: false; error: string };

/** Errors that are the student's situation rather than a crash. */
function isExpectedSourcingError(err: unknown): boolean {
  return (
    err instanceof CompanyIdentityRequiredError ||
    err instanceof CompanyResolutionUnavailableError ||
    err instanceof NoContactCreditsError ||
    err instanceof SourcingContextError ||
    err instanceof CrustdataError
  );
}

type Db = Awaited<ReturnType<typeof getDb>>;

/** The ONLY place a run is settled as failed. Never charged. */
async function settleFailed(db: Db, runId: string, err: unknown): Promise<void> {
  await db
    .update(contactSourcingRuns)
    .set({
      status: "failed",
      error: err instanceof Error ? err.message.slice(0, 500) : "Unknown error",
      creditsSpent: 0,
      completedAt: new Date(),
    })
    .where(eq(contactSourcingRuns.id, runId));
}

async function runForKey(db: Db, key: string) {
  return db.query.contactSourcingRuns.findFirst({
    where: eq(contactSourcingRuns.idempotencyKey, key),
  });
}

/**
 * Which refresh this is.
 *
 * Counted rather than stored on a counter column: successive refreshes must
 * get distinct keys, and the count of refresh runs already in the table IS
 * that sequence. Two concurrent refreshes derive the same number and collide
 * on the unique index, which is the correct outcome - they are, in that
 * instant, the same intent.
 */
async function nextRefreshSequence(db: Db, userId: string, firmId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contactSourcingRuns)
    .where(
      and(
        eq(contactSourcingRuns.userId, userId),
        eq(contactSourcingRuns.firmId, firmId),
        eq(contactSourcingRuns.mode, "refresh"),
      ),
    );
  return (row?.n ?? 0) + 1;
}

/** The people already saved for this student at this firm, newest first. */
async function savedContactsFor(db: Db, userId: string, firmName: string) {
  return db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), eq(contacts.firm, firmName)),
    orderBy: [desc(contacts.createdAt)],
  });
}

export async function runContactSourcing(input: {
  user: SourcingActor;
  firmId: string;
  /** Defaults to `generate`, which is what the button sends. */
  mode?: RequestMode;
  now?: Date;
}): Promise<GenerateContactsResult> {
  const { user, firmId } = input;
  const mode: RequestMode = input.mode ?? "generate";
  const now = input.now ?? new Date();

  try {
    const db = await getDb();

    // ---- 1. the key, and what already exists under it --------------------
    //
    // BEFORE anything that costs: before the credit check, before the firm
    // resolution, and specifically before any provider call. A repeat click
    // must not identify a company, must not search and must not enrich - it
    // must read what the first click already bought.
    const refreshSequence =
      mode === "refresh" ? await nextRefreshSequence(db, user.id, firmId) : 0;
    const key = idempotencyKey({
      userId: user.id,
      recommendationId: firmId,
      mode,
      refreshSequence,
    });

    let existing = await runForKey(db, key);
    const decision = decideServe({
      mode,
      existing: existing
        ? {
            status: existing.status as "succeeded" | "failed" | "pending",
            contactsCreated: existing.contactsCreated,
            creditsSpent: existing.creditsSpent,
            completedAt: existing.completedAt,
            createdAt: existing.createdAt,
          }
        : null,
      now,
    });

    // A pending row nobody is working on any more. Release its key - the row
    // stays exactly as it is, as evidence - so the retry can claim one.
    if (decision.action === "run" && decision.reason === "stale_pending" && existing) {
      await db
        .update(contactSourcingRuns)
        .set({
          idempotencyKey: null,
          status: "failed",
          error: "Abandoned: no result recorded before the staleness window elapsed",
          creditsSpent: 0,
          completedAt: now,
        })
        .where(eq(contactSourcingRuns.id, existing.id));
      existing = undefined;
    }

    if (decision.action === "serve_cached" || decision.action === "join_in_flight") {
      return servedWithoutRunning(db, user, firmId, decision.action);
    }

    // A free top-up is bounded per student per firm: see FILL_LIMIT. Over the
    // cap the partial set is served as it stands rather than refused, so the
    // student still sees their people.
    if (decision.reason === "fill") {
      const topUp = await rateLimit(
        "contacts:fill",
        `${user.id}:${firmId}`,
        FILL_LIMIT,
        FILL_WINDOW_MS,
        now,
      );
      if (!topUp.allowed) return servedWithoutRunning(db, user, firmId, "serve_cached");
    }

    // ---- 2. commitments --------------------------------------------------
    //
    // A firm whose company identity is not verified must not reach a paid
    // search at all - and specifically must not fall back to its stored SEC
    // website, which for 25 rows in the directory is a LinkedIn country
    // subdomain or a careers host. Five contacts at the wrong company is
    // worse than none.
    //
    // ensure, not require: this resolves the firm on the spot if it has not
    // been resolved yet, saves the verified identity, and carries straight on
    // into the search below. The lookup bills nothing.
    //
    // The plan first (free): its school names settle a firm the provider
    // lists twice - see pickListedRecord - and that choice is then saved on
    // the firm for every student after.
    const plan = await buildSourcingPlan({ userId: user.id, firmId, limit: CONTACTS_PER_RUN });
    const verified = await ensureVerifiedIdentity(firmId, {
      schoolNames: plan.query.education.school?.names,
    });
    // Every search for this firm is on the company we just verified - never
    // a second, independent lookup that can land on a namesake.
    plan.query.employer.companyId = verified.crustdataCompanyId;

    await assertContactCredit(user.id);

    // The firm's own approved alias list, for the email gate below.
    const firmRow = await db.query.firms.findFirst({
      where: eq(firms.id, firmId),
      columns: { approvedEmailDomains: true },
    });

    // ---- 3. claim the intent ---------------------------------------------
    //
    // Insert-or-lose, not check-then-insert. A SELECT followed by an INSERT
    // leaves a window two concurrent requests both pass through; ON CONFLICT
    // DO NOTHING closes it in the database, where the race actually happens.
    //
    // Zero credits: the pending row is a lock, not a debit. It is settled
    // with its real cost at the end, from the outcome.
    let run: typeof contactSourcingRuns.$inferSelect | undefined;

    /**
     * A row already holds this key and we are going to run anyway.
     *
     * Two ways that happens, and both REUSE the row rather than inserting
     * beside it - the key is taken, so a second insert would simply lose:
     *
     *   fill          topping up the partial set the row records. Reusing it
     *                 is what makes the top-up free.
     *   failed_cache  the previous attempt failed. Without this a retry
     *                 collides with the corpse of the run it is retrying and
     *                 is told to join an in-flight run that is not running -
     *                 which made a single rate limit permanent.
     */
    const reuseExisting =
      existing && (decision.reason === "fill" || decision.reason === "failed_cache")
        ? existing
        : null;

    if (reuseExisting) {
      const [reopened] = await db
        .update(contactSourcingRuns)
        .set({ status: "pending", completedAt: null, error: null })
        .where(eq(contactSourcingRuns.id, reuseExisting.id))
        .returning();
      run = reopened;
    } else {
      const [claimed] = await db
        .insert(contactSourcingRuns)
        .values({
          userId: user.id,
          firmId,
          idempotencyKey: key,
          mode,
          refreshSequence,
          creditsSpent: 0,
          contactsRequested: plan.query.limit,
          status: "pending",
          querySummary: plan.summary,
        })
        /**
         * The arbiter is `contact_sourcing_idempotency_uq`. Legacy rows carry
         * a null key and never collide, because Postgres indexes nulls as
         * distinct - so this needs no predicate.
         */
        .onConflictDoNothing({ target: contactSourcingRuns.idempotencyKey })
        .returning();
      run = claimed;
    }

    if (!run) {
      // Somebody else claimed this intent between step 1 and here. They own
      // the provider call and the charge; this request serves whatever they
      // produce. Nothing was called and nothing is owed.
      const winner = await runForKey(db, key);
      return servedWithoutRunning(
        db,
        user,
        firmId,
        winner?.status === "succeeded" ? "serve_cached" : "join_in_flight",
      );
    }

    // The allowance again, now this run's pending row is counted (see
    // runIsWithinAllowance): runs started together cannot all spend the same
    // last credit. Over it, the row is marked failed - which costs nothing -
    // before any paid call is made.
    if (!(await runIsWithinAllowance(user.id, run.id))) {
      await db
        .update(contactSourcingRuns)
        .set({ status: "failed", error: "No contact credits left", completedAt: new Date() })
        .where(eq(contactSourcingRuns.id, run.id));
      const credits = await getContactCredits(user.id);
      throw new NoContactCreditsError(credits.limit);
    }

    // ---- 4. the provider: retrieve a POOL ----------------------------------
    //
    // Retrieval and selection are separate (lib/contact-pool). The baseline
    // ladder gathers its own quota - same school-first rule, employment check,
    // complete-name rule and deduplication as before - and up to three
    // affinity searches add people found through the student's strongest
    // signals. Nothing is chosen here; the whole pool is ranked below. This
    // replaces "the first rungs to fill five slots decide the result".
    type Sourced = SourcedContact & { employment: EmploymentEvidence };
    let pooled: Awaited<ReturnType<typeof buildCandidatePool<Sourced>>>;
    let providerCredits = 0;
    // Enrichment and hidden-search spend; declared here so the budget below
    // sees every credit the run has used, whichever step used it.
    let enrichCredits = 0;
    const budgetCredits = patternProbeBudgetCredits();
    const spentCredits = () => providerCredits + enrichCredits;
    /** Whether a call costing `credits` at worst still fits in the $2. */
    const affords = (credits: number) =>
      budgetCredits <= 0 || spentCredits() + credits <= budgetCredits + 1e-9;
    const searchTier = searchTiersExcludingSeen(plan.query);
    const affinityOverRequest = plan.query.exclude.linkedinUrls.length + plan.query.exclude.names.length;
    // The rollout guard: with affinity searching off (the default), no free
    // text leaves Offerly and the baseline ladder runs alone.
    const affinityEnabled = affinitySearchEnabled();
    const signals = !affinityEnabled ? [] : buildAffinitySignals(
      {
        clubGroups: clubGroups({
          offerly: plan.dossier.background.clubs,
          resume: plan.dossier.resume.activities,
        }),
        priorEmployers: plan.affinity.priorEmployers,
        hometown: plan.dossier.identity.hometown,
        interests: interestHooks(plan.dossier),
        coverage: plan.dossier.targeting.coverage,
      },
      {
        priorEmployerSupported: CRUSTDATA_CAPABILITIES.supportsPastEmployerFilter,
        categories: [
          ...CRUSTDATA_CAPABILITIES.searchableCategories,
          ...(CRUSTDATA_CAPABILITIES.supportsPastEmployerFilter ? (["prior_employer"] as const) : []),
        ],
      },
    );
    try {
      pooled = await buildCandidatePool<Sourced>({
        firm: { crustdataCompanyId: verified.crustdataCompanyId },
        now: new Date(),
        schoolNames: plan.query.education.school?.names,
        baselineTiers: DEFAULT_TIERS,
        signals,
        canAfford: (kind, limit) =>
          affords(
            (kind === "baseline" ? searchTier.plannedResults(limit) : Math.min(limit + affinityOverRequest, 60)) *
              SEARCH_CREDITS_PER_RESULT,
          ),
        baselineSearch: async (tier, limit) => {
          const page = await searchTier(tier, limit);
          providerCredits += page.creditsUsed;
          return { contacts: page.contacts as Sourced[], creditsUsed: page.creditsUsed };
        },
        affinitySearch: async (signal, limit) => {
          const page = await searchPeopleForAffinity(plan.query, signal, limit);
          providerCredits += page.creditsUsed;
          return { contacts: page.contacts as Sourced[], creditsUsed: page.creditsUsed };
        },
      });
    } catch (err) {
      // Settled by the caller's failure path, which is the only place a run
      // is settled - see `settleFailed`. Two settle sites is how a run ends
      // up both failed and charged.
      await settleFailed(db, run.id, err);
      throw err;
    }

    // ---- the email anchor ------------------------------------------------
    //
    // A firm whose email pattern we have not learned yet: make sure one of the
    // five is a schoolmate whose current work email the provider has VERIFIED,
    // and enrich them first - one credit that almost certainly teaches the
    // shape, instead of enriching down the list hoping. Same school, same
    // employment check as everyone else, so the rule never brings in another
    // school. When no schoolmate there is verified, the five stand as they are.
    // Unchanged by the pool: the anchor still takes the last of the final five.
    let anchorUrl: string | null = null;
    let anchorEntry: PoolCandidate<Sourced> | null = null;
    /** Paid searches outside the pool - the anchor and the hidden probe - for the run's metrics. */
    const extraSearches: SearchLog[] = [];
    const storedPattern = await db.query.firmEmailPatterns.findFirst({
      where: eq(firmEmailPatterns.firmId, firmId),
      columns: { samples: true },
    });
    const held = pooled.pool.map((a) => a.contact.linkedinUrl).filter((u): u is string => !!u);
    const anchorResults = Math.min(1 + held.length + plan.query.exclude.linkedinUrls.length, 60);
    if (
      !storedPattern &&
      verified.crustdataCompanyId != null &&
      pooled.pool.length > 0 &&
      affords(anchorResults * SEARCH_CREDITS_PER_RESULT + ENRICH_CREDITS)
    ) {
      try {
        const found = await searchVerifiedEmailSchoolmate(
          verified.crustdataCompanyId,
          plan.query.education.school?.names ?? [],
          [...held, ...plan.query.exclude.linkedinUrls],
        );
        providerCredits += found.creditsUsed;
        const anchor = found.contact;
        const anchorSearch: SearchLog = {
          searchType: "anchor",
          signalCategory: null,
          signalId: null,
          tier: "verified-email anchor",
          requested: anchorResults,
          returned: anchor ? 1 : 0,
          accepted: 0,
          duplicates: 0,
          rejected: {},
          credits: found.creditsUsed,
        };
        extraSearches.push(anchorSearch);
        const schoolNames = new Set((plan.query.education.school?.names ?? []).map((n) => n.toLowerCase()));
        const atSchool =
          !schoolNames.size || (anchor?.schools ?? []).some((sc) => schoolNames.has(sc.trim().toLowerCase()));
        const employed =
          !!anchor &&
          isAdmissibleContact(
            confirmEmployment(anchor.employment, { crustdataCompanyId: verified.crustdataCompanyId }, new Date()),
            { includeIncoming: false },
          );
        const alreadyHeld = pooled.pool.some(
          (a) =>
            a.contact.linkedinUrl === anchor?.linkedinUrl ||
            (anchor?.crustdataPersonId != null && a.contact.crustdataPersonId === anchor.crustdataPersonId),
        );
        if (anchor?.linkedinUrl && atSchool && employed && !alreadyHeld && hasCompleteUnambiguousName(anchor.name)) {
          anchorSearch.accepted = 1;
          anchorEntry = {
            contact: anchor as Sourced,
            employmentStatus: "current",
            provenance: [
              {
                searchType: "anchor",
                signalCategory: null,
                signalId: null,
                signalTerms: null,
                tier: "verified-email anchor",
                providerPosition: 0,
                searchCredits: found.creditsUsed,
              },
            ],
          };
          anchorUrl = anchor.linkedinUrl;
        }
      } catch {
        // The anchor is an optimisation; without it the run carries on as before.
      }
    }

    const sourced = {
      contacts: pooled.pool.map((a) => a.contact),
      creditsUsed: providerCredits,
      totalCount: pooled.pool.length,
    };

    // The student's side of the comparison. Resume AND typed interests are
    // passed, but the provider returns no interests, clubs or hometown today
    // (fromCrustdataProfile maps them to null), so those can only ever come
    // out "unknown" - they do not move the score until it does.
    const student = {
      school: plan.dossier.identity.school,
      schoolNames: plan.query.education.school?.names ?? [],
      // Cohort distance is the strongest thing left once every result shares
      // the school - see contact-similarity.ts.
      gradYear: plan.dossier.identity.gradYear,
      targetCities: plan.dossier.targeting.locations,
      major: plan.dossier.identity.major,
      hometown: plan.dossier.identity.hometown,
      clubs: clubSignals({
        offerly: plan.dossier.background.clubs,
        resume: plan.dossier.resume.activities,
      }),
      interests: interestHooks(plan.dossier),
      priorEmployers: plan.affinity.priorEmployers,
    };

    // ---- 5. rank the WHOLE pool, then select ------------------------------
    const ranked = rankPool({
      student,
      targetTitles: plan.query.person.titleAnyOf,
      now: new Date(),
      pool: anchorEntry ? [...pooled.pool, anchorEntry] : pooled.pool,
    });

    // Never save the same person twice: a second click should buy new names.
    const already = await db.query.contacts.findMany({
      where: and(eq(contacts.userId, user.id), eq(contacts.firm, plan.firm.name)),
      columns: {
        name: true,
        linkedinUrl: true,
        role: true,
        currentCity: true,
        school: true,
        gradYear: true,
      },
    });

    // Identity, never a name-uniqueness rule.
    //
    // The previous version refused any second row sharing a lowercased name at
    // this firm. That fixed one real duplicate and introduced a worse bug: two
    // different people called John Smith at one bank are ordinary, and such a
    // rule silently drops one of them. A shared name is not evidence of a
    // shared person; a shared stable id is, and DIFFERENT stable ids are
    // evidence they are distinct.
    //
    // The genuine one-human-two-records case is caught by a conservative
    // fingerprint instead - see isProbableDuplicate - which needs several
    // independent fields to agree before it merges anything. Run over the
    // ranked pool BEFORE selecting, so a duplicate never costs a slot.
    const heldFingerprints: {
      crustdataPersonId: number | null;
      linkedinUrl: string | null;
      fingerprint: DuplicateFingerprint;
    }[] = already.map((c) => ({
      crustdataPersonId: null,
      linkedinUrl: c.linkedinUrl,
      fingerprint: {
        name: c.name,
        companyId: verified.crustdataCompanyId,
        title: c.role,
        location: c.currentCity,
        schools: c.school ? [c.school] : null,
        gradYear: c.gradYear,
      },
    }));

    const distinct: Ranked<Sourced>[] = [];
    const acceptedFingerprints = [...heldFingerprints];
    for (const entry of ranked) {
      const c = entry.candidate.contact;
      const candidate = {
        crustdataPersonId: c.crustdataPersonId ?? null,
        linkedinUrl: c.linkedinUrl,
        fingerprint: {
          name: c.name,
          companyId: verified.crustdataCompanyId,
          title: c.title ?? null,
          location: c.currentCity ?? null,
          schools: c.schools ?? null,
          gradYear: c.gradYear ?? null,
        },
      };
      if (acceptedFingerprints.some((h) => isProbableDuplicate(h, candidate).duplicate)) continue;
      acceptedFingerprints.push(candidate);
      distinct.push(entry);
    }

    // The final five by composite score, school first. No junior-first
    // reorder any more: seniority is a scored component (reachability), so an
    // analyst gets an edge without automatically outranking a far stronger
    // match. The rows are saved in this order and the view below relies on it.
    const chosen = selectFinal(distinct, CONTACTS_PER_RUN);
    const anchorRanked = anchorEntry ? distinct.find((r) => r.candidate === anchorEntry) : undefined;
    if (anchorRanked && !chosen.includes(anchorRanked)) {
      // Unchanged rule: the anchor takes the last slot, so the firm's email
      // pattern can be learned from a verified address.
      if (chosen.length >= CONTACTS_PER_RUN) chosen.pop();
      chosen.push(anchorRanked);
    }

    const fresh = chosen.map((r, i) => ({
      contact: r.candidate.contact,
      // `matches` and `memo` are evidence only: built from structured fields
      // the provider returned, never from which search found the person.
      affinity: { matches: r.score.evidence, memo: r.score.memo, score: r.score.total },
      score: r.score,
      // What is persisted on the contact: numbers and categories only.
      record: sourcingRecord(r, i + 1),
    }));

    // ---- addresses -------------------------------------------------------
    //
    // Buying an address costs a credit EACH TIME. Buying one teaches us the
    // shape every address at the firm takes, and the shape is free to apply to
    // everybody else. So: learn the firm's pattern once, then derive.
    //
    //   pattern known    -> derive all five, spend nothing
    //   pattern unknown  -> enrich ONE, learn from it, derive the other four
    //
    // A derived address is labelled unverified all the way to the student,
    // exactly like a provider address nobody could confirm. See
    // email-patterns.ts.
    // Every domain the provider files under this firm, for the pattern check.
    const identity = await resolveCompany(plan.firm.name, plan.firm.website);
    const identityDomains = [...(identity?.domains ?? []), plan.firm.website].filter(
      (d): d is string => Boolean(d),
    );

    const known = await db.query.firmEmailPatterns.findFirst({
      where: eq(firmEmailPatterns.firmId, firmId),
    });

    // The firm's approved mail domains. `verifiedDomain` is what the identity
    // resolution confirmed; the aliases are an explicit list. Neither is
    // inferred from the SEC-filed `website`, which is exactly how
    // careers.db.com and ch.linkedin.com got into the directory.
    const firmDomains: FirmEmailDomains = {
      primaryDomain: verified.verifiedDomain,
      approvedAliases: firmRow?.approvedEmailDomains ?? [],
    };

    /**
     * Employment is confirmed PER CONTACT by accumulateAcrossTiers, which
     * admits nobody whose current employment record fails to carry the
     * selected firm's company id. Anything that reaches here has already
     * passed that gate, so the flag is a restatement rather than the
     * assumption it used to be - and it fails closed when the provider's
     * payload turns out not to carry the field at all, because then no
     * contact is admitted in the first place.
     */
    const employmentConfirmed = true;

    let tally: PatternTally = (known?.tally as PatternTally | null) ?? {};
    const confirmed = isPatternConfirmed(tally);

    /** The provider's raw answer per person, kept whether or not it is usable. */
    const enriched = new Map<string, { email: string | null; status: ProviderEmailStatus }>();
    /**
     * Teach the firm's shape from one address, if it may teach it (see
     * canLearnPattern: the firm's approved domain, spelled from the person's
     * name), and save the tally so every later run starts from it.
     */
    const learn = async (name: string, email: string, status: ProviderEmailStatus) => {
      if (!canLearnPattern({ name, email, providerStatus: status, firm: firmDomains, employmentConfirmed })) return;
      const seen = detectPattern(name, email);
      if (!seen || !domainBelongsToFirm(seen.domain, plan.firm.name, identityDomains)) return;
      tally = recordObservation(tally, seen.shape, seen.domain);
      const leader = winnerOf(tally);
      if (!leader) return;
      pattern = { shape: leader.shape, domain: leader.domain, sampleCount: leader.samples };
      await db
        .insert(firmEmailPatterns)
        .values({ firmId, shape: leader.shape, domain: leader.domain, samples: leader.samples, tally })
        .onConflictDoUpdate({
          target: firmEmailPatterns.firmId,
          set: { shape: leader.shape, domain: leader.domain, samples: leader.samples, tally, updatedAt: new Date() },
        });
    };

    const winner = winnerOf(tally);
    const agreed = winner?.samples ?? known?.samples ?? 0;
    let pattern: { shape: PatternShape; domain: string; sampleCount: number } | null =
      agreed >= PATTERN_DERIVE_MIN_SAMPLES
        ? winner
          ? { shape: winner.shape, domain: winner.domain, sampleCount: winner.samples }
          : { shape: known!.shape as PatternShape, domain: known!.domain, sampleCount: agreed }
        : null;

    // A firm whose shape is already stored - learned on ANY student's run,
    // it is a fact about the firm, not the student - buys nothing: every
    // address below is derived from it and labelled predicted. Enrichment is
    // only for firms we have not learned yet. (It used to keep buying until a
    // shape had ten agreeing samples, so every student at Brookfield would
    // have paid again for what the first had already taught.)
    if (!confirmed && !pattern) {
      // One at a time down the ranked list. A miss is free - an identifier the
      // provider cannot match bills zero - so walking all five costs one credit
      // if any resolves and nothing if none do.
      // The verified-email schoolmate first: the one most likely to teach it.
      const byLikelihood = [...fresh].sort(
        (a, b) => Number(b.contact.linkedinUrl === anchorUrl) - Number(a.contact.linkedinUrl === anchorUrl),
      );
      for (const { contact } of byLikelihood) {
        if (!contact.linkedinUrl) continue;
        if (!affords(ENRICH_CREDITS)) break;

        let found: EnrichedEmail | undefined;
        try {
          const result = await enrichBusinessEmails([contact.linkedinUrl]);
          enrichCredits += result.creditsUsed;
          found = result.emails.get(contact.linkedinUrl);
        } catch {
          break;
        }

        // The address on the firm's own domain, if the provider holds one -
        // not simply the first deliverable, which is how a Brookfield run got
        // two old employers' mailboxes.
        const pick = found ? preferFirmAddress(found.all ?? [], firmDomains, found) : null;
        const status = (pick?.status ?? null) as ProviderEmailStatus;
        enriched.set(contact.linkedinUrl, { email: pick?.email ?? null, status });
        if (!pick?.email) continue;
        await learn(contact.name, pick.email, status);

        // One address that teaches the shape is enough: the rest are derived
        // from it, and buying more would only buy what we can now build.
        if ((winnerOf(tally)?.samples ?? 0) >= PATTERN_DERIVE_MIN_SAMPLES) break;
      }
    }

    // ---- the hidden probe --------------------------------------------------
    //
    // Still no shape, and somebody in the set has no address: find the firm's
    // convention from people the student never sees. One person at a time -
    // search, enrich, learn - until a single address on the firm's domain
    // spelled from its owner's name turns up (that is the shape, applied below
    // to everyone without an address), or the run's provider spend reaches the
    // budget. None of these people is saved, shown or charged to the student.
    //
    // Off unless CRUSTDATA_USD_PER_CREDIT is set: the budget is in dollars and
    // the provider's price per credit is a contract term, not something to
    // guess at.
    const probeBudget = patternProbeBudgetCredits();
    const someoneLacksAnAddress = () =>
      fresh.some(({ contact }) => {
        const raw = contact.linkedinUrl ? enriched.get(contact.linkedinUrl) : undefined;
        return !resolveContactEmail({
          name: contact.name,
          enrichedEmail: raw?.email ?? null,
          providerStatus: raw?.status ?? null,
          firm: firmDomains,
          employmentConfirmed,
          previousCompanies: contact.previousCompanies ?? [],
          pattern,
        }).email;
      });
    let probed = 0;
    if (
      probeBudget > 0 &&
      !pattern &&
      verified.crustdataCompanyId != null &&
      fresh.length > 0 &&
      someoneLacksAnAddress()
    ) {
      const probeSeen = new Set<string>([
        ...fresh.map(({ contact }) => contact.linkedinUrl).filter((u): u is string => !!u),
        ...plan.query.exclude.linkedinUrls,
      ]);
      let queue: SourcedContact[] = [];
      while (!pattern && probed < MAX_PATTERN_PROBES) {
        if (!queue.length) {
          // The page, and at least one enrichment after it, must both fit.
          const pageCost = Math.min(10 + probeSeen.size, 60) * SEARCH_CREDITS_PER_RESULT;
          if (!affords(pageCost + ENRICH_CREDITS)) break;
          try {
            const page = await searchPeopleForPatternProbe(verified.crustdataCompanyId, [...probeSeen], 10);
            // A search, not an enrichment: counted as one, so the metrics'
            // search/enrichment split stays true. The budget sees both.
            providerCredits += page.creditsUsed;
            extraSearches.push({
              searchType: "pattern_probe",
              signalCategory: null,
              signalId: null,
              tier: "hidden pattern probe",
              requested: Math.min(10 + probeSeen.size, 60),
              returned: page.contacts.length,
              accepted: 0,
              duplicates: 0,
              rejected: {},
              credits: page.creditsUsed,
            });
            queue = page.contacts;
          } catch {
            break;
          }
          if (!queue.length) break;
        }
        const person = queue.shift()!;
        if (person.linkedinUrl) probeSeen.add(person.linkedinUrl);
        // A shape is read off a name; an abbreviated one teaches nothing.
        if (!person.linkedinUrl || !hasCompleteUnambiguousName(person.name)) continue;
        // The same employment check as a visible contact: an address at the
        // firm from someone who has left would teach the right domain, but
        // nothing else here is trusted without it.
        const employed = isAdmissibleContact(
          confirmEmployment(person.employment, { crustdataCompanyId: verified.crustdataCompanyId }, new Date()),
          { includeIncoming: false },
        );
        if (!employed) continue;

        if (!affords(ENRICH_CREDITS)) break;
        probed++;
        let found: EnrichedEmail | undefined;
        try {
          const result = await enrichBusinessEmails([person.linkedinUrl]);
          enrichCredits += result.creditsUsed;
          found = result.emails.get(person.linkedinUrl);
        } catch {
          break;
        }
        const pick = found ? preferFirmAddress(found.all ?? [], firmDomains, found) : null;
        if (pick?.email) await learn(person.name, pick.email, (pick.status ?? null) as ProviderEmailStatus);
      }
    }

    /**
     * What each person's email actually is, after the gate.
     *
     * Every route that fails to produce a usable provider address - wrong
     * domain, invalid, unknown, empty, or no enrichment at all - lands in the
     * same pattern fallback, because from the student's side they are one
     * situation: we have no confirmed address, and we either know the firm's
     * shape well enough to derive one or we say so.
     */
    const decided = new Map<string, ContactEmailResult>();
    for (const { contact } of fresh) {
      const raw = contact.linkedinUrl ? enriched.get(contact.linkedinUrl) : undefined;
      decided.set(
        contact.linkedinUrl ?? contact.name,
        resolveContactEmail({
          name: contact.name,
          enrichedEmail: raw?.email ?? null,
          providerStatus: raw?.status ?? null,
          firm: firmDomains,
          employmentConfirmed,
          previousCompanies: contact.previousCompanies ?? [],
          pattern,
        }),
      );
    }
    const emailFor = (c: { linkedinUrl: string | null; name: string }) =>
      decided.get(c.linkedinUrl ?? c.name)!;



    // ---- 5. one transaction: the people and the charge -------------------
    //
    // Both or neither. Charging before the write means a crash on the way
    // home leaves the student billed for contacts they never received;
    // writing before the charge loses the charge. The database decides, and
    // `contact_sourcing_charge_needs_contacts` refuses the inconsistent state
    // even if this code one day forgets.
    // ---- the run, measured -------------------------------------------------
    // After every paid call (searches, the anchor, enrichment and the hidden
    // probe), so the totals are the whole provider cost. Counts, categories
    // and redacted ids only (see summarizeRun) - safe for the general log and
    // stored on the run below.
    const metrics = summarizeRun({
      pool: anchorEntry ? [...pooled.pool, anchorEntry] : pooled.pool,
      searches: [...pooled.searches, ...extraSearches],
      final: chosen,
      target: CONTACTS_PER_RUN,
      enrichmentCredits: enrichCredits,
      affinityEnabled,
    });
    console.info("[contact-sourcing:metrics]", JSON.stringify({ runId: run.id, mode, ...metrics }));

    const credits = creditsForOutcome({
      // Charged as the mode the SERVER agreed to, not the one the browser
      // asked for: a "fill" with no partial run to complete is the generate
      // it actually is, and is charged like one.
      mode: chargeModeFor(mode, decision),
      contactsCreated: fresh.length,
      outcome: "succeeded",
    });

    const saved = await db.transaction(async (tx) => {
      const rows = fresh.length
        ? await tx
            .insert(contacts)
            .values(
              fresh.map(({ contact, affinity, record }) => ({
                userId: user.id,
                name: contact.name,
                firm: plan.firm.name,
                role: contact.title,
                linkedinUrl: contact.linkedinUrl,
                // Only what survived the gate reaches the user-facing column.
                email: emailFor(contact).email,
                emailConfidence: emailFor(contact).emailConfidence,
                emailDomainRelevant: emailFor(contact).emailDomainRelevant,
                emailSource: emailFor(contact).emailSource,
                // Diagnostics. Preserved, never rendered.
                emailRawProvider: emailFor(contact).rawProviderEmail,
                emailStatusRaw: emailFor(contact).providerStatus,
                emailRejectionReason: emailFor(contact).rejection,
                // The school they SHARE, not whichever the provider listed
                // first - a row reading "Saint Francis High School" next to a
                // memo saying "Also USC" is just confusing.
                school:
                  affinity.matches.find((m) => m.kind === "school")?.label ??
                  contact.schools?.[0] ??
                  null,
                // What makes one alum at this firm different from another.
                gradYear: contact.gradYear ?? null,
                currentCity: contact.currentCity ?? null,
                background: contact.headline,
                connectionAngle: affinity.memo || null,
                sourceUrl: contact.linkedinUrl,
                enrichedAt: new Date(),
                sourcingRunId: run.id,
                sourcingRank: record.rank,
                sourcingScore: record.score,
                sourcingRetrieval: record.retrieval,
              })),
            )
            .returning()
        : [];

      /**
       * The charge, from what was actually persisted inside THIS transaction.
       *
       * `rows.length`, not `fresh.length`: the only number that matters is
       * how many contacts exist after the write. `isChargeable` is the last
       * guard - it refuses a credit with nothing to show for it, which is the
       * same rule the table's check constraint enforces underneath.
       */
      const charge = isChargeable({ contactsPersisted: rows.length > 0, credits }) ? credits : 0;

      /**
       * A reused row already carries what this intent cost and produced.
       *
       * The charge may only ever go UP: a fill computes zero credits by
       * design, and writing that straight back would refund the generate it
       * is completing. The contact count accumulates for the same reason -
       * the row describes the intent, not the last attempt at it.
       */
      const priorCredits = reuseExisting?.creditsSpent ?? 0;
      const priorContacts = reuseExisting?.contactsCreated ?? 0;

      await tx
        .update(contactSourcingRuns)
        .set({
          status: "succeeded",
          contactsCreated: priorContacts + rows.length,
          creditsSpent: Math.max(priorCredits, charge) as 0 | 1,
          completedAt: new Date(),
          // A reused row (a fill) records its latest attempt's measurement.
          algorithmVersion: CONTACT_ALGORITHM_VERSION,
          metrics,
        })
        .where(eq(contactSourcingRuns.id, run.id));

      return rows;
    });

    const remaining = await getContactCredits(user.id);

    return {
      ok: true,
      status: "sourced",
      contacts: saved.map((row, i) => ({
        id: row.id,
        name: row.name,
        title: fresh[i].contact.title ?? null,
        linkedinUrl: fresh[i].contact.linkedinUrl,
        memo: fresh[i].affinity.memo,
        score: fresh[i].affinity.score,
        email: row.email ?? null,
        emailConfidence: (row.emailConfidence as ContactEmailConfidence) ?? "unavailable",
        emailDomainRelevant: row.emailDomainRelevant,
      })),
      creditsUsed: metrics.providerCredits,
      totalMatching: sourced.totalCount,
      summary: plan.summary,
      willRequest: plan.query.limit,
      hasResume: plan.dossier.resume.present,
      hasLinkedin: !!plan.dossier.linkedinUrl,
      missing: plan.missing,
      ...(isInternalAccount(user.email) ? { query: plan.query, metrics } : {}),
      resumeRead: {
        interests: plan.dossier.resume.interests,
        employers: plan.dossier.resume.employers,
        activities: plan.dossier.resume.activities,
        skills: plan.dossier.resume.skills,
      },
      consent: plan.dossier.consent,
      credits: {
        used: remaining.used,
        limit: remaining.limit,
        remaining: remaining.unlimited ? -1 : remaining.remaining,
        unlimited: remaining.unlimited,
      },
      // The firm cards show a contact count, and it just changed.
      revalidate: saved.length ? ["/dashboard", `/discovery/firm/${plan.firm.slug}`] : [],
      decision: "run",
    };
  } catch (err) {
    if (isExpectedSourcingError(err)) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    throw err;
  }
}

/**
 * A click that costs nothing: a repeat, or one that lost the race.
 *
 * Reads the saved set straight out of `contacts` and returns it. No identity
 * resolution, no search, no enrichment - the point of the cache is that the
 * provider is never reached, not that it is reached more cheaply.
 */
async function servedWithoutRunning(
  db: Db,
  user: SourcingActor,
  firmId: string,
  action: "serve_cached" | "join_in_flight",
): Promise<GenerateContactsResult> {
  const firm = await db.query.firms.findFirst({
    where: eq(firms.id, firmId),
    columns: { name: true },
  });
  const rows = juniorFirst(firm ? await savedContactsFor(db, user.id, firm.name) : [], (row) => row.role);
  const credits = await getContactCredits(user.id);

  return {
    ok: true,
    status: action === "serve_cached" ? "cached" : "in_progress",
    contacts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      title: row.role,
      linkedinUrl: row.linkedinUrl,
      memo: row.connectionAngle ?? "",
      score: 0,
      email: row.email ?? null,
      emailConfidence: (row.emailConfidence as ContactEmailConfidence) ?? "unavailable",
      emailDomainRelevant: row.emailDomainRelevant,
    })),
    creditsUsed: 0,
    totalMatching: rows.length,
    summary:
      action === "serve_cached"
        ? "Showing the contacts already generated for this firm."
        : "Still generating - this request joined one already in progress.",
    willRequest: 0,
    hasResume: false,
    hasLinkedin: false,
    missing: [],
    resumeRead: { interests: [], employers: [], activities: [], skills: [] },
    consent: { shareHometown: false, shareInterests: false },
    credits: {
      used: credits.used,
      limit: credits.limit,
      remaining: credits.unlimited ? -1 : credits.remaining,
      unlimited: credits.unlimited,
    },
    revalidate: [],
    decision: action,
  };
}
