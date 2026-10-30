/**
 * The action's database layer, against a REAL PostgreSQL on the REAL driver.
 *
 * Parity, not a second implementation of the offline suite. Every assertion
 * here targets something that could differ between PGlite and
 * postgres-js/Postgres: parameter serialisation, ON CONFLICT arbitration,
 * transaction isolation, timestamp handling, array and null binding.
 *
 * The reason it exists: a JS `Date` interpolated into a raw `sql` template was
 * accepted by PGlite and refused by postgres-js, so 4264 offline tests passed
 * and the first live query threw. PGlite cannot be the only witness.
 *
 * NO CRUSTDATA. The provider is a fake installed at global fetch, and any URL
 * it does not recognise throws. NO SUPABASE - the cluster is created by initdb
 * into a temp directory and destroyed at the end of the file.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import "./helpers/no-network";
import { and, eq, sql } from "drizzle-orm";

import { SEARCH_URL, fakeProfile, installFakeCrustdata, type FakeOptions } from "./helpers/fake-crustdata";
import { installAsAppDb } from "./helpers/test-db";
import { postgresAvailability, startRealPostgres, type RealPostgres } from "./helpers/real-postgres";
import { contacts, contactSourcingRuns, firms, users } from "@/db/schema";
import { runContactSourcing } from "@/lib/contact-sourcing-run";
import { getContactCredits, MONTHLY_CREDITS_USED } from "@/lib/contact-credits";
import { PENDING_STALE_MS } from "@/lib/sourcing-run-policy";

const availability = postgresAvailability();

/**
 * The ONE honest skip in this suite.
 *
 * A machine with no PostgreSQL server binaries cannot run a real cluster, and
 * pretending otherwise would be the same mistake as the seven Form ADV skips.
 * The logic itself is covered by the PGlite suite either way; what is lost
 * here is only the driver comparison. It names itself when it happens.
 */
const skipIfNoPostgres = availability.ok ? undefined : { skip: availability.why };
if (!availability.ok) {
  console.log(`  [postgres parity] UNAVAILABLE: ${availability.why}`);
} else {
  console.log(`  [postgres parity] using ${availability.version} from ${availability.bin}`);
}

const EVERCORE_ID = 682795;
const USER = "11111111-1111-4111-8111-111111111111";
const FIRM = "22222222-2222-4222-8222-222222222222";
const FIRM_B = "33333333-3333-4333-8333-333333333333";

let pg: RealPostgres | null = null;
let restoreDb: (() => void) | null = null;

async function db(): Promise<RealPostgres> {
  if (!pg) {
    pg = await startRealPostgres();
    restoreDb = installAsAppDb(pg.db);
  }
  return pg;
}

after(async () => {
  restoreDb?.();
  await pg?.stop();
});

/** A clean slate between tests, without paying for a new cluster each time. */
async function reset(plan: "free" | "pro" = "pro", email = "student@example.edu") {
  const h = await db();
  await h.sql`truncate table contacts, contact_sourcing_runs, firm_email_patterns, user_top_firms, users, firms restart identity cascade`;
  await h.db.insert(users).values({
    id: USER,
    email,
    passwordHash: "not-a-real-hash",
    name: "Test Student",
    plan,
    school: "University of Southern California",
    gradYear: 2027,
    major: "Business Administration",
  });
  await h.db.insert(firms).values([
    {
      id: FIRM,
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
    },
    {
      id: FIRM_B,
      name: "Lazard",
      slug: "lazard",
      headquarters: "New York, NY",
      keyOffices: "New York",
      description: "Independent investment bank.",
      website: "https://lazard.com",
      crustdataCompanyId: 1234,
      verifiedDomain: "lazard.com",
      identityStatus: "verified",
      identityCheckedAt: new Date(),
      verifiedAt: new Date(),
    },
  ]);
  return h;
}

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

const provider = (over: FakeOptions = {}) =>
  installFakeCrustdata({ searchPages: [fivePeople()], ...over });

const click = (over: Partial<Parameters<typeof runContactSourcing>[0]> = {}) =>
  runContactSourcing({
    user: { id: USER, email: "student@example.edu" },
    firmId: FIRM,
    ...over,
  });

// ===================================================== driver serialisation

