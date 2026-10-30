import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  DEFAULT_TIERS,
  MAX_CONTACTS,
  accumulateAcrossTiers,
  canonicalProfileUrl,
  identityKeys,
  remainingSlots,
  validateAndDeduplicate,
  type Tier,
  type TierCandidate,
} from "@/lib/contact-tiers";
import type { SelectedFirmIdentity } from "@/lib/employment";

const EVERCORE: SelectedFirmIdentity = { crustdataCompanyId: 682795 };
const NOW = new Date("2026-09-22T00:00:00Z");

let nextId = 1;
function person(over: Partial<TierCandidate> = {}): TierCandidate {
  const id = nextId++;
  return {
    crustdataPersonId: id,
    linkedinUrl: `https://www.linkedin.com/in/person-${id}`,
    name: `Person ${id}`,
    employment: { current: [{ companyId: 682795, name: "Evercore" }], past: [] },
    ...over,
  };
}

// --------------------------------------------------------- remaining slots

test("remaining never goes negative and reaches zero exactly", () => {
  assert.equal(remainingSlots(0), 5);
  assert.equal(remainingSlots(3), 2);
  assert.equal(remainingSlots(5), 0);
  assert.equal(remainingSlots(9), 0);
});

test("each tier asks for only the slots still open, and none run once full", async () => {
  const asked: number[] = [];
  const result = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    search: async (_t, limit) => {
      asked.push(limit);
      return [person(), person()]; // two per tier
    },
  });
  // 5 then 3 then 1, and the fourth tier never runs.
  assert.deepEqual(asked, [5, 3, 1]);
  assert.equal(result.contacts.length, 5);
  assert.equal(result.partial, false);
});

test("a first tier that fills the set stops the ladder immediately", async () => {
  let calls = 0;
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    search: async () => {
      calls++;
      return [person(), person(), person(), person(), person()];
    },
  });
  assert.equal(calls, 1);
  assert.equal(r.contacts.length, 5);
});

test("earlier tiers are PRESERVED, never discarded by a later one", async () => {
  // The old widening kept only the last rung that answered.
  const first = person({ name: "Tier One Alum" });
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS.slice(0, 3),
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    search: async (tier) => (tier.drop.length === 0 ? [first] : [person()]),
  });
  assert.ok(r.contacts.some((c) => c.contact.name === "Tier One Alum"));
});

test("zero results at every tier yields an empty, partial result - not an error", async () => {
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    search: async () => [],
  });
  assert.equal(r.contacts.length, 0);
  assert.equal(r.partial, true);
  assert.equal(r.tiers.length, DEFAULT_TIERS.length);
});

test("a partial result is returned honestly rather than padded", async () => {
  const only = [person(), person()];
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    search: async (tier) => (tier.drop.length === 0 ? only : []),
  });
  assert.equal(r.contacts.length, 2);
  assert.equal(r.partial, true);
});

test("a provider that ignores the limit cannot overfill the set", async () => {
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    search: async () => Array.from({ length: 20 }, () => person()),
  });
  assert.equal(r.contacts.length, MAX_CONTACTS);
});

test("the selected-company constraint appears in no tier's relaxation list", () => {
  for (const tier of DEFAULT_TIERS) {
    assert.ok(!tier.drop.includes("company" as never), tier.label);
  }
  // Role is relaxed at the student's school before any other school is
  // tried, and once more at the very end for everyone.
  const roleTiers = DEFAULT_TIERS.filter((t) => t.drop.includes("role"));
  assert.equal(roleTiers.length, 2);
  assert.ok(!roleTiers[0].drop.includes("school"), "first loosened at the student's school");
  assert.equal(roleTiers[1], DEFAULT_TIERS[DEFAULT_TIERS.length - 1]);
});

test("every rung at the student's school comes before any other school", () => {
  const lastSameSchool = DEFAULT_TIERS.map((t) => !t.drop.includes("school")).lastIndexOf(true);
  const firstOtherSchool = DEFAULT_TIERS.findIndex((t) => t.drop.includes("school"));
  assert.ok(lastSameSchool < firstOtherSchool);
});

