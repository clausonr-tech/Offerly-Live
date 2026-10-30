/**
 * The Help assistant's gate must never QUEUE on its shared lock.
 *
 * WHAT BROKE. The gate took one `pg_advisory_xact_lock(hashtext('help-gate'))`
 * - a single lock for every student and every firm recruiter - with no timeout,
 * and summed the day's chat rows inside it. ai_usage grows with every AI call
 * in the app, the pool is eight connections per instance and does not
 * pipeline, so a handful of simultaneous questions could hold every connection
 * waiting on that one lock. And a wedged pool is not a Help-assistant problem:
 * lib/rate-limit catches ANY database error and falls back to a per-process
 * memory counter, so every rate limiter in the app silently weakens at the
 * moment the traffic that wedged it arrives.
 *
 * The fix is two locks: the student's own gates stay exact under a lock on that
 * student alone, and the shared budget lock is TRIED rather than waited for. A
 * question that does not get it reads the budget unlocked and carries on.
 *
 * These tests pin that the fall-through still refuses correctly. The lock is
 * forced to be unobtainable by shadowing `pg_try_advisory_xact_lock` with a
 * function of the same signature in a schema ahead of pg_catalog on the search
 * path - which is the only way to make it return false in PGlite, where the
 * whole test database is one session and a session is always granted its own
 * advisory locks. The shadow also counts its calls, so "the gate tried the
 * lock and went on without it" is asserted rather than assumed.
 *
 * In-memory PGlite. No network, no model.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { HELP_LIMITS, helpSpendUsd } from "@/lib/help-chat-rules";
import { HELP_PROVISIONAL_USAGE, reserveHelpQuestion } from "@/lib/help-gate";
import { aiUsage, users } from "@/db/schema";

const USER_ID = "66666666-6666-4666-8666-666666666666";
const MODEL = "claude-haiku-5-5";

async function withStudent(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  const budget = process.env.HELP_ASSISTANT_DAILY_BUDGET_USD;
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "lock@example.edu",
      passwordHash: "x",
      name: "Lock Student",
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

/**
 * Makes `pg_try_advisory_xact_lock` answer false for the rest of the session,
 * and counts every call. pg_catalog is searched first only while it is not
 * named in search_path, so naming it last puts this schema ahead of it.
 */
async function refuseTheSharedLock(h: TestDatabase): Promise<() => Promise<number>> {
  await h.client.exec(`
    create schema lock_shadow;
    create table lock_shadow.attempts (at timestamptz not null default now());
    -- Two arguments now: each lock family has its own int4 space
    -- (lib/advisory-locks), so the gate takes (family, hashtext(key)) and a
    -- one-argument shadow would not be the function it calls.
    create function lock_shadow.pg_try_advisory_xact_lock(int, int) returns boolean as $$
      insert into lock_shadow.attempts default values returning false
    $$ language sql;
    set search_path to lock_shadow, public, pg_catalog;
  `);
  return async () => {
    const res = await h.client.query<{ n: number }>("select count(*)::int as n from lock_shadow.attempts");
    return res.rows[0]?.n ?? 0;
  };
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
  return new Date(Math.max(midnight.getTime() + 1_000, Date.now() - 5 * 60_000));
}

