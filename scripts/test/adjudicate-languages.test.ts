/**
 * An internship in another language is still an internship.
 *
 * `looksPromising` is the free pre-filter in front of the model: a listing it
 * rejects is DENIED without a model call ever being made. So any language it
 * does not know is a language whose internships cannot be recovered.
 *
 * Found by running the review agent over 200 title-phrase rejections on
 * 12 October 2026. One denial stood out:
 *
 *   deny  Egeria: Stagiair Private Equity June/July 2027
 *         "the page shows no student or internship language"
 *
 * "Stagiair" is Dutch for intern, and that is a private equity internship for
 * 2027. The list carried French `stagiaire`, German `praktikum` and
 * `werkstudent`, Spanish `becario` - and missed the Dutch form, which is the
 * same word without its final e. It is the French-`Stage` bug that
 * adjudicate-rejections.ts was built for, in a different language.
 *
 * THE TRAP, and why `stage` alone is not the fix: "Taking center stage at
 * Vanguard's tech conference" was in the same run. The existing rule is
 * deliberately `stage` followed by a French preposition, and it stays that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { looksPromising } from "@/lib/monitoring/llm-adjudicate";

/** `looksPromising` needs 120+ characters of body before it looks at all. */
const pad =
  "Wij zoeken een enthousiaste kandidaat voor ons team in Amsterdam. " +
  "De functie biedt veel ruimte voor eigen initiatief en ontwikkeling binnen de organisatie.";

test("the Dutch internship that was denied is now worth a model call", () => {
  assert.equal(
    looksPromising("Stagiair Private Equity June/July 2027", pad),
    true,
    "Stagiair is Dutch for intern - this was denied without a model call",
  );
});

test("the other languages this crawler actually meets", () => {
  for (const [title, language] of [
    ["Stagiair Corporate Finance", "Dutch"],
    ["Stageplaats Investment Management", "Dutch"],
    ["Stagista Private Equity Milano", "Italian"],
    ["Tirocinio Curriculare Finanza", "Italian"],
    ["Estágio em Banca de Investimento", "Portuguese"],
    ["Estagiário de Research", "Portuguese"],
    ["Prácticas en Banca de Inversión", "Spanish"],
    ["Pasantía Finanzas Corporativas", "Spanish"],
    ["Praktykant Dział Analiz", "Polish"],
    ["Alternance - Analyste M&A", "French work-study"],
  ] as const) {
    assert.equal(looksPromising(title, pad), true, `${language}: "${title}" was filtered out`);
  }
});

test("the words already covered still work", () => {
  for (const title of [
    "Summer Analyst Programme 2027",
    "Investment Banking Internship",
    "Werkstudent Compliance (m/w/d)",
    "Praktikant Digital Business",
    "Becario de Finanzas",
    "Stagiaire Fusions & Acquisitions",
    "Stage de fin d'études - Private Equity",
  ]) {
    assert.equal(looksPromising(title, pad), true, `"${title}" regressed`);
  }
});

test("English 'stage' is still not an internship", () => {
  /**
   * The exact title from the same run. Adding a bare `stage` rule would make
   * every conference write-up, product launch and funding round look like a
   * student programme.
   */
  const english =
    "Taking center stage at Vanguard's tech conference, our engineers presented " +
    "the platform work of the last year to an audience of several hundred people.";
  assert.equal(
    looksPromising("Taking center stage at Vanguard's tech conference", english),
    false,
    "an English 'stage' was read as an internship",
  );
  // And the other English words that must not qualify on their own.
  assert.equal(
    looksPromising(
      "Managing Consultant",
      "We are hiring an experienced managing consultant to lead client engagements " +
        "across our restructuring practice, with at least eight years of experience.",
    ),
    false,
  );
});
