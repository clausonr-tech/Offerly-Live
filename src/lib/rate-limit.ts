import "server-only";
import { LOCK_FAMILY } from "@/lib/advisory-locks";
import { createHash } from "node:crypto";
import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rateEvents } from "@/db/schema";

/**
 * A generic per-subject rate limiter backed by the rate_events table
 * (migration 0041). It is the shared guard for spend levers and
 * write-amplification paths: test SMS, provider enrichment lookups, direct
 * messages, community writes, follows, in-session re-verify, the news image
 * proxy, the crest route.
 *
 * The count and the insert happen in ONE transaction behind a per-(bucket,
 * subject) advisory lock, the same shape lib/plan-quotas.ts and
 * lib/ai-runner.ts use for their reservations. The first version of this file
 * did not take the lock: it inserted, then counted the rows its own SELECT
 * happened to see, and allowed the request if it saw fewer than `limit`
 * predecessors. Under MVCC a request is then admitted when it SEES fewer than
 * the limit rather than when fewer exist, so a genuine burst - several requests
 * inserting and selecting interleaved - could admit more than `limit`. That is
 * exactly the shape every other new ceiling in this codebase was converted away
 * from, and these are the limiters standing in front of billed SMS, billed
 * provider lookups and a password re-verification budget.
 *
 * The lock is TRIED, never waited for, and an attempt that does not get it is
 * refused rather than queued. That is not a detail: the version that waited
 * for it was itself a denial-of-service lever. /api/crest takes no session and
 * meters on the caller's own address, so a few hundred parallel requests from
 * one address all contend on one lock key; each waiter holds one of the
 * instance's eight Postgres connections (src/db/client.ts) while it waits,
 * because a transaction reserves its connection for its whole life. The pool
 * empties, every unrelated query in the app queues behind it, and at
 * `lock_timeout` (3s, src/db/connection.ts) the waiters throw into the catch
 * below and drop every limiter in the app to its per-process fallback. This is
 * the same lesson lib/help-gate.ts learned about its global lock, in the same
 * week, from the other direction.
 *
 * So: contention refuses. Refusing costs one subject one attempt it can retry
 * a second later; waiting costs every other person using the app.
 *
 * Can a refusal be aimed at someone else? For most buckets no - the key is the
 * caller's own user id, or a pair containing it. But three buckets are keyed on
 * a third party on purpose: the firm code-send and reset buckets on the typed
 * email address, and the resume-share ceiling on the OWNER of the link while
 * whoever holds it drives the request. In all three the same caller can already
 * spend that budget outright, which is a strictly larger power than making one
 * attempt collide, so this adds no capability - but the first version of this
 * comment claimed nobody could aim it anywhere, and that was simply wrong.
 *
 * `subject` must be a server-resolved identity (a user id, a normalised
 * destination, a validated IP), never a client-supplied label. A composite
 * subject is joined with ":" - never with a NUL byte, which the `text` column
 * cannot store.
 *
 * If the database is unreachable it falls back to a per-process memory count,
 * which bounds a burst on one instance but not across them. That fallback is a
 * fail-open, so it is logged: a silent one would hide the moment every limiter
 * in the app got weaker.
 */

export type RateLimitOutcome = { allowed: boolean; retryAfterMs: number };

const memory = new Map<string, number[]>();

/** The longest subject stored verbatim. Beyond this it is hashed, so an
 *  oversized value cannot exceed the index's row limit and make the insert
 *  throw - which would silently drop this limiter to the memory fallback. */
const MAX_SUBJECT = 200;

/**
 * The subject as stored. Hashed when it is too long or carries a NUL byte, so
 * no call site can make the insert fail. Hashing keeps buckets distinct, which
 * is all the limiter needs; nothing reads the subject back.
 */
function storedSubject(subject: string): string {
  if (subject.length <= MAX_SUBJECT && !subject.includes("\u0000")) return subject;
  return `sha256:${createHash("sha256").update(subject).digest("hex")}`;
}

/**
 * What a contended attempt is told to wait. Short, because the thing it
 * collided with finishes in milliseconds - this is "you and you alone sent two
 * at once", not "you are out of budget".
 */
const CONTENDED_RETRY_MS = 1_000;

/**
 * Whether this transaction got the subject's lock. Tried, so it returns
 * immediately either way.
 *
 * The two drivers hand back a result in two shapes (postgres-js an array,
 * PGlite an object with `rows`), which is why the row is dug out the way
 * lib/video-interview/deletion-queue.ts does it. A result that cannot be read
 * counts as NOT holding the lock, so an unreadable answer refuses rather than
 * proceeding unprotected.
 */
