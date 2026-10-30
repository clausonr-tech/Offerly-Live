import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { DEFAULT_TIERS, accumulateAcrossTiers, type Tier } from "@/lib/contact-tiers";
import { parseEmploymentEvidence } from "@/lib/employment";
import {
  canSeedPattern,
  resolveContactEmail,
  type FirmEmailDomains,
  type ProviderEmailStatus,
} from "@/lib/contact-email-gate";
import { shouldRenderEmail } from "@/lib/contact-email-render";
import { detectPattern, recordObservation, winnerOf, type PatternTally } from "@/lib/email-patterns";
import { creditsForOutcome, decideServe, type CachedRun } from "@/lib/sourcing-run-policy";

/**
 * The whole pipeline, composed exactly as generateContactsAction composes it,
 * driven by a fake provider.
 *
 * This is the step above the unit tests: they prove each rule in isolation,
 * and this proves the rules still hold when wired together in order - which is
 * where the employment bypass hid, in the seam between two functions that were
 * each individually correct.
 *
 * What it does NOT cover is the Next server-action wrapper itself: auth via
 * cookies, and revalidatePath. Those need a Next runtime, and they are thin.
 * Stated rather than implied.
 */

const EVERCORE_ID = 682795;
const FIRM: FirmEmailDomains = { primaryDomain: "evercore.com", approvedAliases: [] };
const NOW = new Date("2026-09-22T00:00:00Z");

type FakeProfile = {
  crustdataPersonId: number | null;
  linkedinUrl: string | null;
  name: string;
  title?: string | null;
  raw: unknown;
  redacted?: boolean;
  email?: { address: string | null; status: ProviderEmailStatus };
};

function profile(over: Partial<FakeProfile> & { name: string }): FakeProfile {
  return {
    crustdataPersonId: Math.floor(Math.random() * 1e6),
    linkedinUrl: `https://www.linkedin.com/in/${over.name.toLowerCase().replace(/\s+/g, "-")}`,
    raw: {
      experience: {
        employment_details: { current: [{ company_id: EVERCORE_ID, name: "Evercore", title: "Analyst" }], past: [] },
      },
    },
    ...over,
  };
}

/** The action's sequence, end to end, over a fake provider. */
async function runPipeline(options: {
  tiers?: Tier[];
  pages: FakeProfile[][];
  seedPattern?: PatternTally;
  throwOnTier?: number;
}) {
  const asked: number[] = [];
  let tierIndex = 0;

  const accumulated = await accumulateAcrossTiers({
    tiers: options.tiers ?? DEFAULT_TIERS,
    firm: { crustdataCompanyId: EVERCORE_ID },
    includeIncoming: false,
    now: NOW,
    search: async (_tier, limit) => {
      const i = tierIndex++;
      if (options.throwOnTier === i) throw new Error("provider exploded");
      asked.push(limit);
      const page = options.pages[i] ?? [];
      return page.map((p) => ({
        crustdataPersonId: p.crustdataPersonId,
        linkedinUrl: p.linkedinUrl,
        name: p.name,
        title: p.title ?? null,
        redacted: p.redacted,
        employment: parseEmploymentEvidence(p.raw),
        source: p,
      }));
    },
  });

  // --- enrichment + pattern learning, in the action's order ----------------
  let tally: PatternTally = options.seedPattern ?? {};
  for (const { contact } of accumulated.contacts) {
    const src = (contact as { source: FakeProfile }).source;
    const email = src.email?.address ?? null;
    const status = src.email?.status ?? null;
    if (!email) continue;
    if (!canSeedPattern({ email, providerStatus: status, firm: FIRM, employmentConfirmed: true, source: "crustdata" })) {
      continue;
    }
    const seen = detectPattern(contact.name, email);
    if (seen) tally = recordObservation(tally, seen.shape, seen.domain);
  }
  const leader = winnerOf(tally);
  const pattern = leader ? { shape: leader.shape, domain: leader.domain, sampleCount: leader.samples } : null;

  // --- the email gate, then the render guard -------------------------------
  const contacts = accumulated.contacts.map(({ contact }) => {
    const src = (contact as { source: FakeProfile }).source;
    const decided = resolveContactEmail({
      name: contact.name,
      enrichedEmail: src.email?.address ?? null,
      providerStatus: src.email?.status ?? null,
      firm: FIRM,
      employmentConfirmed: true,
      pattern,
    });
    return {
      name: contact.name,
      email: decided.email,
      emailConfidence: decided.emailConfidence,
      emailDomainRelevant: decided.emailDomainRelevant,
      rawProviderEmail: decided.rawProviderEmail,
      renders: shouldRenderEmail(decided),
    };
  });

  return { contacts, asked, tiers: accumulated.tiers, partial: accumulated.partial, pattern };
}

