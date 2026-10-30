/**
 * The Help assistant's gates, against a REAL database.
 *
 * The hole these pin shut: the gates were a count followed, after the model
 * had already answered, by an insert. Between the two the question did not
 * exist, so questions fired together all read the same pre-call numbers and
 * all passed - the in-process InFlightGuard only stops that on one server
 * instance, and production runs several. A question is now RESERVED under an
 * advisory lock before the model is called (lib/help-gate).
 *
 * No network and no model: reserveHelpQuestion only touches the database.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { and, eq, sql } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { HELP_LIMITS, helpSpendUsd } from "@/lib/help-chat-rules";
import { HELP_PROVISIONAL_USAGE, releaseHelpQuestion, reserveHelpQuestion } from "@/lib/help-gate";
import { aiUsage, users } from "@/db/schema";

const USER_ID = "55555555-5555-4555-8555-555555555555";
const MODEL = "claude-haiku-5-5";

async function withStudent(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  const budget = process.env.HELP_ASSISTANT_DAILY_BUDGET_USD;
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "help@example.edu",
      passwordHash: "x",
      name: "Help Student",
      plan: "free",
    });
    await fn(h);
  } finally {
    if (budget === undefined) delete process.env.HELP_ASSISTANT_DAILY_BUDGET_USD;
    else process.env.HELP_ASSISTANT_DAILY_BUDGET_USD = budget;
    restore();
    await h.close();
  }
}

async function chatRows(h: TestDatabase): Promise<number> {
  const [row] = await h.db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, USER_ID), eq(aiUsage.feature, "chat")));
  return row?.n ?? 0;
}

/** A timestamp earlier today but outside the minute window, whatever the hour. */
function earlierToday(): Date {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const fiveMinutesAgo = Date.now() - 5 * 60_000;
  return new Date(Math.max(midnight.getTime() + 1_000, fiveMinutesAgo));
}

test("questions fired together cannot all pass the same count", async () => {
  await withStudent(async (h) => {
    // Three times the minute's allowance, all at once - which is what a script
    // landing on several server instances looks like to the database. The
    // check-then-record version admitted every one of these.
    const results = await Promise.all(
      Array.from({ length: HELP_LIMITS.perMinute * 3 }, () => reserveHelpQuestion(USER_ID, MODEL)),
    );
    const granted = results.filter((r) => r.ok).length;
    assert.equal(granted, HELP_LIMITS.perMinute, `exactly ${HELP_LIMITS.perMinute} admitted, not ${granted}`);
    for (const r of results.filter((x) => !x.ok)) {
      if (!r.ok) assert.equal(r.reason, "burst");
    }
    assert.equal(await chatRows(h), HELP_LIMITS.perMinute, "one row per admitted question, and no more");
  });
});

test("a reserved question is counted before the model is called", async () => {
  await withStudent(async (h) => {
    const first = await reserveHelpQuestion(USER_ID, MODEL);
    assert.equal(first.ok, true);
    assert.equal(await chatRows(h), 1, "the row exists before any answer comes back");
  });
});

test("a question that never reached the model is given back", async () => {
  await withStudent(async (h) => {
    const r = await reserveHelpQuestion(USER_ID, MODEL);
    assert.equal(r.ok, true);
    if (r.ok) await releaseHelpQuestion(r.id);
    assert.equal(await chatRows(h), 0, "a failed call has never counted");
  });
});

test("the minute window reopens once the reservations age out of it", async () => {
  await withStudent(async (h) => {
    for (let i = 0; i < HELP_LIMITS.perMinute; i++) {
      assert.equal((await reserveHelpQuestion(USER_ID, MODEL)).ok, true);
    }
    const over = await reserveHelpQuestion(USER_ID, MODEL);
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.reason, "burst");

    // Age today's rows out of the 60-second window.
    await h.db.update(aiUsage).set({ createdAt: earlierToday() }).where(eq(aiUsage.userId, USER_ID));
    assert.equal((await reserveHelpQuestion(USER_ID, MODEL)).ok, true, "the window is rolling, not a daily cap");
  });
});

