/**
 * The contact-sourcing run, against a REAL database.
 *
 * Everything below drives `runContactSourcing` - the function the server
 * action calls, with only `getCurrentUser` and `revalidatePath` left outside
 * it - over a PGlite instance migrated by replaying drizzle/*.sql. The unique
 * index, the check constraints, the transaction and the foreign keys are the
 * real ones. Claims about concurrency and billing cannot be made against a
 * stub: a fake that "models" ON CONFLICT proves only that the fake works.
 *
 * NO LIVE CALLS. The provider is a fake installed at global fetch, and any URL
 * it does not recognise throws. There is no API key, no connection string and
 * no network in this file.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  ENRICH_URL,
  VERIFIED_EMAIL_SEARCH,
  IDENTIFY_URL,
  SEARCH_URL,
  fakeProfile,
  installFakeCrustdata,
  type FakeOptions,
} from "./helpers/fake-crustdata";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { contacts, contactSourcingRuns, firmEmailPatterns, firms, users } from "@/db/schema";
import { runContactSourcing } from "@/lib/contact-sourcing-run";
import { PENDING_STALE_MS } from "@/lib/sourcing-run-policy";
import { eq } from "drizzle-orm";

/**
 * The whole error chain as text.
 *
 * Drizzle wraps a driver error in one whose message is the SQL it sent, so
 * the constraint name - the only thing that says WHICH rule fired - is only
 * ever on `cause`. Matching the outer message would pass for any failed
 * insert, including a typo in the test.
 */
function chain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 6 && current; i++) {
    parts.push(String((current as { message?: string }).message ?? current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

const EVERCORE_ID = 682795;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const FIRM_ID = "22222222-2222-4222-8222-222222222222";

/** A signed-in student with a plan that has a real allowance. */
async function seed(h: TestDatabase) {
  await h.db.insert(users).values({
    id: USER_ID,
    // Deliberately NOT an unlimited or internal address: the allowance and the
    // charge have to be observable.
    email: "student@example.edu",
    passwordHash: "not-a-real-hash",
    name: "Test Student",
    plan: "pro",
    school: "University of Southern California",
    gradYear: 2027,
    major: "Business Administration",
  });

  await h.db.insert(firms).values({
    id: FIRM_ID,
    name: "Evercore",
    slug: "evercore",
    headquarters: "New York, NY",
    keyOffices: "New York",
    description: "Independent investment bank.",
    website: "https://evercore.com",
    // Pre-verified, so `ensureVerifiedIdentity` returns without resolving.
    // The resolution gate has its own tests; this file is about the run.
    crustdataCompanyId: EVERCORE_ID,
    verifiedDomain: "evercore.com",
    identityStatus: "verified",
    identityConfidence: 95,
    identityCheckedAt: new Date(),
    verifiedAt: new Date(),
  });
}

type Harness = TestDatabase & { restoreDb: () => void };

async function harness(): Promise<Harness> {
  const h = await createTestDb();
  const restoreDb = installAsAppDb(h.db);
  await seed(h);
  return { ...h, restoreDb };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness();
  try {
    await fn(h);
  } finally {
    h.restoreDb();
    await h.close();
  }
}

/** Five ordinary Evercore analysts, one page. */
function fivePeople() {
  return [
    ["Ada Lin", 2024],
    ["Ben Ortiz", 2023],
    ["Cara Nwosu", 2025],
    ["Dev Shah", 2022],
    ["Elena Marsh", 2026],
  ].map(([name, year]) =>
    fakeProfile({ name: name as string, companyId: EVERCORE_ID, gradYear: year as number }),
  );
}

function provider(over: FakeOptions = {}) {
  return installFakeCrustdata({ searchPages: [fivePeople()], ...over });
}

const click = (over: Parameters<typeof runContactSourcing>[0]["mode"] extends never ? never : Partial<Parameters<typeof runContactSourcing>[0]> = {}) =>
  runContactSourcing({
    user: { id: USER_ID, email: "student@example.edu" },
    firmId: FIRM_ID,
    ...over,
  });

// ============================================================ the happy path

test("'fill' with no earlier run is charged as the generate it is", async () => {
  // `mode` comes from the browser and the free-fill path waives the charge, so
  // a client sending mode:'fill' as its FIRST request once got a paid provider
  // run for nothing - repeatably, since the fill key is the generate key and
  // the fill branch ran before the cache rules.
  await withHarness(async (h) => {
    const api = provider();
    try {
      const result = await click({ mode: "fill" });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.contacts.length, 5, "the student still gets their people");

      const rows = await h.db.select().from(contactSourcingRuns);
      assert.equal(rows.length, 1, "one run row");
      assert.equal(rows[0].status, "succeeded");
      assert.equal(rows[0].creditsSpent, 1, "charged - there was no paid run to complete");
    } finally {
      api.restore();
    }
  });
});

test("'fill' cannot be repeated for free once the set is complete", async () => {
  await withHarness(async (h) => {
    const api = provider();
    try {
      await click({ mode: "fill" }); // charged as a generate, saves five
      const again = await click({ mode: "fill" });
      assert.equal(again.ok, true);
      if (!again.ok) return;
      // The set is complete, so this is served from cache rather than re-run.
      assert.equal(again.decision, "serve_cached");

      const rows = await h.db.select().from(contactSourcingRuns);
      assert.equal(rows.length, 1, "no second run row");
      const spent = rows.reduce((n, r) => n + r.creditsSpent, 0);
      assert.equal(spent, 1, "exactly one charge across both clicks");
      assert.equal(api.countOf(SEARCH_URL), 1, "the provider was not called twice");
    } finally {
      api.restore();
    }
  });
});

test("a first click runs the provider, saves people and charges exactly one credit", async () => {
  await withHarness(async (h) => {
    const api = provider();
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.equal(result.status, "sourced");
      assert.equal(result.decision, "run");
      assert.equal(result.contacts.length, 5);

      const rows = await h.db.select().from(contactSourcingRuns);
      assert.equal(rows.length, 1, "one run row");
      assert.equal(rows[0].status, "succeeded");
      assert.equal(rows[0].contactsCreated, 5);
      assert.equal(rows[0].creditsSpent, 1, "one run, one credit - not one per contact");
      assert.equal(rows[0].mode, "generate");
      assert.equal(rows[0].idempotencyKey, `${USER_ID}:${FIRM_ID}:generate`);

      const saved = await h.db.select().from(contacts);
      assert.equal(saved.length, 5);
      assert.ok(api.countOf(SEARCH_URL) >= 1, "the provider was actually called");
    } finally {
      api.restore();
    }
  });
});

test("every rendered address is on the firm's own domain", async () => {
  await withHarness(async () => {
    const api = provider({
      emails: {
        "https://www.linkedin.com/in/ada-lin": { email: "ada.lin@evercore.com", status: "deliverable" },
      },
    });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      for (const c of result.contacts) {
        if (!c.email) continue;
        assert.ok(c.email.endsWith("@evercore.com"), `${c.name}: ${c.email}`);
        assert.equal(c.emailDomainRelevant, true, c.name);
      }
    } finally {
      api.restore();
    }
  });
});