async function tookLock(tx: { execute: (q: SQL) => Promise<unknown> }, key: string): Promise<boolean> {
  const res = await tx.execute(sql`select pg_try_advisory_xact_lock(${LOCK_FAMILY.rateLimit}, hashtext(${key})) as got`);
  const row = Array.isArray(res) ? res[0] : (res as { rows?: { got?: boolean }[] }).rows?.[0];
  return (row as { got?: boolean } | undefined)?.got === true;
}

function memoryCheck(key: string, limit: number, windowMs: number, now: number): RateLimitOutcome {
  const kept = (memory.get(key) ?? []).filter((t) => t > now - windowMs);
  if (kept.length >= limit) {
    memory.set(key, kept);
    const oldestCounted = kept[kept.length - limit] ?? kept[0] ?? now;
    return { allowed: false, retryAfterMs: Math.max(0, oldestCounted + windowMs - now) };
  }
  kept.push(now);
  memory.set(key, kept);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Whether an action for `subject` in `bucket` may proceed, given at most
 * `limit` in the trailing `windowMs`. A refused attempt records nothing, so
 * hammering a blocked subject does not push its window forward: a legitimate
 * retry lands as soon as the earliest counted attempt ages out.
 */
export async function rateLimit(
  bucket: string,
  subject: string,
  limit: number,
  windowMs: number,
  now: Date = new Date(),
): Promise<RateLimitOutcome> {
  // A limit of zero means "never", and has no retry to report.
  if (limit <= 0) return { allowed: false, retryAfterMs: windowMs };

  const stored = storedSubject(subject);
  const key = `${bucket}\u0000${stored}`;
  const since = new Date(now.getTime() - windowMs);
  const mine = and(eq(rateEvents.bucket, bucket), eq(rateEvents.subject, stored));

  try {
    const db = await getDb();
    // One transaction type across the two drivers (PGlite, postgres-js).
    const run = db.transaction.bind(db) as unknown as <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
    return await run(async (tx) => {
      if (!(await tookLock(tx, `rate:${bucket}:${stored}`))) {
        return { allowed: false, retryAfterMs: CONTENDED_RETRY_MS };
      }
      const rows = await tx
        .select({ at: rateEvents.createdAt })
        .from(rateEvents)
        .where(and(mine, gte(rateEvents.createdAt, since)));

      if (rows.length >= limit) {
        const counted = rows.map((r) => r.at.getTime()).sort((a, b) => a - b);
        const oldestCounted = counted[counted.length - limit];
        return { allowed: false, retryAfterMs: Math.max(0, oldestCounted + windowMs - now.getTime()) };
      }

      await tx.insert(rateEvents).values({ bucket, subject: stored, createdAt: now });
      // Keep the table from growing without bound. Pruned inside the lock, and
      // on this subject's own rows only, so it cannot scan the whole bucket -
      // which for an anonymous bucket like the crest route's would be a
      // growing cost on every request.
      if (Math.random() < 0.05) {
        await tx.delete(rateEvents).where(and(mine, lt(rateEvents.createdAt, since)));
      }
      return { allowed: true, retryAfterMs: 0 };
    });
  } catch (err) {
    // Fail-open, and say so. Without this line the whole rate-limiting layer
    // could weaken - every bucket at once, on a database wobble - with nothing
    // in the log to show it happened.
    console.error(
      `[rate-limit] database unavailable for bucket "${bucket}"; falling back to this process's own count:`,
      err instanceof Error ? err.message : err,
    );
    return memoryCheck(key, limit, windowMs, now.getTime());
  }
}

/**
 * Forgets a subject's attempts in one bucket.
 *
 * For a budget that exists to bound WRONG answers: the caller charges every
 * attempt, so a parallel burst is still counted, and clears the record once an
 * attempt succeeds. Without this, five CORRECT password re-entries would lock a
 * student out of their own settings for the window - the limiter counting
 * diligently against the one person it was not meant to stop. The sign-in
 * throttle has had the same shape from the start (its finish(true) clears the
 * account's count); this is that, for the rate_events buckets.
 *
 * Best-effort: failing to forget leaves a budget slightly smaller than
 * intended, which is the safe direction.
 */
export async function clearRateLimit(bucket: string, subject: string): Promise<void> {
  const stored = storedSubject(subject);
  memory.delete(`${bucket}\u0000${stored}`);
  try {
    const db = await getDb();
    await db.delete(rateEvents).where(and(eq(rateEvents.bucket, bucket), eq(rateEvents.subject, stored)));
  } catch {
    // A budget that stays charged is the safe direction to fail.
  }
}

/** A short human phrase for a retry delay, for action error messages. */
export function retryAfterText(ms: number): string {
  // Under five seconds is a collision, not a budget: "a minute" would be wrong
  // and would read as a much longer wait than the caller actually has.
  if (!Number.isFinite(ms) || ms <= 5_000) return "a moment";
  const mins = Math.ceil(ms / 60_000);
  if (mins <= 1) return "a minute";
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.ceil(mins / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}
