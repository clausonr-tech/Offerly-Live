// Telling "no" apart from "not now", for every sector.
//
// The probe learned this when Personio answered a bogus token with 429 and
// "any status that is not 200 means no board" became "this firm has no
// board". The crawler had the identical bug against REAL firms and nobody
// connected the two: every status at or above 400 went to recordFailure,
// which degrades a source at two failures and marks it broken at five.
//
// Measured 20 September 2026, looking across all sectors rather than just
// investment banking: all thirteen Workable sources answered 429 - nine hedge
// funds, three venture capital firms, one real estate manager - on one shared
// host, with `Retry-After: 32615`. Five hourly runs would have marked every
// one of them broken and tiered them out of the schedule.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInconclusive,
  retryAfterMs,
  inconclusiveRetryMs,
  inconclusiveWaitMs,
  INCONCLUSIVE_PATIENCE,
  INCONCLUSIVE_MAX_MS,
  MAX_RETRY_AFTER_MS,
} from "../../src/lib/monitoring/http-outcome";

// ------------------------------------------------- which statuses are answers

const notAnswers = [0, 408, 429, 500, 502, 503, 504, 599];
for (const status of notAnswers) {
  test(`${status} is not an answer about the firm`, () => {
    assert.equal(isInconclusive(status), true);
  });
}

// 403 left this list on 20 September 2026 - see the note on isInconclusive.
const realAnswers = [200, 201, 204, 301, 302, 304, 400, 401, 404, 410, 418, 451];
for (const status of realAnswers) {
  test(`${status} IS a real answer`, () => {
    assert.equal(isInconclusive(status), false);
  });
}

test("404 stays conclusive - a board that is gone is gone", () => {
  // The rule must not widen into "treat everything as temporary", or a
  // genuinely dead board is retried forever and never reported. 404 is the
  // board saying it does not exist, which is an answer.
  assert.equal(isInconclusive(404), false);
  assert.equal(isInconclusive(401), false, "wanting credentials is an answer too");
});

test("403 is NOT an answer about the firm", () => {
  // The server refusing to serve US says nothing about whether the firm has
  // internships. Stephens Inc and Cascadia Capital were both two failures
  // from being written off for it, with robots.txt on both sites permitting
  // the careers page we were being refused.
  assert.equal(isInconclusive(403), true);
});

test("the crawler and the prober share one definition", async () => {
  // Two copies of "which statuses are not answers" would drift the moment one
  // of them learned about a new status.
  const probe = await import("../../src/lib/monitoring/ats-probe");
  for (const status of [...notAnswers, ...realAnswers]) {
    assert.equal(probe.isInconclusive(status), isInconclusive(status), String(status));
  }
});

// --------------------------------------------------------------- Retry-After

test("the numeric form is read as seconds", () => {
  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs("1"), 1000);
  assert.equal(retryAfterMs("0"), 0);
});

test("Workable's real header is honoured", () => {
  // 32615 seconds - just over nine hours - measured on apply.workable.com.
  assert.equal(retryAfterMs("32615"), 32_615_000);
  assert.ok(32_615_000 <= MAX_RETRY_AFTER_MS, "the cap must not silently discard a real answer");
});

test("the date form is read as a moment to come back at", () => {
  const when = new Date(Date.now() + 90 * 60_000).toUTCString();
  const got = retryAfterMs(when);
  assert.ok(got !== null);
  assert.ok(Math.abs(got - 90 * 60_000) < 2000, `got ${got}`);
});

test("a date already past means now, never a negative wait", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(retryAfterMs(past), 0);
});

test("an absurd wait is clamped rather than dropping the source", () => {
  // A header asking for a week is a ban or a mistake; either way the source
  // must stay in the schedule.
  const week = retryAfterMs(String(7 * 24 * 3600));
  assert.equal(week, MAX_RETRY_AFTER_MS);
  assert.ok(MAX_RETRY_AFTER_MS <= 12 * 60 * 60_000);
});

const noHeader = [null, undefined, "", "   ", "soon", "tomorrow", "-5", "1.5", "NaN"];
for (const h of noHeader) {
  test(`an unusable Retry-After is null, so the caller falls back: ${JSON.stringify(h)}`, () => {
    assert.equal(retryAfterMs(h), null);
  });
}

