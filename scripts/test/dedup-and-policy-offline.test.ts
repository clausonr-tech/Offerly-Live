import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { isProbableDuplicate, type DuplicateFingerprint } from "@/lib/contact-tiers";
import {
  chargeModeFor,
  creditsForOutcome,
  decideServe,
  idempotencyKey,
  isChargeable,
  isStalePending,
  PENDING_STALE_MS,
  type CachedRun,
} from "@/lib/sourcing-run-policy";
import { parseEmploymentEvidence, evaluateEmployment } from "@/lib/employment";

const fp = (over: Partial<DuplicateFingerprint> = {}): DuplicateFingerprint => ({
  name: "John Smith",
  companyId: 682795,
  title: "Investment Banking Analyst",
  location: "New York City",
  schools: ["University of Southern California"],
  gradYear: 2024,
  ...over,
});

// ------------------------------------------------------------ deduplication

test("same name, DIFFERENT stable IDs: two genuinely different people", () => {
  const v = isProbableDuplicate(
    { crustdataPersonId: 1, linkedinUrl: "https://linkedin.com/in/a", fingerprint: fp() },
    { crustdataPersonId: 2, linkedinUrl: "https://linkedin.com/in/b", fingerprint: fp() },
  );
  assert.equal(v.duplicate, false);
  assert.equal(v.basis, "distinct");
});

test("same human, same ID, different URLs: one person", () => {
  const v = isProbableDuplicate(
    { crustdataPersonId: 7, linkedinUrl: "https://linkedin.com/in/tena-broyles-77570a28", fingerprint: fp() },
    { crustdataPersonId: 7, linkedinUrl: "https://linkedin.com/in/tena-broyles-4b522374", fingerprint: fp() },
  );
  assert.equal(v.duplicate, true);
  assert.equal(v.basis, "stable_id");
});

test("same human, NO IDs, strong fingerprint agreement: merged", () => {
  // The real Tena Broyles shape once ids are absent on both sides.
  const v = isProbableDuplicate(
    { crustdataPersonId: null, linkedinUrl: "https://linkedin.com/in/tena-broyles-77570a28", fingerprint: fp({ name: "Tena Broyles" }) },
    { crustdataPersonId: null, linkedinUrl: "https://linkedin.com/in/tena-broyles-4b522374", fingerprint: fp({ name: "Tena Broyles" }) },
  );
  assert.equal(v.duplicate, true);
  assert.equal(v.basis, "fingerprint");
  assert.ok(v.agreed.length >= 2);
});

test("same name and firm but different title, location and education: kept apart", () => {
  const v = isProbableDuplicate(
    { crustdataPersonId: null, linkedinUrl: "https://linkedin.com/in/a", fingerprint: fp() },
    {
      crustdataPersonId: null,
      linkedinUrl: "https://linkedin.com/in/b",
      fingerprint: fp({ title: "Vice President", location: "London", schools: ["Yale"], gradYear: 2015 }),
    },
  );
  assert.equal(v.duplicate, false);
  assert.equal(v.basis, "name_only", "flagged for review, not enforced");
});

test("a name match with only ONE corroborating signal does not merge", () => {
  const v = isProbableDuplicate(
    { crustdataPersonId: null, linkedinUrl: "https://linkedin.com/in/a", fingerprint: fp({ title: null, location: null, schools: null, gradYear: null }) },
    { crustdataPersonId: null, linkedinUrl: "https://linkedin.com/in/b", fingerprint: fp({ title: null, location: null, schools: null, gradYear: null }) },
  );
  // Only company_id agrees.
  assert.equal(v.duplicate, false);
  assert.deepEqual(v.agreed, ["company_id"]);
});

test("same canonical URL written differently: one person even with no IDs", () => {
  const v = isProbableDuplicate(
    { crustdataPersonId: null, linkedinUrl: "https://www.linkedin.com/in/John-Teeter/", fingerprint: fp({ name: "John Teeter" }) },
    { crustdataPersonId: null, linkedinUrl: "http://linkedin.com/in/john-teeter?x=1", fingerprint: fp({ name: "John Teeter" }) },
  );
  assert.equal(v.basis, "profile_url");
  assert.equal(v.duplicate, true);
});

test("one ID present and one missing falls through to the softer signals", () => {
  const v = isProbableDuplicate(
    { crustdataPersonId: 5, linkedinUrl: null, fingerprint: fp({ name: "Tena Broyles" }) },
    { crustdataPersonId: null, linkedinUrl: null, fingerprint: fp({ name: "Tena Broyles" }) },
  );
  assert.equal(v.duplicate, true);
  assert.equal(v.basis, "fingerprint");
});

test("different names never merge, however much else agrees", () => {
  const v = isProbableDuplicate(
    { crustdataPersonId: null, linkedinUrl: "https://linkedin.com/in/a", fingerprint: fp({ name: "John Smith" }) },
    { crustdataPersonId: null, linkedinUrl: "https://linkedin.com/in/b", fingerprint: fp({ name: "Jane Doe" }) },
  );
  assert.equal(v.duplicate, false);
});

