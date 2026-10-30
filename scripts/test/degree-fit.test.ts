// The three degree tracks do not overlap, and the banks say so themselves.
// Every case below is taken from a real posting or a published eligibility rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { degreeMismatch } from "../../src/lib/degree-fit";

const MBA_BODY = "Candidates must be currently enrolled in an MBA program.";
const UG_BODY = "Applicants must be in the penultimate year of their undergraduate degree.";

test("an undergraduate does not see MBA associate programmes", () => {
  assert.ok(degreeMismatch("bachelors", "Global Investment Banking Summer Associate Program - 2027", MBA_BODY));
  assert.ok(degreeMismatch("bachelors", "2027 Quantitative Research Intern", "Requires a PhD in statistics."));
});

test("an undergraduate still sees analyst seats whose body mentions MBA", () => {
  // Banks describe both programmes in one body; excluding on that wording
  // would drop real undergraduate openings.
  assert.equal(degreeMismatch("bachelors", "2027 Japan Summer Analyst Program (Tokyo)", MBA_BODY), null);
});

test("an MBA student does not see undergraduate-only analyst seats", () => {
  // Lazard, BlackRock and Jefferies all require undergraduate enrolment.
  assert.ok(degreeMismatch("masters", "2027 Investment Banking Summer Analyst", UG_BODY));
});

test("an MBA student does see the associate seat", () => {
  assert.equal(
    degreeMismatch("masters", "Global Investment Banking Summer Associate Program - 2027", MBA_BODY),
    null,
  );
});

test("a PhD student sees neither the undergraduate nor the MBA seat", () => {
  assert.ok(degreeMismatch("phd", "2027 Investment Banking Summer Analyst", UG_BODY));
  assert.ok(degreeMismatch("phd", "2027 Summer Associate Program", MBA_BODY));
});

test("a PhD student sees PhD requisitions", () => {
  assert.equal(
    degreeMismatch("phd", "Quantitative Research Intern (PhD) - Summer 2027", "PhD candidates in a quantitative field."),
    null,
  );
});

test("a posting open to both levels is shown to everyone", () => {
  // Stephens runs its Summer Analyst programme for "undergraduate and
  // graduate students".
  const body = "A 10 week internship offered to undergraduate and graduate students.";
  for (const lvl of ["bachelors", "masters", "phd"] as const) {
    assert.equal(degreeMismatch(lvl, "Investment Banking Summer Analyst Program", body), null, lvl);
  }
});

test("silence is never treated as exclusion", () => {
  // Most postings state nothing. They stay in for everyone: a wrong exclusion
  // costs a real opening, a wrong inclusion costs a click.
  for (const lvl of ["bachelors", "masters", "phd"] as const) {
    assert.equal(degreeMismatch(lvl, "2027 Investment Banking Summer Analyst", "Join our New York team."), null, lvl);
  }
});

test("an account with no stated degree is not filtered at all", () => {
  // Every account predating this question. Guessing costs openings.
  assert.equal(degreeMismatch(null, "2027 Summer Associate Program", MBA_BODY), null);
  assert.equal(degreeMismatch(undefined, "2027 Summer Associate Program", MBA_BODY), null);
});

import { normalizeDegreeLevel } from "../../src/lib/degree-fit";

test("the wizard's own labels normalise to the three levels", () => {
  // These are the exact option strings the onboarding question offers, and
  // what therefore lands in users.degree_level.
  assert.equal(normalizeDegreeLevel("Bachelor's"), "bachelors");
  assert.equal(normalizeDegreeLevel("Master's or MBA"), "masters");
  assert.equal(normalizeDegreeLevel("PhD"), "phd");
});

test("slugs and casing round-trip too", () => {
  assert.equal(normalizeDegreeLevel("bachelors"), "bachelors");
  assert.equal(normalizeDegreeLevel("MBA"), "masters");
  assert.equal(normalizeDegreeLevel("Ph.D."), "phd");
});

test("an unset or unrecognised answer filters nothing", () => {
  // Null is the state of every account predating the question.
  for (const v of [null, undefined, "", "something else"]) {
    assert.equal(normalizeDegreeLevel(v), null, String(v));
  }
});
