/**
 * No two advisory-lock families share a key space.
 *
 * Seven places take a Postgres advisory lock to make a reservation exact, and
 * every one of them derived its key as `hashtext('<name>:<id>')`. `hashtext`
 * returns an int4, so all seven were sharing one 32-bit space - and `hashtext`
 * is Postgres's ordinary hash_any, stable and reproducible offline by anyone.
 *
 * One of those keys takes an attacker-chosen string from an endpoint that takes
 * no session: the firm code-send bucket is keyed on the address typed into the
 * sign-up form. So a caller could search offline for a string colliding with
 * `hashtext('ai-quota:<a victim's uuid>')` and then hold that lock, making the
 * victim's reservations WAIT - and five of these families do wait, each waiter
 * holding one of the eight web connections while it does. That is the
 * connection-pool lever the rate limiter was converted away from, reachable in
 * the other five through the key space rather than through the limiter.
 *
 * The two-argument lock form keys on a pair, so a distinct first argument per
 * family makes the spaces disjoint. This test is the gate: a new lock site that
 * forgets the family argument, or reuses a number, fails here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LOCK_FAMILY } from "@/lib/advisory-locks";

/** Every file that takes one of these locks, and the call as written. */
const SITES: [file: string, family: keyof typeof LOCK_FAMILY][] = [
  ["src/lib/rate-limit.ts", "rateLimit"],
  ["src/lib/ai-runner.ts", "aiQuota"],
  ["src/lib/plan-quotas.ts", "monthlyQuota"],
  ["src/lib/practice-session.ts", "practiceRound"],
  ["src/lib/help-gate.ts", "helpGateUser"],
  ["src/lib/help-gate.ts", "helpGateGlobal"],
  ["src/lib/video-interview/consent.ts", "videoSession"],
  ["src/lib/video-interview/stt-budget.ts", "sttBudget"],
];

test("every family has its own number, and no number is used twice", () => {
  const numbers = Object.values(LOCK_FAMILY);
  assert.equal(new Set(numbers).size, numbers.length, "two families share a number");
  for (const n of numbers) {
    assert.ok(Number.isInteger(n) && n > 0 && n < 2 ** 31, `${n} is not a usable int4 family`);
  }
});

test("each lock site names its family", () => {
  for (const [file, family] of SITES) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      new RegExp(`pg_(try_)?advisory_xact_lock\\(\\$\\{LOCK_FAMILY\\.${family}\\}`),
      `${file} does not take its lock in the ${family} family`,
    );
  }
});

test("no lock in the repository takes the single-argument form", () => {
  // The single-argument form is the shared space. Any new site must pass a
  // family, and this is what refuses the copy-paste that forgets.
  const files = new Set(SITES.map(([f]) => f));
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Comments quote the old shape on purpose; only the executable lines count.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    assert.doesNotMatch(
      code,
      /pg_(try_)?advisory_xact_lock\(hashtext/,
      `${file} still takes a lock in the shared single-argument space`,
    );
  }
});
