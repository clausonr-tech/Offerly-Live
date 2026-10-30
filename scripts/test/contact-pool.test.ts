// Two-stage contact generation: retrieve a bounded pool, then rank the whole
// pool and select the final five. Offline - every search here is a fixture.
import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  CONTACT_ALGORITHM_VERSION,
  DEFAULT_POOL_CONFIG,
  RETRIEVAL_HINT_CAP,
  buildAffinitySignals,
  buildCandidatePool,
  isGenericTerm,
  rankPool,
  scoreCandidate,
  selectFinal,
  sourcingRecord,
  summarizeRun,
  type AffinitySignal,
  type PoolCandidate,
} from "@/lib/contact-pool";
import { DEFAULT_TIERS, type TierCandidate } from "@/lib/contact-tiers";
import { clubGroups } from "@/lib/club-signals";
import type { StudentProfile } from "@/lib/contact-similarity";

const FIRM = { crustdataCompanyId: 682795 };
const NOW = new Date("2026-10-08T00:00:00Z");
const PENN = "University of Pennsylvania";

type Candidate = TierCandidate & {
  title?: string | null;
  gradYear?: number | null;
  currentCity?: string | null;
  previousCompanies?: string[] | null;
  clubs?: string[] | null;
  interests?: string[] | null;
  hometown?: string | null;
  major?: string | null;
  hasBusinessEmail?: boolean;
};

let nextId = 1;
/** Letters only: a surname with digits fails the complete-name rule. */
const letters = (n: number): string => (n > 26 ? letters(Math.floor((n - 1) / 26)) : "") + String.fromCharCode(97 + ((n - 1) % 26));
function person(over: Partial<Candidate> = {}): Candidate {
  const id = nextId++;
  return {
    crustdataPersonId: id,
    linkedinUrl: `https://www.linkedin.com/in/person-${id}`,
    name: `Pat Person${letters(id)}`,
    title: "Investment Banking Analyst",
    schools: [PENN],
    employment: { current: [{ companyId: 682795, name: "Evercore" }], past: [] },
    clubs: null,
    interests: null,
    hometown: null,
    ...over,
  };
}

const student: StudentProfile = {
  school: PENN,
  schoolNames: [PENN],
  gradYear: 2028,
  major: "Finance",
  targetCities: ["New York"],
  hometown: "Boise, Idaho",
  clubs: ["Wharton Investment Club"],
  interests: ["poker", "college football"],
  priorEmployers: ["Lazard"],
};

const club: AffinitySignal = { id: "club:1", category: "club", terms: ["Trojan Investing Society", "TIS"] };
const hometown: AffinitySignal = { id: "hometown:1", category: "hometown", terms: ["Boise, Idaho"] };

const free = () => true;
const page = (contacts: Candidate[], creditsUsed = 0.15) => Promise.resolve({ contacts, creditsUsed });

// ------------------------------------------------------------- signals

test("generic terms are dropped and aliases of one club are one signal", () => {
  for (const t of ["Travel", "hiking", "Sports", "finance", "Investing", "technology"]) {
    assert.ok(isGenericTerm(t), `${t} should be generic`);
  }
  const signals = buildAffinitySignals({
    clubGroups: clubGroups({ offerly: "Trojan Investing Society, TIS" }),
    priorEmployers: [],
    hometown: null,
    interests: ["travel", "hiking"],
    coverage: ["Technology"],
  });
  assert.equal(signals.length, 1, "TIS and its full name are one group; the generic terms are gone");
  assert.equal(signals[0].category, "club");
  assert.deepEqual(new Set(signals[0].terms), new Set(["Trojan Investing Society", "TIS"]));
});

test("several clubs cannot starve the hometown and niche-interest searches", () => {
  const signals = buildAffinitySignals(
    {
      clubGroups: [["Model United Nations", "MUN"], ["Wharton Investment Club"], ["Penn Rowing"]],
      priorEmployers: ["Lazard"],
      hometown: "Boise, Idaho",
      interests: ["competitive poker"],
      coverage: ["Healthcare"],
    },
    { max: 3, priorEmployerSupported: false },
  );
  assert.deepEqual(
    signals.map((s) => s.category),
    ["club", "hometown", "interest"],
    "first pass: one per category in priority order; prior employer skipped while the provider question is open",
  );
  assert.deepEqual(signals[0].terms, ["Model United Nations", "MUN"], "the first club listed, not a guess at the rarest");
  assert.ok(signals.every((s) => /^[a-z_]+:\d+$/.test(s.id)), "ids are redacted category indices");
});

