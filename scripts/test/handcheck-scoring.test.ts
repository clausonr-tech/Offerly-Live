/**
 * The headline number must not contradict its own footnote.
 *
 * Two bugs, both found on Kai's real 40-row hand-check of 13 October 2026,
 * which came back 40 agree / 0 wrong.
 *
 * 1. The interval was Wald, which has zero width when nothing is wrong. The
 *    output read "FALSE DENIAL RATE: 0.0% (95% CI 0.0% - 0.0%)" - a claim that
 *    the agent is certainly perfect, printed two lines above a note saying the
 *    rate is only known to be below about 8%. Wilson is used instead because
 *    it does not collapse at the boundary, and a clean sweep of forty is
 *    evidence of a LOW rate, never of a zero one.
 *
 * 2. The sheet asks for "agree" / "WRONG" / "unsure" and a person filling in
 *    forty rows writes the REASON. Both of Kai's labels - "Full time" and
 *    "Page doesn't go to internship site" - were discarded as unparseable,
 *    which would have thrown away the whole check over vocabulary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readVerdict, wilsonInterval } from "../review-agent-sample";

test("a clean sweep does not claim certainty", () => {
  const { lo, hi } = wilsonInterval(0, 40);
  assert.equal(lo, 0, "the low end of a zero-wrong sample is zero");
  assert.ok(
    hi > 0.05 && hi < 0.15,
    `0 wrong in 40 must leave real room above - got an upper bound of ${(hi * 100).toFixed(1)}%, ` +
      `and anything near zero is the Wald collapse coming back`,
  );
  // Agrees with the rule of three (3/n) printed underneath it.
  assert.ok(Math.abs(hi - 3 / 40) < 0.02, `${hi} should sit near ${3 / 40}`);
});

test("the other boundary does not claim certainty either", () => {
  const { lo, hi } = wilsonInterval(40, 40);
  assert.equal(hi, 1);
  assert.ok(lo < 0.95 && lo > 0.85, `40 wrong in 40 should still have a lower bound below 1: ${lo}`);
});

test("a middle rate still brackets itself", () => {
  const { lo, hi } = wilsonInterval(10, 40);
  assert.ok(lo < 0.25 && hi > 0.25, `the interval must contain the observed 25%: ${lo}-${hi}`);
  assert.ok(hi - lo > 0.1, "and at n=40 it must be visibly wide");
});

test("a wider sample gives a tighter interval", () => {
  assert.ok(wilsonInterval(0, 400).hi < wilsonInterval(0, 40).hi);
});

test("the three exact words are read, whatever the capitals", () => {
  for (const [raw, want] of [
    ["agree", "agree"],
    ["Agree", "agree"],
    ["WRONG", "WRONG"],
    ["wrong", "WRONG"],
    ["unsure", "unsure"],
  ] as const) {
    assert.equal(readVerdict(raw)?.verdict, want, raw);
  }
});

test("the reasons a person actually writes are read as agreement", () => {
  // Both labels verbatim from the 13 October check, curly apostrophe included.
  for (const raw of [
    "Full time",
    "full time",
    "Full-time position",
    "Page doesn’t go to internship site",
    "Page doesn't go to internship site",
    "link does not go to a careers page",
  ]) {
    const read = readVerdict(raw);
    assert.equal(read?.verdict, "agree", `"${raw}" says the denial was right`);
    assert.ok(read?.readAs, `"${raw}" must report HOW it was read, so a wrong reading is visible`);
  }
});

test("a label it cannot read is refused rather than guessed", () => {
  for (const raw of ["maybe?", "see my notes", "???", "2027"]) {
    assert.equal(readVerdict(raw), null, `"${raw}" is not a verdict and must not be invented into one`);
  }
});
