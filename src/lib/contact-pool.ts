/**
 * Contact generation in two stages: retrieve a bounded candidate POOL, then
 * rank the WHOLE pool and select the final five.
 *
 * It replaces "accumulate until five slots are full, show them in the order
 * found". That design had search-order bias: whichever search ran first and
 * returned five mediocre people decided the result, and nothing found later
 * could compete. Here retrieval only gathers; selection is a separate step
 * that sees everyone.
 *
 *   1. Baseline - the existing ladder (lib/contact-tiers), with its school-first
 *      rule, employment check, complete-name rule and deduplication, filling
 *      its own quota of the pool.
 *   2. Affinity - up to a few searches, one per strong student signal (a
 *      specific club, then hometown, a niche interest, coverage), validated by
 *      exactly the same rules. A person found by both keeps both provenances.
 *   3. Rank everyone on a composite score, school first, and take five.
 *
 * WHAT A KEYWORD SEARCH PROVES. Nothing about the person. A profile returned by
 * a "TIS" query is not evidence that the person was in TIS - the provider does
 * not tell us which field matched, or whether it matched at all (questions
 * open with Crustdata; see lib/contact-search-provider). So retrieval is kept
 * as `RetrievalProvenance`, a HINT that nudges the ranking a capped amount,
 * and never becomes a displayed "you were both in TIS". Only structured fields
 * the provider actually returned can become evidence.
 *
 * Pure apart from the injected searches: no network, no database.
 */

import {
  compareContact,
  type ReturnedContact,
  type Similarity,
  type SimilarityKind,
  type StudentProfile,
} from "@/lib/contact-similarity";
import { seniorityLevel } from "@/lib/contact-seniority";
import {
  accumulateAcrossTiers,
  identityKeys,
  validateAndDeduplicate,
  type Accepted,
  type Tier,
  type TierCandidate,
} from "@/lib/contact-tiers";
import type { SelectedFirmIdentity } from "@/lib/employment";

// ---------------------------------------------------------------- config

/**
 * Which contact-generation algorithm produced a run, stored on the run and in
 * its metrics so outcomes can be compared across versions. Bump it when the
 * retrieval or ranking changes in a way that should be measured separately.
 */
export const CONTACT_ALGORITHM_VERSION = "pool-v1-2026-10-08";

export type PoolConfig = {
  /** How many people the baseline asks its first rung for - its pool quota. */
  baselineTarget: number;
  /**
   * The ladder widens past its first rung only while it holds fewer than
   * this - the final five. Typically that makes the baseline ONE search; a
   * thin firm still walks the ladder as before.
   */
  baselineMinimum: number;
  /** The whole pool, baseline and affinity together, never exceeds this. */
  poolMax: number;
  /** Affinity searches per run, at most. */
  maxAffinitySearches: number;
  /** Results requested from each affinity search. */
  affinityResultsPerSearch: number;
};

/**
 * 12 + up to 3 x 5 affinity results, capped at 20. The baseline quota sits
 * below the cap on purpose: it guarantees room for affinity candidates, and
 * running the baseline first guarantees affinity can never crowd it out.
 */
export const DEFAULT_POOL_CONFIG: PoolConfig = {
  baselineTarget: 12,
  baselineMinimum: 5,
  poolMax: 20,
  maxAffinitySearches: 3,
  affinityResultsPerSearch: 5,
};

// ---------------------------------------------------------------- signals

/** Strongest first - the order affinity searches are spent in. */
export const SIGNAL_PRIORITY = ["club", "prior_employer", "hometown", "interest", "coverage"] as const;
export type SignalCategory = (typeof SIGNAL_PRIORITY)[number];

export type AffinitySignal = {
  /** Redacted: category and index ("club:1"). Safe to log. */
  id: string;
  category: SignalCategory;
  /** The spellings searched together. In memory only - never logged. */
  terms: string[];
};

/**
 * Words too common to find anyone in particular. A search for "travel" at a
 * bank returns the bank. Data, not logic - extend freely.
 */