test("spare capacity goes to further signals in priority order", () => {
  const signals = buildAffinitySignals(
    {
      clubGroups: [["Model United Nations", "MUN"], ["Wharton Investment Club"], ["Penn Rowing"]],
      priorEmployers: [],
      hometown: null,
      interests: ["travel"],
      coverage: ["Healthcare"],
    },
    { max: 3 },
  );
  assert.deepEqual(signals.map((s) => s.category), ["club", "coverage", "club"], "second pass fills with the next club");
  assert.deepEqual(signals[2].terms, ["Wharton Investment Club"]);
});

// ------------------------------------------------------------- the pool

test("a full affinity search cannot keep baseline candidates out of the pool", async () => {
  const baselinePeople = Array.from({ length: 12 }, () => person());
  const r = await buildCandidatePool<Candidate>({
    firm: FIRM,
    now: NOW,
    schoolNames: [PENN],
    baselineTiers: DEFAULT_TIERS,
    signals: [club, hometown],
    canAfford: free,
    baselineSearch: (_t, limit) => page(baselinePeople.splice(0, limit)),
    affinitySearch: (_s, limit) => page(Array.from({ length: limit }, () => person())),
  });
  const baseline = r.pool.filter((c) => c.provenance.some((p) => p.searchType === "baseline"));
  assert.equal(baseline.length, DEFAULT_POOL_CONFIG.baselineTarget, "the baseline fills its own quota");
  assert.ok(r.pool.length <= DEFAULT_POOL_CONFIG.poolMax, "the pool cap is respected");
  assert.ok(r.pool.some((c) => c.provenance.some((p) => p.searchType === "affinity")), "affinity still contributes");
});

test("candidates found by several searches are one pool entry carrying every provenance", async () => {
  const shared = person({ name: "Alex Shared" });
  const r = await buildCandidatePool<Candidate>({
    firm: FIRM,
    now: NOW,
    schoolNames: [PENN],
    baselineTiers: DEFAULT_TIERS.slice(0, 1),
    signals: [club],
    canAfford: free,
    baselineSearch: () => page([shared, person()]),
    affinitySearch: () => page([{ ...shared }, person()]),
  });
  const entries = r.pool.filter((c) => c.contact.crustdataPersonId === shared.crustdataPersonId);
  assert.equal(entries.length, 1, "deduplicated");
  assert.deepEqual(entries[0].provenance.map((p) => p.searchType).sort(), ["affinity", "baseline"]);
  const hint = entries[0].provenance.find((p) => p.searchType === "affinity")!;
  assert.equal(hint.signalCategory, "club");
  assert.equal(typeof hint.providerPosition, "number");
  assert.equal(hint.searchCredits, 0.15);
});

test("employment, school, complete-name and exclusion checks still guard the pool", async () => {
  const elsewhere = person({ employment: { current: [{ companyId: 1, name: "Lazard" }], past: [] } });
  const otherSchool = person({ schools: ["Penn State"] });
  const initialOnly = person({ name: "Simran S." });
  const excluded = person();
  const ok = person();
  const r = await buildCandidatePool<Candidate>({
    firm: FIRM,
    now: NOW,
    schoolNames: [PENN],
    excluded: new Set([`id:${excluded.crustdataPersonId}`]),
    baselineTiers: DEFAULT_TIERS.slice(0, 1),
    signals: [club],
    canAfford: free,
    baselineSearch: () => page([ok]),
    affinitySearch: () => page([elsewhere, otherSchool, initialOnly, excluded]),
  });
  assert.deepEqual(r.pool.map((c) => c.contact.crustdataPersonId), [ok.crustdataPersonId]);
  const log = r.searches.find((s) => s.searchType === "affinity")!;
  assert.equal(log.accepted, 0);
  assert.ok(log.rejected.EMPLOYMENT_UNCONFIRMED && log.rejected.WRONG_SCHOOL && log.rejected.INCOMPLETE_NAME && log.rejected.EXCLUDED);
});

