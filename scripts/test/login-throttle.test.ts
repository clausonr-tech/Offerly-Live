// When password guessing is stopped. No database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { EMAIL_MAX_FAILURES, IP_MAX_FAILURES, throttleMessage, throttleVerdict, WINDOW_MS, type Attempt } from "../../src/lib/login-throttle-rules";

const NOW = new Date("2026-09-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const fails = (n: number, spacing = MIN): Attempt[] => Array.from({ length: n }, (_, i) => ({ at: ago((n - i) * spacing), success: false }));

describe("one account, many guesses", () => {
  for (let n = 0; n <= EMAIL_MAX_FAILURES + 2; n++) {
    const blocked = n >= EMAIL_MAX_FAILURES;
    test(`${n} failures in the window -> ${blocked ? "stopped" : "allowed"}`, () => {
      assert.equal(throttleVerdict(fails(n), [], NOW).ok, !blocked);
    });
  }
  test("failures older than the window do not count", () => {
    assert.equal(throttleVerdict(fails(EMAIL_MAX_FAILURES, WINDOW_MS), [], NOW).ok, true);
  });
  test("a success clears the count before it", () => {
    const a = [...fails(4), { at: ago(30_000), success: true }, { at: ago(10_000), success: false }];
    assert.equal(throttleVerdict(a, [], NOW).ok, true);
  });
  test("the wait ends when the tipping failure leaves the window", () => {
    const v = throttleVerdict(fails(EMAIL_MAX_FAILURES, MIN), [], NOW);
    assert.ok(!v.ok);
    // Failures at 5,4,3,2,1 minutes ago; the oldest leaves the window in 10 minutes.
    assert.equal(v.retryAfterMinutes, 10);
  });
});

describe("one machine, many accounts", () => {
  test(`${IP_MAX_FAILURES - 1} failures from one IP: allowed; ${IP_MAX_FAILURES}: stopped`, () => {
    assert.equal(throttleVerdict([], fails(IP_MAX_FAILURES - 1, 10_000), NOW).ok, true);
    assert.equal(throttleVerdict([], fails(IP_MAX_FAILURES, 10_000), NOW).ok, false);
  });
  test("a success on one account does not clear the machine's count", () => {
    const a = [...fails(IP_MAX_FAILURES, 10_000), { at: ago(1000), success: true }];
    assert.equal(throttleVerdict([], a, NOW).ok, false);
  });
});

test("the message says how long, and points to the reset", () => {
  assert.match(throttleMessage(1), /1 minute,/);
  assert.match(throttleMessage(10), /10 minutes/);
  assert.match(throttleMessage(3), /reset your password/);
});
