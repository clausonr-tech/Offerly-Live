import assert from "node:assert/strict";
import test from "node:test";

import {
  PATTERN_MIN_SAMPLES,
  domainBelongsToFirm,
  isPatternConfirmed,
  recordObservation,
  winnerOf,
} from "@/lib/email-patterns";

test("an address at another company never becomes a firm's pattern", () => {
  // The real one. The first Barclays contact the provider could resolve had a
  // business email at narrativ.com - a different company - and that single
  // record became Barclays' pattern. Four other Barclays contacts were then
  // handed manufactured @narrativ.com addresses marked "inferred".
  const barclays = ["barclays.com", "home.barclays", "uk.barclays", "barclays.co.uk"];
  assert.equal(domainBelongsToFirm("narrativ.com", "Barclays (US)", barclays), false);
  assert.equal(domainBelongsToFirm("barclays.com", "Barclays (US)", barclays), true);
  assert.equal(domainBelongsToFirm("home.barclays", "Barclays (US)", barclays), true);
});

test("a mail domain that is not the website domain is still the firm's", () => {
  // Rejecting anything outside the known-domain list would throw this away:
  // JPMorgan's site is jpmorgan.com and its mail is jpmorganchase.com.
  assert.equal(domainBelongsToFirm("jpmorganchase.com", "JPMorgan", ["jpmorgan.com"]), true);
  assert.equal(domainBelongsToFirm("gs.com", "Goldman Sachs", ["goldmansachs.com", "gs.com"]), true);
});

test("words every firm shares cannot vouch for a domain", () => {
  // Otherwise "capitalone.com" would pass as evidence for any firm with
  // "Capital" in its name, and "bankofamerica.com" for any bank.
  assert.equal(domainBelongsToFirm("capitalone.com", "Evercore Capital Partners", []), false);
  assert.equal(domainBelongsToFirm("somebank.com", "Deutsche Bank (US)", ["db.com"]), false);
  assert.equal(domainBelongsToFirm("db.com", "Deutsche Bank (US)", ["db.com"]), true);
});

test("one sample is not enough to invent an address", () => {
  const one = recordObservation({}, "first.last", "barclays.com");
  assert.equal(winnerOf(one)?.samples, 1);
  assert.ok(1 < PATTERN_MIN_SAMPLES, "a single observation is below the floor");

  const two = recordObservation(one, "first.last", "barclays.com");
  assert.equal(winnerOf(two)?.samples, 2);
  assert.ok(2 >= PATTERN_MIN_SAMPLES, "two agreeing observations clear it");
});

test("usable and settled are different thresholds", () => {
  // Two agreeing samples make a pattern safe to apply; it still keeps being
  // sampled until PATTERN_CONFIRMED_SAMPLES agree, which is when it stops
  // costing anything.
  let tally = {};
  for (let i = 0; i < PATTERN_MIN_SAMPLES; i++) tally = recordObservation(tally, "first.last", "x.com");
  assert.equal(isPatternConfirmed(tally), false);
});

import { applyPattern, detectPattern } from "@/lib/email-patterns";

test("a truncated surname does not become an invented address", () => {
  // LinkedIn shows private profiles as "Alexander N.", and the provider passes
  // that through. A first.last pattern turned it into alexander.n@barclays.com
  // - an address for a surname we do not know, which will bounce.
  assert.equal(applyPattern("Alexander N.", "first.last", "barclays.com"), null);
  assert.equal(applyPattern("Manan T.", "flast", "barclays.com"), null);
  // A full name is unaffected.
  assert.equal(
    applyPattern("Kelsey Fleming", "first.last", "barclays.com"),
    "kelsey.fleming@barclays.com",
  );
});

test("a shape that only needs an initial still works from one", () => {
  // "firstl" uses the surname's first letter and nothing else, so a truncated
  // surname carries all the information that shape requires.
  assert.equal(applyPattern("Alexander N.", "firstl", "barclays.com"), "alexandern@barclays.com");
});

test("accents are stripped rather than rejected", () => {
  assert.equal(
    applyPattern("Jean-Benoît Robillard", "first.last", "barclays.com"),
    detectPattern("Jean-Benoît Robillard", "jeanbenoit.robillard@barclays.com")
      ? "jeanbenoit.robillard@barclays.com"
      : null,
  );
});
