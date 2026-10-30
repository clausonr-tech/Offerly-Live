/**
 * An unambiguous intern noun in the TITLE is student evidence.
 *
 * The adjudicator refuses a quote that does not prove the candidate is still
 * studying - a guard added after a measured error, where "2027 Investment
 * Banking Analyst - Boston Technology" was recovered on a quote that actually
 * described a graduate role. That guard is correct and stays.
 *
 * But it only ever reads the QUOTE. Measured 13 October 2026 on the one
 * listing independently confirmed to be a real internship - Egeria's
 * "Stagiair Private Equity June/July 2027", a Dutch private equity internship -
 * the model answered, its quote was verbatim in the page, and the quote was
 * refused with "shows a junior role but not a current student". The page's
 * student evidence is in its title. Dutch postings routinely put it there and
 * then describe the work.
 *
 * WHY THIS CANNOT REOPEN THE BUG THE GUARD EXISTS FOR. The failure it was
 * built on is "2027 Investment Banking Analyst - Boston Technology", whose
 * title contains no intern noun at all - so it fails this test too. Only the
 * UNAMBIGUOUS nouns count: `stage` on its own is excluded ("Stage Manager"),
 * `analyst program` is excluded (a UK graduate scheme), and `trainee` is
 * excluded ("International Graduate Trainee" is a graduate scheme, and one of
 * those is in this corpus).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { titleProvesStudent } from "@/lib/monitoring/llm-adjudicate";

test("the Dutch internship's title is evidence", () => {
  assert.equal(titleProvesStudent("Stagiair Private Equity June/July 2027"), true);
});

test("titles that unambiguously name an internship", () => {
  for (const t of [
    "2027 Investment Banking Summer Analyst Internship",
    "Praktikum Investment Banking",
    "Werkstudent Compliance (m/w/d)",
    "Stagiaire Fusions & Acquisitions",
    "Becario de Finanzas",
    "Stagista Private Equity Milano",
    "Tirocinio Curriculare Finanza",
    "Summer Intern, Markets",
  ]) {
    assert.equal(titleProvesStudent(t), true, `"${t}" should count as evidence`);
  }
});

test("the exact case the guard was built to stop still fails", () => {
  /**
   * The measured error: recovered on a quote reading "Piper Sandler is
   * currently seeking a Class of 2027 Investment Banking Analyst" - a
   * full-time graduate role. Its title must not become a shortcut.
   */
  assert.equal(
    titleProvesStudent("2027 Investment Banking Analyst - Boston Technology"),
    false,
    "the graduate role this guard exists for would now pass on its title",
  );
});

test("the ambiguous words are not evidence, however internship-ish they look", () => {
  for (const t of [
    "Stage Manager, Events",
    "Growth Stage Investing - Analyst",
    "2027 Investment Banking Analyst Programme - London",
    "Analyst Program",
    "International Graduate Trainee - focus on mathematics",
    "Graduate Analyst Programme",
    "Industrial Placement",
    "Apprenticeship Lead",
    "Head of Strategic Initiatives",
    "Registered Client Service Associate",
  ]) {
    assert.equal(titleProvesStudent(t), false, `"${t}" must not count as student evidence`);
  }
});

test("nothing is not evidence", () => {
  assert.equal(titleProvesStudent(""), false);
  assert.equal(titleProvesStudent(null), false);
  assert.equal(titleProvesStudent(undefined), false);
});