test("Date and timestamp parameters survive the real driver", skipIfNoPostgres, async () => {
  const h = await reset();

  // The exact class of bug this file exists for: a JS Date reaching the
  // driver through Drizzle's column-aware path, and through a raw template.
  const born = new Date("2026-09-01T12:34:56.000Z");
  await h.db.insert(contactSourcingRuns).values({
    userId: USER,
    firmId: FIRM,
    status: "succeeded",
    creditsSpent: 1,
    contactsCreated: 5,
    contactsRequested: 5,
    createdAt: born,
    completedAt: born,
  });

  const [row] = await h.db.select().from(contactSourcingRuns);
  assert.equal(row.createdAt.toISOString(), born.toISOString(), "a Date did not round-trip");
  assert.equal(row.completedAt?.toISOString(), born.toISOString());

  // A Date in a WHERE clause, through Drizzle's typed comparison.
  const found = await h.db
    .select()
    .from(contactSourcingRuns)
    .where(sql`${contactSourcingRuns.createdAt} >= ${born.toISOString()}`);
  assert.equal(found.length, 1, "a timestamp comparison lost the row");

  // And the credit-window expression, which is the one that actually broke.
  await assert.doesNotReject(
    h.db.select({ used: MONTHLY_CREDITS_USED }).from(contactSourcingRuns),
    "the monthly credit sum is not portable to postgres-js",
  );
});

test("null and array parameters bind correctly", skipIfNoPostgres, async () => {
  const h = await reset();

  // text[] with a default, an explicit value, and an empty array.
  await h.db
    .update(firms)
    .set({ approvedEmailDomains: ["evercore.com", "evercoreisi.com"], aliases: [] })
    .where(eq(firms.id, FIRM));
  const firm = await h.db.query.firms.findFirst({ where: eq(firms.id, FIRM) });
  assert.deepEqual(firm?.approvedEmailDomains, ["evercore.com", "evercoreisi.com"]);
  assert.deepEqual(firm?.aliases, [], "an empty array came back as something else");

  // Nulls across every nullable column the action writes.
  await h.db.insert(contacts).values({
    userId: USER,
    name: "Null Person",
    firm: "Evercore",
    role: null,
    linkedinUrl: null,
    email: null,
    emailConfidence: null,
    emailSource: null,
    emailRawProvider: null,
    emailStatusRaw: null,
    emailRejectionReason: null,
    school: null,
    gradYear: null,
    currentCity: null,
    background: null,
    connectionAngle: null,
    sourceUrl: null,
  });
  const [saved] = await h.db.select().from(contacts);
  assert.equal(saved.email, null);
  assert.equal(saved.gradYear, null);
  assert.equal(saved.emailDomainRelevant, false, "a NOT NULL boolean default did not apply");

  // A null idempotency key must not collide with another null.
  for (let i = 0; i < 3; i++) {
    await h.db.insert(contactSourcingRuns).values({
      userId: USER, firmId: FIRM, status: "failed", creditsSpent: 0, contactsRequested: 5,
    });
  }
  assert.equal((await h.db.select().from(contactSourcingRuns)).length, 3);
});

// ============================================================ query paths

test("idempotency-key lookup and run claim behave identically on Postgres", skipIfNoPostgres, async () => {
  const h = await reset();
  const api = provider();
  try {
    const first = await click();
    assert.equal(first.ok && first.decision, "run");

    const [run] = await h.db.select().from(contactSourcingRuns);
    assert.equal(run.idempotencyKey, `${USER}:${FIRM}:generate`);
    assert.equal(run.mode, "generate");
    assert.equal(run.refreshSequence, 0);

    // The lookup the action performs first, on the real driver.
    const found = await h.db.query.contactSourcingRuns.findFirst({
      where: eq(contactSourcingRuns.idempotencyKey, run.idempotencyKey!),
    });
    assert.equal(found?.id, run.id);
  } finally {
    api.restore();
  }
});

test("ON CONFLICT DO NOTHING arbitrates on the real unique index", skipIfNoPostgres, async () => {
  const h = await reset();
  const key = `${USER}:${FIRM}:generate`;
  await h.db.insert(contactSourcingRuns).values({
    userId: USER, firmId: FIRM, idempotencyKey: key, status: "pending", creditsSpent: 0, contactsRequested: 5,
  });

  // The action's exact claim statement. Returning nothing is how it learns it lost.
  const claimed = await h.db
    .insert(contactSourcingRuns)
    .values({
      userId: USER, firmId: FIRM, idempotencyKey: key, status: "pending", creditsSpent: 0, contactsRequested: 5,
    })
    .onConflictDoNothing({ target: contactSourcingRuns.idempotencyKey })
    .returning();
  assert.deepEqual(claimed, [], "the second claim was accepted");
  assert.equal((await h.db.select().from(contactSourcingRuns)).length, 1);

  // And an unguarded insert is refused by the index itself.
  await assert.rejects(
    h.db.insert(contactSourcingRuns).values({
      userId: USER, firmId: FIRM, idempotencyKey: key, status: "pending", creditsSpent: 0, contactsRequested: 5,
    }),
  );
});