// ------------------------------------------------------------ deduplication

test("the same person ID under two different URLs is one person", () => {
  const seen = new Set<string>();
  const a = person({ crustdataPersonId: 77, linkedinUrl: "https://www.linkedin.com/in/tena-broyles-77570a28" });
  const b = person({ crustdataPersonId: 77, linkedinUrl: "https://www.linkedin.com/in/tena-broyles-4b522374" });
  const out = validateAndDeduplicate([a, b], { firm: EVERCORE, includeIncoming: false, seen, now: NOW });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.rejected[0]?.reason, "DUPLICATE");
});

test("the same URL written differently is one person", () => {
  const seen = new Set<string>();
  const a = person({ crustdataPersonId: null, linkedinUrl: "https://www.linkedin.com/in/John-Teeter/" });
  const b = person({ crustdataPersonId: null, linkedinUrl: "http://linkedin.com/in/john-teeter?utm=x" });
  const out = validateAndDeduplicate([a, b], { firm: EVERCORE, includeIncoming: false, seen, now: NOW });
  assert.equal(out.accepted.length, 1);
  assert.equal(canonicalProfileUrl("https://www.linkedin.com/in/John-Teeter/"), "linkedin.com/in/john-teeter");
});

test("a duplicate INSIDE one tier is caught, not only across tiers", () => {
  const seen = new Set<string>();
  const p = person({ crustdataPersonId: 5 });
  const out = validateAndDeduplicate([p, { ...p }], { firm: EVERCORE, includeIncoming: false, seen, now: NOW });
  assert.equal(out.accepted.length, 1);
});

test("two genuinely different people who share a name are both kept", () => {
  const seen = new Set<string>();
  const a = person({ crustdataPersonId: 1, name: "John Smith", linkedinUrl: "https://linkedin.com/in/john-smith-1" });
  const b = person({ crustdataPersonId: 2, name: "John Smith", linkedinUrl: "https://linkedin.com/in/john-smith-2" });
  const out = validateAndDeduplicate([a, b], { firm: EVERCORE, includeIncoming: false, seen, now: NOW });
  assert.equal(out.accepted.length, 2, "distinct ids must not collapse on a shared name");
});

test("a duplicate across tiers is rejected on the second tier", async () => {
  const shared = person({ crustdataPersonId: 42 });
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS.slice(0, 2),
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    search: async () => [shared],
  });
  assert.equal(r.contacts.length, 1);
  assert.equal(r.tiers[1].rejected.DUPLICATE, 1);
});

test("a contact with no stable identifier is refused", () => {
  const seen = new Set<string>();
  const out = validateAndDeduplicate(
    [person({ crustdataPersonId: null, linkedinUrl: null })],
    { firm: EVERCORE, includeIncoming: false, seen, now: NOW },
  );
  assert.equal(out.accepted.length, 0);
  assert.equal(out.rejected[0].reason, "NO_STABLE_IDENTIFIER");
});

test("a redacted profile is refused before anything else is considered", () => {
  const seen = new Set<string>();
  const out = validateAndDeduplicate([person({ redacted: true })], {
    firm: EVERCORE,
    includeIncoming: false,
    seen,
    now: NOW,
  });
  assert.equal(out.rejected[0].reason, "REDACTED");
});

test("an explicit refresh excludes people already returned", () => {
  const seen = new Set<string>();
  const p = person({ crustdataPersonId: 9 });
  const excluded = new Set(identityKeys(p));
  const out = validateAndDeduplicate([p], { firm: EVERCORE, includeIncoming: false, seen, excluded, now: NOW });
  assert.equal(out.accepted.length, 0);
  assert.equal(out.rejected[0].reason, "EXCLUDED");
});

// ------------------------------------------------------------- employment

