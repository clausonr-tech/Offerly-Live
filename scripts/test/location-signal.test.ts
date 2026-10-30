import assert from "node:assert/strict";
import test from "node:test";

import { scoreResponseLikelihood, type ScorablePerson, type ScorableStudent } from "@/lib/response-likelihood";

const student: ScorableStudent = {
  school: "University of Southern California",
  gradYear: 2029,
  targetLocations: ["New York City"],
};

const person = (over: Partial<ScorablePerson>): ScorablePerson => ({
  name: "Someone",
  firmName: "Deutsche Bank",
  title: "Investment Banking Analyst",
  gradYear: 2024,
  ...over,
});

const kinds = (p: ScorablePerson) => scoreResponseLikelihood(student, p).signals.map((s) => s.kind);
const score = (p: ScorablePerson) => scoreResponseLikelihood(student, p).score;

test("a target city matches the spelling a profile actually uses", () => {
  // The chip says "New York City"; a profile says "New York, New York". This
  // signal never fired once for that pair - the label was matched verbatim.
  assert.ok(kinds(person({ freeText: "New York, New York" })).includes("location"));
});

test("a different city does not earn the signal", () => {
  assert.ok(!kinds(person({ freeText: "Chicago, Illinois" })).includes("location"));
});

test("a university named after a city is not a place someone lives", () => {
  // "new york" is a substring of "New York University", so matching the city
  // against the school credited an NYU graduate in Chicago with being in New
  // York - and they scored the same as someone who actually was.
  const nyuInChicago = person({ school: "New York University", freeText: "Chicago, Illinois" });
  assert.ok(!kinds(nyuInChicago).includes("location"));
  assert.ok(score(nyuInChicago) < score(person({ school: "New York University", freeText: "New York, New York" })));
});

test("being out of the target city lowers the score without excluding them", () => {
  // The rule this encodes: a contact outside the city the student wants is
  // still worth having, just worth less. Both keep the alumni signal.
  const inCity = person({ school: "University of Southern California", freeText: "New York, New York" });
  const outOfCity = person({ school: "University of Southern California", freeText: "Chicago, Illinois" });
  assert.ok(score(outOfCity) > 0, "an out-of-city alum still scores");
  assert.ok(score(inCity) > score(outOfCity), "but scores below one in the city");
  assert.ok(kinds(outOfCity).includes("school"));
});