test("an off-domain provider address never reaches the student", async () => {
  await withHarness(async (h) => {
    // The Vikram Jolly shape: enrichment answers with a former employer's
    // domain. It must not be rendered and must not teach the pattern.
    const api = provider({
      emails: {
        "https://www.linkedin.com/in/ada-lin": { email: "ada.lin@greenhill.com", status: "deliverable" },
      },
    });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      for (const c of result.contacts) {
        assert.ok(!c.email?.includes("greenhill.com"), `${c.name}: ${c.email}`);
      }
      const [row] = await h.db.select().from(contacts).where(eq(contacts.name, "Ada Lin"));
      assert.equal(row.emailRawProvider, "ada.lin@greenhill.com", "the raw answer is kept for diagnosis");
      assert.notEqual(row.email, "ada.lin@greenhill.com", "but never as the usable address");
    } finally {
      api.restore();
    }
  });
});

// ======================================================== idempotency & cache

test("two SEQUENTIAL clicks create one run, one charge, and call the provider once", async () => {
  await withHarness(async (h) => {
    const api = provider();
    try {
      const first = await click();
      const searchesAfterFirst = api.countOf(SEARCH_URL);
      const second = await click();

      assert.equal(first.ok && first.decision, "run");
      assert.equal(second.ok && second.decision, "serve_cached");
      assert.equal(second.ok && second.status, "cached");

      assert.equal(
        api.countOf(SEARCH_URL),
        searchesAfterFirst,
        "the repeat click reached the provider",
      );
      assert.equal(api.countOf(IDENTIFY_URL), 0, "a cached click must not even identify the company");
      assert.equal(second.ok && second.creditsUsed, 0);

      const runs = await h.db.select().from(contactSourcingRuns);
      assert.equal(runs.length, 1, "a second run row was written");
      assert.equal(runs[0].creditsSpent, 1, "charged twice");

      // The student sees the same five people, not an empty list.
      assert.equal(second.ok && second.contacts.length, 5);
    } finally {
      api.restore();
    }
  });
});

test("two CONCURRENT clicks produce one provider workflow and at most one charge", async () => {
  await withHarness(async (h) => {
    // Hold the first search open until both requests are past the claim, so
    // they genuinely overlap rather than queueing.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;

    const api = provider({
      searchPages: [fivePeople(), fivePeople()],
      onSearch: async () => {
        if (held) return;
        held = true;
        await gate;
      },
    });

    try {
      const a = click();
      // Let the first request reach the provider and block there.
      await new Promise((r) => setTimeout(r, 30));
      const b = click();
      await new Promise((r) => setTimeout(r, 30));
      release();

      const [first, second] = await Promise.all([a, b]);

      const runs = await h.db.select().from(contactSourcingRuns);
      assert.equal(runs.length, 1, `expected one run row, got ${runs.length}`);

      const charged = runs.reduce((n, r) => n + r.creditsSpent, 0);
      assert.ok(charged <= 1, `charged ${charged} credits for one intent`);

      const decisions = [first.ok && first.decision, second.ok && second.decision].sort();
      assert.deepEqual(decisions, ["join_in_flight", "run"], `got ${decisions.join(", ")}`);

      // One workflow: the loser never searched.
      assert.equal(api.countOf(SEARCH_URL), 1, "two provider searches ran for one intent");

      const saved = await h.db.select().from(contacts);
      assert.equal(saved.length, 5, "the loser saved a second copy of everyone");
    } finally {
      api.restore();
    }
  });
});

test("the in-flight loser is told so, and is charged nothing", async () => {
  await withHarness(async (h) => {
    // A pending run already holds the key - the state a second tab arrives in.
    await h.db.insert(contactSourcingRuns).values({
      userId: USER_ID,
      firmId: FIRM_ID,
      idempotencyKey: `${USER_ID}:${FIRM_ID}:generate`,
      mode: "generate",
      status: "pending",
      creditsSpent: 0,
      contactsRequested: 5,
    });

    const api = provider();
    try {
      const result = await click();
      assert.equal(result.ok && result.status, "in_progress");
      assert.equal(result.ok && result.creditsUsed, 0);
      assert.equal(api.calls.length, 0, "the joining request called the provider");

      const runs = await h.db.select().from(contactSourcingRuns);
      assert.equal(runs.length, 1);
    } finally {
      api.restore();
    }
  });
});

