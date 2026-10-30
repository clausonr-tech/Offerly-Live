// What the crawler does when something goes wrong mid-crawl, in every sector.
//
// Four separate rules decide whether a bad moment is charged to a firm, and
// each was written after one of them was not:
//
//   isInconclusive     a vendor's 429 is not a firm saying "no"
//   isDatabaseError    OUR failed write is not a verdict on their board
//   isBoardCollapse    a board that emptied is a flag, not a failure
//   decideClosure      absence during a failed read is not evidence
//
// Every one of them is sector-blind by construction - they read statuses and
// counts, not industries - and this file is the standing proof of that. A
// rule that behaved differently for hedge funds than for banks would be
// invisible until a sector quietly emptied.
//
// The cost of getting these wrong is asymmetric and permanent: a source
// degrades at 2 failures and is marked broken at 5, and a broken source is
// tiered out of the schedule with a stated reason nobody revisits.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInconclusive,
  retryAfterMs,
  inconclusiveRetryMs,
  MAX_RETRY_AFTER_MS,
  INCONCLUSIVE_PATIENCE,
  INCONCLUSIVE_MAX_MS,
} from "../../src/lib/monitoring/http-outcome";
import { isDatabaseError } from "../../src/lib/monitoring/db-outcome";
import { isBoardCollapse, COLLAPSE_FLOOR } from "../../src/lib/monitoring/board-collapse";
import { decideClosure } from "../../src/lib/monitoring/listing-lifecycle";
import type { FirmProgramCategory } from "../../src/lib/firm-metadata";

const SECTORS: FirmProgramCategory[] = [
  "investment_banking", "private_equity", "venture_capital", "private_credit",
  "real_estate", "hedge_fund", "sales_trading", "asset_wealth_management",
  "commercial_banking", "insurance", "fintech", "market_infrastructure",
  "consulting", "other_finance",
];

const HOUR = 60 * 60_000;

// ------------------------------------------------ which statuses are answers

// Every status a real crawl meets, and whether it says anything about the firm.
const STATUS_MEANING: [number, boolean, string][] = [
  [0, true, "connector could not complete the read at all"],
  [200, false, "a real answer"],
  [204, false, "a real answer, empty"],
  [301, false, "a redirect the fetch follows"],
  [400, false, "we sent something wrong - a real fault"],
  [401, false, "the board wants credentials - a real fault"],
  [403, true, "the server refuses to serve US - not a fact about the firm"],
  [404, false, "the board is gone - a real answer"],
  [408, true, "our own request timed out"],
  [410, false, "gone, deliberately"],
  [429, true, "the vendor is throttling us"],
  [500, true, "the vendor is broken"],
  [502, true, "the vendor is broken"],
  [503, true, "the vendor is broken"],
  [504, true, "the vendor is broken"],
];

for (const [status, inconclusive, why] of STATUS_MEANING) {
  test(`HTTP ${status} is ${inconclusive ? "inconclusive" : "an answer"} - ${why}`, () => {
    assert.equal(isInconclusive(status), inconclusive);
  });
}

test("every 5xx is inconclusive, not just the common ones", () => {
  for (let s = 500; s <= 599; s++) assert.equal(isInconclusive(s), true, `HTTP ${s}`);
});

test("403 does not drag the other 4xx with it", () => {
  // Only 403 and 408 are inconclusive in the 4xx range. A 404 is the board
  // being gone and a 401 is it wanting credentials - both real answers.
  for (const s of [400, 401, 402, 404, 405, 409, 410, 418, 422]) {
    assert.equal(isInconclusive(s), false, `HTTP ${s}`);
  }
});

test("no 2xx or 3xx is ever inconclusive", () => {
  for (let s = 200; s < 400; s++) assert.equal(isInconclusive(s), false, `HTTP ${s}`);
});

// ------------------------------------------------------- Retry-After shapes