test("the shared lock is tried, not waited for", () => {
  // The behaviour below cannot tell a try from a wait: PGlite is one session,
  // which is granted its own advisory locks either way. What the production
  // hazard actually turns on is the verb, so the verb is asserted directly.
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "help-gate.ts"), "utf8");
  // Only the statements the gate actually runs - the note at the top of that
  // file quotes the old lock in prose, which is not a lock being taken.
  // Each lock now names its family first (lib/advisory-locks), so the pattern
  // allows that argument - and requires it, which is what stops this matching a
  // site that slipped back into the shared single-argument key space.
  const statements =
    source.match(/sql`select pg_(?:try_)?advisory_xact_lock\(\$\{LOCK_FAMILY\.\w+\}, hashtext\([^)]*\)\)/g) ?? [];
  assert.equal(statements.length, 2, "the gate takes a per-student lock and tries the shared one");
  for (const statement of statements) {
    if (statement.includes("${userId}")) {
      assert.ok(
        !statement.includes("pg_try_"),
        "the student's own gates must be exact, so their lock is waited for: " + statement,
      );
      continue;
    }
    assert.ok(
      statement.includes("pg_try_advisory_xact_lock"),
      "a lock shared by every student and recruiter must never be waited for - that is the " +
        "self-inflicted denial of service this file exists to stop: " + statement,
    );
  }
});

test("a question over the shared budget is still refused when the lock is not obtained", async () => {
  await withStudent(async (h) => {
    const attempts = await refuseTheSharedLock(h);
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
    assert.equal(over.ok, false, "the budget is read whether or not the lock was granted");
    if (!over.ok) assert.equal(over.reason, "budget");
    assert.ok((await attempts()) > 0, "the gate tried the shared lock");
    assert.equal(await chatRows(h), 1, "a refusal reserves nothing");
  });
});

test("the student's day is still refused when the lock is not obtained", async () => {
  await withStudent(async (h) => {
    await refuseTheSharedLock(h);
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
  });
});

test("a question within every limit is still admitted when the lock is not obtained", async () => {
  await withStudent(async (h) => {
    const attempts = await refuseTheSharedLock(h);
    const first = await reserveHelpQuestion(USER_ID, MODEL);
    assert.equal(first.ok, true, "failing to get the shared lock must not refuse the question");
    assert.equal(await chatRows(h), 1);
    assert.equal(await attempts(), 1, "one attempt per question, never a second wait");

    const [row] = await h.db.select().from(aiUsage).where(eq(aiUsage.userId, USER_ID));
    assert.equal(row.inputTokens, HELP_PROVISIONAL_USAGE.inputTokens, "still charged its provisional cost");
    assert.equal(row.outputTokens, HELP_PROVISIONAL_USAGE.outputTokens);
  });
});

test("the per-student burst stays exact with the shared lock unobtainable", async () => {
  await withStudent(async (h) => {
    await refuseTheSharedLock(h);
    // Three times the minute's allowance at once, the shape a script landing on
    // several instances has. The student's own gates are taken under a lock on
    // that student, which is waited for, so the count stays exact even though
    // the shared budget lock was refused.
    const results = await Promise.all(
      Array.from({ length: HELP_LIMITS.perMinute * 3 }, () => reserveHelpQuestion(USER_ID, MODEL)),
    );
    const granted = results.filter((r) => r.ok).length;
    assert.equal(granted, HELP_LIMITS.perMinute, `exactly ${HELP_LIMITS.perMinute} admitted, not ${granted}`);
    for (const r of results) if (!r.ok) assert.equal(r.reason, "burst");
    assert.equal(await chatRows(h), HELP_LIMITS.perMinute, "one row per admitted question, and no more");
  });
});

// ---- the pool's own backstop ------------------------------------------------

test("a pooled connection bounds every statement and every lock wait", async () => {
  const { createPostgresClient } = await import("@/db/connection");
  const { sql: client } = createPostgresClient("postgres://u:p@127.0.0.1:5432/x", {
    max: 8,
    allowLocalTestPlaintext: true,
  });
  try {
    const params = (client.options as { connection?: Record<string, string> }).connection ?? {};
    // Startup parameters, not SET: the app's pool is Supavisor's transaction
    // mode, where a SET does not outlive the statement (see db/pool.ts).
    assert.equal(params.lock_timeout, "3000", "an unbounded lock wait is what wedged the pool");
    assert.equal(params.statement_timeout, "30000", "a ceiling, not a performance target");
  } finally {
    await client.end({ timeout: 1 });
  }
});

test("an operator's own session keeps the server's defaults", async () => {
  const { createPostgresClient } = await import("@/db/connection");
  const { sql: client } = createPostgresClient("postgres://u:p@127.0.0.1:5432/x", {
    max: 1,
    pooling: "as-configured",
    allowLocalTestPlaintext: true,
  });
  try {
    const params = (client.options as { connection?: Record<string, string> }).connection ?? {};
    assert.equal(params.statement_timeout, undefined, "a backfill or a CREATE INDEX must not be cut off");
    assert.equal(params.lock_timeout, undefined);
  } finally {
    await client.end({ timeout: 1 });
  }
});
