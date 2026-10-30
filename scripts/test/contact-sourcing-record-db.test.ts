/**
 * Contact generation's persisted record, against a real migrated database
 * (PGlite replaying drizzle/*.sql, 0040 included) and a fake provider at
 * global fetch. No network, no API key, nothing paid.
 *
 * Covers: the run's algorithm version and redacted metrics, the link from each
 * generated contact to its run, metric totals that agree with what the
 * provider actually billed (the verified-email anchor included), repeat clicks
 * that write nothing new, the affinity rollout guard, and the outcome snapshot
 * taken when a generated contact is deleted.
 */
import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { SEARCH_URL, fakeProfile, installFakeCrustdata, type FakeOptions } from "./helpers/fake-crustdata";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { contactSourcingOutcomes, contactSourcingRuns, contacts, emailDrafts, firms, users } from "@/db/schema";
import { runContactSourcing } from "@/lib/contact-sourcing-run";
import { removeContact } from "@/lib/contact-removal";
import { CONTACT_ALGORITHM_VERSION, type RunMetrics } from "@/lib/contact-pool";
import { eq } from "drizzle-orm";

const EVERCORE_ID = 682795;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const FIRM_ID = "22222222-2222-4222-8222-222222222222";
const HOMETOWN = "Boise, Idaho";
const CLUB = "Trojan Investing Society";

async function seed(h: TestDatabase) {
  await h.db.insert(users).values({
    id: USER_ID,
    email: "student@example.edu",
    passwordHash: "not-a-real-hash",
    name: "Test Student",
    plan: "pro",
    school: "University of Southern California",
    gradYear: 2027,
    major: "Business Administration",
    hometown: HOMETOWN,
    clubsAndActivities: CLUB,
  });
  await h.db.insert(firms).values({
    id: FIRM_ID,
    name: "Evercore",
    slug: "evercore",
    headquarters: "New York, NY",
    keyOffices: "New York",
    description: "Independent investment bank.",
    website: "https://evercore.com",
    crustdataCompanyId: EVERCORE_ID,
    verifiedDomain: "evercore.com",
    identityStatus: "verified",
    identityConfidence: 95,
    identityCheckedAt: new Date(),
    verifiedAt: new Date(),
  });
}

async function withHarness(fn: (h: TestDatabase) => Promise<void>, env: Record<string, string | undefined> = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const h = await createTestDb();
  const restoreDb = installAsAppDb(h.db);
  await seed(h);
  try {
    await fn(h);
  } finally {
    restoreDb();
    await h.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const people = (names: string[]) =>
  names.map((name, i) => fakeProfile({ name, companyId: EVERCORE_ID, gradYear: 2022 + i }));
const five = () => people(["Ada Lin", "Ben Ortiz", "Cara Nwosu", "Dev Shah", "Elena Marsh"]);

const click = () => runContactSourcing({ user: { id: USER_ID, email: "student@example.edu" }, firmId: FIRM_ID });

async function onlyRun(h: TestDatabase) {
  const rows = await h.db.select().from(contactSourcingRuns);
  assert.equal(rows.length, 1);
  return { run: rows[0], metrics: rows[0].metrics as RunMetrics };
}

test("a run stores its algorithm version and metrics, and links every contact to it", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({ searchPages: [five()] });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      const { run, metrics } = await onlyRun(h);
      assert.equal(run.algorithmVersion, CONTACT_ALGORITHM_VERSION);
      assert.equal(metrics.selected, 5);
      assert.equal(metrics.affinityEnabled, false, "off by default");

      const saved = await h.db.select().from(contacts);
      assert.equal(saved.length, 5);
      assert.deepEqual(saved.map((c) => c.sourcingRank).sort(), [1, 2, 3, 4, 5]);
      for (const c of saved) {
        assert.equal(c.sourcingRunId, run.id);
        assert.ok(c.sourcingScore && c.sourcingRetrieval);
      }

      const stored = JSON.stringify({ metrics: run.metrics, records: saved.map((c) => [c.sourcingScore, c.sourcingRetrieval]) });
      for (const privateText of [HOMETOWN, "Boise", CLUB, "Ada Lin", "Ben Ortiz"]) {
        assert.ok(!stored.includes(privateText), `"${privateText}" leaked into the persisted telemetry`);
      }
    } finally {
      api.restore();
    }
  });
});

test("with the anchor selected, counts and credits agree with what the provider billed", async () => {
  await withHarness(async (h) => {
    const anchor = fakeProfile({ name: "Vera Anchor", companyId: EVERCORE_ID, gradYear: 2026 });
    const opts: FakeOptions = {
      searchPages: [five()],
      verifiedEmailPages: [[anchor]],
      emails: { "https://www.linkedin.com/in/vera-anchor": { email: "vera.anchor@evercore.com", status: "deliverable" } },
    };
    const api = installFakeCrustdata(opts);
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const { metrics } = await onlyRun(h);

      assert.equal(metrics.anchorSelected, true, "the anchor took a slot");
      assert.equal(metrics.selected, 5);
      assert.equal(metrics.poolSize, 6, "five from the baseline plus the anchor");
      assert.equal(metrics.uniqueCandidates, 6);
      const anchorSearch = metrics.searches.filter((s) => s.searchType === "anchor");
      assert.equal(anchorSearch.length, 1, "the anchor's search is recorded");
      assert.equal(anchorSearch[0].accepted, 1);
      assert.equal(metrics.final.filter((f) => f.foundBy.includes("anchor")).length, 1);

      assert.equal(metrics.providerCredits, api.creditsBilled, "metrics total = what the provider billed");
      assert.equal(metrics.providerCredits, metrics.searchCredits + metrics.enrichmentCredits);
      assert.ok(metrics.enrichmentCredits >= 1, "the anchor's email lookup is counted as enrichment");
      assert.equal(result.creditsUsed, metrics.providerCredits);
      assert.ok(result.contacts.some((c) => c.name === "Vera Anchor"));
    } finally {
      api.restore();
    }
  });
});