test("a former employee never enters the result set", () => {
  const seen = new Set<string>();
  const former = person({
    employment: { current: [{ companyId: 111111, name: "Greenhill & Co" }], past: [{ companyId: 682795, name: "Evercore" }] },
  });
  const out = validateAndDeduplicate([former], { firm: EVERCORE, includeIncoming: false, seen, now: NOW });
  assert.equal(out.accepted.length, 0);
  assert.equal(out.rejected[0].reason, "EMPLOYMENT_UNCONFIRMED");
});

test("a wrong subsidiary is refused unless explicitly mapped", () => {
  const seen = new Set<string>();
  const sub = person({ employment: { current: [{ companyId: 999, name: "Evercore Wealth Management" }], past: [] } });
  assert.equal(
    validateAndDeduplicate([sub], { firm: EVERCORE, includeIncoming: false, seen, now: NOW }).accepted.length,
    0,
  );
  const mapped = { crustdataCompanyId: 682795, equivalentCompanyIds: [999] };
  assert.equal(
    validateAndDeduplicate([sub], { firm: mapped, includeIncoming: false, seen: new Set(), now: NOW }).accepted.length,
    1,
  );
});

test("an incoming analyst is excluded by default and labelled when included", () => {
  const incoming = person({
    employment: { current: [{ companyId: 682795, name: "Evercore", startDate: "2027-06-01" }], past: [] },
  });
  const off = validateAndDeduplicate([incoming], { firm: EVERCORE, includeIncoming: false, seen: new Set(), now: NOW });
  assert.equal(off.rejected[0].reason, "INCOMING_NOT_REQUESTED");

  const on = validateAndDeduplicate([incoming], { firm: EVERCORE, includeIncoming: true, seen: new Set(), now: NOW });
  assert.equal(on.accepted[0].employmentStatus, "incoming");
});

test("INVARIANT: no run ever returns more than five, whatever the tiers do", async () => {
  for (const shape of [[9, 9], [3, 3, 3], [1, 1, 1, 1, 1, 1, 1], [5], [0, 0, 7]]) {
    let i = 0;
    const r = await accumulateAcrossTiers({
      tiers: DEFAULT_TIERS,
      firm: EVERCORE,
      includeIncoming: false,
      now: NOW,
      search: async () => Array.from({ length: shape[i++] ?? 0 }, () => person()),
    });
    assert.ok(r.contacts.length <= MAX_CONTACTS, JSON.stringify(shape));
  }
});

test("INVARIANT: no tier is ever asked for more than the slots remaining", async () => {
  const asked: { limit: number; held: number }[] = [];
  let held = 0;
  await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    search: async (_t, limit) => {
      asked.push({ limit, held });
      const out = [person()];
      held += 1;
      return out;
    },
  });
  for (const a of asked) assert.equal(a.limit, MAX_CONTACTS - a.held);
});

test("a tier whose results are all invalid still advances the ladder", async () => {
  const bad: Tier[] = DEFAULT_TIERS.slice(0, 3);
  const r = await accumulateAcrossTiers({
    tiers: bad,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    // The first rung only, by identity - two rungs relax nothing now that the
    // business-school rung leads, so `drop.length === 0` no longer means "first".
    search: async (tier) =>
      tier === bad[0]
        ? [person({ employment: { current: [{ companyId: 1, name: "Someone else" }], past: [] } })]
        : [person()],
  });
  assert.equal(r.contacts.length, 2, "tiers two and three still contributed");
  assert.equal(r.tiers[0].accepted, 0);
});

// ------------------------------------------------------------ school review

const PENN_NAMES = ["University of Pennsylvania", "The Wharton School"];
const pennAlum = () => person({ schools: ["The Wharton School"] });
const otherAlum = () => person({ schools: ["Pennsylvania State University"] });

test("a wrong school in a same-school rung is rejected and replaced from the student's school", async () => {
  let calls = 0;
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    schoolNames: PENN_NAMES,
    search: async (tier, limit) => {
      calls++;
      // The first rung slips a Penn State alum in among four Penn alumni;
      // asked again, it has the Penn alum that replaces them.
      if (calls === 1) return [pennAlum(), pennAlum(), otherAlum(), pennAlum(), pennAlum()];
      return Array.from({ length: limit }, pennAlum);
    },
  });
  assert.equal(r.contacts.length, 5);
  assert.ok(r.contacts.every((c) => c.contact.schools?.includes("The Wharton School")), "only Penn alumni");
  assert.equal(r.tiers[0].rejected.WRONG_SCHOOL, 1);
  assert.equal(r.tiers[1].tier, `${DEFAULT_TIERS[0].label} (repeat 1)`, "the same rung was asked again");
});