test("refresh-sequence calculation counts on the real driver", skipIfNoPostgres, async () => {
  const h = await reset();
  const api = installFakeCrustdata({
    searchPages: [
      [fakeProfile({ name: "Hana Park", companyId: EVERCORE_ID })],
      [fakeProfile({ name: "Ivo Costa", companyId: EVERCORE_ID })],
      [fakeProfile({ name: "Jae Moon", companyId: EVERCORE_ID })],
    ],
  });
  try {
    await click({ mode: "refresh" });
    await click({ mode: "refresh" });
    await click({ mode: "refresh" });

    const rows = await h.db
      .select()
      .from(contactSourcingRuns)
      .where(eq(contactSourcingRuns.mode, "refresh"));
    assert.deepEqual(rows.map((r) => r.refreshSequence).sort(), [1, 2, 3]);
    assert.equal(new Set(rows.map((r) => r.idempotencyKey)).size, 3, "two refreshes shared a key");

    const [count] = await h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(contactSourcingRuns)
      .where(and(eq(contactSourcingRuns.userId, USER), eq(contactSourcingRuns.mode, "refresh")));
    assert.equal(count.n, 3);
  } finally {
    api.restore();
  }
});

test("the credit window is computed by Postgres, not by the application clock", skipIfNoPostgres, async () => {
  const h = await reset();
  const base = { userId: USER, firmId: FIRM, contactsRequested: 5 };

  await h.db.insert(contactSourcingRuns).values([
    { ...base, status: "succeeded", creditsSpent: 1, contactsCreated: 5 },
    { ...base, status: "succeeded", creditsSpent: 0, contactsCreated: 0 },
    { ...base, status: "failed", creditsSpent: 0, contactsCreated: 0 },
    { ...base, status: "pending", creditsSpent: 0, contactsCreated: 0 },
    {
      ...base,
      status: "pending",
      creditsSpent: 0,
      contactsCreated: 0,
      createdAt: new Date(Date.now() - PENDING_STALE_MS - 60_000),
    },
    // Last month - outside the window entirely.
    {
      ...base,
      status: "succeeded",
      creditsSpent: 1,
      contactsCreated: 5,
      createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
    },
  ]);

  const credits = await getContactCredits(USER);
  assert.equal(credits.used, 2, "1 settled + 1 in-flight; empty, failed, stale and last-month excluded");
});

test("cached-result retrieval reads the saved set without touching the provider", skipIfNoPostgres, async () => {
  await reset();
  const api = provider();
  try {
    await click();
    const callsAfterFirst = api.calls.length;

    const second = await click();
    assert.equal(second.ok && second.decision, "serve_cached");
    assert.equal(second.ok && second.status, "cached");
    assert.equal(second.ok && second.contacts.length, 5);
    assert.equal(second.ok && second.creditsUsed, 0);
    assert.equal(api.calls.length, callsAfterFirst, "a cached click reached the provider");
  } finally {
    api.restore();
  }
});

