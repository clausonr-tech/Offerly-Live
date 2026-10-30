import assert from "node:assert/strict";
import test from "node:test";

import { correctCity, editDistance } from "@/lib/city-spelling";

test("a misspelling snaps to the city it was reaching for", () => {
  assert.equal(correctCity("Chicgo"), "Chicago");
  assert.equal(correctCity("Bostn"), "Boston");
  assert.equal(correctCity("Philadelpia"), "Philadelphia");
  assert.equal(correctCity("Singapor"), "Singapore");
});

test("a correctly spelled city outside the chip list is left alone", () => {
  // The whole point of "Other" - snapping this to the nearest chip would be
  // worse than not correcting at all.
  assert.equal(correctCity("Salt Lake City"), "Salt Lake City");
  assert.equal(correctCity("Nashville"), "Nashville");
  assert.equal(correctCity("Frankfurt"), "Frankfurt");
});

test("something that is not a city is kept, not guessed at", () => {
  assert.equal(correctCity("qqqqqqqqqqqq"), "qqqqqqqqqqqq");
  assert.equal(correctCity("anywhere on the west coast"), "anywhere on the west coast");
});

test("a typed answer that means an offered chip is stored as that chip", () => {
  assert.equal(correctCity("new york"), "New York City");
  assert.equal(correctCity("NEW YORK"), "New York City");
  assert.equal(correctCity("chicago"), "Chicago");
});

test("a state or country tail does not defeat the match", () => {
  assert.equal(correctCity("Austin, TX"), "Austin");
  assert.equal(correctCity("Toronto, Canada"), "Toronto");
});

test("blank in, blank out", () => {
  assert.equal(correctCity(""), "");
  assert.equal(correctCity("   "), "");
});

test("edit distance is the standard one", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("same", "same"), 0);
  assert.equal(editDistance("", "abc"), 3);
});

import { providerCityName } from "@/lib/city-spelling";

test("our city chips are translated into a provider's vocabulary", () => {
  // Measured: "New York City" returned 0 people, "New York" returned 6.
  assert.equal(providerCityName("New York City"), "New York");
  assert.equal(providerCityName("Washington DC"), "Washington");
});

test("cities that really are called City keep their name", () => {
  // A "strip trailing City" rule would break all three of these to fix one.
  assert.equal(providerCityName("Kansas City"), "Kansas City");
  assert.equal(providerCityName("Salt Lake City"), "Salt Lake City");
  assert.equal(providerCityName("Jersey City"), "Jersey City");
});

test("an unknown city passes through untouched", () => {
  assert.equal(providerCityName("Chicago"), "Chicago");
});
