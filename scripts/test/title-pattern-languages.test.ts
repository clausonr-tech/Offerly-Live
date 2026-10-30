/**
 * The relevance rule decides what a student sees, in every language.
 *
 * `TITLE_INTERNSHIP_PATTERN` is the sole reason for 9,459 rejections - 46% of
 * all of them - so a language missing from it is a language whose internships
 * are invisible. The list already carries French, German, Italian `tirocinio`
 * and Spanish `becario`, added on 19 September 2026 after 42 real internships
 * were found rejected for lack of a word.
 *
 * This adds DUTCH, and only Dutch, because that is the only one the corpus
 * produced a posting for. The review agent found it on 12 October 2026:
 * Egeria's "Stagiair Private Equity June/July 2027", a real 2027 private
 * equity internship. The list had `stagiaire` - the FRENCH spelling - and
 * Dutch drops the final e, so the word boundary never bridged it.
 *
 * It also fixes a false positive the test found rather than a posting:
 * "Stage Manager, Events" matched the anchored `stage` rule.
 *
 * THE ASYMMETRY THAT GOVERNS WHAT MAY BE ADDED HERE. `looksPromising` in
 * llm-adjudicate is a pre-filter: a false positive there costs one model call.
 * This rule publishes: a false positive here puts a full-time job in front of
 * a student as an internship, which is the failure the whole list exists to
 * prevent. So an ambiguous word may go in the pre-filter and must not come
 * here - which is why Spanish `prácticas` is deliberately absent, since
 * "buenas prácticas" is ordinary business Spanish for "best practices".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TITLE_INTERNSHIP_PATTERN } from "@/lib/monitoring/classify";

test("the Dutch internship the agent found is recognised", () => {
  assert.ok(
    TITLE_INTERNSHIP_PATTERN.test("Stagiair Private Equity June/July 2027"),
    "Egeria's Dutch PE internship was rejected by the relevance rule",
  );
});

test("Portuguese, because the corpus produced a posting for it", () => {
  /**
   * The rule this file states - "vocabulary added without a posting to check
   * it against is a guess" - cuts both ways, and this is the other way.
   *
   * MUFG Securities' São Paulo "Estagiário" is a real Workday internship that
   * was rejected for naming no internship phrase. It was found by measuring
   * the 9,840 listings in that stratum, which this rule is the sole reason for
   * and which had never been measured. So Portuguese went in, on the same
   * evidence standard that kept Italian and Polish out.
   *
   * `estágio` stayed OUT even so: it is the other Portuguese word and no
   * posting in the corpus carries it. One posting justifies one spelling.
   */
  assert.ok(
    TITLE_INTERNSHIP_PATTERN.test("Estagiário"),
    "MUFG's São Paulo internship is titled exactly this and nothing else",
  );
  assert.ok(TITLE_INTERNSHIP_PATTERN.test("Estagiario Investment Banking"), "boards strip accents");
  assert.ok(
    !TITLE_INTERNSHIP_PATTERN.test("Estágio em Banca de Investimento"),
    "estágio has no posting behind it, so it is still a guess",
  );
});

test("the languages NOT added, and why", () => {
  /**
   * The file's own rule, which this change follows rather than overrides:
   * "vocabulary added without a posting to check it against is a guess". The
   * review agent produced a Dutch posting, so Dutch went in. It produced no
   * Italian, Portuguese or Polish internship, so those did not - even though
   * `looksPromising` in llm-adjudicate now carries them.
   *
   * That asymmetry is the point, and this test records it so the next person
   * does not "fix" the inconsistency in the wrong direction: a false positive
   * in the pre-filter costs one model call; a false positive HERE publishes a
   * full-time job to a student as an internship.
   */
  for (const title of [
    "Stagista Private Equity Milano",
    "Estágio em Banca de Investimento",
    "Praktykant w Dziale Analiz",
  ]) {
    assert.ok(
      !TITLE_INTERNSHIP_PATTERN.test(title),
      `"${title}" was added to the publishing rule without a posting to check it against`,
    );
  }
});

test("the languages already covered still are", () => {
  for (const title of [
    "Stage H/F - Private Equity - Janvier 2027",
    "Stagiaire Fusions & Acquisitions",
    "Praktikum Investment Banking",
    "Werkstudent Compliance (m/w/d)",
    "Alternance - Analyste M&A",
    "Tirocinio Curriculare Finanza",
    "Becario de Finanzas",
    "2027 Investment Banking Summer Analyst",
  ]) {
    assert.ok(TITLE_INTERNSHIP_PATTERN.test(title), `"${title}" regressed`);
  }
});

test("the false positives a publishing rule cannot afford", () => {
  /**
   * Each of these is a full-time job that must not reach a student as an
   * internship. "Growth Stage" and "Stage Manager" are the reason bare
   * `stage` is excluded; `prácticas` is why Spanish best-practice language is
   * not on this list.
   */
  for (const title of [
    "Growth Stage Investing - Analyst",
    "Late Stage Venture Associate",
    "Stage Manager, Events",
    "Director of Best Practices",
    "Buenas Prácticas - Gerente de Cumplimiento",
    "Practice Manager, Restructuring",
    "Head of Strategic Initiatives",
    "Managing Consultant",
    "Registered Client Service Associate",
  ]) {
    assert.ok(
      !TITLE_INTERNSHIP_PATTERN.test(title),
      `"${title}" would be published to students as an internship`,
    );
  }
});