test("the student's day runs out at HELP_LIMITS.perDay", async () => {
  await withStudent(async (h) => {
    const when = earlierToday();
    await h.db.insert(aiUsage).values(
      Array.from({ length: HELP_LIMITS.perDay }, () => ({
        userId: USER_ID,
        feature: "chat" as const,
        model: MODEL,
        inputTokens: 10,
        outputTokens: 10,
        usedFallback: false,
        createdAt: when,
      })),
    );
    const over = await reserveHelpQuestion(USER_ID, MODEL);
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.reason, "daily");
    assert.equal(await chatRows(h), HELP_LIMITS.perDay, "a refusal reserves nothing");
  });
});

test("the global budget refuses everyone once it is spent", async () => {
  await withStudent(async (h) => {
    // Derived from what the inserted row actually costs, not a hardcoded
    // dollar figure: the point of the test is "a budget below today's spend
    // refuses everyone", and a literal silently stops testing that the day the
    // model's price changes - which is exactly what happened on 12 October
    // 2026, when Haiku 5.5 made $0.02 ten times too generous to trip it.
    const spent = helpSpendUsd(30_000, 1_000);
    process.env.HELP_ASSISTANT_DAILY_BUDGET_USD = (spent / 2).toFixed(6);
    await h.db.insert(aiUsage).values({
      userId: USER_ID,
      feature: "chat",
      model: MODEL,
      inputTokens: 30_000,
      outputTokens: 1_000,
      usedFallback: false,
      createdAt: earlierToday(),
    });
    const over = await reserveHelpQuestion(USER_ID, MODEL);
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.reason, "budget");
  });
});

test("the whole runner path reserves one row and fills it in with the real tokens", async () => {
  await withStudent(async (h) => {
    const key = process.env.ANTHROPIC_API_KEY;
    // The model call is this test's own callback - the SDK client is only
    // constructed, never used, and ./helpers/no-network would fail the test if
    // anything tried to leave the process.
    process.env.ANTHROPIC_API_KEY = "test-not-a-real-key";
    try {
      const { runAiFeature } = await import("@/lib/ai-runner");
      const answered = await runAiFeature(
        { feature: "chat", userId: USER_ID, quota: "help", meter: (u) => ({ input_tokens: u.input_tokens, output_tokens: u.output_tokens }) },
        async () => ({ usage: { input_tokens: 1_234, output_tokens: 56 } }),
      );
      assert.equal(answered.usage.input_tokens, 1_234);

      const rows = await h.db.select().from(aiUsage).where(eq(aiUsage.userId, USER_ID));
      assert.equal(rows.length, 1, "the reservation was filled in, not duplicated");
      assert.equal(rows[0].inputTokens, 1_234, "the real tokens replaced the provisional ones");
      assert.equal(rows[0].outputTokens, 56);

      // A failed call gives its question back.
      await assert.rejects(
        () =>
          runAiFeature({ feature: "chat", userId: USER_ID, quota: "help" }, async () => {
            throw new Error("the model said no");
          }),
        /the model said no/,
      );
      assert.equal(await chatRows(h), 1, "the failed question left nothing behind");
    } finally {
      if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = key;
    }
  });
});

test("questions in flight are charged against the budget, not counted as free", async () => {
  await withStudent(async () => {
    // Two reservations' provisional spend is already over this budget, so the
    // third is refused even though no answer has been recorded yet. With
    // zero-token reservations a burst could walk the shared budget past its
    // ceiling while every one of them was still in flight.
    const provisional = helpSpendUsd(HELP_PROVISIONAL_USAGE.inputTokens, HELP_PROVISIONAL_USAGE.outputTokens);
    assert.ok(provisional > 0, "a question in flight has a provisional cost");
    process.env.HELP_ASSISTANT_DAILY_BUDGET_USD = String(provisional * 1.5);

    assert.equal((await reserveHelpQuestion(USER_ID, MODEL)).ok, true);
    assert.equal((await reserveHelpQuestion(USER_ID, MODEL)).ok, true);
    const third = await reserveHelpQuestion(USER_ID, MODEL);
    assert.equal(third.ok, false);
    if (!third.ok) assert.equal(third.reason, "budget");
  });
});