test("retryAfterMs never throws", () => {
  for (const h of [...noHeader, "x".repeat(5000), "999999999999999999"]) {
    assert.doesNotThrow(() => retryAfterMs(h), String(h));
  }
});

// ------------------------------------------------------------- the fallback

test("a source that might just be busy is never silenced for long", () => {
  // The 20 September property, unchanged and still the reason this function
  // is not simply exponential: inside the patience window a throttle must not
  // cost the firm a day. All thirteen Workable sources answered 429 from one
  // shared host while being perfectly healthy.
  for (let attempt = 1; attempt <= INCONCLUSIVE_PATIENCE; attempt++) {
    const ms = inconclusiveRetryMs(attempt, () => 0.5);
    assert.ok(ms <= 60 * 60_000, `attempt ${attempt} waited ${Math.round(ms / 60000)}m`);
  }
});

test("a source that has never answered is asked daily, not every 15 minutes", () => {
  // The bug this replaces: the growth below was unreachable, because the only
  // caller passed `failureCount + 1` from the one branch that never
  // increments failureCount. Every attempt was attempt 1, so a board
  // answering nothing was asked four times an hour indefinitely - 351 such
  // sources accounted for 12,902 of 28,597 check runs.
  const at = (n: number) => inconclusiveRetryMs(n, () => 0.5);
  assert.ok(at(2) > at(1), "should back off a little while patient");
  assert.ok(at(6) > at(4), "and keep backing off once patience has run out");
  assert.ok(at(10) >= 12 * 60 * 60_000, `ten no-answers should be ~daily, got ${at(10)}ms`);
});

test("the backoff is capped at a day, jitter included", () => {
  // Never longer: a board that comes back must not wait a week to be noticed.
  for (const attempt of [8, 20, 500]) {
    for (const r of [0, 0.5, 0.999]) {
      assert.ok(
        inconclusiveRetryMs(attempt, () => r) <= INCONCLUSIVE_MAX_MS,
        `attempt ${attempt} r=${r} exceeded the cap`,
      );
    }
  }
});

test("Retry-After wins while patient, and is a floor afterwards", () => {
  const thirtySeconds = 30_000;
  // The vendor's own statement about its own load, honoured exactly.
  assert.equal(inconclusiveWaitMs(1, thirtySeconds, () => 0.5), thirtySeconds);
  assert.equal(
    inconclusiveWaitMs(INCONCLUSIVE_PATIENCE, thirtySeconds, () => 0.5),
    thirtySeconds,
  );
  // Past that, "try again in 30 seconds" on the two-hundredth attempt is not
  // an instruction to keep asking every 30 seconds forever.
  const later = inconclusiveWaitMs(8, thirtySeconds, () => 0.5);
  assert.ok(later > thirtySeconds, `expected our own longer wait, got ${later}ms`);
  // A stated wait LONGER than ours still wins - waiting less could offend.
  const nineHours = 9 * 60 * 60_000;
  assert.ok(inconclusiveRetryMs(5, () => 0.5) < nineHours, "fixture must bracket the curve");
  assert.equal(inconclusiveWaitMs(5, nineHours, () => 0.5), nineHours);
  // No header at all falls back to the curve.
  assert.equal(inconclusiveWaitMs(8, null, () => 0.5), inconclusiveRetryMs(8, () => 0.5));
});

test("the fallback is jittered, so a shared host is not retried in lockstep", () => {
  // Thirteen sources on one host all retrying at the same instant is how the
  // throttle happened in the first place.
  const values = new Set(Array.from({ length: 20 }, () => inconclusiveRetryMs(1)));
  assert.ok(values.size > 5, `only ${values.size} distinct delays - not jittered`);
});

test("the fallback is always a sane positive number", () => {
  for (const attempt of [0, 1, 5, 100, -1]) {
    for (const r of [0, 0.5, 0.999]) {
      const ms = inconclusiveRetryMs(attempt, () => r);
      assert.ok(Number.isFinite(ms) && ms > 0, `attempt ${attempt} r=${r} -> ${ms}`);
    }
  }
});

test("a vendor's stated wait always beats the invented one", () => {
  // The ordering the scheduler relies on: `result.retryAfterMs ?? fallback`.
  const stated = retryAfterMs("32615")!;
  assert.ok(stated > inconclusiveRetryMs(1, () => 0.999), "a real 9h answer must win");
});
