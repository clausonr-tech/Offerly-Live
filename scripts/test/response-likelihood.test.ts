import assert from "node:assert/strict";
import test from "node:test";

import { scoreResponseLikelihood } from "@/lib/response-likelihood";

const student = {
  school: "University of Southern California",
  gradYear: 2028,
  targetLocations: ["New York City"],
  clubsAndActivities: "Trojan Investing Society",
  interests: "skiing, fishing",
};

const base = { firmName: "Goldman Sachs", school: "University of Southern California" };

test("breadth separates contacts that a weighted sum alone would tie", () => {
  // One heavy overlap against several lighter ones. Before breadth, the second
  // person could score no better despite having three things to open with.
  const onlySchool = scoreResponseLikelihood(student, { ...base, name: "One thing" });
  const several = scoreResponseLikelihood(student, {
    ...base,
    name: "Several things",
    gradYear: 2026,
    freeText: "Trojan Investing Society ⋄ New York",
  });

  assert.ok(several.score > onlySchool.score, `${several.score} !> ${onlySchool.score}`);
  assert.ok(
    several.signals.some((s) => s.kind === "breadth"),
    "a contact with several overlaps should be credited for having several",
  );
});

test("a single overlap earns no breadth bonus", () => {
  const { signals } = scoreResponseLikelihood(student, { ...base, name: "One thing" });
  assert.ok(!signals.some((s) => s.kind === "breadth"));
});

test("being reachable is not something you have in common", () => {
  // An enriched contact must not out-score an un-enriched one on breadth just
  // for having an address on file.
  const withEmail = scoreResponseLikelihood(student, {
    ...base,
    name: "Reachable",
    email: "a@b.com",
    linkedinUrl: "https://linkedin.com/in/x",
  });
  assert.ok(!withEmail.signals.some((s) => s.kind === "breadth"));
});

test("the year they graduated actually moves the score", () => {
  const near = scoreResponseLikelihood(student, { ...base, name: "Near", gradYear: 2026 });
  const far = scoreResponseLikelihood(student, { ...base, name: "Far", gradYear: 2006 });
  assert.ok(near.score > far.score, "a recent alum must beat one twenty years out");
});