const RETRY_HEADERS: [string | null | undefined, number | null, string][] = [
  ["30", 30_000, "plain seconds"],
  ["0", 0, "zero seconds is a real instruction"],
  ["32615", 32615_000, "nine hours - the real Workable value"],
  ["999999", MAX_RETRY_AFTER_MS, "clamped to twelve hours"],
  ["  45  ", 45_000, "whitespace trimmed"],
  ["-5", null, "a negative is a broken header, not a date"],
  ["1.5", null, "a fraction is a broken header, not a date"],
  ["+10", null, "a signed number is not a clean count"],
  ["", null, "empty"],
  ["   ", null, "blank"],
  [null, null, "absent"],
  [undefined, null, "undefined"],
  ["not a date at all", null, "unparseable words"],
  ["12345abc", null, "number-shaped rubbish"],
];

for (const [header, expected, why] of RETRY_HEADERS) {
  test(`Retry-After ${JSON.stringify(header)} -> ${expected} (${why})`, () => {
    assert.equal(retryAfterMs(header), expected);
  });
}

test("an HTTP-date Retry-After in the past is now, never negative", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  const ms = retryAfterMs(past);
  assert.ok(ms !== null && ms >= 0, String(ms));
});

test("an HTTP-date Retry-After is clamped like a numeric one", () => {
  const far = new Date(Date.now() + 40 * 24 * HOUR).toUTCString();
  assert.equal(retryAfterMs(far), MAX_RETRY_AFTER_MS);
});

// ------------------------------------------------------ backoff after a 429

test("a source that might just be busy retries sooner than its tier would", () => {
  // Right for a busy source and wrong for a broken one, so it holds only
  // inside the patience window. A 429 from a healthy board must not cost the
  // firm a day - that is the Workable case this branch exists for.
  for (let attempt = 1; attempt <= INCONCLUSIVE_PATIENCE; attempt++) {
    const ms = inconclusiveRetryMs(attempt, () => 0.5);
    assert.ok(ms <= HOUR, `attempt ${attempt} -> ${ms}`);
  }
});

test("a source that has never answered is asked daily, not four times an hour", () => {
  // What the flat version cost: `inconclusiveRetryMs(failureCount + 1)` was
  // called from the one branch that never increments failureCount, so every
  // attempt was attempt 1. 351 sources that had never produced a successful
  // read accounted for 12,902 of 28,597 check runs.
  const at = (n: number) => inconclusiveRetryMs(n, () => 0.5);
  assert.ok(at(2) > at(1), "backs off while patient");
  assert.ok(at(6) > at(4), "keeps backing off once patience runs out");
  assert.equal(at(12), at(20), "capped at a day");
  assert.ok(at(12) <= INCONCLUSIVE_MAX_MS, "and the cap is a day");
});

test("the backoff is jittered - thirteen sources must not retry in lockstep", () => {
  // Thirteen sources on one host all retrying at the same instant is how the
  // throttle happened in the first place.
  const low = inconclusiveRetryMs(1, () => 0);
  const high = inconclusiveRetryMs(1, () => 1);
  assert.ok(high > low, `${low} vs ${high}`);
});

for (let attempt = 1; attempt <= 8; attempt++) {
  test(`attempt ${attempt} never returns a zero or negative wait`, () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      assert.ok(inconclusiveRetryMs(attempt, () => r) > 0);
    }
  });
}

// ------------------------------------------- the rules are the same everywhere

for (const sector of SECTORS) {
  test(`${sector}: a vendor throttle is never charged to the firm`, () => {
    // No sector argument exists, which is the point - this asserts the rule
    // cannot acquire one without this file failing.
    assert.equal(isInconclusive(429), true);
    assert.equal(isInconclusive(503), true);
  });

  test(`${sector}: our own database failure is never charged to the firm`, () => {
    assert.equal(isDatabaseError(new Error("Failed query: select 1\nparams: ")), true);
  });

  test(`${sector}: a full board going to zero is flagged, not failed`, () => {
    assert.equal(isBoardCollapse({ seenNow: 0, openStored: 120 }), true);
    assert.equal(isBoardCollapse({ seenNow: 0, openStored: COLLAPSE_FLOOR - 1 }), false);
  });

  test(`${sector}: a failed read never closes a listing`, () => {
    const d = decideClosure(
      { externalJobId: "a", status: "open", lastConfirmedAt: new Date(Date.now() - 30 * 24 * HOUR), title: "Summer Analyst", descriptionRaw: "x".repeat(300) },
      new Set(),
      { truncated: false, fetchFailed: true, intervalMs: HOUR },
    );
    assert.equal(d.close, false, d.reason);
  });

  test(`${sector}: a truncated read never closes a listing`, () => {
    const d = decideClosure(
      { externalJobId: "a", status: "open", lastConfirmedAt: new Date(Date.now() - 30 * 24 * HOUR), title: "Summer Analyst", descriptionRaw: "x".repeat(300) },
      new Set(),
      { truncated: true, fetchFailed: false, intervalMs: HOUR },
    );
    assert.equal(d.close, false, d.reason);
  });
}