// --------------------------------------------------------- cache & billing

const run = (over: Partial<CachedRun> = {}): CachedRun => ({
  status: "succeeded",
  contactsCreated: 5,
  creditsSpent: 1,
  completedAt: new Date(),
  ...over,
});

test("a repeat click serves the cached set and charges nothing", () => {
  const d = decideServe({ mode: "generate", existing: run() });
  assert.equal(d.action, "serve_cached");
  assert.equal(d.charge, 0);
});

test("a partial set is cached and served, not silently topped up", () => {
  const d = decideServe({ mode: "generate", existing: run({ contactsCreated: 3 }) });
  assert.equal(d.action, "serve_cached");
  assert.equal(d.charge, 0);
  assert.equal(d.reason, "partial");
});

test("a concurrent double-click joins the in-flight run instead of starting a second", () => {
  const d = decideServe({ mode: "generate", existing: run({ status: "pending", contactsCreated: 0 }) });
  assert.equal(d.action, "join_in_flight");
  assert.equal(d.charge, 0);
});

test("a failed run is not a cache", () => {
  const d = decideServe({ mode: "generate", existing: run({ status: "failed", contactsCreated: 0, creditsSpent: 0 }) });
  assert.equal(d.action, "run");
  assert.equal(d.reason, "failed_cache");
});

test("an explicit refresh always runs; a fill runs under the original charge", () => {
  assert.equal(decideServe({ mode: "refresh", existing: run() }).action, "run");
  assert.equal(decideServe({ mode: "fill", existing: run({ contactsCreated: 3 }) }).action, "run");
  assert.equal(decideServe({ mode: "fill", existing: run({ contactsCreated: 3 }) }).reason, "fill");
  assert.equal(creditsForOutcome({ mode: "fill", contactsCreated: 2, outcome: "succeeded" }), 0);
});

// `mode` arrives from the browser and the free-fill path waives the charge, so
// a fill is only free when there is genuinely a paid partial run to complete.

test("a fill with no earlier run is an ordinary chargeable generate", () => {
  const d = decideServe({ mode: "fill", existing: null });
  assert.equal(d.action, "run");
  assert.equal(d.reason, "no_cache", "not treated as a free top-up");
  assert.equal(chargeModeFor("fill", d), "generate");
  assert.equal(creditsForOutcome({ mode: chargeModeFor("fill", d), contactsCreated: 2, outcome: "succeeded" }), 1);
});

test("a fill on a complete set is served from cache, not re-run", () => {
  const d = decideServe({ mode: "fill", existing: run({ contactsCreated: 5 }) });
  assert.equal(d.action, "serve_cached");
  assert.equal(d.charge, 0);
});

test("a fill on a run that produced nobody is not a free completion", () => {
  // That run was never charged (creditsForOutcome gives 0 for no contacts), so
  // completing it for free would be free people.
  const d = decideServe({ mode: "fill", existing: run({ contactsCreated: 0, creditsSpent: 0 }) });
  assert.equal(d.reason, "partial");
  assert.equal(d.action, "serve_cached");
  assert.equal(chargeModeFor("fill", d), "generate");
});

test("a fill the server agreed to is still charged as a fill", () => {
  const d = decideServe({ mode: "fill", existing: run({ contactsCreated: 2 }) });
  assert.equal(chargeModeFor("fill", d), "fill");
  assert.equal(creditsForOutcome({ mode: chargeModeFor("fill", d), contactsCreated: 3, outcome: "succeeded" }), 0);
});

test("chargeModeFor leaves the other modes alone", () => {
  const gen = decideServe({ mode: "generate", existing: null });
  assert.equal(chargeModeFor("generate", gen), "generate");
  const ref = decideServe({ mode: "refresh", existing: run() });
  assert.equal(chargeModeFor("refresh", ref), "refresh");
});

test("the idempotency key makes a double-click one intent, and refreshes separate", () => {
  const a = idempotencyKey({ userId: "u", recommendationId: "r", mode: "generate" });
  const b = idempotencyKey({ userId: "u", recommendationId: "r", mode: "generate" });
  assert.equal(a, b);
  // A fill joins the generate it completes.
  assert.equal(idempotencyKey({ userId: "u", recommendationId: "r", mode: "fill" }), a);
  // Successive refreshes are genuinely different intents.
  assert.notEqual(
    idempotencyKey({ userId: "u", recommendationId: "r", mode: "refresh", refreshSequence: 1 }),
    idempotencyKey({ userId: "u", recommendationId: "r", mode: "refresh", refreshSequence: 2 }),
  );
  // Different students never share a key.
  assert.notEqual(a, idempotencyKey({ userId: "v", recommendationId: "r", mode: "generate" }));
});

