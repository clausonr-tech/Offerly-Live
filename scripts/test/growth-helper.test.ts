// The timing helper's own test: does it tell linear from quadratic?
//
// scripts/test/helpers/growth.ts replaced two wall-clock ceilings that flaked
// under load. A perf assertion that cannot fail is worse than one that fails
// too often, so the instrument is checked here against functions whose shape is
// known by construction - no product code involved, nothing to drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { growth, minTime } from "./helpers/growth";

/** Linear: one pass over n. */
function linear(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += i % 7;
  return acc;
}

/** Quadratic: the shape both real tests exist to catch. */
function quadratic(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) acc += (i ^ j) & 1;
  return acc;
}

// Sized so BOTH land in a measurable range. The first version used 3,000 for
// linear too, which ran in 0.008 ms - under growth()'s floor, so it took the
// "too fast to measure" shortcut and the linear assertion passed without ever
// exercising the ratio. A vacuous check in the test that exists to prove the
// instrument is not vacuous.
const LINEAR_N = 400_000; // ~1 ms
const QUADRATIC_N = 3_000; // ~5 ms

test("growth() reads a linear function as linear", () => {
  const { ratio, smallMs, largeMs } = growth(() => void linear(LINEAR_N), () => void linear(LINEAR_N * 2));
  assert.ok(ratio < 3, `linear work measured a ratio of ${ratio.toFixed(2)} (${smallMs.toFixed(2)}ms -> ${largeMs.toFixed(2)}ms)`);
});

test("growth() reads a quadratic function as worse than linear", () => {
  const { ratio, smallMs, largeMs } = growth(() => void quadratic(QUADRATIC_N), () => void quadratic(QUADRATIC_N * 2));
  assert.ok(ratio > 3, `quadratic work measured a ratio of only ${ratio.toFixed(2)} (${smallMs.toFixed(2)}ms -> ${largeMs.toFixed(2)}ms) - the instrument cannot see a blow-up, so the tests that rely on it are blind`);
});

test("growth() separates the two by a wide margin, not a hair", () => {
  const lin = growth(() => void linear(LINEAR_N), () => void linear(LINEAR_N * 2)).ratio;
  const quad = growth(() => void quadratic(QUADRATIC_N), () => void quadratic(QUADRATIC_N * 2)).ratio;
  assert.ok(quad > lin * 1.5, `linear ${lin.toFixed(2)} vs quadratic ${quad.toFixed(2)} - too close to call a threshold between them`);
});

test("minTime() returns the fastest run, not the average", () => {
  let call = 0;
  const ms = minTime(() => {
    call += 1;
    // One deliberately slow run, as a contended sample would be.
    const spin = call === 2 ? 30 : 1;
    const until = process.hrtime.bigint() + BigInt(spin * 1_000_000);
    while (process.hrtime.bigint() < until) { /* burn */ }
  }, 4);
  assert.ok(ms < 20, `the 30ms outlier dragged the result to ${ms.toFixed(1)}ms - minTime is supposed to ignore it`);
  assert.equal(call, 4);
});