test("a repeat click is served from what was saved and writes no new rows or metrics", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({ searchPages: [five()] });
    try {
      await click();
      const before = await onlyRun(h);
      const searches = api.countOf(SEARCH_URL);
      const again = await click();
      assert.equal(again.ok, true);
      if (again.ok) assert.equal(again.status, "cached");
      const after = await onlyRun(h);
      assert.deepEqual(after.run.metrics, before.run.metrics, "metrics untouched");
      assert.equal(api.countOf(SEARCH_URL), searches, "no new search");
      assert.equal((await h.db.select().from(contacts)).length, 5, "no new contacts");
    } finally {
      api.restore();
    }
  });
});

test("with affinity searching off, no free text is sent and the baseline still fills five", async () => {
  await withHarness(
    async (h) => {
      const api = installFakeCrustdata({ searchPages: [five()] });
      try {
        const result = await click();
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.contacts.length, 5);
        const bodies = api.calls.filter((c) => c.url === SEARCH_URL).map((c) => JSON.stringify(c.body));
        assert.ok(bodies.every((b) => !b.includes('"search"')), "no hybrid free-text search was sent");
        assert.ok(bodies.every((b) => !b.includes("Boise") && !b.includes("Trojan")), "no private term left Offerly");
        assert.equal((await onlyRun(h)).metrics.affinityEnabled, false);
      } finally {
        api.restore();
      }
    },
    { CONTACT_AFFINITY_SEARCH: undefined },
  );
});

test("with affinity searching on, signals are searched and recorded only by category", async () => {
  await withHarness(
    async (h) => {
      const api = installFakeCrustdata({ searchPages: [five(), people(["Fay Gold"]), people(["Gus Hale"])] });
      try {
        const result = await click();
        assert.equal(result.ok, true);
        const affinityBodies = api.calls
          .filter((c) => c.url === SEARCH_URL && JSON.stringify(c.body).includes('"search"'))
          .map((c) => (c.body as { search: { query: string } }).search.query);
        assert.ok(affinityBodies.length >= 1 && affinityBodies.length <= 3, "at most three affinity searches");
        assert.ok(affinityBodies.some((q) => q.includes("Trojan Investing Society")), "the club is searched");
        const { metrics } = await onlyRun(h);
        assert.equal(metrics.affinityEnabled, true);
        const recorded = JSON.stringify(metrics);
        assert.ok(!recorded.includes("Trojan") && !recorded.includes("Boise"), "metrics hold categories, not terms");
        assert.ok(metrics.searches.some((s) => s.searchType === "affinity" && s.signalCategory === "club"));
      } finally {
        api.restore();
      }
    },
    { CONTACT_AFFINITY_SEARCH: "on" },
  );
});

test("deleting a generated contact keeps its outcomes against the run, and nothing personal", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({ searchPages: [five()] });
    try {
      await click();
      const { run } = await onlyRun(h);
      const [target] = await h.db.select().from(contacts).where(eq(contacts.sourcingRank, 2));
      await h.db.insert(emailDrafts).values({
        userId: USER_ID,
        contactId: target.id,
        subject: "Coffee chat?",
        body: "Hi",
        sentAt: new Date(),
        gotReply: true,
      });

      assert.equal(await removeContact(h.db as never, USER_ID, target.id), true);

      const outcomes = await h.db.select().from(contactSourcingOutcomes);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].runId, run.id);
      assert.equal(outcomes[0].sourcingRank, 2);
      assert.equal(outcomes[0].event, "removed");
      assert.equal(outcomes[0].hadDraft, true);
      assert.equal(outcomes[0].markedSent, true);
      assert.equal(outcomes[0].gotReply, true);
      assert.equal((await h.db.select().from(contacts).where(eq(contacts.id, target.id))).length, 0);
      const [draft] = await h.db.select().from(emailDrafts);
      assert.equal(draft.contactId, null, "the draft survives, unlinked - which is why the snapshot exists");

      assert.equal(await removeContact(h.db as never, "33333333-3333-4333-8333-333333333333", target.id), false, "not someone else's");
    } finally {
      api.restore();
    }
  });
});

test("deleting a contact the student added themselves writes no outcome", async () => {
  await withHarness(async (h) => {
    const [mine] = await h.db.insert(contacts).values({ userId: USER_ID, name: "Hand Added", firm: "Evercore" }).returning();
    assert.equal(await removeContact(h.db as never, USER_ID, mine.id), true);
    assert.equal((await h.db.select().from(contactSourcingOutcomes)).length, 0);
  });
});