test("pending-run recovery releases an abandoned key", skipIfNoPostgres, async () => {
  const h = await reset();
  await h.db.insert(contactSourcingRuns).values({
    userId: USER,
    firmId: FIRM,
    idempotencyKey: `${USER}:${FIRM}:generate`,
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

    const rows = await h.db.select().from(contactSourcingRuns);
    assert.equal(rows.length, 2, "the abandoned row should be kept as evidence");
    const ghost = rows.find((r) => r.error?.startsWith("Abandoned"));
    assert.ok(ghost);
    assert.equal(ghost.idempotencyKey, null);
    assert.equal(ghost.creditsSpent, 0);
  } finally {
    api.restore();
  }
});

test("contact persistence writes every column the renderer reads", skipIfNoPostgres, async () => {
  const h = await reset();
  const api = provider({
    emails: {
      "https://www.linkedin.com/in/ada-lin": { email: "ada.lin@evercore.com", status: "deliverable" },
    },
  });
  try {
    const result = await click();
    assert.equal(result.ok && result.contacts.length, 5);

    const saved = await h.db.select().from(contacts);
    assert.equal(saved.length, 5);
    for (const row of saved) {
      assert.ok(row.name);
      assert.equal(row.firm, "Evercore");
      assert.equal(typeof row.emailDomainRelevant, "boolean");
      if (row.email) {
        assert.ok(row.email.endsWith("@evercore.com"), `${row.name}: ${row.email}`);
        assert.equal(row.emailDomainRelevant, true);
      }
      assert.ok(row.createdAt instanceof Date, "createdAt did not deserialise as a Date");
    }
  } finally {
    api.restore();
  }
});

test("charge settlement is atomic with the contact write", skipIfNoPostgres, async () => {
  const h = await reset();
  const api = provider();
  try {
    await click();
    const [run] = await h.db.select().from(contactSourcingRuns);
    const saved = await h.db.select().from(contacts);
    assert.equal(run.contactsCreated, saved.length, "the ledger and the contacts disagree");
    assert.equal(run.creditsSpent, 1);
    assert.ok(run.completedAt instanceof Date);
  } finally {
    api.restore();
  }

  // And the table refuses the inconsistent state outright.
  await assert.rejects(
    h.db.insert(contactSourcingRuns).values({
      userId: USER, firmId: FIRM, status: "succeeded", creditsSpent: 1, contactsCreated: 0, contactsRequested: 5,
    }),
    (err: unknown) => /contact_sourcing_charge_needs_contacts/.test(chain(err)),
  );
  await assert.rejects(
    h.db.insert(contactSourcingRuns).values({
      userId: USER, firmId: FIRM, status: "succeeded", creditsSpent: -1, contactsCreated: 3, contactsRequested: 5,
    }),
    (err: unknown) => /contact_sourcing_credits_nonnegative/.test(chain(err)),
  );
});

test("a rolled-back transaction leaves nothing behind on real Postgres", skipIfNoPostgres, async () => {
  const h = await reset();
  await assert.rejects(
    h.db.transaction(async (tx) => {
      await tx.insert(contacts).values({ userId: USER, name: "Rolled Back", firm: "Evercore" });
      await tx.insert(contactSourcingRuns).values({
        userId: USER, firmId: FIRM, status: "succeeded", creditsSpent: 1, contactsCreated: 1, contactsRequested: 5,
      });
      throw new Error("deliberate");
    }),
    /deliberate/,
  );
  assert.equal((await h.db.select().from(contacts)).length, 0);
  assert.equal((await h.db.select().from(contactSourcingRuns)).length, 0);
});

test("a failed run is uncharged and can be retried", skipIfNoPostgres, async () => {
  const h = await reset();
  const limited = installFakeCrustdata({ failSearchWith: 429 });
  try {
    assert.equal((await click()).ok, false);
  } finally {
    limited.restore();
  }

  const [failed] = await h.db.select().from(contactSourcingRuns);
  assert.equal(failed.status, "failed");
  assert.equal(failed.creditsSpent, 0);

  const ok = provider();
  try {
    const retry = await click();
    assert.equal(retry.ok && retry.decision, "run", "a failed run blocked its own retry");
    assert.equal(retry.ok && retry.contacts.length, 5);
    const rows = await h.db.select().from(contactSourcingRuns);
    assert.equal(rows.length, 1, "the retry started a rival run");
    assert.equal(rows.reduce((n, r) => n + r.creditsSpent, 0), 1);
  } finally {
    ok.restore();
  }
});

test("two CONCURRENT clicks produce one workflow and one charge on real Postgres", skipIfNoPostgres, async () => {
  const h = await reset();

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
    await new Promise((r) => setTimeout(r, 80));
    const b = click();
    await new Promise((r) => setTimeout(r, 80));
    release();
    const [first, second] = await Promise.all([a, b]);

    const rows = await h.db.select().from(contactSourcingRuns);
    assert.equal(rows.length, 1, `expected one run row, got ${rows.length}`);
    assert.ok(rows.reduce((n, r) => n + r.creditsSpent, 0) <= 1);
    assert.equal(api.countOf(SEARCH_URL), 1, "two provider searches ran for one intent");
    assert.deepEqual(
      [first.ok && first.decision, second.ok && second.decision].sort(),
      ["join_in_flight", "run"],
    );
    assert.equal((await h.db.select().from(contacts)).length, 5);
  } finally {
    api.restore();
  }
});

