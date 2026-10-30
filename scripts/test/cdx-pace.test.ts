// How fast we are willing to ask the Internet Archive, and how we find out.
//
// This exists because of a measured failure. On 22 September a sweep managed
// 13 firms in 1h57m - about nine minutes each, against 2.7s to 39s when the
// Archive is healthy - and would have taken roughly four weeks to finish.
// Almost none of that was work: the CDX index was refusing us with 503s and
// timeouts, and the client asked again at the same fixed five-second gap every
// time, so it never discovered a rate it would be answered at.
//
// The gap is now found rather than assumed. These tests pin the two halves of
// that rule, because both failure directions are real: too fast and the sweep
// makes no progress AND deepens the block; too slow and it merely takes
// longer. Those costs are not symmetric, so the response is not symmetric.
//
// No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cdxPaceMs, __setCdxPaceForTests, __cdxRefusedForTests, __cdxAcceptedForTests } from "../../src/lib/monitoring/opening-history";

const FLOOR = 5000;
const CEILING = 60000;

function reset() {
  __setCdxPaceForTests(FLOOR);
}

test("starts at the floor", () => {
  reset();
  assert.equal(cdxPaceMs(), FLOOR);
});

test("a refusal makes us ask LESS often", () => {
  reset();
  const before = cdxPaceMs();
  __cdxRefusedForTests();
  assert.ok(cdxPaceMs() > before, `pace did not widen: ${before} -> ${cdxPaceMs()}`);
});

test("repeated refusals keep widening, up to the ceiling", () => {
  reset();
  for (let i = 0; i < 50; i++) __cdxRefusedForTests();
  assert.equal(cdxPaceMs(), CEILING, "should stop at the ceiling, not grow forever");
});

test("the gap never exceeds the ceiling", () => {
  // An unbounded backoff turns one bad afternoon into a sweep that has
  // effectively stopped without saying so.
  reset();
  for (let i = 0; i < 200; i++) __cdxRefusedForTests();
  assert.ok(cdxPaceMs() <= CEILING);
});

test("the server's own Retry-After wins when it is longer", () => {
  // It knows its limit and we are guessing at it.
  reset();
  __cdxRefusedForTests(30000);
  assert.ok(cdxPaceMs() >= 30000, `ignored Retry-After: ${cdxPaceMs()}`);
});

test("a Retry-After shorter than our own backoff does not speed us up", () => {
  reset();
  for (let i = 0; i < 10; i++) __cdxRefusedForTests();
  const wide = cdxPaceMs();
  __cdxRefusedForTests(1000);
  assert.ok(cdxPaceMs() >= Math.min(wide, CEILING) * 0.9, "a small Retry-After must not undo a long backoff");
});

test("ONE success during a throttle does not speed us back up", () => {
  // The measured throttle answered 2 of 5 probes. Treating the first answer
  // as "the limit lifted" is exactly how a client oscillates back into being
  // blocked.
  reset();
  for (let i = 0; i < 4; i++) __cdxRefusedForTests();
  const wide = cdxPaceMs();
  __cdxAcceptedForTests();
  assert.equal(cdxPaceMs(), wide, "sped up after a single success");
});

test("a RUN of successes narrows the gap again", () => {
  reset();
  for (let i = 0; i < 4; i++) __cdxRefusedForTests();
  const wide = cdxPaceMs();
  for (let i = 0; i < 5; i++) __cdxAcceptedForTests();
  assert.ok(cdxPaceMs() < wide, `never recovered: still ${cdxPaceMs()}`);
});

test("success never takes the gap below the floor", () => {
  // The floor is the politeness gap. Recovering past it would mean a healthy
  // Archive gets hammered harder than we ever intended.
  reset();
  for (let i = 0; i < 500; i++) __cdxAcceptedForTests();
  assert.equal(cdxPaceMs(), FLOOR);
});

test("recovery is slower than backoff", () => {
  // Being slightly too slow costs time; being too fast costs the whole run.
  reset();
  __cdxRefusedForTests();
  const afterOneRefusal = cdxPaceMs() - FLOOR;
  reset();
  __cdxRefusedForTests();
  __cdxRefusedForTests();
  const wide = cdxPaceMs();
  for (let i = 0; i < 5; i++) __cdxAcceptedForTests();
  const recovered = wide - cdxPaceMs();
  assert.ok(
    recovered <= afterOneRefusal * 2,
    `recovery (${recovered}ms per 5 successes) is too aggressive against backoff (${afterOneRefusal}ms per refusal)`,
  );
});