const GENERIC_TERMS = new Set(
  [
    "travel", "traveling", "travelling", "hiking", "sports", "sport", "finance", "investing", "investment",
    "investments", "technology", "tech", "business", "economics", "markets", "stocks", "reading", "music",
    "fitness", "gym", "working out", "running", "cooking", "food", "movies", "film", "photography", "art",
    "gaming", "video games", "coffee", "networking", "volunteering", "leadership",
  ].map((t) => t.toLowerCase()),
);

export function isGenericTerm(term: string): boolean {
  return GENERIC_TERMS.has(term.trim().toLowerCase().replace(/\s+/g, " "));
}

/**
 * The signals to search on, one search's worth each, deterministic.
 *
 * Two passes, so one category cannot take every search: the first takes at
 * most one usable signal per category in SIGNAL_PRIORITY order (the first one
 * the student listed - nothing here measures how distinctive a term is); the
 * second fills any remaining capacity with further signals, again in priority
 * order. Aliases of one club arrive as one group (lib/club-signals
 * clubGroups) and stay one signal. Generic terms are dropped before either
 * pass. Prior employer is skipped while it is unknown whether the provider can
 * search past employers (`priorEmployerSupported`).
 */
export function buildAffinitySignals(
  input: {
    clubGroups: string[][];
    priorEmployers: string[];
    hometown: string | null;
    interests: string[];
    coverage: string[];
  },
  options: {
    max?: number;
    priorEmployerSupported?: boolean;
    /**
     * Categories the provider is known (or assumed) to search as free text -
     * CRUSTDATA_CAPABILITIES.searchableCategories. Others are never spent on.
     */
    categories?: readonly SignalCategory[];
  } = {},
): AffinitySignal[] {
  const max = options.max ?? DEFAULT_POOL_CONFIG.maxAffinitySearches;
  const allowed = new Set<SignalCategory>(options.categories ?? SIGNAL_PRIORITY);
  const keep = (terms: string[]) => terms.map((t) => t.trim()).filter((t) => t && !isGenericTerm(t));
  const raw: Record<SignalCategory, string[][]> = {
    club: input.clubGroups,
    prior_employer: options.priorEmployerSupported ? input.priorEmployers.map((e) => [e]) : [],
    hometown: input.hometown ? [[input.hometown]] : [],
    interest: input.interests.map((i) => [i]),
    coverage: input.coverage.map((c) => [c]),
  };

  // Usable groups per category, in the student's order, with any spelling
  // already claimed by an earlier group removed.
  const seen = new Set<string>();
  const queue: Record<SignalCategory, string[][]> = { club: [], prior_employer: [], hometown: [], interest: [], coverage: [] };
  for (const category of SIGNAL_PRIORITY) {
    if (!allowed.has(category)) continue;
    for (const terms of raw[category]) {
      const fresh = keep(terms).filter((t) => !seen.has(t.toLowerCase()));
      if (!fresh.length) continue;
      for (const t of fresh) seen.add(t.toLowerCase());
      queue[category].push(fresh);
    }
  }

  const out: AffinitySignal[] = [];
  const counts: Record<SignalCategory, number> = { club: 0, prior_employer: 0, hometown: 0, interest: 0, coverage: 0 };
  const take = (category: SignalCategory) => {
    const terms = queue[category].shift();
    if (!terms) return false;
    out.push({ id: `${category}:${++counts[category]}`, category, terms });
    return true;
  };
  // Pass 1: breadth - one per category.
  for (const category of SIGNAL_PRIORITY) {
    if (out.length >= max) return out;
    take(category);
  }
  // Pass 2: depth - whatever is left, in priority order.
  for (const category of SIGNAL_PRIORITY) {
    while (out.length < max && take(category)) {
      /* fill */
    }
  }
  return out;
}

// ---------------------------------------------------------------- the pool