test("a fill shares the run and never refunds the original charge", skipIfNoPostgres, async () => {
  const h = await reset();
  const api = installFakeCrustdata({
    searchPages: [
      [
        fakeProfile({ name: "Jae Moon", companyId: EVERCORE_ID }),
        fakeProfile({ name: "Kit Alvarez", companyId: EVERCORE_ID }),
      ],
    ],
  });
  try {
    const first = await click();
    assert.equal(first.ok && first.contacts.length, 2);

    api.enqueueSearchPages([fakeProfile({ name: "Lior Adan", companyId: EVERCORE_ID })]);
    const filled = await click({ mode: "fill" });
    assert.equal(filled.ok && filled.decision, "run");

    const rows = await h.db.select().from(contactSourcingRuns);
    assert.equal(rows.length, 1, "the fill started a second run");
    assert.equal(rows[0].idempotencyKey, `${USER}:${FIRM}:generate`);
    assert.equal(rows[0].creditsSpent, 1, "the fill changed the charge");
    assert.equal(rows[0].contactsCreated, 3);
    assert.equal((await h.db.select().from(contacts)).length, 3);
  } finally {
    api.restore();
  }
});

test("an explicit refresh runs and is charged", skipIfNoPostgres, async () => {
  const h = await reset();
  const api = installFakeCrustdata({
    searchPages: [fivePeople(), [fakeProfile({ name: "Farah Idris", companyId: EVERCORE_ID })]],
  });
  try {
    await click();
    const refreshed = await click({ mode: "refresh" });
    assert.equal(refreshed.ok && refreshed.decision, "run");

    const rows = await h.db.select().from(contactSourcingRuns);
    assert.equal(rows.length, 2);
    const refresh = rows.find((r) => r.mode === "refresh")!;
    assert.equal(refresh.refreshSequence, 1);
    assert.equal(refresh.idempotencyKey, `${USER}:${FIRM}:refresh:1`);
    assert.equal(refresh.creditsSpent, 1);
    assert.equal(rows.reduce((n, r) => n + r.creditsSpent, 0), 2);
  } finally {
    api.restore();
  }
});

// ======================================================== the allowance

test("an unlimited account is never blocked, however many runs it has", skipIfNoPostgres, async () => {
  const h = await reset("free", "matuseno@usc.edu");
  for (let i = 0; i < 25; i++) {
    await h.db.insert(contactSourcingRuns).values({
      userId: USER, firmId: FIRM, status: "succeeded", creditsSpent: 1, contactsCreated: 5, contactsRequested: 5,
    });
  }
  const credits = await getContactCredits(USER);
  assert.equal(credits.unlimited, true);
  assert.equal(credits.used, 25);
  assert.equal(credits.limit, 0, "the free limit is still reported, it is simply not enforced");

  const api = provider();
  try {
    const result = await runContactSourcing({
      user: { id: USER, email: "matuseno@usc.edu" },
      firmId: FIRM,
    });
    assert.equal(result.ok, true, "an unlimited account was blocked");
    assert.equal(result.ok && result.credits.remaining, -1, "-1 is the sentinel for unlimited");
  } finally {
    api.restore();
  }
});

test("an ordinary FREE account has no credits since billing, and the provider is never called", skipIfNoPostgres, async () => {
  await reset("free", "free-student@example.edu");
  const credits = await getContactCredits(USER);
  assert.equal(credits.unlimited, false);
  assert.equal(credits.limit, 0);
  assert.equal(credits.used, 0);
  assert.equal(credits.remaining, 0);

  const api = provider();
  try {
    const result = await runContactSourcing({
      user: { id: USER, email: "free-student@example.edu" },
      firmId: FIRM,
    });
    assert.equal(result.ok, false, "a free account was allowed a paid run");
    assert.match(result.ok ? "" : result.error, /part of Offerly Pro/);
    assert.equal(api.calls.length, 0, "the provider was called for a student with no credits");
  } finally {
    api.restore();
  }
});