test("credits follow the outcome, not the attempt", () => {
  const cases: [Parameters<typeof creditsForOutcome>[0], 0 | 1][] = [
    [{ mode: "generate", contactsCreated: 5, outcome: "succeeded" }, 1],
    [{ mode: "generate", contactsCreated: 3, outcome: "succeeded" }, 1],
    [{ mode: "generate", contactsCreated: 0, outcome: "succeeded" }, 0],
    [{ mode: "generate", contactsCreated: 0, outcome: "failed" }, 0],
    [{ mode: "generate", contactsCreated: 0, outcome: "identity_unresolved" }, 0],
    [{ mode: "generate", contactsCreated: 0, outcome: "provider_error" }, 0],
    [{ mode: "refresh", contactsCreated: 2, outcome: "succeeded" }, 1],
    [{ mode: "refresh", contactsCreated: 0, outcome: "succeeded" }, 0],
    [{ mode: "fill", contactsCreated: 2, outcome: "succeeded" }, 0],
  ];
  for (const [input, expected] of cases) {
    assert.equal(creditsForOutcome(input), expected, JSON.stringify(input));
  }
});

test("a charge without a persisted result is never committed", () => {
  assert.equal(isChargeable({ contactsPersisted: true, credits: 1 }), true);
  assert.equal(isChargeable({ contactsPersisted: false, credits: 1 }), false);
  assert.equal(isChargeable({ contactsPersisted: true, credits: 0 }), false);
});

// ------------------------------------------------------- parse/evaluate split

test("the parser is the only place a provider field name appears", () => {
  const raw = {
    basic_profile: { headline: "IB Associate" },
    experience: {
      employment_details: {
        current: [{ company_id: 682795, name: "Evercore", title: "Associate", start_date: "2023-07-01" }],
        past: [{ company_id: 111111, name: "Greenhill & Co" }],
      },
    },
  };
  const evidence = parseEmploymentEvidence(raw);
  assert.equal(evidence.current[0].companyId, 682795);
  assert.equal(evidence.past[0].companyId, 111111);
  assert.equal(
    evaluateEmployment(evidence, { crustdataCompanyId: 682795 }, new Date("2026-09-22")).status,
    "current",
  );
});

test("an unrecognised payload shape parses to no company id, and so fails closed", () => {
  for (const raw of [null, {}, { experience: {} }, { experience: { employment_details: { current: [{}] } } }]) {
    const evidence = parseEmploymentEvidence(raw);
    const verdict = evaluateEmployment(evidence, { crustdataCompanyId: 682795 }, new Date("2026-09-22"));
    assert.notEqual(verdict.status, "current", JSON.stringify(raw));
  }
});

test("the camelCase spelling the filter grammar also evidences is accepted", () => {
  const evidence = parseEmploymentEvidence({
    experience: { employment_details: { current: [{ companyId: 682795, name: "Evercore" }] } },
  });
  assert.equal(evidence.current[0].companyId, 682795);
});

// ------------------------------------------------------- abandoned runs

test("an in-flight run is joined; an abandoned one is re-run", () => {
  const started = (msAgo: number) => run({ status: "pending", contactsCreated: 0, creditsSpent: 0, createdAt: new Date(Date.now() - msAgo) });

  assert.equal(decideServe({ mode: "generate", existing: started(1_000) }).action, "join_in_flight");

  const abandoned = decideServe({ mode: "generate", existing: started(PENDING_STALE_MS + 1_000) });
  assert.equal(abandoned.action, "run");
  assert.equal(abandoned.reason, "stale_pending");
  assert.equal(abandoned.charge, "on_result");
});

test("a pending run with no start time is treated as in flight, not abandoned", () => {
  // Fail towards joining. Wrongly re-running costs a paid workflow; wrongly
  // joining costs a student one more click.
  const d = decideServe({
    mode: "generate",
    existing: run({ status: "pending", contactsCreated: 0, creditsSpent: 0, createdAt: null }),
  });
  assert.equal(d.action, "join_in_flight");
});

test("the staleness rule is the same one the allowance uses", () => {
  const fresh = { status: "pending", createdAt: new Date() };
  const old = { status: "pending", createdAt: new Date(Date.now() - PENDING_STALE_MS - 1) };
  assert.equal(isStalePending(fresh), false);
  assert.equal(isStalePending(old), true);
  // Only pending runs can be stale - a settled one is simply settled.
  assert.equal(isStalePending({ status: "succeeded", createdAt: old.createdAt }), false);
  assert.equal(isStalePending({ status: "failed", createdAt: old.createdAt }), false);
});

test("a refresh and a fill of the same firm never share a key", () => {
  const generate = idempotencyKey({ userId: "u", recommendationId: "r", mode: "generate" });
  const refresh = idempotencyKey({ userId: "u", recommendationId: "r", mode: "refresh", refreshSequence: 1 });
  assert.notEqual(generate, refresh);
  assert.equal(idempotencyKey({ userId: "u", recommendationId: "r", mode: "fill" }), generate);
});
