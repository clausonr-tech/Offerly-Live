/**
 * The shared limiter refuses a collision instead of queueing for it.
 *
 * This needs REAL Postgres on the production driver, because the thing being
 * tested is what happens to a second connection while a first one holds a
 * lock - and PGlite has one connection, so under PGlite a "burst" is already
 * serialised and nothing ever contends.
 *
 * WHY IT MATTERS. The second round of fixes put a per-(bucket, subject)
 * advisory lock in lib/rate-limit so a burst from one subject could not all
 * pass the same count. It WAITED for that lock, and the third adversarial pass
 * showed that the waiting was itself a denial-of-service lever: /api/crest
 * takes no session and meters on the caller's own address, so a few hundred
 * parallel requests from one address contend on one key, each waiter holds one
 * of the instance's eight Postgres connections for the whole wait (a
 * transaction reserves its connection), the pool empties, every unrelated
 * query in the app queues behind it, and at lock_timeout the waiters throw
 * into the limiter's catch and drop every bucket in the app to its weak
 * per-process fallback.
 *
 * So the lock is now TRIED and a collision is refused. These tests pin both
 * halves: a contended attempt comes back refused and comes back FAST, and the
 * budget is untouched by it - a refusal must not spend the subject's window.
 *
 * Nothing here touches Supabase: helpers/real-postgres runs initdb into a temp
 * directory and deletes it afterwards. DATABASE_URL is never read.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import "./helpers/no-network";
import { postgresAvailability, startRealPostgres, type RealPostgres } from "./helpers/real-postgres";
import { installAsAppDb } from "./helpers/test-db";
import { LOCK_FAMILY } from "@/lib/advisory-locks";
import { clearRateLimit, rateLimit, retryAfterText } from "@/lib/rate-limit";

const availability = postgresAvailability();
// The one honest skip: a machine without Postgres binaries cannot run this.
const skipIfNoPostgres = availability.ok ? undefined : { skip: availability.why };
if (!availability.ok) console.warn(`SKIPPING rate-limit-contention: ${availability.why}`);

const BUCKET = "contention-test";
const SUBJECT = "11111111-1111-4111-8111-111111111111";
const LOCK_KEY = `rate:${BUCKET}:${SUBJECT}`;

let pg: RealPostgres;
let restoreDb: (() => void) | undefined;

before(async () => {
  if (!availability.ok) return;
  pg = await startRealPostgres();
  restoreDb = installAsAppDb(pg.db);
});

after(async () => {
  restoreDb?.();
  await pg?.stop();
});

test("a contended attempt is refused, not queued behind the lock", skipIfNoPostgres, async () => {
  await clearRateLimit(BUCKET, SUBJECT);

  // A second connection holds the subject's lock for as long as this
  // transaction runs. This is what a parallel request from the same address
  // looks like from inside the limiter.
  await pg.sql.begin(async (held) => {
    // The family argument matters: each lock family has its own int4 space
      // (lib/advisory-locks), so a lock taken without it would not contend with
      // the limiter at all and this test would pass vacuously.
      await held`select pg_advisory_xact_lock(${LOCK_FAMILY.rateLimit}, hashtext(${LOCK_KEY}))`;

    const started = Date.now();
    const outcome = await rateLimit(BUCKET, SUBJECT, 5, 60_000);
    const elapsed = Date.now() - started;

    assert.equal(outcome.allowed, false, "a contended attempt was admitted without holding the lock");
    // The point of the whole change. If this ever waits, it is holding a pool
    // connection while it does, and the number that matters is lock_timeout:
    // three SECONDS. One second is already far more slack than a try-lock
    // round trip needs.
    assert.ok(elapsed < 1_000, `the attempt waited ${elapsed}ms - it is queueing again`);
    // And it is told to come back in a moment, not in a minute: this is a
    // collision with itself, not a spent budget.
    assert.ok(outcome.retryAfterMs <= 5_000, `retryAfterMs was ${outcome.retryAfterMs}`);
    assert.equal(retryAfterText(outcome.retryAfterMs), "a moment");
  });
});

test("the refusal spends nothing: the full budget is still there afterwards", skipIfNoPostgres, async () => {
  await clearRateLimit(BUCKET, SUBJECT);

  // Collide three times.
  for (let i = 0; i < 3; i++) {
    await pg.sql.begin(async (held) => {
      // The family argument matters: each lock family has its own int4 space
      // (lib/advisory-locks), so a lock taken without it would not contend with
      // the limiter at all and this test would pass vacuously.
      await held`select pg_advisory_xact_lock(${LOCK_FAMILY.rateLimit}, hashtext(${LOCK_KEY}))`;
      assert.equal((await rateLimit(BUCKET, SUBJECT, 3, 60_000)).allowed, false);
    });
  }

  // With the lock free again, all three uses are available. If a contended
  // refusal had written a row - or had pushed the window forward - this would
  // run out early, and the student it collided with would be the one punished.
  for (let i = 0; i < 3; i++) {
    assert.equal((await rateLimit(BUCKET, SUBJECT, 3, 60_000)).allowed, true, `use ${i + 1} of 3`);
  }
  assert.equal((await rateLimit(BUCKET, SUBJECT, 3, 60_000)).allowed, false, "the fourth is over the limit");
});

test("with the lock free, the limiter is exact under a real parallel burst", skipIfNoPostgres, async () => {
  // The property round two added, now measured on real Postgres with real
  // concurrency rather than on PGlite's single connection. Twice the limit,
  // fired together: because a collision refuses rather than overshooting,
  // the count can never exceed the limit - which is the direction that
  // matters for a limiter standing in front of a bill.
  await clearRateLimit(BUCKET, SUBJECT);
  const limit = 4;
  const results = await Promise.all(
    Array.from({ length: limit * 2 }, () => rateLimit(BUCKET, SUBJECT, limit, 60_000)),
  );
  const granted = results.filter((r) => r.allowed).length;
  assert.ok(granted <= limit, `${granted} attempts were admitted against a limit of ${limit}`);
  assert.ok(granted >= 1, "every attempt in the burst was refused - the limiter admitted nobody");
});