test("used > limit never becomes extra allowance", skipIfNoPostgres, async () => {
  // remaining is floored at zero. Without that, a free account that somehow
  // reached four runs would report -1 remaining, and `remaining <= 0` is the
  // gate - so the sign, not the magnitude, is what has to hold.
  const h = await reset("free", "overrun@example.edu");
  for (let i = 0; i < 9; i++) {
    await h.db.insert(contactSourcingRuns).values({
      userId: USER, firmId: FIRM_B, status: "succeeded", creditsSpent: 1, contactsCreated: 5, contactsRequested: 5,
    });
  }
  const credits = await getContactCredits(USER);
  assert.equal(credits.used, 9);
  assert.equal(credits.remaining, 0, "remaining went negative or wrapped");

  const api = provider();
  try {
    const result = await runContactSourcing({
      user: { id: USER, email: "overrun@example.edu" },
      firmId: FIRM,
    });
    assert.equal(result.ok, false);
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("a PRO account gets thirty, not zero", skipIfNoPostgres, async () => {
  const h = await reset("pro", "pro-student@example.edu");
  for (let i = 0; i < 29; i++) {
    await h.db.insert(contactSourcingRuns).values({
      userId: USER, firmId: FIRM_B, status: "succeeded", creditsSpent: 1, contactsCreated: 5, contactsRequested: 5,
    });
  }
  let credits = await getContactCredits(USER);
  assert.equal(credits.limit, 30);
  assert.equal(credits.remaining, 1);

  const api = provider();
  try {
    const result = await runContactSourcing({
      user: { id: USER, email: "pro-student@example.edu" },
      firmId: FIRM,
    });
    assert.equal(result.ok, true, "the thirtieth run was refused");
  } finally {
    api.restore();
  }

  credits = await getContactCredits(USER);
  assert.equal(credits.used, 30);
  assert.equal(credits.remaining, 0);

  const blocked = provider();
  try {
    const thirtyFirst = await runContactSourcing({
      user: { id: USER, email: "pro-student@example.edu" },
      firmId: FIRM_B,
    });
    assert.equal(thirtyFirst.ok, false, "a pro account exceeded thirty");
    assert.equal(blocked.calls.length, 0);
  } finally {
    blocked.restore();
  }
});

test("a cached click is free even for a student at their limit", skipIfNoPostgres, async () => {
  const h = await reset("pro", "at-limit@example.edu");
  const actor = { id: USER, email: "at-limit@example.edu" };

  const api = provider();
  try {
    // One real run, then fill the allowance to the brim.
    const first = await runContactSourcing({ ...{ user: actor, firmId: FIRM } });
    assert.equal(first.ok && first.decision, "run");

    for (let i = 0; i < 29; i++) {
      await h.db.insert(contactSourcingRuns).values({
        userId: USER, firmId: FIRM_B, status: "succeeded", creditsSpent: 1, contactsCreated: 5, contactsRequested: 5,
      });
    }
    assert.equal((await getContactCredits(USER)).remaining, 0);

    const callsBefore = api.calls.length;
    const cached = await runContactSourcing({ user: actor, firmId: FIRM });
    assert.equal(cached.ok, true, "a student at their limit could not re-read what they already paid for");
    assert.equal(cached.ok && cached.decision, "serve_cached");
    assert.equal(cached.ok && cached.contacts.length, 5);
    assert.equal(cached.ok && cached.creditsUsed, 0);
    assert.equal(api.calls.length, callsBefore, "a cached click reached the provider");
    assert.equal((await getContactCredits(USER)).used, 30, "re-reading a cached set cost a credit");
  } finally {
    api.restore();
  }
});

test("failed and empty runs leave the allowance untouched", skipIfNoPostgres, async () => {
  const h = await reset("pro", "careful@example.edu");
  const actor = { id: USER, email: "careful@example.edu" };

  const broken = installFakeCrustdata({ failSearchWith: 500 });
  try {
    assert.equal((await runContactSourcing({ user: actor, firmId: FIRM })).ok, false);
  } finally {
    broken.restore();
  }
  assert.equal((await getContactCredits(USER)).used, 0, "a failed run cost a credit");

  const empty = installFakeCrustdata({ searchPages: [[], [], [], [], [], []] });
  try {
    const result = await runContactSourcing({ user: actor, firmId: FIRM_B });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.contacts.length, 0);
  } finally {
    empty.restore();
  }
  assert.equal((await getContactCredits(USER)).used, 0, "an empty run cost a credit");

  // Both runs are still on the record - they happened.
  assert.equal((await h.db.select().from(contactSourcingRuns)).length, 2);
});

/** The whole error chain as text - Drizzle hides the constraint name on `cause`. */
function chain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 6 && current; i++) {
    parts.push(String((current as { message?: string }).message ?? current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}