test("an ABANDONED pending run does not lock the firm forever", async () => {
  await withHarness(async (h) => {
    await h.db.insert(contactSourcingRuns).values({
      userId: USER_ID,
      firmId: FIRM_ID,
      idempotencyKey: `${USER_ID}:${FIRM_ID}:generate`,
      mode: "generate",
      status: "pending",
      creditsSpent: 0,
      contactsRequested: 5,
      createdAt: new Date(Date.now() - PENDING_STALE_MS - 60_000),
    });

    const api = provider();
    try {
      const result = await click();
      assert.equal(result.ok && result.decision, "run", "the ghost blocked the retry");

      const runs = await h.db.select().from(contactSourcingRuns);
      assert.equal(runs.length, 2, "the abandoned row should be kept as evidence");
      const ghost = runs.find((r) => r.error?.startsWith("Abandoned"));
      assert.ok(ghost, "the abandoned run was not marked");
      assert.equal(ghost.idempotencyKey, null, "its key must be released, not reused");
      assert.equal(ghost.creditsSpent, 0, "an abandoned run is not a charge");
    } finally {
      api.restore();
    }
  });
});

// ================================================================= billing

test("an EMPTY run is uncharged and leaves nothing behind", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({ searchPages: [[], [], [], [], [], []] });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.contacts.length, 0);

      const [run] = await h.db.select().from(contactSourcingRuns);
      assert.equal(run.status, "succeeded", "it happened, and the log should say so");
      assert.equal(run.contactsCreated, 0);
      assert.equal(run.creditsSpent, 0, "charged for nothing");
      assert.equal((await h.db.select().from(contacts)).length, 0);
    } finally {
      api.restore();
    }
  });
});

test("a FAILED run is uncharged", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({ searchPages: [fivePeople()], failSearchWith: 500 });
    try {
      const result = await click();
      assert.equal(result.ok, false, "a provider error should surface as an error");

      const [run] = await h.db.select().from(contactSourcingRuns);
      assert.equal(run.status, "failed");
      assert.equal(run.creditsSpent, 0);
      assert.ok(run.error, "the reason was not recorded");
      assert.equal((await h.db.select().from(contacts)).length, 0);
    } finally {
      api.restore();
    }
  });
});

test("a rate limit is a failure, not a charge, and does not become a cache", async () => {
  await withHarness(async (h) => {
    const limited = installFakeCrustdata({ failSearchWith: 429 });
    try {
      const first = await click();
      assert.equal(first.ok, false);
    } finally {
      limited.restore();
    }

    // The next click must RUN - a failed run is not a cached result.
    const ok = provider();
    try {
      const second = await click();
      assert.equal(second.ok && second.decision, "run");
      assert.equal(second.ok && second.contacts.length, 5);

      const runs = await h.db.select().from(contactSourcingRuns);
      const charged = runs.reduce((n, r) => n + r.creditsSpent, 0);
      assert.equal(charged, 1, "the rate-limited attempt was charged");
    } finally {
      ok.restore();
    }
  });
});

test("a saved result and its charge cannot become inconsistent - the DATABASE refuses", async () => {
  await withHarness(async (h) => {
    // The rule lives in application code AND in the table. This proves the
    // table enforces it, so a future code path that forgets cannot write the
    // state where a student is billed for contacts that do not exist.
    await assert.rejects(
      h.db.insert(contactSourcingRuns).values({
        userId: USER_ID,
        firmId: FIRM_ID,
        status: "succeeded",
        creditsSpent: 1,
        contactsCreated: 0,
        contactsRequested: 5,
      }),
      (err: unknown) => /contact_sourcing_charge_needs_contacts/i.test(chain(err)),
    );

    await assert.rejects(
      h.db.insert(contactSourcingRuns).values({
        userId: USER_ID,
        firmId: FIRM_ID,
        status: "succeeded",
        creditsSpent: -1,
        contactsCreated: 3,
        contactsRequested: 5,
      }),
      (err: unknown) => /contact_sourcing_credits_nonnegative/i.test(chain(err)),
    );
  });
});

test("the unique index is what stops a second run, not the application", async () => {
  await withHarness(async (h) => {
    const key = `${USER_ID}:${FIRM_ID}:generate`;
    await h.db.insert(contactSourcingRuns).values({
      userId: USER_ID,
      firmId: FIRM_ID,
      idempotencyKey: key,
      status: "succeeded",
      creditsSpent: 1,
      contactsCreated: 5,
      contactsRequested: 5,
    });
    await assert.rejects(
      h.db.insert(contactSourcingRuns).values({
        userId: USER_ID,
        firmId: FIRM_ID,
        idempotencyKey: key,
        status: "pending",
        creditsSpent: 0,
        contactsRequested: 5,
      }),
      (err: unknown) => /contact_sourcing_idempotency_uq|duplicate key/i.test(chain(err)),
    );
  });
});

test("legacy rows with no key do not collide with each other", async () => {
  await withHarness(async (h) => {
    // The index is PARTIAL for exactly this reason: every row written before
    // the migration has a null key, and an unconditional unique index would
    // let only one of them exist.
    for (let i = 0; i < 3; i++) {
      await h.db.insert(contactSourcingRuns).values({
        userId: USER_ID,
        firmId: FIRM_ID,
        status: "failed",
        creditsSpent: 0,
        contactsRequested: 5,
      });
    }
    assert.equal((await h.db.select().from(contactSourcingRuns)).length, 3);
  });
});

// =========================================================== refresh & fill

