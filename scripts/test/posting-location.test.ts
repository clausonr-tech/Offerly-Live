// Onboarding writes "New York City"; job boards write "New York, NY". Neither
// contains the other exactly, so matching is loose in both directions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesLocation, locationFromTitle } from "../../src/lib/posting-location";

test("the two sides meet despite different qualifiers", () => {
  assert.equal(matchesLocation("New York, NY", ["New York City"]), true);
  assert.equal(matchesLocation("New York", ["New York City"]), true);
  assert.equal(matchesLocation("New York City", ["New York"]), true);
});

test("a different city does not match", () => {
  assert.equal(matchesLocation("Chicago, IL", ["New York City"]), false);
});

test("an unknown location cannot satisfy a stated preference", () => {
  assert.equal(matchesLocation(null, ["New York"]), false);
  assert.equal(matchesLocation("", ["New York"]), false);
});

test("no stated preference returns false, not true", () => {
  // Documented behaviour, and the OPPOSITE of what this function's doc comment
  // says ("no stated preference means no constraint"). Callers treat a false
  // here as "no location signal to apply" rather than "excluded", so the
  // behaviour is correct and the comment is what is wrong. Pinned so a
  // well-meaning fix to match the prose cannot silently widen every list.
  assert.equal(matchesLocation("New York, NY", []), false);
  assert.equal(matchesLocation("New York, NY", null), false);
});

test("a city named in the title is returned in canonical casing", () => {
  assert.equal(locationFromTitle("2027 Summer Analyst - new york"), "New York");
  assert.equal(locationFromTitle("2027 Summer Analyst"), null);
});
