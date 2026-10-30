/**
 * A year next to a non-English internship noun is still a cycle.
 *
 * `extractRecruitingCycle` only reads a year that sits near a word naming an
 * internship, which is what stops a random "2024" in a page footer becoming a
 * recruiting cycle. The list was English plus `stage` and `alternance`, and it
 * looked like it covered Dutch because `stage` is the Dutch word too. It does
 * not: "stagiair" contains no "stage", and both uses of the list anchor with
 * \b, so `stage` cannot match inside the longer word either.
 *
 * The cost of that gap, measured on Egeria's "Stagiair Private Equity
 * June/July 2027": a real internship, its year written in its own title, and
 * no cycle derived - so it could not be published. Counted across the live
 * listings on 13 October 2026, the same gap held the cycle off 10 relevant
 * listings for `stagiair` and 1 for `praktikum`.
 *
 * This test exists because the gap was invisible: nothing failed, the listings
 * were simply held back with "no recruiting cycle", which reads like the
 * posting's fault rather than ours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";

function cycleOf(title: string, body: string): number | null {
  return classifyListing(
    {
      title,
      descriptionRaw: body,
      division: null,
      location: null,
      employmentType: null,
      applicationUrl: null,
      listingUrl: "https://example.test/x",
      publishedAt: null,
      deadlineAt: null,
    } as never,
    "investment_banking" as never,
  ).recruitingCycle;
}

test("the Dutch noun carries its year", () => {
  assert.equal(
    cycleOf("Stagiair Private Equity June/July 2027", "Stagiair Private Equity June/July 2027"),
    2027,
    "this exact title is the posting the gap was found on",
  );
});

test("its inflections carry it too", () => {
  for (const title of [
    "Stagiaire Corporate Finance 2027",
    "Stagiairs Investment Banking 2027",
    "Stagiaires M&A 2027",
  ]) {
    assert.equal(cycleOf(title, title), 2027, title);
  }
});

test("the German noun is NOT in the list, and a school placement proves why", () => {
  /**
   * `praktikum` was added on the strength of a count - it rescued one listing -
   * and taken out again on the strength of reading it. That one listing was
   * Deutsche Bank's "Dein Schul-, FOS- und Berufsorientierungs-Praktikum": a
   * careers-orientation week for SCHOOL pupils, FOS being a German vocational
   * secondary school. The year is the last gate before publishing, so reading
   * it would have put a school taster on undergraduates' internship lists.
   *
   * The lesson is in the test rather than only in the comment: a candidate
   * word is judged by the listings it would rescue, never by how few.
   */
  // The year sits directly beside the word, with no sentence break between
  // them - the shape the proximity rule actually fires on. An earlier version
  // of this fixture put a full stop in between, so it passed whether or not
  // `praktikum` was in the list and guarded nothing at all.
  assert.equal(
    cycleOf(
      "Dein Schul-, FOS- und Berufsorientierungs-Praktikum 2027",
      "Dein Schul-, FOS- und Berufsorientierungs-Praktikum 2027 bei Deutsche Bank, " +
        "fuer Schuelerinnen und Schueler ab der 9. Klasse",
    ),
    null,
    "a school placement must not get a recruiting cycle - that is the last gate",
  );
});

test("a year with no internship word near it is still not a cycle", () => {
  // The guard the list exists for. Widening it must not reach this far.
  assert.equal(
    cycleOf("Managing Director, Credit", "Copyright 2024 Example Bank. All rights reserved."),
    null,
    "a year in a footer names no recruiting cycle",
  );
});
