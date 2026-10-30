/**
 * What an import costs, and how much of it one student can store.
 *
 * Three things the importers did not bound:
 *
 *   - duplicate detection compared every row to every row the student already
 *     had, recomputing the firm key and the role split on both sides of every
 *     pair. Each of those is an NFKD pass, a regex chain and - for the role -
 *     a freshly sorted copy of the city list. Now each name is read once and
 *     rows are bucketed by firm key, which has to give the same answer,
 *     because two rows under different keys never matched;
 *   - nothing capped how many rows a student could accumulate, and the import
 *     can be repeated;
 *   - the schedule importer took a row's title on trust - truthy was the whole
 *     check - so one row could carry a megabyte of it and a file as many rows
 *     as the body limit allowed.
 *
 *   node --import tsx --conditions=react-server --test \
 *     scripts/test/import-dedupe-and-caps.test.ts
 *
 * Real (in-memory) Postgres, no network.
 */

import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";

// See import-decoded-language-check.test.ts: revalidatePath needs a request.
{
  const cachePath = require.resolve("next/cache");
  const stub = new Module(cachePath);
  stub.filename = cachePath;
  stub.loaded = true;
  stub.exports = { __esModule: true, revalidatePath: () => {}, revalidateTag: () => {} };
  require.cache[cachePath] = stub;
}

import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { firmResolver } from "@/lib/firm-name";
import { roleParts, sameRole, sameRoleParts } from "@/lib/role-name";
import { applications, events, users } from "@/db/schema";

const USER_ID = "55555555-5555-4555-8555-555555555555";

async function withStudent(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "caps@example.edu",
      passwordHash: "x",
      name: "Caps Student",
      school: "University of Southern California",
      gradYear: 2028,
    });
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

async function run<T>(fn: () => Promise<T>): Promise<T | { redirected: true }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT")) return { redirected: true };
    throw err;
  }
}

function importApplications(rows: unknown[]) {
  const form = new FormData();
  form.set("rows", JSON.stringify(rows));
  return async () => {
    const { bulkImportApplications } = await import("@/app/(app)/applications/import/actions");
    return run(() => bulkImportApplications(undefined, form));
  };
}

test("reading a firm name twice gives the same answer as reading it once", () => {
  // The resolver now remembers what it worked out. The memory must not change
  // any answer, including the ambiguous and the empty ones.
  const resolve = firmResolver([
    { name: "Jane Street Capital" },
    { name: "Evercore", aliases: ["EVR"] },
    { name: "Bain Capital" },
    { name: "Citadel Securities" },
  ]);
  const names = ["Jane Street", "J.P. Morgan", "EVR", "Evercore Partners LLC", "Citadel", "Bain", "", "   ", "Moelis & Company"];
  const first = names.map((n) => resolve(n));
  const second = names.map((n) => resolve(n));
  assert.deepEqual(second, first);
  const fresh = names.map((n) =>
    firmResolver([
      { name: "Jane Street Capital" },
      { name: "Evercore", aliases: ["EVR"] },
      { name: "Bain Capital" },
      { name: "Citadel Securities" },
    ])(n),
  );
  assert.deepEqual(first, fresh, "a cached resolver answers like a cold one");
  assert.equal(resolve("Evercore Partners LLC"), resolve("EVR"));
  assert.equal(resolve("Citadel"), "citadel", "still not Citadel Securities");
  assert.equal(resolve(null), "");
});

