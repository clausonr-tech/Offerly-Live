// Surviving the Internet Archive's rate limiter.
//
// Measured 19 September against the critical tier: 23 CDX index queries fired
// back to back returned 22 HTTP 503s and one normal answer. Not an outage -
// the index is a shared service that refuses a client asking faster than it
// likes. A sweep that reads 503 as "this firm has no history" writes that
// conclusion into the permanent record for the whole directory.
//
// Three things have to hold, and none of them did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/lib/monitoring/opening-history.ts", "utf8");
const sweep = readFileSync("scripts/tiered-opening-dates.ts", "utf8");

test("index queries are spaced by a process-wide gate", () => {
  // GAP_MS spaces snapshot fetches WITHIN one firm's boundary search. Nothing
  // spaced the index queries BETWEEN firms, which is what produced 22
  // consecutive refusals.
  assert.match(source, /CDX_GAP_MS/, "a gap between CDX requests must exist");
  assert.match(source, /nextCdxSlot/, "and be enforced for every caller");
  assert.match(source, /await nextCdxSlot\(\);/, "including inside the retry loop");
});

test("the gate is a queue, not a timestamp check", () => {
  // Concurrent callers must queue behind each other rather than all observing
  // "the last request was long ago" at the same instant and firing together.
  assert.match(source, /cdxTurn = mine/, "the chain has to be advanced");
});

test("the retry schedule outlasts a rate-limit window", () => {
  // Three tries at 2s and 4s all land inside the same refusal.
  assert.match(source, /const CDX_ATTEMPTS = 3;/);
  assert.match(source, /const RETRY_GAP_MS = 10000;/);
  assert.match(source, /2 \*\* \(attempt - 1\)/, "backoff must be exponential");
});

test("retrying is bounded so a refusal is cheap", () => {
  // Five attempts at 10/20/40/80s meant one board took nine minutes to fail,
  // which is how a 284-lookup sweep became a 40-hour one.
  const attempts = Number(/const CDX_ATTEMPTS = (\d+);/.exec(source)?.[1]);
  const gap = Number(/const RETRY_GAP_MS = (\d+);/.exec(source)?.[1]);
  let worst = 0;
  for (let a = 1; a < attempts; a++) worst += gap * 2 ** (a - 1);
  assert.ok(worst <= 60000, `a single refusal costs ${worst / 1000}s of backoff`);
});

test("the sweep stops when the Archive is refusing everything", () => {
  // A throttled run does not fail fast, so grinding through the rest takes
  // hours to learn what was clear after a handful.
  assert.match(sweep, /REFUSAL_LIMIT/);
  assert.match(sweep, /consecutiveRefusals/);
  assert.match(sweep, /HTTP \(429\|50/, "only a refusal should count, not a 404");
  assert.match(sweep, /STOPPING/);
});

test("the Archive index is fetched once per board, not once per industry", () => {
  // The three CDX queries depend only on the board; the industry is a filter
  // on the result. Fetching per task made Goldman eighteen identical requests.
  assert.match(sweep, /boardCache/);
  assert.match(sweep, /cache\.jobUrls === null/);
  assert.match(sweep, /cache\.pages === null/);
  assert.match(sweep, /cache\.api === null/);
});

test("the server's own Retry-After beats our guess", () => {
  assert.match(source, /retry-after/i);
  assert.match(source, /Math\.max\(retryAfterMs/);
});

test("a 503 is retried and a 404 is not", () => {
  // A 4xx will not improve on retry; a 5xx or 429 might. Spending five
  // attempts on a board that does not exist is the other way to waste a
  // rate limit.
  assert.match(source, /res\.status < 500 && res\.status !== 429/);
});

test("resume re-attempts errored pairs rather than calling them done", () => {
  // The quiet one. An error row is the Archive refusing us, not a finding, and
  // skipping it forever writes "we could not reach the Archive once" into the
  // permanent record.
  assert.match(sweep, /r\.outcome !== "error"/);
  assert.match(sweep, /will be re-attempted/);
});

test("real answers are still kept on resume", () => {
  // A window, a span too wide, or no usable history do not improve by asking
  // again - re-running those would spend the whole rate limit on settled
  // questions.
  assert.match(sweep, /answered: new Set\(keep\.map/);
});

test("the sweep still writes after every pair", () => {
  // A run that dies to rate limiting must keep what it already learned.
  assert.match(sweep, /write\(rows\);/);
});
