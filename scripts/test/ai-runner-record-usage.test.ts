/**
 * A paid call must never become free and unrecorded.
 *
 * WHAT BROKE. runAiFeature reserves a row in ai_usage BEFORE the model is
 * called and fills it in afterwards, so that a question in flight already
 * counts. recordUsage - the filling in - was awaited inside the try of the
 * fallback loop. A database error there is not a capacity error, so it was
 * rethrown, and the outer handler then released the reservation: DELETING the
 * only record that the call happened. The model had answered and the provider
 * had billed for it, and afterwards nothing could tell that apart from a
 * question the model never answered. It failed toward more spend and erased
 * the evidence of the spend.
 *
 * So the runner now tracks whether call() actually resolved, recordUsage is
 * wrapped in its own try/catch that logs and swallows, and a reservation is
 * released only while the question is still unanswered. These tests pin both
 * halves: a bookkeeping failure keeps the row, a failure before the model still
 * gives it back.
 *
 * In-memory PGlite, and the model call is this file's own callback - the SDK
 * client is constructed but never used, and ./helpers/no-network fails the test
 * if anything tries to leave the process.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { and, eq, sql } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDb, type TestDatabase } from "./helpers/test-db";
import { HELP_PROVISIONAL_USAGE } from "@/lib/help-gate";
import { aiUsage, users } from "@/db/schema";

const USER_ID = "77777777-7777-4777-8777-777777777777";

/**
 * The application's database with one operation broken: the UPDATE recordUsage
 * uses to fill a reservation in. Everything else - the reservation's own
 * transaction, the release, the reads these tests make - still works, which is
 * what makes it a bookkeeping failure rather than an outage.
 */
function withBrokenUpdate(real: TestDb): object {
  return new Proxy(real as unknown as Record<string | symbol, unknown>, {
    get(target, prop, receiver) {
      if (prop === "update") {
        return () => {
          throw new Error("could not write ai_usage");
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function withStudent(
  fn: (h: TestDatabase, install: (db: TestDb | object) => void) => Promise<void>,
): Promise<void> {
  const h = await createTestDb();
  let restore = installAsAppDb(h.db);
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-not-a-real-key";
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "usage@example.edu",
      passwordHash: "x",
      name: "Usage Student",
      plan: "free",
    });
    await fn(h, (db) => {
      restore();
      restore = installAsAppDb(db);
    });
    // Every swallowed bookkeeping failure has to leave a trace: the row keeps
    // provisional numbers, so the undercount must at least be visible.
    assert.ok(
      logged.some((args) => String(args[0]).includes("[ai-usage]")),
      "a swallowed recordUsage failure must be logged, not hidden",
    );
  } finally {
    console.error = realError;
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
    restore();
    await h.close();
  }
}

async function rowsFor(h: TestDatabase, feature: "chat" | "draft") {
  return h.db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, USER_ID), eq(aiUsage.feature, feature)));
}

async function countAll(h: TestDatabase): Promise<number> {
  const [row] = await h.db.select({ n: sql<number>`count(*)::int` }).from(aiUsage);
  return row?.n ?? 0;
}

test("a Help question whose usage cannot be written keeps its reservation", async () => {
  await withStudent(async (h, install) => {
    const { runAiFeature } = await import("@/lib/ai-runner");
    install(withBrokenUpdate(h.db));

    // The model answered. The student gets their answer, and the question
    // stays counted at its provisional cost - the row the old code deleted.
    const answer = await runAiFeature(
      { feature: "chat", userId: USER_ID, quota: "help" },
      async () => ({ usage: { input_tokens: 4_321, output_tokens: 99 } }),
    );
    assert.equal(answer.usage.input_tokens, 4_321, "the answer is still returned");

    install(h.db);
    const rows = await rowsFor(h, "chat");
    assert.equal(rows.length, 1, "the reservation was NOT released - we paid for this call");
    assert.equal(
      rows[0].inputTokens,
      HELP_PROVISIONAL_USAGE.inputTokens,
      "it keeps its provisional cost, so the shared budget still sees the spend",
    );
    assert.equal(rows[0].outputTokens, HELP_PROVISIONAL_USAGE.outputTokens);
  });
});

test("a general AI call whose usage cannot be written keeps its reservation", async () => {
  await withStudent(async (h, install) => {
    const { runAiFeature } = await import("@/lib/ai-runner");
    install(withBrokenUpdate(h.db));

    await runAiFeature({ feature: "draft", userId: USER_ID }, async () => ({
      usage: { input_tokens: 500, output_tokens: 20 },
    }));

    install(h.db);
    const rows = await rowsFor(h, "draft");
    assert.equal(rows.length, 1, "the day's quota keeps the call it spent");
    assert.equal(rows[0].inputTokens, 0, "the reservation's own zeros, since the real tokens never landed");
  });
});

test("a call that never reached the model is still given back, on both gates", async () => {
  await withStudent(async (h, install) => {
    const { runAiFeature } = await import("@/lib/ai-runner");

    await assert.rejects(
      () =>
        runAiFeature({ feature: "chat", userId: USER_ID, quota: "help" }, async () => {
          throw new Error("the model said no");
        }),
      /the model said no/,
    );
    assert.equal(await countAll(h), 0, "a question the model never answered has never counted");

    await assert.rejects(
      () =>
        runAiFeature({ feature: "draft", userId: USER_ID }, async () => {
          throw new Error("the model said no");
        }),
      /the model said no/,
    );
    assert.equal(await countAll(h), 0, "and the same on the daily quota");

    // The logging assertion in withStudent is about swallowed bookkeeping
    // failures; this test has none, so it makes one to satisfy it rather than
    // leaving the check unstated for the other two.
    install(withBrokenUpdate(h.db));
    await runAiFeature({ feature: "draft", userId: USER_ID }, async () => ({
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    install(h.db);
    assert.equal(await countAll(h), 1, "the answered one stayed");
  });
});