test("a refresh is deliberately a NEW request, and is charged", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({
      searchPages: [
        fivePeople(),
        [
          fakeProfile({ name: "Farah Idris", companyId: EVERCORE_ID }),
          fakeProfile({ name: "Gus Weber", companyId: EVERCORE_ID }),
        ],
      ],
    });
    try {
      await click();
      const refreshed = await click({ mode: "refresh" });
      assert.equal(refreshed.ok && refreshed.decision, "run", "a refresh served a cache");

      const runs = await h.db.select().from(contactSourcingRuns);
      assert.equal(runs.length, 2);
      const refresh = runs.find((r) => r.mode === "refresh");
      assert.ok(refresh);
      assert.equal(refresh.refreshSequence, 1, "the first refresh is sequence 1");
      assert.equal(refresh.idempotencyKey, `${USER_ID}:${FIRM_ID}:refresh:1`);
      assert.equal(refresh.creditsSpent, 1, "a refresh that found people is a charge");
    } finally {
      api.restore();
    }
  });
});

test("successive refreshes get distinct keys and both run", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({
      searchPages: [
        [fakeProfile({ name: "Hana Park", companyId: EVERCORE_ID })],
        [fakeProfile({ name: "Ivo Costa", companyId: EVERCORE_ID })],
      ],
    });
    try {
      const one = await click({ mode: "refresh" });
      const two = await click({ mode: "refresh" });
      assert.equal(one.ok && one.decision, "run");
      assert.equal(two.ok && two.decision, "run");

      const keys = (await h.db.select().from(contactSourcingRuns)).map((r) => r.idempotencyKey);
      assert.equal(new Set(keys).size, keys.length, `refreshes shared a key: ${keys.join(", ")}`);
    } finally {
      api.restore();
    }
  });
});

test("a FILL shares the original run and creates no new charge", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({
      // A partial first result; the person who completes it is queued for
      // the fill below, however many rungs the first click walks.
      searchPages: [
        [
          fakeProfile({ name: "Jae Moon", companyId: EVERCORE_ID }),
          fakeProfile({ name: "Kit Alvarez", companyId: EVERCORE_ID }),
        ],
      ],
    });
    try {
      const first = await click();
      assert.equal(first.ok && first.contacts.length, 2, "expected a partial first result");

      api.enqueueSearchPages([fakeProfile({ name: "Lior Adan", companyId: EVERCORE_ID })]);
      api.enqueueSearchPages([fakeProfile({ name: "Lior Adan", companyId: EVERCORE_ID })]);
    const filled = await click({ mode: "fill" });
      assert.equal(filled.ok && filled.decision, "run", "a fill must actually run");

      const runs = await h.db.select().from(contactSourcingRuns);
      assert.equal(runs.length, 1, "a fill started a second run");
      assert.equal(runs[0].idempotencyKey, `${USER_ID}:${FIRM_ID}:generate`, "the fill took a new key");
      assert.equal(runs[0].creditsSpent, 1, "a fill charged a second credit");
      assert.equal(runs[0].contactsCreated, 3, "the run row should total the intent, not the last attempt");

      const saved = await h.db.select().from(contacts);
      assert.equal(saved.length, 3, "the fill lost or duplicated the original two");
    } finally {
      api.restore();
    }
  });
});

// ============================================================== the ledger

test("the allowance counts settled runs, and an in-flight run provisionally", async () => {
  await withHarness(async (h) => {
    const api = provider();
    try {
      const result = await click();
      assert.equal(result.ok && result.credits.used, 1);
      assert.equal(result.ok && result.credits.limit, 30, "the pro allowance");
    } finally {
      api.restore();
    }

    // A pending run at another firm counts as one against the allowance, so
    // twenty tabs cannot start twenty paid workflows on a three-run plan.
    await h.db.insert(firms).values({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Lazard",
      slug: "lazard",
      headquarters: "New York, NY",
      keyOffices: "New York",
      description: "Independent investment bank.",
      website: "https://lazard.com",
      identityStatus: "verified",
      crustdataCompanyId: 1234,
    });
    await h.db.insert(contactSourcingRuns).values({
      userId: USER_ID,
      firmId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: `${USER_ID}:33333333-3333-4333-8333-333333333333:generate`,
      status: "pending",
      creditsSpent: 0,
      contactsRequested: 5,
    });

    const { getContactCredits } = await import("@/lib/contact-credits");
    const credits = await getContactCredits(USER_ID);
    assert.equal(credits.used, 2, "the in-flight run was not counted");
  });
});

test("a student out of credits is refused before the provider is touched", async () => {
  await withHarness(async (h) => {
    // Thirty settled runs = the whole pro allowance.
    for (let i = 0; i < 30; i++) {
      await h.db.insert(contactSourcingRuns).values({
        userId: USER_ID,
        firmId: FIRM_ID,
        status: "succeeded",
        creditsSpent: 1,
        contactsCreated: 5,
        contactsRequested: 5,
      });
    }

    const api = provider();
    try {
      const result = await click();
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /used all 30 contact generations/);
      assert.equal(api.calls.length, 0, "the provider was called for a student with no credits");
    } finally {
      api.restore();
    }
  });
});

test("a free account is refused outright - contact sourcing is a paid feature", async () => {
  await withHarness(async (h) => {
    await h.db.update(users).set({ plan: "free" }).where(eq(users.id, USER_ID));
    const api = provider();
    try {
      const result = await click();
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /part of Offerly Pro/);
      assert.equal(api.calls.length, 0, "the provider was called for a free account");
    } finally {
      api.restore();
    }
  });
});

// ========================================================== employment gate