test("affinity searches respect the search count, the pool cap and the credit budget", async () => {
  const signals: AffinitySignal[] = Array.from({ length: 6 }, (_, i) => ({ id: `club:${i + 1}`, category: "club", terms: [`Club ${i}`] }));
  let affinityCalls = 0;
  const capped = await buildCandidatePool<Candidate>({
    firm: FIRM,
    now: NOW,
    schoolNames: [PENN],
    baselineTiers: DEFAULT_TIERS.slice(0, 1),
    signals,
    canAfford: free,
    baselineSearch: () => page([]),
    affinitySearch: (_s, limit) => {
      affinityCalls++;
      return page(Array.from({ length: limit }, () => person()));
    },
  });
  assert.equal(affinityCalls, DEFAULT_POOL_CONFIG.maxAffinitySearches);
  assert.ok(capped.pool.length <= DEFAULT_POOL_CONFIG.poolMax);

  let budgetCalls = 0;
  const broke = await buildCandidatePool<Candidate>({
    firm: FIRM,
    now: NOW,
    schoolNames: [PENN],
    baselineTiers: DEFAULT_TIERS.slice(0, 1),
    signals,
    canAfford: (kind) => kind === "baseline",
    baselineSearch: () => page([person()]),
    affinitySearch: () => {
      budgetCalls++;
      return page([person()]);
    },
  });
  assert.equal(budgetCalls, 0, "no affinity search runs once the budget says no");
  assert.equal(broke.stoppedByBudget, true);
});

// ------------------------------------------------------------- ranking

const targetTitles = ["Investment Banking", "M&A"];
const asCandidate = (contact: Candidate, provenance: PoolCandidate<Candidate>["provenance"] = []) =>
  ({ contact, employmentStatus: "current", provenance }) as PoolCandidate<Candidate>;
const baselineHit = { searchType: "baseline", signalCategory: null, signalId: null, signalTerms: null, tier: "same school, same city", providerPosition: 0, searchCredits: 0.15 } as const;

test("a strong verified match outranks an unrelated junior contact", () => {
  const strong = asCandidate(person({ title: "Vice President, Investment Banking", gradYear: 2027, previousCompanies: ["Lazard"], currentCity: "New York" }), [baselineHit]);
  const unrelated = asCandidate(person({ title: "Analyst", schools: ["Somewhere Else"], gradYear: 2012 }), [baselineHit]);
  const [first] = rankPool({ student, targetTitles, now: NOW, pool: [unrelated, strong] });
  assert.equal(first.candidate, strong);
});

test("junior status still counts when everything else is equal", () => {
  const md = asCandidate(person({ title: "Managing Director, Investment Banking", gradYear: 2027 }), [baselineHit]);
  const analyst = asCandidate(person({ title: "Investment Banking Analyst", gradYear: 2027 }), [baselineHit]);
  const ranked = rankPool({ student, targetTitles, now: NOW, pool: [md, analyst] });
  assert.equal(ranked[0].candidate, analyst);
  assert.ok(ranked[0].score.reachability > ranked[1].score.reachability);
});

test("the retrieval hint is capped and cannot beat verified overlap", () => {
  const hints = Array.from({ length: 5 }, (_, i) => ({ ...baselineHit, searchType: "affinity" as const, signalCategory: "club" as const, signalId: `club:${i}`, signalTerms: ["X"] }));
  const hinted = asCandidate(person({ gradYear: 2015 }), hints);
  const verified = asCandidate(person({ gradYear: 2027, previousCompanies: ["Lazard"] }), [baselineHit]);
  const s = scoreCandidate({ student, targetTitles, now: NOW, candidate: hinted });
  assert.equal(s.retrievalHint, RETRIEVAL_HINT_CAP);
  const ranked = rankPool({ student, targetTitles, now: NOW, pool: [hinted, verified] });
  assert.equal(ranked[0].candidate, verified);
});

test("a keyword-query result never becomes a displayed shared connection without evidence", () => {
  const fromTis = asCandidate(person(), [{ ...baselineHit, searchType: "affinity", signalCategory: "club", signalId: "club:1", signalTerms: ["Trojan Investing Society", "TIS"] }]);
  const s = scoreCandidate({ student: { ...student, clubs: ["Trojan Investing Society"] }, targetTitles, now: NOW, candidate: fromTis });
  assert.ok(!s.evidence.some((e) => e.kind === "club"), "no club evidence");
  assert.ok(!/TIS|Trojan/.test(s.memo), "the memo says nothing about the club");
  assert.ok(s.retrievalHint > 0, "it may still nudge the ranking, as a hint");
});