/** How one candidate was found. Internal: a hint, never evidence. */
export type RetrievalProvenance = {
  /** "anchor" is the verified-email schoolmate search (contact-sourcing-run). */
  searchType: "baseline" | "affinity" | "anchor";
  signalCategory: SignalCategory | null;
  signalId: string | null;
  /** The searched spellings. In memory only; summarizeRun never emits them. */
  signalTerms: string[] | null;
  /** The ladder rung, or "affinity". */
  tier: string;
  /** 0-based position in the provider's page. */
  providerPosition: number;
  /** What the search that returned them cost, in provider credits. */
  searchCredits: number;
};

export type PoolCandidate<T extends TierCandidate> = Accepted<T> & { provenance: RetrievalProvenance[] };

export type SearchLog = {
  /** "pattern_probe" pages are the hidden email-pattern search: never saved, still paid for. */
  searchType: "baseline" | "affinity" | "anchor" | "pattern_probe";
  signalCategory: SignalCategory | null;
  signalId: string | null;
  tier: string;
  requested: number;
  returned: number;
  accepted: number;
  /** Already in the pool: their provenance gained a hint instead. */
  duplicates: number;
  rejected: Record<string, number>;
  credits: number;
};

type SearchPage<T> = { contacts: T[]; creditsUsed: number };

export async function buildCandidatePool<T extends TierCandidate>(options: {
  firm: SelectedFirmIdentity;
  now?: Date;
  schoolNames?: string[];
  excluded?: Set<string>;
  baselineTiers: Tier[];
  signals: AffinitySignal[];
  config?: PoolConfig;
  /** Asked before every search: may this one be paid for? */
  canAfford?: (kind: "baseline" | "affinity", limit: number) => boolean;
  baselineSearch: (tier: Tier, limit: number) => Promise<SearchPage<T>>;
  affinitySearch: (signal: AffinitySignal, limit: number) => Promise<SearchPage<T>>;
}): Promise<{
  pool: PoolCandidate<T>[];
  searches: SearchLog[];
  partial: boolean;
  stoppedAtSchool: boolean;
  stoppedByBudget: boolean;
}> {
  const config = options.config ?? DEFAULT_POOL_CONFIG;
  const searches: SearchLog[] = [];

  // ---- 1. baseline: the existing ladder, filling its own quota
  const stamped = new Map<T, RetrievalProvenance>();
  const baselineCredits: number[] = [];
  const baseline = await accumulateAcrossTiers<T>({
    tiers: options.baselineTiers,
    firm: options.firm,
    includeIncoming: false,
    now: options.now,
    excluded: options.excluded,
    schoolNames: options.schoolNames,
    requireCompleteName: true,
    max: Math.min(config.baselineTarget, config.poolMax),
    enough: config.baselineMinimum,
    canAfford: options.canAfford ? (limit) => options.canAfford!("baseline", limit) : undefined,
    search: async (tier, limit) => {
      const page = await options.baselineSearch(tier, limit);
      baselineCredits.push(page.creditsUsed);
      page.contacts.forEach((c, i) =>
        stamped.set(c, {
          searchType: "baseline",
          signalCategory: null,
          signalId: null,
          signalTerms: null,
          tier: tier.label,
          providerPosition: i,
          searchCredits: page.creditsUsed,
        }),
      );
      return page.contacts;
    },
  });
  baseline.tiers.forEach((run, i) =>
    searches.push({
      searchType: "baseline",
      signalCategory: null,
      signalId: null,
      tier: run.tier,
      requested: run.requested,
      returned: run.returned,
      accepted: run.accepted,
      duplicates: run.rejected.DUPLICATE ?? 0,
      rejected: run.rejected,
      credits: baselineCredits[i] ?? 0,
    }),
  );

  const pool: PoolCandidate<T>[] = baseline.contacts.map((a) => ({ ...a, provenance: [stamped.get(a.contact)!].filter(Boolean) }));
  const byKey = new Map<string, PoolCandidate<T>>();
  const seen = new Set<string>();
  for (const entry of pool) {
    for (const k of identityKeys(entry.contact)) {
      byKey.set(k, entry);
      seen.add(k);
    }
  }

  // ---- 2. affinity: a few searches on the strongest signals
  const school = options.schoolNames?.length ? new Set(options.schoolNames.map((n) => n.trim().toLowerCase())) : undefined;
  let stoppedByBudget = !!baseline.stoppedByBudget;
  for (const signal of options.signals.slice(0, config.maxAffinitySearches)) {
    const room = config.poolMax - pool.length;
    if (room <= 0) break;
    const limit = config.affinityResultsPerSearch;
    if (options.canAfford && !options.canAfford("affinity", limit)) {
      stoppedByBudget = true;
      break;
    }
    const page = await options.affinitySearch(signal, limit);
    const hint = (i: number): RetrievalProvenance => ({
      searchType: "affinity",
      signalCategory: signal.category,
      signalId: signal.id,
      signalTerms: signal.terms,
      tier: "affinity",
      providerPosition: i,
      searchCredits: page.creditsUsed,
    });
    const position = new Map(page.contacts.map((c, i) => [c, i]));

    const { accepted, rejected } = validateAndDeduplicate(page.contacts, {
      firm: options.firm,
      includeIncoming: false,
      seen,
      excluded: options.excluded,
      now: options.now,
      requireSchool: school,
      requireCompleteName: true,
    });

    let duplicates = 0;
    for (const r of rejected) {
      if (r.reason !== "DUPLICATE") continue;
      const held = identityKeys(r.contact).map((k) => byKey.get(k)).find(Boolean);
      if (held) {
        held.provenance.push(hint(position.get(r.contact) ?? -1));
        duplicates++;
      }
    }
    const admitted = accepted.slice(0, room);
    for (const a of admitted) {
      const entry: PoolCandidate<T> = { ...a, provenance: [hint(position.get(a.contact) ?? -1)] };
      pool.push(entry);
      for (const k of identityKeys(a.contact)) byKey.set(k, entry);
    }

    const counts: Record<string, number> = {};
    for (const r of rejected) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
    searches.push({
      searchType: "affinity",
      signalCategory: signal.category,
      signalId: signal.id,
      tier: "affinity",
      requested: limit,
      returned: page.contacts.length,
      accepted: admitted.length,
      duplicates,
      rejected: counts,
      credits: page.creditsUsed,
    });
  }

  return {
    pool,
    searches,
    partial: baseline.partial,
    stoppedAtSchool: baseline.stoppedAtSchool,
    stoppedByBudget,
  };
}