test("nobody without a confirmed company id is saved, and the run is uncharged", async () => {
  await withHarness(async (h) => {
    // The fail-closed case: the provider answers, but no profile carries the
    // selected firm's company id. Five unverifiable people is worse than none.
    const nobodyPlaceable = [
      { ...fakeProfile({ name: "Mara Voss", companyId: EVERCORE_ID }), experience: {} },
      { ...fakeProfile({ name: "Nils Berg", companyId: EVERCORE_ID }), experience: {} },
    ];
    const api = installFakeCrustdata({
      searchPages: [nobodyPlaceable, [], [], [], [], []],
    });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.contacts.length, 0, "an unplaceable person was saved anyway");

      const [run] = await h.db.select().from(contactSourcingRuns);
      assert.equal(run.creditsSpent, 0);
      assert.equal((await h.db.select().from(contacts)).length, 0);
    } finally {
      api.restore();
    }
  });
});

test("a former employee at the firm is rejected", async () => {
  await withHarness(async (h) => {
    const api = installFakeCrustdata({
      searchPages: [
        [fakeProfile({ name: "Vikram Jolly", companyId: EVERCORE_ID, pastCompanyId: EVERCORE_ID })],
        [], [], [], [], [],
      ],
    });
    try {
      const result = await click();
      assert.equal(result.ok && result.contacts.length, 0, "a past employee was admitted");
      assert.equal((await h.db.select().from(contacts)).length, 0);
    } finally {
      api.restore();
    }
  });
});

test("the same person returned twice across tiers is saved once", async () => {
  await withHarness(async (h) => {
    const ada = fakeProfile({ name: "Ada Lin", companyId: EVERCORE_ID, personId: 4242 });
    const api = installFakeCrustdata({
      searchPages: [[ada], [ada], [ada], [ada], [ada], [ada]],
    });
    try {
      const result = await click();
      assert.equal(result.ok && result.contacts.length, 1);
      const saved = await h.db.select().from(contacts);
      assert.equal(saved.length, 1, `saved ${saved.length} copies of one person`);
    } finally {
      api.restore();
    }
  });
});

test("two different people who share a name are both kept", async () => {
  await withHarness(async (h) => {
    // The John Smith rule. Different stable ids are evidence they are
    // distinct; a shared name is not evidence they are the same. Both at the
    // student's school - this is about names, and the school review would
    // rightly turn away a second John Smith from somewhere else.
    const api = installFakeCrustdata({
      searchPages: [
        [
          fakeProfile({ name: "John Smith", companyId: EVERCORE_ID, personId: 1001, linkedin: "https://www.linkedin.com/in/john-smith-a", title: "Analyst", city: "New York City" }),
          fakeProfile({ name: "John Smith", companyId: EVERCORE_ID, personId: 1002, linkedin: "https://www.linkedin.com/in/john-smith-b", title: "Vice President", city: "London", gradYear: 2015 }),
        ],
        [], [], [], [], [],
      ],
    });
    try {
      const result = await click();
      assert.equal(result.ok && result.contacts.length, 2, "one of the two John Smiths was dropped");
      assert.equal((await h.db.select().from(contacts)).length, 2);
    } finally {
      api.restore();
    }
  });
});

// ============================================================ the enrichment

test("enrichment stops once the firm's pattern is known", async () => {
  await withHarness(async () => {
    const api = provider({
      emails: {
        "https://www.linkedin.com/in/ada-lin": { email: "ada.lin@evercore.com", status: "deliverable" },
        "https://www.linkedin.com/in/ben-ortiz": { email: "ben.ortiz@evercore.com", status: "deliverable" },
        "https://www.linkedin.com/in/cara-nwosu": { email: "cara.nwosu@evercore.com", status: "deliverable" },
        "https://www.linkedin.com/in/dev-shah": { email: "dev.shah@evercore.com", status: "deliverable" },
        "https://www.linkedin.com/in/elena-marsh": { email: "elena.marsh@evercore.com", status: "deliverable" },
      },
    });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // Buying an address costs a credit each time; the shape is free to
      // apply. So enrichment must stop as soon as the pattern is confirmed.
      assert.ok(
        api.countOf(ENRICH_URL) < 5,
        `enriched ${api.countOf(ENRICH_URL)} people after the pattern was known`,
      );
      assert.equal(result.contacts.filter((c) => c.email).length, 5, "the rest were not derived");
    } finally {
      api.restore();
    }
  });
});

// ============================================================== atomicity

test("the transaction the charge relies on actually rolls back", async () => {
  await withHarness(async (h) => {
    // Not a claim about the action - a claim about the mechanism underneath
    // it. If this driver committed partial transactions, every "both or
    // neither" assertion in this file would be describing something that does
    // not happen.
    await assert.rejects(
      h.db.transaction(async (tx) => {
        await tx.insert(contacts).values({
          userId: USER_ID,
          name: "Rolled Back",
          firm: "Evercore",
        });
        throw new Error("deliberate");
      }),
      /deliberate/,
    );
    const saved = await h.db.select().from(contacts);
    assert.equal(saved.length, 0, "a contact survived a rolled-back transaction");
  });
});

test("the run's contact count always equals the contacts that exist", async () => {
  await withHarness(async (h) => {
    const api = provider();
    try {
      await click();
    } finally {
      api.restore();
    }
    const runs = await h.db.select().from(contactSourcingRuns);
    const saved = await h.db.select().from(contacts);
    const counted = runs.reduce((n, r) => n + r.contactsCreated, 0);
    assert.equal(counted, saved.length, "the ledger and the contacts disagree");
    // And the charge follows the contacts, not the attempt.
    for (const run of runs) {
      if (run.creditsSpent > 0) assert.ok(run.contactsCreated > 0, "charged with nothing to show");
    }
  });
});