test("missing provider fields stay unknown rather than counting as no overlap", () => {
  const s = scoreCandidate({ student, targetTitles, now: NOW, candidate: asCandidate(person(), [baselineHit]) });
  assert.deepEqual([...s.unknownSignals].sort(), ["club", "hometown", "interest", "major"]);
  assert.equal(s.signalStatus.club, "unavailable", "the provider returned no clubs");
  assert.equal(s.signalStatus.major, "unavailable", "the parser never fills major");
  assert.equal(s.signalStatus.school, "matched");
  assert.equal(s.signalStatus.cohort, "unavailable", "this profile has no graduation year");
  const known = scoreCandidate({
    student,
    targetTitles,
    now: NOW,
    candidate: asCandidate(person({ clubs: [], interests: [], hometown: "Austin, Texas", major: "History" }), [baselineHit]),
  });
  assert.deepEqual(known.unknownSignals, [], "an empty list or a different hometown is known");
  assert.equal(known.signalStatus.hometown, "no_match", "known and different is not unknown");
  assert.equal(known.signalStatus.club, "no_match");
  const noStudentMajor = scoreCandidate({ student: { ...student, major: null }, targetTitles, now: NOW, candidate: asCandidate(person(), [baselineHit]) });
  assert.equal(noStudentMajor.signalStatus.major, "student_missing");
});

test("the final five come from ranking the whole pool, school first", () => {
  // Pool order is retrieval order; the strongest two arrive last.
  const pool = [
    ...Array.from({ length: 5 }, () => asCandidate(person({ title: "Analyst", gradYear: 2010 }), [baselineHit])),
    asCandidate(person({ gradYear: 2027, previousCompanies: ["Lazard"] }), [baselineHit]),
    asCandidate(person({ gradYear: 2028 }), [baselineHit]),
    asCandidate(person({ schools: ["Somewhere Else"], gradYear: 2028, previousCompanies: ["Lazard"] }), [baselineHit]),
  ];
  const ranked = rankPool({ student, targetTitles, now: NOW, pool });
  const final = selectFinal(ranked, 5);
  assert.equal(final.length, 5);
  assert.ok(final.includes(ranked.find((r) => r.candidate === pool[5])!), "a late, strong candidate is selected");
  assert.ok(!final.some((r) => r.candidate === pool[7]), "another school waits while same-school candidates remain");
  for (const r of final) assert.equal(typeof r.score.total, "number");
});

// ------------------------------------------------------------- measurement

test("run metrics carry counts and categories but never the private search terms", () => {
  const hinted = asCandidate(person(), [{ ...baselineHit, searchType: "affinity", signalCategory: "hometown", signalId: "hometown:1", signalTerms: ["Boise, Idaho"] }]);
  const ranked = rankPool({ student, targetTitles, now: NOW, pool: [hinted] });
  const metrics = summarizeRun({
    pool: [hinted],
    searches: [{ searchType: "affinity", signalCategory: "hometown", signalId: "hometown:1", tier: "affinity", requested: 5, returned: 1, accepted: 1, duplicates: 0, rejected: {}, credits: 0.15 }],
    final: selectFinal(ranked, 5),
    target: 5,
    enrichmentCredits: 1,
    affinityEnabled: true,
  });
  assert.equal(metrics.uniqueCandidates, 1);
  assert.equal(metrics.affinitySelected, 1);
  assert.equal(metrics.partial, true);
  assert.equal(metrics.zeroResult, false);
  assert.equal(metrics.searchCredits, 0.15);
  assert.equal(metrics.enrichmentCredits, 1);
  assert.equal(metrics.providerCredits, 1.15);
  assert.equal(metrics.algorithmVersion, CONTACT_ALGORITHM_VERSION);
  assert.ok(!JSON.stringify(metrics).includes("Boise"), "raw terms stay out of the metrics");
});

test("the baseline is one search when the first rung fills the five; a thin firm still widens", async () => {
  let calls = 0;
  await buildCandidatePool<Candidate>({
    firm: FIRM,
    now: NOW,
    schoolNames: [PENN],
    baselineTiers: DEFAULT_TIERS,
    signals: [],
    canAfford: free,
    baselineSearch: (_t, limit) => {
      calls++;
      return page(Array.from({ length: Math.min(limit, 7) }, () => person()));
    },
    affinitySearch: () => page([]),
  });
  assert.equal(calls, 1, "seven alumni on the first rung: no further widening");

  let thinCalls = 0;
  const thin = await buildCandidatePool<Candidate>({
    firm: FIRM,
    now: NOW,
    schoolNames: [PENN],
    baselineTiers: DEFAULT_TIERS,
    signals: [],
    canAfford: free,
    baselineSearch: () => {
      thinCalls++;
      return page(thinCalls <= 3 ? [person()] : []);
    },
    affinitySearch: () => page([]),
  });
  assert.ok(thinCalls > 3, "fewer than five: the ladder keeps widening");
  assert.equal(thin.pool.length, 3);
});