// ---------------------------------------------------------------- scoring

/**
 * Relative points, not probabilities. Offerly has no reply data yet, so these
 * are judgement, named so a test can read them and a later change can tune
 * them against outcomes. Keep them small integers; the breakdown is meant to
 * be readable.
 */
export const SCORE_WEIGHTS = {
  /** Title names one of the seat's target titles. */
  roleMatch: 6,
  /** No title at all: unknown, not wrong. */
  roleUnknown: 3,
  /** By seniorityLevel 0 (intern) .. 5 (MD). A judgement that junior people answer students more. */
  reachabilityByLevel: [5, 6, 5, 3, 1, 0] as const,
  /**
   * Graduated within this many years. A small heuristic - recent graduates
   * were recently recruited themselves - not a measured response rate. The
   * provider's `has_business_email` flag is deliberately NOT scored: it is
   * documented as unreliable (crustdata-client), and nothing returned by the
   * search verifies it.
   */
  recentGraduateYears: 8,
  recentGraduate: 1,
  /** Per distinct affinity search that returned them... */
  retrievalHintPerSignal: 1,
} as const;

/** ...and never more than this, whatever the searches say. */
export const RETRIEVAL_HINT_CAP = 2;

/** Similarity fields the Crustdata parser never fills - always unknown today. */
export type UnknownSignal = "club" | "interest" | "hometown" | "major";