test("other schools are never tried while the student's school might have more", async () => {
  const labels: string[] = [];
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    schoolNames: PENN_NAMES,
    // Every same-school rung comes back full of wrong schools - so the school
    // is never confirmed to have run out, and no other school may be shown.
    search: async (tier, limit) => {
      labels.push(tier.label);
      return Array.from({ length: limit }, otherAlum);
    },
  });
  assert.equal(r.contacts.length, 0);
  assert.equal(r.stoppedAtSchool, true);
  assert.ok(labels.every((l) => !DEFAULT_TIERS.find((t) => t.label === l)!.drop.includes("school")), "an other-school rung ran");
});

test("other schools fill in only once the widest same-school rung comes back short", async () => {
  const r = await accumulateAcrossTiers({
    tiers: DEFAULT_TIERS,
    firm: EVERCORE,
    includeIncoming: false,
    now: NOW,
    schoolNames: PENN_NAMES,
    // Penn has exactly two alumni at the firm: returned once, then gone.
    search: async (tier, limit) => {
      if (tier.drop.includes("school")) return Array.from({ length: limit }, otherAlum);
      return tier === DEFAULT_TIERS[0] ? [pennAlum(), pennAlum()] : [];
    },
  });
  assert.equal(r.stoppedAtSchool, false);
  assert.equal(r.contacts.length, 5);
  assert.equal(r.contacts.filter((c) => c.contact.schools?.includes("The Wharton School")).length, 2, "both Penn alumni first");
  const widest = r.tiers.find((t) => t.tier === "same school, any role at the firm");
  assert.ok(widest && widest.returned < widest.requested, "confirmed by the widest same-school rung");
});

test("no ladder rung sends free text; only the affinity search does", async () => {
  const { relaxQueryForTier, toCrustdataRequest } = await import("../../src/lib/crustdata-client");
  const { AFFINITY_TIER, affinityQuery } = await import("../../src/lib/contact-search-provider");
  const keywords = ["Wharton Investment Club", "poker", "Boise, Idaho"];
  const base = {
    employer: { name: "Evercore", domain: "evercore.com", companyId: 42 },
    person: { titleAnyOf: ["Investment Banking"], seniorityLevels: ["analyst"], maxYearsExperience: 20 },
    education: { school: { names: ["University of Pennsylvania"], businessNames: ["The Wharton School"] }, graduatedOnOrAfter: 2006 },
    location: { cities: ["New York"] },
    keywords,
    exclude: { linkedinUrls: [], names: [] },
    limit: 5,
  } as unknown as Parameters<typeof relaxQueryForTier>[0];

  for (const tier of DEFAULT_TIERS) {
    assert.ok(!tier.keywords, `"${tier.label}" must not send free text - it narrows rather than ranks`);
    const body = toCrustdataRequest(relaxQueryForTier(base, tier)) as { search?: unknown };
    assert.equal(body.search, undefined, `"${tier.label}" sent free text`);
  }

  const signal = { id: "club:1", category: "club" as const, terms: ["Trojan Investing Society", "TIS"] };
  const body = toCrustdataRequest(relaxQueryForTier(affinityQuery(base, signal, 5), AFFINITY_TIER)) as {
    search?: { query: string };
    filters: { conditions: { field?: string }[] };
  };
  assert.equal(
    body.search?.query,
    "Trojan Investing Society",
    "one spelling per search: sending aliases together would assume the free text is OR",
  );
  const fields = body.filters.conditions.map((c) => c.field);
  assert.ok(fields.includes("education.schools.school"), "the affinity search keeps the school");
  assert.ok(!fields.includes("basic_profile.location.city"), "and drops the city");
});
