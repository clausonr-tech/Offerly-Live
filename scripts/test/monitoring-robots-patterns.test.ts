// robots.ts pattern matching (src/lib/monitoring/robots.ts).
//
// Both halves of a robots match are chosen by someone else: the pattern comes
// from the crawled host's own robots.txt, and the path comes from a link on a
// scraped index page that the generic connector follows. The matcher used to
// compile the pattern into a regex with each `*` as `.*` and test it
// synchronously, so `Disallow: /*a*a*a*a*a*a*a*a*b` against a long run of
// `a`s with no `b` wedged the event loop - which in this crawl is the whole
// process, because the per-source budget is a timer that cannot fire while
// the loop is blocked, and the hourly lock then skips every later run.
//
// These tests pin the bound and the meaning: the matcher must stay fast on
// the pathological shape AND keep answering real robots.txt files exactly as
// it did. No network, no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, isPathAllowed, parseRobots } from "../../src/lib/monitoring/robots";
import { growth, minTime } from "./helpers/growth";

// GROWTH, not a ceiling. These assertions used `ms < 250` and flaked on a
// machine that was building and running evals at the same time. The regression
// they guard is exponential backtracking, so the honest claim is about SHAPE:
// doubling the input should roughly double the work. A ratio cancels machine
// speed because both halves pay it; see helpers/growth.ts for why no single
// ceiling can work here, and growth-helper.test.ts for the proof that this
// instrument tells linear from quadratic (measured: 1.98 against 3.98).
const LINEAR_RATIO = 3;

// A wedged event loop never comes back, so a ceiling twenty times the measured
// cost still catches the failure this file was written for and cannot trip on
// load. It is a hang detector, not a performance budget.
const HANG_MS = 5_000;

test("the pathological wildcard pattern stays linear instead of wedging the loop", () => {
  // Eight stars and no `b` to find: the regex version tried every way of
  // splitting the run of `a`s between the stars.
  const rules = parseRobots("User-agent: *\nDisallow: /*a*a*a*a*a*a*a*a*b");
  assert.equal(rules.length, 1, "the rule parsed, so the match below is the real path");

  // The answer is part of the claim: a path with no `b` must still be allowed.
  for (const length of [100, 400, 1600, 3200]) {
    assert.equal(isPathAllowed(rules, `/${"a".repeat(length)}`), true, "no `b`, so the Disallow does not apply");
  }

  // Doubling the run of `a`s is the axis the old exponent came from.
  const byLength = growth(
    () => void isPathAllowed(rules, `/${"a".repeat(2_000)}`),
    () => void isPathAllowed(rules, `/${"a".repeat(4_000)}`),
  );
  assert.ok(
    byLength.ratio < LINEAR_RATIO,
    `doubling the path grew the work ${byLength.ratio.toFixed(2)}x (${byLength.smallMs.toFixed(2)}ms -> ${byLength.largeMs.toFixed(2)}ms) - the regex version was exponential here`,
  );
  assert.ok(byLength.largeMs < HANG_MS, `a 4,000-character path took ${byLength.largeMs.toFixed(0)}ms, which is a wedge`);

  // Growing the star count is the other axis.
  const byStars = growth(
    () => void matches(`/${"a*".repeat(8)}b`, `/${"a".repeat(2000)}`),
    () => void matches(`/${"a*".repeat(16)}b`, `/${"a".repeat(2000)}`),
  );
  assert.ok(
    byStars.ratio < LINEAR_RATIO,
    `doubling the stars grew the work ${byStars.ratio.toFixed(2)}x (${byStars.smallMs.toFixed(2)}ms -> ${byStars.largeMs.toFixed(2)}ms) - eight more stars used to mean 2^8 more work`,
  );
  assert.ok(byStars.largeMs < HANG_MS, `sixteen stars took ${byStars.largeMs.toFixed(0)}ms, which is a wedge`);
});

test("a long attacker-chosen path does not have to be walked in full", () => {
  // Doubling a path the matcher should short-circuit must not double the work.
  const g = growth(
    () => void matches("/*careers*job*", `/${"x".repeat(1_000_000)}`),
    () => void matches("/*careers*job*", `/${"x".repeat(2_000_000)}`),
  );
  assert.ok(g.ratio < LINEAR_RATIO, `doubling a 1MB path grew the work ${g.ratio.toFixed(2)}x (${g.smallMs.toFixed(2)}ms -> ${g.largeMs.toFixed(2)}ms)`);
  assert.ok(g.largeMs < HANG_MS, `a 2MB path took ${g.largeMs.toFixed(0)}ms, which is a wedge`);
});

