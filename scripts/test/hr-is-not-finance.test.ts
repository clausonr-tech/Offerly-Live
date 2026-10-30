/**
 * HR is not finance, and `HR` is how the title says it.
 *
 * `OFF_PROFESSION_RULES` has excluded "human resources" for a while - 70
 * listings - while the abbreviation went straight through. The result was real
 * internships, correctly identified as internships, reaching a finance product
 * as finance roles.
 *
 * Measured 13 October 2026: 12 relevant listings carry `HR` in the title and 7
 * were LIVE to students:
 *
 *   Archimed      HR Internship (Lyon, France)
 *   Pai Partners  Talent & Development HR Internship | 6 Months
 *   Group 11      Praktikant im Bereich HR Learning & Talent Development
 *   Group 11      Praktikant Recruiting & HR Marketing (m/w/d)
 *   Group 11      Werkstudent im Bereich HR People Strategy
 *
 * None of the 12 also names a finance function, which is what makes the
 * abbreviation safe to add: it costs no finance internship in this corpus.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

function verdict(title: string, body = "") {
  const listing: NormalizedListing = {
    externalJobId: "req-1",
    title,
    division: null,
    location: "Lyon",
    descriptionRaw:
      body ||
      "A six-month internship with our team in Lyon. You are a student in your " +
        "penultimate year and will support the team day to day. Private equity.",
    employmentType: "Full-time",
    applicationUrl: null,
    listingUrl: "https://example.test/x",
    publishedAt: null,
    deadlineAt: null,
  };
  return classifyListing(listing, "private_equity");
}

test("the HR internships that were live are rejected, and say why", () => {
  for (const title of [
    "HR Internship (Lyon, France)",
    "Talent & Development HR Internship | 6 Months",
    "Praktikant im Bereich HR Learning & Talent Development",
    "Praktikant Recruiting & HR Marketing (m/w/d)",
    "Werkstudent im Bereich HR People Strategy",
  ]) {
    const c = verdict(title);
    assert.equal(c.relevant, false, title);
    assert.match(c.matchedEvidence.join(" "), /human resources role, not finance/, title);
  }
});

test("the spelled-out form still works", () => {
  assert.equal(verdict("Human Resources Internship").relevant, false);
});

test("a bounded abbreviation cannot reach into a longer word", () => {
  /**
   * `\bHR\b` and not `HR`. These are the words that would break if the
   * boundary were dropped, and a finance internship is not allowed to lose on
   * a substring.
   */
  for (const title of [
    "Summer Analyst - Thrive Capital Coverage",
    "Investment Banking Intern - Chry Group",
    "HRT Research Intern",
  ]) {
    const c = verdict(title);
    assert.ok(
      !c.matchedEvidence.join(" ").includes("human resources"),
      `"${title}" was caught by the HR rule on a substring`,
    );
  }
});

test("a finance internship is untouched", () => {
  const c = verdict("2027 Private Equity Summer Analyst");
  assert.equal(c.relevant, true);
});