/**
 * Per similarity component, why it did or did not count:
 *  - matched          both sides known and they agree (it is in `evidence`)
 *  - no_match         both sides known and they differ
 *  - unavailable      the provider returned nothing for this person
 *  - student_missing  the student has not given us this
 */
export type SignalStatus = "matched" | "no_match" | "unavailable" | "student_missing";

export type ScoreBreakdown = {
  roleRelevance: number;
  /** From structured fields the provider returned - compareContact. */
  verifiedSimilarity: number;
  reachability: number;
  /** Small heuristic: graduated recently. Not a measured response rate. */
  recentGraduate: number;
  /** Capped. Retrieval only - see the note at the top of this file. */
  retrievalHint: number;
  total: number;
  /** The overlaps that may be shown. Never built from provenance. */
  evidence: Similarity[];
  memo: string;
  /** Fields the provider never returns, so these overlaps cannot be checked. */
  unknownSignals: UnknownSignal[];
  /** Every similarity component, with why it did or did not count. */
  signalStatus: Record<SimilarityKind, SignalStatus>;
};

/** null/undefined = not returned. An empty list or any value is known. */
function isMissing(value: unknown): boolean {
  return value == null;
}

/**
 * Which provider field each similarity component reads. The audit of what
 * Crustdata returns today (crustdata-client fromCrustdataProfile):
 *   available:   school(s), cohort (education end year), school city, current
 *                city, prior employer (past employment names)
 *   unavailable: club, interest, hometown, major - mapped to null
 * A profile can still lack an available field (no end year, say): that is
 * "unavailable" for that person, never "no_match".
 */
const PROVIDER_FIELD: Record<SimilarityKind, (c: ReturnedContact) => unknown> = {
  school: (c) => (c.school == null && c.schools == null ? null : [c.school, ...(c.schools ?? [])].filter(Boolean)),
  cohort: (c) => c.gradYear,
  club: (c) => c.clubs,
  hometown: (c) => c.hometown,
  school_city: (c) => c.schoolCities,
  city: (c) => c.currentCity,
  employer: (c) => c.previousCompanies,
  major: (c) => c.major,
  interest: (c) => c.interests,
};

const STUDENT_FIELD: Record<SimilarityKind, (s: StudentProfile) => unknown> = {
  school: (s) => s.school ?? (s.schoolNames?.length ? s.schoolNames : null),
  cohort: (s) => s.gradYear,
  club: (s) => (s.clubs?.length ? s.clubs : null),
  hometown: (s) => s.hometown,
  school_city: (s) => (s.targetCities?.length ? s.targetCities : null),
  city: (s) => (s.targetCities?.length ? s.targetCities : null),
  employer: (s) => (s.priorEmployers?.length ? s.priorEmployers : null),
  major: (s) => s.major,
  interest: (s) => (s.interests?.length ? s.interests : null),
};

function similarityStatus(
  student: StudentProfile,
  contact: ReturnedContact,
  matches: Similarity[],
): Record<SimilarityKind, SignalStatus> {
  const matched = new Set(matches.map((m) => m.kind));
  const out = {} as Record<SimilarityKind, SignalStatus>;
  for (const kind of Object.keys(PROVIDER_FIELD) as SimilarityKind[]) {
    const theirs = PROVIDER_FIELD[kind](contact);
    out[kind] = matched.has(kind)
      ? "matched"
      : isMissing(STUDENT_FIELD[kind](student))
        ? "student_missing"
        : isMissing(theirs)
          ? "unavailable"
          : "no_match";
  }
  return out;
}

export type ScorableContact = TierCandidate & ReturnedContact;