test("the wildcards still mean what real robots.txt files mean by them", () => {
  // Any run, anywhere.
  assert.equal(matches("/*/jobs", "/uk/jobs"), true);
  assert.equal(matches("/*/jobs", "/uk/jobs/123"), true, "unanchored, so a prefix match");
  assert.equal(matches("/*/jobs", "/jobsboard"), false);
  assert.equal(matches("/a*b", "/axxxb"), true);
  assert.equal(matches("/a*b", "/axxx"), false);

  // `$` anchors the end.
  assert.equal(matches("/*.pdf$", "/files/cv.pdf"), true);
  assert.equal(matches("/*.pdf$", "/files/cv.pdf?x=1"), false);
  assert.equal(matches("/careers$", "/careers"), true);
  assert.equal(matches("/careers$", "/careers/analyst"), false);

  // A trailing star is the whole rest of the path, and a bare one is everything.
  assert.equal(matches("/search*", "/search?q=intern"), true);
  assert.equal(matches("*", "/anything"), true);
  assert.equal(matches("/*", "/anything"), true);

  // No wildcard at all is still a plain prefix.
  assert.equal(matches("/api/", "/api/jobs"), true);
  assert.equal(matches("/api/", "/apiary"), false);
  assert.equal(matches("", "/anything"), false, "an empty pattern prohibits nothing");

  // Regex metacharacters are the characters they look like, not operators.
  assert.equal(matches("/a+b*", "/a+b/c"), true);
  assert.equal(matches("/a+b*", "/aab/c"), false);
  assert.equal(matches("/(x)*", "/(x)y"), true);
  assert.equal(matches("/a.b*", "/axb"), false, "a dot is a dot");
});

test("the rules a real site writes are still read the same way", () => {
  const rules = parseRobots(
    [
      "User-agent: *",
      "Disallow: /",
      "Allow: /careers",
      "Disallow: /careers/internal",
      "Allow: /*.html$",
    ].join("\n"),
  );
  assert.equal(isPathAllowed(rules, "/careers/analyst"), true, "longest match wins");
  assert.equal(isPathAllowed(rules, "/careers/internal/x"), false);
  assert.equal(isPathAllowed(rules, "/about"), false, "Disallow: / still means it");
  assert.equal(isPathAllowed(rules, "/about/page.html"), true, "the anchored Allow is longer");
  assert.equal(isPathAllowed([], "/anything"), true, "no rules is no restriction");
});

test("a pattern too long or too starred is unenforceable, and resolved conservatively", () => {
  // This test used to assert `false` - "this rule does not match" - which is
  // what the first version returned. That was new permissiveness, not parity:
  // a 600-character or 20-wildcard pattern compiled perfectly well under the
  // old regex, so a Disallow the crawler HAD honoured silently stopped being
  // honoured, in the project's only robots-compliance gate. The answer is now
  // a distinct "unenforceable", which isPathAllowed resolves by refusing a
  // Disallow and ignoring an Allow - conservative in both directions.
  assert.equal(matches(`/${"a*".repeat(400)}b`, "/aaab"), "unenforceable", "600 characters of pattern");
  assert.equal(matches(`/${"a*".repeat(20)}b`, `/${"a".repeat(40)}b`), "unenforceable", "20 stars");
  // Just inside both limits, it still matches.
  assert.equal(matches(`/${"a*".repeat(8)}b`, `/${"a".repeat(20)}b`), true);
});

test("an unenforceable Disallow still keeps the crawler out", () => {
  // The point of the change: the conservative resolution, end to end.
  const longPattern = `/${"a*".repeat(400)}b`;
  assert.equal(isPathAllowed([{ allow: false, path: longPattern }], "/aaab"), false);
  // An unenforceable ALLOW is the mirror image: it grants nothing, so a
  // narrower Disallow still applies.
  assert.equal(
    isPathAllowed([{ allow: true, path: longPattern }, { allow: false, path: "/" }], "/aaab"),
    false,
  );
});

test("a robots.txt with a rule per URL is read up to a bound", () => {
  const huge = ["User-agent: *", ...Array.from({ length: 5000 }, (_, i) => `Disallow: /x${i}`)].join("\n");
  const rules = parseRobots(huge);
  assert.ok(rules.length <= 2000, `kept ${rules.length} rules`);
  assert.ok(rules.length > 0, "the host's policy is still honoured, just not without limit");
  // Every rule is matched against every URL, so the cap is what bounds the
  // per-URL cost. The matching itself still has to be quick.
  // Every rule is matched against every URL, so halving the rules should halve
  // the work. This is the assertion that actually flaked: 395.6ms against a
  // 250ms ceiling, on fixed code, because the machine was busy.
  const half = rules.slice(0, Math.floor(rules.length / 2));
  const g = growth(
    () => void isPathAllowed(half, `/${"y".repeat(4000)}`),
    () => void isPathAllowed(rules, `/${"y".repeat(4000)}`),
  );
  assert.ok(
    g.ratio < LINEAR_RATIO,
    `doubling the rule count grew the work ${g.ratio.toFixed(2)}x (${g.smallMs.toFixed(2)}ms -> ${g.largeMs.toFixed(2)}ms)`,
  );
  assert.ok(g.largeMs < HANG_MS, `matching ${rules.length} rules took ${g.largeMs.toFixed(0)}ms, which is a wedge`);
  assert.ok(minTime(() => void isPathAllowed(rules, "/x1")) >= 0, "the matcher returns");
});