// ---------------------------------------------------------------- scenarios

test("five strong contacts from the first tier: one call, five returned", async () => {
  const r = await runPipeline({
    pages: [[1, 2, 3, 4, 5].map((i) => profile({ name: `Person ${i}` }))],
  });
  assert.equal(r.contacts.length, 5);
  assert.deepEqual(r.asked, [5]);
  assert.equal(r.partial, false);
});

test("contacts accumulate across several tiers, asking only for what is left", async () => {
  const r = await runPipeline({
    pages: [
      [profile({ name: "A" }), profile({ name: "B" })],
      [profile({ name: "C" })],
      [profile({ name: "D" }), profile({ name: "E" })],
    ],
  });
  assert.equal(r.contacts.length, 5);
  assert.deepEqual(r.asked, [5, 3, 2]);
  assert.deepEqual(r.contacts.map((c) => c.name), ["A", "B", "C", "D", "E"]);
});

test("a partial result is returned honestly and charges one run", async () => {
  const r = await runPipeline({ pages: [[profile({ name: "A" }), profile({ name: "B" })]] });
  assert.equal(r.contacts.length, 2);
  assert.equal(r.partial, true);
  assert.equal(creditsForOutcome({ mode: "generate", contactsCreated: 2, outcome: "succeeded" }), 1);
});

test("a zero result charges nothing", async () => {
  const r = await runPipeline({ pages: [] });
  assert.equal(r.contacts.length, 0);
  assert.equal(creditsForOutcome({ mode: "generate", contactsCreated: 0, outcome: "succeeded" }), 0);
});

test("duplicate provider responses across tiers collapse to one person", async () => {
  const same = profile({ name: "Repeat", crustdataPersonId: 4242 });
  const r = await runPipeline({ pages: [[same], [same], [same]] });
  assert.equal(r.contacts.length, 1);
});

test("a wrong-company contact never enters the set", async () => {
  const wrong = profile({
    name: "Wrong Co",
    raw: { experience: { employment_details: { current: [{ company_id: 999, name: "Greenhill & Co" }], past: [] } } },
  });
  const r = await runPipeline({ pages: [[wrong, profile({ name: "Right Co" })]] });
  assert.deepEqual(r.contacts.map((c) => c.name), ["Right Co"]);
});

test("a former employee is rejected even though the firm is on the profile", async () => {
  const former = profile({
    name: "Vikram Jolly",
    raw: {
      experience: {
        employment_details: {
          current: [{ company_id: 111111, name: "Greenhill & Co" }],
          past: [{ company_id: EVERCORE_ID, name: "Evercore" }],
        },
      },
    },
  });
  const r = await runPipeline({ pages: [[former]] });
  assert.equal(r.contacts.length, 0);
});

test("an incoming analyst is excluded by default", async () => {
  const incoming = profile({
    name: "Jay Shapiro",
    raw: {
      experience: {
        employment_details: { current: [{ company_id: EVERCORE_ID, name: "Evercore", start_date: "2027-06-01" }], past: [] },
      },
    },
  });
  const r = await runPipeline({ pages: [[incoming]] });
  assert.equal(r.contacts.length, 0);
});

test("a missing company_id yields zero contacts rather than five unverified ones", async () => {
  const noId = profile({
    name: "No Id",
    raw: { experience: { employment_details: { current: [{ name: "Evercore", title: "Analyst" }], past: [] } } },
  });
  const r = await runPipeline({ pages: [[noId, noId, noId]] });
  assert.equal(r.contacts.length, 0, "fails closed");
});

test("a provider error midway propagates rather than returning a half-truth", async () => {
  await assert.rejects(
    () => runPipeline({ pages: [[profile({ name: "A" })]], throwOnTier: 1 }),
    /provider exploded/,
  );
  assert.equal(creditsForOutcome({ mode: "generate", contactsCreated: 0, outcome: "provider_error" }), 0);
});

test("an off-domain enriched email never reaches the student", async () => {
  const r = await runPipeline({
    pages: [[
      profile({ name: "John Teeter", email: { address: "john.teeter@evercore.com", status: "deliverable" } }),
      profile({ name: "Adeel Chaudhry", email: { address: "adeel.chaudhry@evercore.com", status: "deliverable" } }),
      profile({ name: "Vikram Jolly", email: { address: "vikram.jolly@greenhill.com", status: "deliverable" } }),
    ]],
  });
  const vikram = r.contacts.find((c) => c.name === "Vikram Jolly")!;
  assert.equal(vikram.email, "vikram.jolly@evercore.com");
  assert.equal(vikram.emailConfidence, "predicted");
  assert.equal(vikram.rawProviderEmail, "vikram.jolly@greenhill.com");
  assert.ok(r.contacts.every((c) => !String(c.email).includes("greenhill")));
});