export function scoreCandidate<T extends ScorableContact>(input: {
  student: StudentProfile;
  targetTitles: string[];
  now: Date;
  candidate: PoolCandidate<T>;
}): ScoreBreakdown {
  const { contact, provenance } = input.candidate;
  const W = SCORE_WEIGHTS;

  const title = (contact.title ?? "").trim();
  const roleRelevance = !title
    ? W.roleUnknown
    : input.targetTitles.some((t) => t && title.toLowerCase().includes(t.toLowerCase()))
      ? W.roleMatch
      : 0;

  const affinity = compareContact({ student: input.student, contact });

  const reachability = W.reachabilityByLevel[seniorityLevel(contact.title)] ?? 0;

  const yearsOut = contact.gradYear ? input.now.getFullYear() - contact.gradYear : null;
  const recentGraduate = yearsOut != null && yearsOut >= 0 && yearsOut <= W.recentGraduateYears ? W.recentGraduate : 0;

  const hintedSignals = new Set(provenance.filter((p) => p.searchType === "affinity").map((p) => p.signalId));
  const retrievalHint = Math.min(hintedSignals.size * W.retrievalHintPerSignal, RETRIEVAL_HINT_CAP);

  const signalStatus = similarityStatus(input.student, contact, affinity.matches);
  const unknownSignals = (["club", "interest", "hometown", "major"] as const).filter((k) =>
    isMissing(PROVIDER_FIELD[k](contact)),
  );

  return {
    roleRelevance,
    verifiedSimilarity: affinity.score,
    reachability,
    recentGraduate,
    retrievalHint,
    total: roleRelevance + affinity.score + reachability + recentGraduate + retrievalHint,
    evidence: affinity.matches,
    memo: affinity.memo,
    unknownSignals,
    signalStatus,
  };
}

export type Ranked<T extends TierCandidate> = { candidate: PoolCandidate<T>; score: ScoreBreakdown };

/**
 * Highest total first. Ties keep pool order - baseline before affinity, then
 * the order each search returned people in. That order is used only to make
 * the result deterministic: nothing here assumes the provider's results are
 * relevance-ranked (CRUSTDATA_CAPABILITIES.resultsRelevanceRanked).
 */
export function rankPool<T extends ScorableContact>(input: {
  student: StudentProfile;
  targetTitles: string[];
  now: Date;
  pool: PoolCandidate<T>[];
}): Ranked<T>[] {
  return input.pool
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate({ ...input, candidate }) }))
    .sort((a, b) => b.score.total - a.score.total || a.index - b.index)
    .map(({ candidate, score }) => ({ candidate, score }));
}

/**
 * The final set. School first, as everywhere else in contact generation: a
 * contact from another school is shown only when the student's own school has
 * nobody left in the pool - however well they score. Within each group, by
 * score.
 */
export function selectFinal<T extends TierCandidate>(ranked: Ranked<T>[], n: number): Ranked<T>[] {
  const sameSchool = ranked.filter((r) => r.score.evidence.some((e) => e.kind === "school"));
  const others = ranked.filter((r) => !r.score.evidence.some((e) => e.kind === "school"));
  return [...sameSchool, ...others].slice(0, n);
}

// ---------------------------------------------------------------- measurement

/**
 * One run, measured - for comparing algorithm versions. Counts, categories
 * and redacted signal ids only: never a search term, a name, a club or a
 * hometown, so it may be logged and stored on the run.
 *
 * Credits are the provider's own `x-credits-used` figures as each call
 * reported them: `searchCredits` covers every person search (baseline,
 * affinity, the verified-email anchor and the hidden pattern probe's pages);
 * `enrichmentCredits` every email lookup (the five's and the probe's);
 * `providerCredits` is their sum - the run's whole provider cost.
 */
export type RunMetrics = {
  algorithmVersion: string;
  affinityEnabled: boolean;
  searches: SearchLog[];
  /** Everyone ranked: the pool plus the anchor, when there was one. */
  poolSize: number;
  uniqueCandidates: number;
  selected: number;
  affinitySelected: number;
  anchorSelected: boolean;
  zeroResult: boolean;
  partial: boolean;
  /** By search type, so the cost of each strategy can be read on its own. */
  baselineSearchCredits: number;
  affinitySearchCredits: number;
  anchorSearchCredits: number;
  probeSearchCredits: number;
  /** All person searches: the four above. */
  searchCredits: number;
  enrichmentCredits: number;
  /** Searches plus enrichment: the run's whole provider cost. */
  providerCredits: number;
  final: (SourcingRecord["score"] & SourcingRecord["retrieval"] & { rank: number })[];
};