test("a run for one student is never served to another", async () => {
  await withHarness(async (h) => {
    const other = "44444444-4444-4444-8444-444444444444";
    await h.db.insert(users).values({
      id: other,
      email: "other@example.edu",
      passwordHash: "not-a-real-hash",
      name: "Other Student",
      plan: "pro",
    });

    const api = installFakeCrustdata({
      searchPages: [fivePeople(), [fakeProfile({ name: "Omar Diaz", companyId: EVERCORE_ID })]],
    });
    try {
      await click();
      const theirs = await runContactSourcing({
        user: { id: other, email: "other@example.edu" },
        firmId: FIRM_ID,
      });
      assert.equal(theirs.ok && theirs.decision, "run", "one student's cache served another's click");

      const keys = (await h.db.select().from(contactSourcingRuns)).map((r) => r.idempotencyKey);
      assert.equal(new Set(keys).size, 2, "two students shared an idempotency key");
    } finally {
      api.restore();
    }
  });
});

// ========================================================== the migration

test("0008 is repeatable: applying it twice changes nothing and throws nothing", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFileSync } = await import("node:fs");
  const { applyMigrations } = await import("./helpers/test-db");

  const client = new PGlite();
  await applyMigrations(client);

  const shape = async () => {
    const cols = await client.query<{ c: string }>(
      "select column_name as c from information_schema.columns where table_name='contact_sourcing_runs' order by 1",
    );
    const idx = await client.query<{ c: string }>(
      "select indexname as c from pg_indexes where tablename='contact_sourcing_runs' order by 1",
    );
    const con = await client.query<{ c: string }>(
      "select conname as c from pg_constraint where conrelid='contact_sourcing_runs'::regclass order by 1",
    );
    return [cols, idx, con].map((r) => r.rows.map((x) => x.c).join(","));
  };

  const before = await shape();
  const sql = readFileSync("drizzle/0008_sourcing_run_idempotency.sql", "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await client.exec(trimmed);
  }
  assert.deepEqual(await shape(), before, "re-applying 0008 changed the table");

  // And the pieces it is supposed to add are actually there.
  const [cols, idx, con] = before;
  for (const c of ["idempotency_key", "mode", "refresh_sequence"]) assert.ok(cols.includes(c), c);
  assert.ok(idx.includes("contact_sourcing_idempotency_uq"));
  assert.ok(idx.includes("contact_sourcing_user_firm_status_idx"));
  assert.ok(con.includes("contact_sourcing_charge_needs_contacts"));
  assert.ok(con.includes("contact_sourcing_credits_nonnegative"));
  await client.close();
});

test("a legacy row that violates the new CHECK survives 0008, because it is NOT VALID", async () => {
  // The whole point of NOT VALID, proved rather than asserted. The row is
  // written BEFORE the constraint exists - which is the only way a historical
  // violation can exist - and then 0008 is applied on top of it.
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFileSync } = await import("node:fs");
  const { migrationFiles } = await import("./helpers/test-db");
  const { pinUtcClock } = await import("@/db/utc-clock");

  const client = new PGlite();
  await pinUtcClock(client);

  const files = migrationFiles();
  const upTo0007 = files.filter((f) => !f.includes("0008"));
  const only0008 = files.filter((f) => f.includes("0008"));
  const apply = async (list: string[]) => {
    for (const file of list) {
      for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) await client.exec(trimmed);
      }
    }
  };

  await apply(upTo0007);
  await client.exec(`
    insert into users (id, email, password_hash, name, plan)
    values ('${USER_ID}', 'legacy@example.edu', 'x', 'Legacy', 'pro')
  `);
  await client.exec(`
    insert into firms (id, slug, name, headquarters, key_offices, description, website)
    values ('${FIRM_ID}', 'evercore', 'Evercore', 'New York, NY', 'New York', 'd', 'https://evercore.com')
  `);
  // Charged one credit, produced nobody - the old behaviour, and exactly what
  // contact_sourcing_charge_needs_contacts now forbids.
  await client.exec(`
    insert into contact_sourcing_runs (user_id, firm_id, credits_spent, contacts_requested, contacts_created, status)
    values ('${USER_ID}', '${FIRM_ID}', 1, 5, 0, 'succeeded')
  `);

  await apply(only0008);

  const after = await client.query<{ n: number }>(
    "select count(*)::int as n from contact_sourcing_runs",
  );
  assert.equal(after.rows[0].n, 1, "0008 destroyed or rejected a historical row");

  const row = await client.query<{ idempotency_key: string | null; mode: string; refresh_sequence: number }>(
    "select idempotency_key, mode, refresh_sequence from contact_sourcing_runs",
  );
  assert.equal(row.rows[0].idempotency_key, null);
  assert.equal(row.rows[0].mode, "generate", "the new column's default did not backfill");
  assert.equal(row.rows[0].refresh_sequence, 0);

  // And the constraint really is unvalidated, which is what let it survive.
  const con = await client.query<{ convalidated: boolean }>(
    "select convalidated from pg_constraint where conname = 'contact_sourcing_charge_needs_contacts'",
  );
  assert.equal(con.rows[0].convalidated, false, "the constraint was added as VALID");

  // A NEW row of the same shape is still refused.
  await assert.rejects(
    client.exec(`
      insert into contact_sourcing_runs (user_id, firm_id, credits_spent, contacts_requested, contacts_created, status)
      values ('${USER_ID}', '${FIRM_ID}', 1, 5, 0, 'succeeded')
    `),
    /contact_sourcing_charge_needs_contacts/,
  );

  await client.close();
});

// ======================================================= the hidden pattern probe

