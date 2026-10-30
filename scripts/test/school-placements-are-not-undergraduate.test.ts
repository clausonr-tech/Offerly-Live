/**
 * Offerly is for undergraduates at BOTH ends of the range.
 *
 * `EXCLUSION_RULES` has excluded what sits above an undergraduate for a while -
 * an MBA, a PhD, a graduate degree - on the grounds that showing a student a
 * real opening they cannot apply to is worse than showing them nothing.
 * Nothing excluded what sits below.
 *
 * The gap was invisible because exactly one posting in the corpus is
 * school-level: Deutsche Bank's "Dein Schul-, FOS- und Berufsorientierungs-
 * Praktikum", a careers-orientation week for pupils (FOS is a German
 * vocational secondary school). It was held back - and only by luck. Its year
 * is not derivable, so it had no recruiting cycle and could not publish. But
 * `placement` is already in CYCLE_WORDS, so the same posting written in
 * English, "school placement 2027", would have had a cycle and gone out. The
 * only thing between a pupils' taster week and an undergraduate's internship
 * list was a German compound noun.
 *
 * The three keep-cases below are the ones that make this rule narrow rather
 * than merely strict, and each is a real word that a loose pattern eats:
 * "Hochschul-" is HIGHER education, "Schulung" is TRAINING, and "high school
 * diploma or equivalent" is a floor on a full-time role - 58 relevant
 * listings say it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";

function verdict(title: string) {
  return classifyListing(
    {
      title,
      descriptionRaw:
        "Du unterstuetzt das Team bei der taeglichen Arbeit und lernst das " +
        "Unternehmen kennen. Dauer ein bis zwei Wochen. Standort Frankfurt. " +
        "Wir freuen uns auf deine Bewerbung fuer einen Platz im Jahr 2027.",
      division: null,
      location: "Frankfurt",
      employmentType: null,
      applicationUrl: null,
      listingUrl: "https://example.test/x",
      publishedAt: null,
      deadlineAt: null,
    } as never,
    "investment_banking" as never,
  );
}

test("a school placement is rejected, and says why", () => {
  const c = verdict("Dein Schul-, FOS- und Berufsorientierungs-Praktikum");
  assert.equal(c.relevant, false, "a careers week for school pupils is not an undergraduate role");
  assert.match(
    c.matchedEvidence.join(" "),
    /school-level placement/,
    `the reason must name the level, not just refuse: ${c.matchedEvidence.join(" | ")}`,
  );
});

test("the other school-level shapes are rejected too", () => {
  for (const title of [
    "Schuelerpraktikum Corporate Finance",
    "Schülerpraktikum Investment Banking",
    "Schnupperpraktikum M&A",
    "Berufsorientierungspraktikum",
    "Praktikum fuer Schuelerinnen und Schueler",
    "Sixth Form Insight Day",
    "High School Summer Program",
  ]) {
    assert.equal(verdict(title).relevant, false, title);
  }
});

test("HIGHER education is not school - the words differ by three letters", () => {
  // "Hochschul-" and "Fachhochschule" are university. A rule that ate these
  // would reject real undergraduate internships for looking German.
  for (const title of [
    "Hochschulpraktikum Corporate Finance",
    "Fachhochschule Praktikum M&A",
  ]) {
    assert.notEqual(
      verdict(title).matchedEvidence.join(" ").includes("school-level placement"),
      true,
      `${title} is higher education and must not hit the school rule`,
    );
  }
});

test("Schulung is training, not school", () => {
  for (const title of ["Schulungsprogramm Analyst", "Schulung Corporate Finance"]) {
    assert.notEqual(
      verdict(title).matchedEvidence.join(" ").includes("school-level placement"),
      true,
      `${title} means training - this is why the prefix form requires its hyphen`,
    );
  }
});

test("a high-school diploma is a floor on a job, not a pupils' placement", () => {
  // 58 relevant listings carry this phrasing. None in a title today, which is
  // why the rule is title-scoped - but it must be right if one ever does.
  for (const title of [
    "Analyst - High School Diploma required",
    "Associate, high school or equivalent",
    "Processor (High School Graduate)",
  ]) {
    assert.notEqual(
      verdict(title).matchedEvidence.join(" ").includes("school-level placement"),
      true,
      `${title} states a qualification, and excluding it would delete real postings`,
    );
  }
});

test("ordinary undergraduate internships are untouched", () => {
  for (const title of [
    "Stagiair Private Equity June/July 2027",
    "Praktikum Investment Banking 2027",
    "Werkstudent Corporate Finance 2027",
    "2027 Investment Banking Summer Analyst",
  ]) {
    assert.notEqual(
      verdict(title).matchedEvidence.join(" ").includes("school-level placement"),
      true,
      title,
    );
  }
});