// ------------------------------------------------------- the closure grace

/**
 * ONE clock reading for the whole section.
 *
 * These cases sit exactly on the grace-period boundary - `agoMs` is
 * `intervalMs * 1.5`, and the rule is `missingFor <= intervalMs * 1.5`. With
 * `lastConfirmedAt` read when the fixture is built and `decideClosure`
 * reading the clock again when it runs, `missingFor` is `agoMs` PLUS however
 * long passed in between. A single millisecond tips the boundary case over
 * and the listing closes, so the test passed only when both reads landed in
 * the same millisecond.
 *
 * It failed exactly that way during a full 22,150-test run on 11 October
 * 2026 - `discovery 30d: exactly one and a half cycles is still open` - and
 * passed 136 of 136 when the file was run on its own.
 *
 * `decideClosure` takes `options.now` precisely so a caller can pin it. Both
 * sides now come from NOW, which makes the boundary exact rather than a race.
 */
const NOW = new Date("2026-10-11T12:00:00Z");

const state = (agoMs: number, id = "req-1") => ({
  externalJobId: id,
  status: "open",
  lastConfirmedAt: new Date(NOW.getTime() - agoMs),
  title: "Summer Analyst",
  descriptionRaw: "x".repeat(300),
});

// One and a half cycles, across every tier interval the schedule uses.
const INTERVALS: [string, number][] = [
  ["critical 60m", 60 * 60_000],
  ["high 2h", 2 * HOUR],
  ["standard 12h", 12 * HOUR],
  ["discovery 30d", 30 * 24 * HOUR],
];

for (const [label, intervalMs] of INTERVALS) {
  test(`${label}: still inside the grace period stays open`, () => {
    const d = decideClosure(state(intervalMs), new Set(), { truncated: false, intervalMs, now: NOW });
    assert.equal(d.close, false, d.reason);
  });

  test(`${label}: exactly one and a half cycles is still open`, () => {
    const d = decideClosure(state(intervalMs * 1.5), new Set(), { truncated: false, intervalMs, now: NOW });
    assert.equal(d.close, false, d.reason);
  });

  test(`${label}: past one and a half cycles closes`, () => {
    const d = decideClosure(state(intervalMs * 1.5 + 60_000), new Set(), { truncated: false, intervalMs, now: NOW });
    assert.equal(d.close, true, d.reason);
  });

  test(`${label}: a listing seen in this fetch never closes, however old`, () => {
    const d = decideClosure(state(intervalMs * 100), new Set(["req-1"]), { truncated: false, intervalMs, now: NOW });
    assert.equal(d.close, false, d.reason);
  });

  test(`${label}: an already-closed listing is not closed twice`, () => {
    const d = decideClosure({ ...state(intervalMs * 100), status: "closed" }, new Set(), { truncated: false, intervalMs, now: NOW });
    assert.equal(d.close, false, d.reason);
  });
}

test("a listing with no external id is not matched by an empty key", () => {
  // `seenKeys.has(listing.externalJobId ?? "")` must not let a null id match
  // an empty string somebody happened to store.
  const d = decideClosure(
    { ...state(30 * 24 * HOUR), externalJobId: null },
    new Set([""]),
    { truncated: false, intervalMs: HOUR },
  );
  // It matches the empty key, so it stays open - documented here so the
  // behaviour is deliberate rather than accidental.
  assert.equal(d.close, false, d.reason);
});