async function withPrice<T>(usdPerCredit: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.CRUSTDATA_USD_PER_CREDIT;
  if (usdPerCredit === undefined) delete process.env.CRUSTDATA_USD_PER_CREDIT;
  else process.env.CRUSTDATA_USD_PER_CREDIT = usdPerCredit;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.CRUSTDATA_USD_PER_CREDIT;
    else process.env.CRUSTDATA_USD_PER_CREDIT = before;
  }
}

test("no address among the five: a hidden colleague's teaches the shape, and is never saved", async () => {
  await withHarness(async (h) => {
    const colleague = fakeProfile({ name: "Zoe Park", companyId: EVERCORE_ID });
    const api = provider({
      searchPages: [fivePeople(), [colleague]],
      emails: { [colleague.social_handles!.professional_network_identifier!.profile_url!]: { email: "zoe.park@evercore.com", status: "deliverable" } },
    });
    try {
      const result = await withPrice("0.1", () => click());
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.contacts.length, 5, "the colleague was shown");
      const emails = result.contacts.map((c) => c.email);
      assert.ok(emails.every(Boolean), `not every contact got an address: ${emails.join(", ")}`);
      assert.ok(result.contacts.every((c) => c.emailConfidence === "predicted"));
      assert.ok(emails.includes("ada.lin@evercore.com"), "first.last applied to the visible five");
      const saved = await h.db.select().from(contacts);
      assert.equal(saved.length, 5);
      assert.ok(!saved.some((c) => c.name === "Zoe Park"), "the hidden colleague was saved");
      const pattern = await h.db.select().from(firmEmailPatterns);
      assert.equal(pattern[0]?.shape, "first.last", "the shape was not kept for later runs");
    } finally {
      api.restore();
    }
  });
});

test("without a configured price per credit, no hidden search runs", async () => {
  await withHarness(async () => {
    const colleague = fakeProfile({ name: "Zoe Park", companyId: EVERCORE_ID });
    const api = provider({
      searchPages: [fivePeople(), [colleague]],
      emails: { [colleague.social_handles!.professional_network_identifier!.profile_url!]: { email: "zoe.park@evercore.com", status: "deliverable" } },
    });
    try {
      const result = await withPrice(undefined, () => click());
      assert.equal(result.ok && result.contacts.filter((c) => c.email).length, 0);
      assert.equal(api.countOf(SEARCH_URL), 1, "a hidden search ran with no budget");
    } finally {
      api.restore();
    }
  });
});

test("the hidden search stops at the budget", async () => {
  await withHarness(async () => {
    // Ten colleagues, each with only an old employer's address - a credit
    // each and nothing learned. At $1 a credit the $2 budget is two credits.
    const colleagues = Array.from({ length: 10 }, (_, i) =>
      fakeProfile({ name: `Colleague Number${String.fromCharCode(97 + i)}`, companyId: EVERCORE_ID }),
    );
    const emails = Object.fromEntries(
      colleagues.map((c, i) => [c.social_handles!.professional_network_identifier!.profile_url!, { email: `c${i}@greenhill.com`, status: "deliverable" }]),
    );
    const api = provider({ searchPages: [fivePeople(), colleagues], emails });
    try {
      await withPrice("1", () => click());
      assert.ok(api.creditsBilled <= 2 + 1 + 1, `spent ${api.creditsBilled} credits against a 2-credit budget`);
      assert.ok(api.countOf(ENRICH_URL) - 5 <= 3, `enriched ${api.countOf(ENRICH_URL) - 5} hidden people`);
    } finally {
      api.restore();
    }
  });
});

test("an unconfirmed address on the firm's domain, spelled from the name, is enough - no hidden search", async () => {
  await withHarness(async () => {
    // Brookfield's case: the provider has the right mailbox but cannot confirm it.
    const api = provider({
      emails: { "https://www.linkedin.com/in/ada-lin": { email: "ada.lin@evercore.com", status: "unknown" } },
    });
    try {
      const result = await withPrice("0.1", () => click());
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.contacts.filter((c) => c.email).length, 5, "the shape was not applied");
      assert.equal(api.countOf(SEARCH_URL), 1, "searched for hidden people despite knowing the shape");
    } finally {
      api.restore();
    }
  });
});

test("a firm that keeps no verified-email flags still gets its hidden search", async () => {
  await withHarness(async () => {
    // Brookfield: nobody verified. The flagged ask (its own queue, empty)
    // finds no one; the unfiltered one has the colleague.
    const colleague = fakeProfile({ name: "Zoe Park", companyId: EVERCORE_ID });
    const api = provider({
      searchPages: [fivePeople(), [colleague]],
      emails: { [colleague.social_handles!.professional_network_identifier!.profile_url!]: { email: "zoe.park@evercore.com", status: "deliverable" } },
    });
    try {
      const result = await withPrice("0.1", () => click());
      assert.equal(result.ok && result.contacts.filter((c) => c.email).length, 5, "the empty flagged page ended the search");
    } finally {
      api.restore();
    }
  });
});

test("a firm whose pattern another student already taught buys no addresses", async () => {
  await withHarness(async (h) => {
    // Stored by an earlier run - any student's. The pattern is the firm's.
    const { recordObservation } = await import("@/lib/email-patterns");
    let tally = recordObservation({}, "first.last", "evercore.com");
    tally = recordObservation(tally, "first.last", "evercore.com");
    await h.db.insert(firmEmailPatterns).values({ firmId: FIRM_ID, shape: "first.last", domain: "evercore.com", samples: 2, tally });

    const api = provider({
      emails: { "https://www.linkedin.com/in/ada-lin": { email: "ada.lin@evercore.com", status: "deliverable" } },
    });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(api.countOf(ENRICH_URL), 0, "paid for an address the stored pattern already gives");
      assert.equal(result.contacts.filter((c) => c.email).length, 5);
      assert.ok(result.contacts.every((c) => c.emailConfidence === "predicted"));
      assert.ok(result.contacts.some((c) => c.email === "ada.lin@evercore.com"));
    } finally {
      api.restore();
    }
  });
});