test("the provider's email flag does not move the score; recent graduation is a named heuristic", () => {
  const withFlag = scoreCandidate({ student, targetTitles, now: NOW, candidate: asCandidate(person({ gradYear: 2024, hasBusinessEmail: true }), [baselineHit]) });
  const without = scoreCandidate({ student, targetTitles, now: NOW, candidate: asCandidate(person({ gradYear: 2024, hasBusinessEmail: false }), [baselineHit]) });
  assert.equal(withFlag.total, without.total, "hasBusinessEmail is documented as unreliable and is not scored");
  assert.equal(withFlag.recentGraduate, 1);
  assert.ok(!("responseLikelihood" in withFlag), "no component claims to measure response likelihood");
});

test("the persisted record carries numbers and categories, never the searched terms or labels", () => {
  const hinted = asCandidate(person({ gradYear: 2027, hometown: "Boise, Idaho" }), [
    { ...baselineHit, searchType: "affinity", signalCategory: "hometown", signalId: "hometown:1", signalTerms: ["Boise, Idaho"] },
  ]);
  const [ranked] = rankPool({ student, targetTitles, now: NOW, pool: [hinted] });
  const record = sourcingRecord(ranked, 1);
  assert.equal(record.rank, 1);
  assert.equal(record.score.total, ranked.score.total);
  assert.ok(record.score.evidenceKinds.includes("hometown"));
  assert.deepEqual(record.retrieval.hintCategories, ["hometown"]);
  assert.ok(!JSON.stringify(record).includes("Boise"), "no hometown, club, interest or term text");
});

// ------------------------------------------------- provider-assumption guards

test("every affinity search can come back empty and the baseline still yields five", async () => {
  const r = await buildCandidatePool<Candidate>({
    firm: FIRM,
    now: NOW,
    schoolNames: [PENN],
    baselineTiers: DEFAULT_TIERS,
    signals: [club, hometown, { id: "interest:1", category: "interest", terms: ["competitive poker"] }],
    canAfford: free,
    baselineSearch: (_t, limit) => page(Array.from({ length: Math.min(limit, 6) }, () => person())),
    affinitySearch: () => page([]),
  });
  const ranked = rankPool({ student, targetTitles: ["Investment Banking"], now: NOW, pool: r.pool });
  assert.equal(selectFinal(ranked, 5).length, 5);
  assert.equal(r.searches.filter((s) => s.searchType === "affinity").length, 3, "each signal is its own search");
  assert.ok(r.searches.filter((s) => s.searchType === "affinity").every((s) => s.returned === 0));
});

test("categories the provider is not known to search are never spent on", () => {
  const signals = buildAffinitySignals(
    { clubGroups: [["Penn Rowing"]], priorEmployers: [], hometown: "Boise, Idaho", interests: ["competitive poker"], coverage: [] },
    { max: 3, categories: ["club", "interest"] },
  );
  assert.deepEqual(signals.map((s) => s.category), ["club", "interest"]);
});

test("run metrics report baseline, affinity, enrichment and total cost separately", () => {
  const log = (searchType: "baseline" | "affinity" | "anchor" | "pattern_probe", credits: number) =>
    ({ searchType, signalCategory: null, signalId: null, tier: "t", requested: 5, returned: 0, accepted: 0, duplicates: 0, rejected: {}, credits });
  const m = summarizeRun({
    pool: [],
    searches: [log("baseline", 0.36), log("affinity", 0.15), log("affinity", 0.15), log("anchor", 0.18), log("pattern_probe", 0.3)],
    final: [],
    target: 5,
    enrichmentCredits: 2,
    affinityEnabled: true,
  });
  assert.equal(m.baselineSearchCredits, 0.36);
  assert.equal(m.affinitySearchCredits, 0.3);
  assert.equal(m.anchorSearchCredits, 0.18);
  assert.equal(m.probeSearchCredits, 0.3);
  assert.equal(m.searchCredits, 1.14);
  assert.equal(m.enrichmentCredits, 2);
  assert.equal(m.providerCredits, 3.14);
});
