// The pure half of board probing: which tokens get asked for, and how a
// response is read.
//
// The live half lives in scripts/ats-probe-live-check.ts and needs network.
// What is guarded here is everything that decides how many requests a sweep
// makes and what it concludes from them - because both of those are how a
// probe turns from useful into either expensive or wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateTokens,
  probePlan,
  isInconclusive,
  PROBE_PLATFORMS,
  BOGUS_TOKENS,
} from "../../src/lib/monitoring/ats-probe";

const byName = (name: string) => PROBE_PLATFORMS.find((p) => p.name === name)!;

// ------------------------------------------------------------------ tokens

test("the domain label is the first thing tried", () => {
  const tokens = candidateTokens("https://www.baincapital.com", "Bain Capital");
  assert.equal(tokens[0], "baincapital");
});

test("a hyphenated domain contributes both forms", () => {
  const tokens = candidateTokens("https://general-atlantic.com", "General Atlantic");
  assert.ok(tokens.includes("general-atlantic"));
  assert.ok(tokens.includes("generalatlantic"));
});

test("the firm name catches boards the domain cannot", () => {
  // warburgpincusllc is a real Greenhouse token in this directory and is not
  // derivable from warburgpincus.com - the legal suffix is in the board name.
  const tokens = candidateTokens("https://www.warburgpincus.com", "Warburg Pincus LLC");
  assert.ok(tokens.includes("warburgpincus"));
});

test("tokens are capped, because the cap is the request budget", () => {
  // Requests are firms x tokens x platforms. An unbounded token list is how a
  // 17,772-firm sweep becomes millions of requests.
  const tokens = candidateTokens("https://a-very-long-hyphenated-name.com", "A Very Long Hyphenated Name Partners LP");
  assert.ok(tokens.length <= 3);
});

test("a missing or malformed website still yields a name-derived token", () => {
  assert.deepEqual(candidateTokens(null, "Blackstone"), ["blackstone"]);
  assert.deepEqual(candidateTokens("not a url", "Blackstone"), ["blackstone"]);
});

test("tokens too short to identify anyone are dropped", () => {
  // A two-character token would collide across thousands of firms.
  assert.deepEqual(candidateTokens("https://ab.com", "AB"), []);
});

// ------------------------------------------------------------------- plan

test("only proven platforms are ever probed", () => {
  // SmartRecruiters answers 200 for a token that does not exist, so probing it
  // would invent a board for every firm in the directory. The plan must not
  // contain it no matter how it is asked for.
  const plan = probePlan("https://example.com", "Example Capital");
  assert.ok(plan.every((step) => step.platform.name !== "SmartRecruiters"));
  assert.equal(byName("SmartRecruiters").provenDiscriminating, false);
});

test("the best token is tried across all platforms before the next token", () => {
  // A firm is likelier to use its domain label on SOME platform than an odd
  // variant on its most likely one.
  const plan = probePlan("https://general-atlantic.com", "General Atlantic");
  const platformCount = plan.filter((s) => s.token === plan[0].token).length;
  assert.equal(plan.slice(0, platformCount).every((s) => s.token === plan[0].token), true);
});

// -------------------------------------------------------------- responses

test("a rate limit is not a 'no'", () => {
  // The bug this guards: 429 read as "this firm has no board" writes off a
  // firm with a stated reason nobody revisits.
  assert.equal(isInconclusive(429), true);
  assert.equal(isInconclusive(503), true);
  assert.equal(isInconclusive(0), true);
  assert.equal(isInconclusive(404), false);
  assert.equal(isInconclusive(200), false);

  const outcome = byName("Greenhouse").interpret(429, "");
  assert.equal(outcome.inconclusive, true);
  assert.equal(outcome.found, false);
});

test("a real but empty board is found, not missed", () => {
  // GTCR answered 200 with zero jobs on 19 Sep. That is a board between
  // postings, not an absent one, and the distinction decides whether the firm
  // is ever polled again.
  const outcome = byName("Greenhouse").interpret(200, JSON.stringify({ jobs: [] }));
  assert.equal(outcome.found, true);
  assert.equal(outcome.listings, 0);
});

test("a 200 that is not a board is refused", () => {
  // Vendors serve HTML error pages and marketing redirects with a 200.
  const outcome = byName("Greenhouse").interpret(200, "<!DOCTYPE html><html>nope</html>");
  assert.equal(outcome.found, false);
  assert.match(outcome.note ?? "", /without a jobs array/);
});

test("404 is a clean negative", () => {
  const outcome = byName("Ashby").interpret(404, "Not Found");
  assert.equal(outcome.found, false);
  assert.ok(!outcome.inconclusive);
});

test("listing counts come back for a populated board", () => {
  const body = JSON.stringify({ jobs: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.equal(byName("Ashby").interpret(200, body).listings, 3);
});

test("Personio's XML feed is read as a feed, not as JSON", () => {
  const xml = "<?xml version='1.0'?><workzag-jobs><position><id>1</id></position></workzag-jobs>";
  const outcome = byName("Personio").interpret(200, xml);
  assert.equal(outcome.found, true);
  assert.equal(outcome.listings, 1);
});

test("there are several control tokens, not one", () => {
  // The count is load-bearing. With a single control, Workable and Recruitee
  // both read as platforms that accept anything - they refused that one
  // string while returning boards for improbable sweep tokens. Six controls
  // settled it: all six refused, so they discriminate and those were real but
  // empty accounts. One control can only prove a platform refuses one string.
  assert.ok(BOGUS_TOKENS.length >= 6);
  assert.equal(new Set(BOGUS_TOKENS).size, BOGUS_TOKENS.length);
  for (const token of BOGUS_TOKENS) {
    // Long and unpronounceable, so no future edit quietly turns a control into
    // a real company's board token.
    assert.match(token, /^[a-z0-9]{12,}$/);
  }
});

test("a platform that throttles gets a slower cadence, not more pressure", () => {
  // Personio 429'd all six controls at the default gap, which made it
  // unknowable rather than bad.
  const personio = PROBE_PLATFORMS.find((p) => p.name === "Personio")!;
  assert.ok((personio.minGapMs ?? 0) >= 1000);
});