const round = (n: number) => Math.round(n * 1000) / 1000;

export function summarizeRun<T extends TierCandidate>(input: {
  /** Every ranked candidate, the anchor included. */
  pool: PoolCandidate<T>[];
  searches: SearchLog[];
  final: Ranked<T>[];
  target: number;
  enrichmentCredits: number;
  affinityEnabled: boolean;
}): RunMetrics {
  const creditsFor = (type: SearchLog["searchType"]) =>
    round(input.searches.filter((s) => s.searchType === type).reduce((sum, s) => sum + s.credits, 0));
  const searchCredits = round(input.searches.reduce((sum, s) => sum + s.credits, 0));
  const enrichmentCredits = round(input.enrichmentCredits);
  return {
    algorithmVersion: CONTACT_ALGORITHM_VERSION,
    affinityEnabled: input.affinityEnabled,
    searches: input.searches.map((s) => ({ ...s, rejected: { ...s.rejected } })),
    poolSize: input.pool.length,
    uniqueCandidates: new Set(input.pool.map((c) => identityKeys(c.contact).join("|"))).size,
    selected: input.final.length,
    affinitySelected: input.final.filter((f) => f.candidate.provenance.some((p) => p.searchType === "affinity")).length,
    anchorSelected: input.final.some((f) => f.candidate.provenance.some((p) => p.searchType === "anchor")),
    zeroResult: input.pool.length === 0,
    partial: input.final.length < input.target,
    baselineSearchCredits: creditsFor("baseline"),
    affinitySearchCredits: creditsFor("affinity"),
    anchorSearchCredits: creditsFor("anchor"),
    probeSearchCredits: creditsFor("pattern_probe"),
    searchCredits,
    enrichmentCredits,
    providerCredits: round(searchCredits + enrichmentCredits),
    final: input.final.map((f, i) => {
      const record = sourcingRecord(f, i + 1);
      return { rank: record.rank, ...record.score, ...record.retrieval };
    }),
  };
}

/**
 * What is stored on a generated contact (contacts.sourcing_*): its rank, the
 * score breakdown and how it was found - numbers, kinds and categories only.
 * Evidence LABELS are left out on purpose: a label is the shared club or
 * hometown itself.
 */
export type SourcingRecord = {
  rank: number;
  score: {
    total: number;
    roleRelevance: number;
    verifiedSimilarity: number;
    reachability: number;
    recentGraduate: number;
    retrievalHint: number;
    evidenceKinds: SimilarityKind[];
    unknownSignals: UnknownSignal[];
    signalStatus: Record<SimilarityKind, SignalStatus>;
  };
  retrieval: {
    foundBy: RetrievalProvenance["searchType"][];
    hintCategories: SignalCategory[];
    tiers: string[];
  };
};

export function sourcingRecord<T extends TierCandidate>(entry: Ranked<T>, rank: number): SourcingRecord {
  const s = entry.score;
  const p = entry.candidate.provenance;
  return {
    rank,
    score: {
      total: s.total,
      roleRelevance: s.roleRelevance,
      verifiedSimilarity: s.verifiedSimilarity,
      reachability: s.reachability,
      recentGraduate: s.recentGraduate,
      retrievalHint: s.retrievalHint,
      evidenceKinds: [...new Set(s.evidence.map((e) => e.kind))],
      unknownSignals: s.unknownSignals,
      signalStatus: s.signalStatus,
    },
    retrieval: {
      foundBy: [...new Set(p.map((x) => x.searchType))],
      hintCategories: [...new Set(p.flatMap((x) => (x.searchType === "affinity" && x.signalCategory ? [x.signalCategory] : [])))],
      // Ladder rung labels are fixed strings ("same school, same city"), never student data.
      tiers: [...new Set(p.map((x) => x.tier))],
    },
  };
}