test("comparing split titles is the same question as comparing titles", () => {
  const titles = [
    "IB Summer Analyst", "Investment Banking Summer Analyst", "Summer Analyst, IB", "2027 IB Summer Analyst - New York",
    "2026 IB Summer Analyst", "Equity Research Summer Analyst", "Summer Analyst - London", "", "Analyst Program",
  ];
  for (const a of titles) {
    for (const b of titles) {
      assert.equal(
        sameRoleParts(roleParts(a), roleParts(b)),
        sameRole(a, b),
        `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
      );
    }
  }
});

test("the same line, by another name, is still one application", async () => {
  await withStudent(async (h) => {
    assert.deepEqual(
      await asStudent(h.db, USER_ID, importApplications([
        { firm: "Goldman Sachs", role: "IB Summer Analyst", status: "submitted", deadlineDate: "2026-11-14" },
        { firm: "GS", role: "Investment Banking Summer Analyst", status: "not_started" },
        { firm: "Evercore", role: "Summer Analyst", status: "not_started" },
      ])),
      { redirected: true },
    );
    const stored = await h.db.select().from(applications);
    assert.equal(stored.length, 2, "Goldman and GS are one row");
    assert.deepEqual(stored.map((a) => a.firm).sort(), ["Evercore", "Goldman Sachs"]);
    assert.equal((await h.db.select().from(events)).length, 1);
  });
});

test("an entry already on the tracker wins over one earlier in the same file", async () => {
  await withStudent(async (h) => {
    // Seeded with a year; the file's first row has none, so it fits the
    // existing entry - which is the row the old scan picked, because it
    // looked through the tracker before the rows it had just accepted.
    const [seeded] = await h.db
      .insert(applications)
      .values({ userId: USER_ID, firm: "Evercore", role: "2027 IB Summer Analyst", status: "submitted" })
      .returning();
    assert.deepEqual(
      await asStudent(h.db, USER_ID, importApplications([
        { firm: "Evercore", role: "IB Summer Analyst", status: "interviewing" },
        { firm: "Evercore", role: "Investment Banking Summer Analyst", status: "interviewing", deadlineDate: "2026-11-14" },
      ])),
      { redirected: true },
    );
    const stored = await h.db.select().from(applications);
    assert.equal(stored.length, 1, "nothing new was added");
    const filed = await h.db.select().from(events);
    assert.equal(filed.length, 1);
    assert.equal(filed[0].applicationId, seeded.id, "the deadline went on the entry that existed");
  });
});

test("importing the same file twice adds no rows and no second deadline", async () => {
  await withStudent(async (h) => {
    const rows = [
      { firm: "Evercore", role: "IB Summer Analyst", status: "submitted", deadlineDate: "2026-11-14" },
      { firm: "Moelis & Company", role: "Summer Analyst", status: "not_started", deadlineDate: "2026-12-01" },
    ];
    await asStudent(h.db, USER_ID, importApplications(rows));
    const first = { apps: (await h.db.select().from(applications)).length, events: (await h.db.select().from(events)).length };
    assert.deepEqual(first, { apps: 2, events: 2 });

    await asStudent(h.db, USER_ID, importApplications(rows));
    assert.deepEqual(
      { apps: (await h.db.select().from(applications)).length, events: (await h.db.select().from(events)).length },
      first,
      "the second run is a no-op, deadlines included",
    );
  });
});

test("a file against a full tracker is matched without the cost growing quadratically", async () => {
  // GROWTH, not a ceiling, and this test is why helpers/growth.ts exists. Its
  // own numbers make the case: the scan this replaced spent 8,000 ms on these
  // pairs and reading each string once costs 16 ms - but the ceiling of 4,000 ms
  // was tripped at 67,410 ms by the FIXED code, on a laptop that was building
  // and running evals at the same time. A broken-but-idle machine and a
  // working-but-busy one overlap, so no ceiling separates them.
  //
  // What separates them is shape. The old scan re-read the same two strings for
  // every pair, so doubling the rows quadrupled the work; reading each once
  // means doubling the rows doubles it. Both halves below run on the same
  // machine moments apart, so contention cancels.
  //
  // Lettered rather than numbered: a number in a title is read as a year, and
  // two titles that differ only by a year the other does not name are the same
  // role - which would (correctly) collapse some of these rows. The "x" matters:
  // three letters on their own eventually spell a word the language check
  // blocks, which it duly did.
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const tag = (i: number) =>
    `x${letters[(i / 26 / 26) % 26 | 0]}${letters[(i / 26) % 26 | 0]}${letters[i % 26]}`;

  /** The milliseconds the import itself costs with N rows already tracked and N more arriving. */
  async function importCost(n: number): Promise<number> {
    let ms = 0;
    await withStudent(async (h) => {
      // One firm, so every firm key matches and the role split is the work.
      await h.db.insert(applications).values(
        Array.from({ length: n }, (_, i) => ({
          userId: USER_ID,
          firm: "Evercore",
          role: `2027 Investment Banking Summer Analyst ${tag(i)} - New York`,
          status: "submitted" as const,
        })),
      );
      const rows = Array.from({ length: n }, (_, i) => ({
        firm: "EVR",
        role: `2027 Equity Research Summer Analyst ${tag(i)} - Chicago`,
        status: "not_started",
      }));
      const started = process.hrtime.bigint();
      await asStudent(h.db, USER_ID, importApplications(rows));
      ms = Number(process.hrtime.bigint() - started) / 1e6;
      // The point of the shape: none of these collapse into each other.
      assert.equal((await h.db.select().from(applications)).length, n * 2);
    });
    return ms;
  }

  const small = await importCost(350);
  const large = await importCost(700);
  const ratio = small < 1 ? 1 : large / small;

  // ~2 is linear, ~4 is the quadratic scan this replaced. 3 sits between them;
  // growth-helper.test.ts measures the instrument at 1.98 against 3.98.
  assert.ok(
    ratio < 3,
    `doubling the rows grew the import ${ratio.toFixed(2)}x (${Math.round(small)}ms -> ${Math.round(large)}ms) - the scan this replaced was quadratic here`,
  );

  // Not a performance budget - a net for "something is catastrophically wrong".
  // It cannot be tight, for the reason in the comment at the top of this test.
  assert.ok(large < 120_000, `the import took ${Math.round(large / 1000)}s, which is not slowness but a fault`);
});

test("the schedule importer refuses more rows than it will accept", async () => {
  await withStudent(async (h) => {
    const { bulkImportScheduleEvents } = await import("@/app/(app)/schedule/actions");
    const form = new FormData();
    form.set(
      "rows",
      JSON.stringify(Array.from({ length: 2001 }, () => ({ title: "FNCE 100", isoDateTime: "2026-11-02T09:00" }))),
    );
    assert.match(
      (await asStudent(h.db, USER_ID, () => bulkImportScheduleEvents(undefined, form)))?.error ?? "",
      /up to 2,000 entries at a time/,
    );
    assert.equal((await h.db.select().from(events)).length, 0);
  });
});

test("an over-long or non-string title is dropped, and the good rows still land", async () => {
  await withStudent(async (h) => {
    const { bulkImportScheduleEvents } = await import("@/app/(app)/schedule/actions");
    const form = new FormData();
    form.set(
      "rows",
      JSON.stringify([
        { title: "x".repeat(100_000), isoDateTime: "2026-11-02T09:00" },
        { title: { toString: "x" }, isoDateTime: "2026-11-02T10:00" },
        { title: "FNCE 100 lecture", isoDateTime: "2026-11-02T11:00" },
      ]),
    );
    assert.deepEqual(await asStudent(h.db, USER_ID, () => bulkImportScheduleEvents(undefined, form)), {
      imported: 1,
    });
    const stored = await h.db.select().from(events);
    assert.deepEqual(stored.map((e) => e.title), ["FNCE 100 lecture"]);
  });
});

test("a file of nothing but unusable rows imports nothing", async () => {
  await withStudent(async (h) => {
    const { bulkImportScheduleEvents } = await import("@/app/(app)/schedule/actions");
    const form = new FormData();
    form.set("rows", JSON.stringify([{ title: "", isoDateTime: "2026-11-02T09:00" }, { isoDateTime: "x" }]));
    assert.deepEqual(await asStudent(h.db, USER_ID, () => bulkImportScheduleEvents(undefined, form)), {
      error: "Nothing to import.",
    });
    assert.equal((await h.db.select().from(events)).length, 0);
  });
});

test("a megabyte of posted text is refused before it is parsed", async () => {
  await withStudent(async (h) => {
    const { bulkImportScheduleEvents } = await import("@/app/(app)/schedule/actions");
    const form = new FormData();
    form.set("rows", "x".repeat(2_000_001));
    assert.match(
      (await asStudent(h.db, USER_ID, () => bulkImportScheduleEvents(undefined, form)))?.error ?? "",
      /too large to import/,
    );
  });
});

test("repeating an import is rate limited per student", async () => {
  await withStudent(async (h) => {
    const { bulkImportScheduleEvents } = await import("@/app/(app)/schedule/actions");
    const once = async (i: number) => {
      const form = new FormData();
      form.set("rows", JSON.stringify([{ title: `FNCE ${i}`, isoDateTime: "2026-11-02T09:00" }]));
      return asStudent(h.db, USER_ID, () => bulkImportScheduleEvents(undefined, form));
    };
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await once(i), { imported: 1 }, `import ${i + 1} of the allowance`);
    }
    assert.match((await once(99))?.error ?? "", /Try again in about/);
    assert.equal((await h.db.select().from(events)).length, 10, "the refused one stored nothing");
  });
});