// ============================================================ the email anchor

test("a schoolmate with a verified work email joins the five and is enriched first", async () => {
  await withHarness(async (h) => {
    const anchor = fakeProfile({ name: "Vera Quinn", companyId: EVERCORE_ID });
    const anchorUrl = anchor.social_handles!.professional_network_identifier!.profile_url!;
    const api = provider({
      verifiedEmailPages: [[anchor]],
      emails: { [anchorUrl]: { email: "vera.quinn@evercore.com", status: "deliverable" } },
    });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.contacts.length, 5, "the anchor must replace, not add");
      assert.ok(result.contacts.some((c) => c.name === "Vera Quinn"), "the verified schoolmate is not in the five");
      const enriched = api.calls.filter((c) => c.url === ENRICH_URL);
      assert.equal(
        (enriched[0]?.body as { professional_network_profile_urls: string[] }).professional_network_profile_urls[0],
        anchorUrl,
        "the anchor was not enriched first",
      );
      assert.equal(enriched.length, 1, "kept enriching after the anchor taught the pattern");
      assert.equal(result.contacts.filter((c) => c.email).length, 5, "the pattern was not applied to the rest");
      const pattern = await h.db.select().from(firmEmailPatterns);
      assert.equal(pattern[0]?.shape, "first.last");
    } finally {
      api.restore();
    }
  });
});

test("a verified-email anchor from another school is never let in", async () => {
  await withHarness(async () => {
    const outsider = fakeProfile({ name: "Omar Reyes", companyId: EVERCORE_ID, school: "Pennsylvania State University" });
    const api = provider({ verifiedEmailPages: [[outsider]] });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.ok(!result.contacts.some((c) => c.name === "Omar Reyes"), "another school slipped in as the anchor");
      assert.equal(result.contacts.length, 5);
    } finally {
      api.restore();
    }
  });
});

test("no anchor search at a firm whose pattern is already stored", async () => {
  await withHarness(async (h) => {
    const { recordObservation } = await import("@/lib/email-patterns");
    const tally = recordObservation({}, "first.last", "evercore.com");
    await h.db.insert(firmEmailPatterns).values({ firmId: FIRM_ID, shape: "first.last", domain: "evercore.com", samples: 1, tally });
    const api = provider();
    try {
      await click();
      assert.equal(api.countOf(VERIFIED_EMAIL_SEARCH), 0, "searched for an anchor the stored pattern made pointless");
    } finally {
      api.restore();
    }
  });
});

test("one generation never spends past the $2 limit, whatever it runs into", async () => {
  await withHarness(async () => {
    // Every address is another company's: nothing teaches the shape, so the
    // run would enrich and search forever if nothing stopped it. At $1 a
    // credit the limit is two credits - searches, anchor, enrichment and the
    // hidden search together.
    const colleagues = Array.from({ length: 10 }, (_, i) =>
      fakeProfile({ name: `Colleague Number${String.fromCharCode(97 + i)}`, companyId: EVERCORE_ID }),
    );
    const everyone = [...fivePeople(), ...colleagues];
    const emails = Object.fromEntries(
      everyone.map((p, i) => [p.social_handles!.professional_network_identifier!.profile_url!, { email: `x${i}@greenhill.com`, status: "deliverable" }]),
    );
    const api = provider({
      searchPages: [fivePeople(), colleagues],
      emails,
      searchCredits: 0.15, // a five-profile page, as measured
      enrichCredits: 1,
    });
    try {
      const result = await withPrice("1", () => click());
      assert.equal(result.ok, true);
      assert.ok(api.creditsBilled <= 2 + 1e-9, `spent ${api.creditsBilled} credits against a 2-credit limit`);
    } finally {
      api.restore();
    }
  });
});

test("someone whose surname is only an initial is replaced - every contact must be emailable", async () => {
  await withHarness(async () => {
    // "Simran S.": no surname, so no address can be built for her.
    const page = [...fivePeople().slice(0, 4), fakeProfile({ name: "Simran S.", companyId: EVERCORE_ID })];
    const api = provider({
      searchPages: [page, [fakeProfile({ name: "Tara Voss", companyId: EVERCORE_ID })]],
      emails: { "https://www.linkedin.com/in/ada-lin": { email: "ada.lin@evercore.com", status: "deliverable" } },
    });
    try {
      const result = await click();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.ok(!result.contacts.some((c) => c.name === "Simran S."), "an unemailable contact was kept");
      assert.ok(result.contacts.some((c) => c.name === "Tara Voss"), "the same rung was not asked for a replacement");
      assert.equal(result.contacts.filter((c) => c.email).length, result.contacts.length);
    } finally {
      api.restore();
    }
  });
});

test("a rate-limited firm lookup is waited out, not reported as unavailable", async () => {
  await withHarness(async (h) => {
    // Measured: three firms in a sixteen-run test failed "temporarily
    // unavailable" when the lookup allowance was momentarily spent.
    await h.db.update(firms).set({ identityStatus: "unresolved", crustdataCompanyId: null, identityCheckedAt: null }).where(eq(firms.id, FIRM_ID));
    const api = provider({ identifyRateLimited: 1 });
    try {
      const result = await click();
      assert.equal(result.ok, true, result.ok ? "" : result.error);
      assert.equal(result.ok && result.contacts.length, 5);
    } finally {
      api.restore();
    }
  });
});