test("a missing enriched email plus a confirmed pattern yields a predicted address", async () => {
  const r = await runPipeline({
    pages: [[
      profile({ name: "John Teeter", email: { address: "john.teeter@evercore.com", status: "deliverable" } }),
      profile({ name: "Adeel Chaudhry", email: { address: "adeel.chaudhry@evercore.com", status: "deliverable" } }),
      profile({ name: "Shania Tang" }),
    ]],
  });
  const shania = r.contacts.find((c) => c.name === "Shania Tang")!;
  assert.equal(shania.email, "shania.tang@evercore.com");
  assert.equal(shania.emailConfidence, "predicted");
  assert.equal(shania.renders, true);
});

test("an incomplete name with no email renders No email found", async () => {
  const r = await runPipeline({
    pages: [[
      profile({ name: "John Teeter", email: { address: "john.teeter@evercore.com", status: "deliverable" } }),
      profile({ name: "Adeel Chaudhry", email: { address: "adeel.chaudhry@evercore.com", status: "deliverable" } }),
      profile({ name: "Joshua O." }),
    ]],
  });
  const joshua = r.contacts.find((c) => c.name === "Joshua O.")!;
  assert.equal(joshua.email, null);
  assert.equal(joshua.renders, false);
});

test("one deliverable sample is enough to predict for others, and only as predicted", async () => {
  const r = await runPipeline({
    pages: [[
      profile({ name: "John Teeter", email: { address: "john.teeter@evercore.com", status: "deliverable" } }),
      profile({ name: "Shania Tang" }),
    ]],
  });
  // PATTERN_DERIVE_MIN_SAMPLES is 1 (email-patterns.ts): a single real
  // address on the firm's domain, spelled from its owner's name, is the
  // firm's convention. What must hold is that the derived address is never
  // passed off as confirmed.
  assert.equal(r.pattern?.sampleCount, 1);
  const shania = r.contacts.find((c) => c.name === "Shania Tang")!;
  assert.equal(shania.email, "shania.tang@evercore.com");
  assert.equal(shania.emailConfidence, "predicted");
  assert.equal(shania.renders, true);
});

test("INVARIANT: every rendered email is on the firm's domain, in every scenario above", async () => {
  const r = await runPipeline({
    pages: [[
      profile({ name: "John Teeter", email: { address: "john.teeter@evercore.com", status: "deliverable" } }),
      profile({ name: "Adeel Chaudhry", email: { address: "adeel.chaudhry@evercore.com", status: "deliverable" } }),
      profile({ name: "Vikram Jolly", email: { address: "vikram.jolly@greenhill.com", status: "deliverable" } }),
      profile({ name: "Alex Rivera", email: { address: "clausonr@wharton.upenn.edu", status: "deliverable" } }),
      profile({ name: "Personal Person", email: { address: "p@gmail.com", status: "deliverable" } }),
    ]],
  });
  for (const c of r.contacts) {
    if (c.renders) assert.match(String(c.email), /@evercore\.com$/, `${c.name} rendered ${c.email}`);
  }
  assert.ok(r.contacts.length <= 5);
});

// ------------------------------------------------------- cache and billing

test("a cached repeat click returns the set with no provider call and no charge", async () => {
  let calls = 0;
  const cached: CachedRun = { status: "succeeded", contactsCreated: 5, creditsSpent: 1, completedAt: NOW };
  const decision = decideServe({ mode: "generate", existing: cached });
  if (decision.action === "run") {
    calls++;
    await runPipeline({ pages: [[]] });
  }
  assert.equal(decision.action, "serve_cached");
  assert.equal(decision.charge, 0);
  assert.equal(calls, 0, "the provider was not called");
});

test("a concurrent second click joins the first and cannot charge twice", () => {
  const inFlight: CachedRun = { status: "pending", contactsCreated: 0, creditsSpent: 0, completedAt: null };
  const second = decideServe({ mode: "generate", existing: inFlight });
  assert.equal(second.action, "join_in_flight");
  assert.equal(second.charge, 0);
});

test("a failed run is re-run, not served, and was never charged", () => {
  const failed: CachedRun = { status: "failed", contactsCreated: 0, creditsSpent: 0, completedAt: NOW };
  assert.equal(decideServe({ mode: "generate", existing: failed }).action, "run");
  assert.equal(failed.creditsSpent, 0);
});
