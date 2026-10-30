/**
 * The shared per-subject rate limiter, against a REAL database.
 *
 * Drives lib/rate-limit.rateLimit over a PGlite instance migrated by replaying
 * drizzle/*.sql, so the rate_events table and its index are the real ones. No
 * network, no connection string: the limiter's only I/O is the test database.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";
import { rateEvents } from "@/db/schema";
import { eq } from "drizzle-orm";

async function withDb(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

const WINDOW = 60 * 60_000; // one hour
const LIMIT = 3;

test("allows up to the limit, then refuses, within the window", async () => {
  await withDb(async () => {
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    for (let i = 0; i < LIMIT; i++) {
      const out = await rateLimit("sms:test", "user-a", LIMIT, WINDOW, new Date(base + i * 1000));
      assert.equal(out.allowed, true, `attempt ${i + 1} should be allowed`);
    }
    const refused = await rateLimit("sms:test", "user-a", LIMIT, WINDOW, new Date(base + LIMIT * 1000));
    assert.equal(refused.allowed, false, "the attempt past the limit must be refused");
    assert.ok(refused.retryAfterMs > 0, "a refusal reports when to retry");
  });
});

test("a refused attempt is not recorded, so it cannot push the window forward", async () => {
  await withDb(async (h) => {
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    for (let i = 0; i < LIMIT; i++) {
      await rateLimit("sms:test", "user-b", LIMIT, WINDOW, new Date(base + i * 1000));
    }
    await rateLimit("sms:test", "user-b", LIMIT, WINDOW, new Date(base + LIMIT * 1000)); // refused
    const rows = await h.db.select().from(rateEvents).where(eq(rateEvents.subject, "user-b"));
    assert.equal(rows.length, LIMIT, "only the allowed attempts leave a row");
  });
});

test("reopens once the earliest counted attempt ages out of the window", async () => {
  await withDb(async () => {
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    for (let i = 0; i < LIMIT; i++) {
      await rateLimit("sms:test", "user-c", LIMIT, WINDOW, new Date(base + i * 1000));
    }
    const stillBlocked = await rateLimit("sms:test", "user-c", LIMIT, WINDOW, new Date(base + WINDOW / 2));
    assert.equal(stillBlocked.allowed, false, "still blocked mid-window");
    const reopened = await rateLimit("sms:test", "user-c", LIMIT, WINDOW, new Date(base + WINDOW + 2000));
    assert.equal(reopened.allowed, true, "allowed again once the first attempt ages out");
  });
});

test("subjects and buckets are independent", async () => {
  await withDb(async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < LIMIT; i++) {
      await rateLimit("sms:test", "user-d", LIMIT, WINDOW, new Date(now.getTime() + i));
    }
    const otherUser = await rateLimit("sms:test", "user-e", LIMIT, WINDOW, now);
    assert.equal(otherUser.allowed, true, "a different subject has its own budget");
    const otherBucket = await rateLimit("dm:send", "user-d", LIMIT, WINDOW, now);
    assert.equal(otherBucket.allowed, true, "a different bucket has its own budget");
  });
});

// The adversarial pass over this file's first version found it was the only
// new metering primitive without a lock: it inserted, then counted the rows
// its own SELECT happened to see, so a request was admitted when it SAW fewer
// than the limit rather than when fewer existed. These are the limiters in
// front of billed SMS, billed provider lookups and a password-guess budget.

test("attempts fired together cannot all pass the same count", async () => {
  await withDb(async () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const results = await Promise.all(
      Array.from({ length: LIMIT * 5 }, () => rateLimit("burst", "user-f", LIMIT, WINDOW, now)),
    );
    const granted = results.filter((r) => r.allowed).length;
    assert.equal(granted, LIMIT, `exactly ${LIMIT} granted, not ${granted}`);
  });
});

test("a refused attempt records nothing, so the window does not creep", async () => {
  await withDb(async (h) => {
    const base = new Date("2026-02-01T00:00:00Z").getTime();
    for (let i = 0; i < LIMIT + 7; i++) {
      await rateLimit("burst", "user-g", LIMIT, WINDOW, new Date(base + i * 1000));
    }
    const rows = await h.db.select().from(rateEvents).where(eq(rateEvents.subject, "user-g"));
    assert.equal(rows.length, LIMIT, "only the granted attempts are stored");
  });
});

test("an oversized or NUL-bearing subject cannot make the insert throw", async () => {
  await withDb(async () => {
    // Left unguarded these would exceed the index row limit, or be rejected by
    // a text column, and the catch would silently drop the whole limiter to
    // its per-process fallback.
    const huge = "x".repeat(5000);
    const nul = `a\u0000b`;
    for (const subject of [huge, nul]) {
      for (let i = 0; i < LIMIT; i++) {
        const ok = await rateLimit("odd", subject, LIMIT, WINDOW);
        assert.equal(ok.allowed, true);
      }
      const over = await rateLimit("odd", subject, LIMIT, WINDOW);
      assert.equal(over.allowed, false, "still a real limit, not a fallback");
    }
  });
});

test("a limit of zero refuses without reporting a nonsense retry", async () => {
  await withDb(async () => {
    const out = await rateLimit("never", "user-h", 0, WINDOW);
    assert.equal(out.allowed, false);
    assert.ok(Number.isFinite(out.retryAfterMs), "retryAfterMs must be a number");
    assert.doesNotMatch(retryAfterText(out.retryAfterMs), /NaN/);
  });
});
