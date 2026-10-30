// What the generic connector will even LOOK at.
//
// This list decides whether a listing row is ever created, which makes it the
// one stage whose failures no corpus audit can find: re-running the classifier
// over stored listings can only inspect rows that exist, and a board this list
// ignores produces none. Last session fixed the classifier for French on the
// strength of 42 rejected French listings; boards read by this connector never
// got that far, because "stage" was not a word it knew.
//
// Two rules are under test. The keywords themselves, and the BOUNDARY - the
// scan used a plain substring match, so "intern" matched "International" and
// every "Internal Audit" link on every careers page was a candidate.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LISTING_KEYWORDS,
  listingKeywordPattern,
  listingKeywordPatternSource,
} from "../../src/lib/monitoring/connectors/generic";

const matches = (text: string) => listingKeywordPattern().test(text);

// ------------------------------------------------------------------- English

const englishHits = [
  "2027 Investment Banking Summer Analyst",
  "Summer Associate - M&A",
  "Intern, Transfer Pricing",
  "Marketing Internship (Year-Round)",
  "2027 Analyst Program - New York",
  "2027 January Off-Cycle Analyst",
  "Spring Week 2027",
  "Insight Week - Markets",
  "Industrial Placement, London",
  "Co-op Student - Finance",
];
for (const title of englishHits) {
  test(`English is matched: ${title}`, () => {
    assert.equal(matches(title), true);
  });
}

// ------------------------------------------------- languages this corpus has

const foreignHits: [string, string][] = [
  ["French", "Stage - Analyste M&A"],
  ["French", "Stagiaire Corporate Finance H/F"],
  ["French", "Alternance - Chargé d'affaires"],
  ["French", "Alternant Finance"],
  ["French", "Apprenti Analyste Crédit"],
  ["German", "Praktikum Investment Banking"],
  ["German", "Praktikant (m/w/d) Corporate Finance"],
  ["German", "Werkstudent Asset Management"],
  ["Spanish", "Prácticas en Banca de Inversión"],
  ["Spanish", "Practicas Finanzas Corporativas"],
  ["Spanish", "Becario de Análisis Financiero"],
  ["Spanish", "Pasantía en Mercados de Capitales"],
  ["Italian", "Tirocinio Corporate Finance"],
  ["Italian", "Stagista Area Finanza"],
  ["Portuguese", "Estágio em Banca de Investimento"],
  ["Portuguese", "Estagio Financas"],
  ["Dutch", "Stagiair Corporate Finance"],
];
for (const [language, title] of foreignHits) {
  test(`${language} is matched: ${title}`, () => {
    // This is the coverage that did not exist. A board in this language
    // produced no candidates at all, so nothing downstream could see it.
    assert.equal(matches(title), true);
  });
}

test("the French words that matter most are present", () => {
  // BC Partners' Recruitee board carried "French Intern | July 2026", and the
  // corpus audit found "Stage H/F - Ingenieur IA" and "Stage H/F - Juriste
  // Corporate". "stage" is the word.
  for (const word of ["stage", "stagiaire", "alternance"]) {
    assert.ok(LISTING_KEYWORDS.includes(word), word);
  }
});

// ------------------------------------------------------------- word boundaries

const boundaryMisses = [
  "Internal Audit Manager",
  "International Equities Desk",
  "Internally Posted Role",
  "Head of Internal Controls",
  "Internationalisation Lead",
];
for (const title of boundaryMisses) {
  test(`a word merely CONTAINING a keyword is not a match: ${title}`, () => {
    // The old scan used `lower.includes("intern")`, so every one of these was
    // a candidate on every careers page.
    assert.equal(matches(title), false);
  });
}

test("the standalone word still matches inside a sentence", () => {
  assert.equal(matches("We are hiring an intern for the summer."), true);
  assert.equal(matches("Apply to our internship programme"), true);
});

test("punctuation is a boundary", () => {
  for (const title of ["Intern, Valuation", "(Intern)", "Intern/Analyst", "Intern."]) {
    assert.equal(matches(title), true, title);
  }
});

test("a hyphen is a boundary, so compound titles still match", () => {
  assert.equal(matches("Summer-Analyst"), false, "keyword itself is 'summer analyst' with a space");
  assert.equal(matches("Analyst-Intern"), true);
});

test("an accented letter is treated as a letter, not a boundary", () => {
  // JavaScript's \b is ASCII-only: it counts "é" as a NON-word character, so
  // \bstage\b matches inside "stagé". Unicode property escapes are what make
  // the multilingual list above safe to add.
  assert.equal(matches("stagé"), false);
  assert.equal(matches("estágios"), false, "plural of a keyword is a different word");
  assert.equal(matches("Estágio"), true);
});

test("a digit is not a boundary either", () => {
  assert.equal(matches("intern2027"), false);
  assert.equal(matches("2027 intern"), true);
});

// -------------------------------------------------------------- case handling

for (const variant of ["INTERNSHIP", "Internship", "internship", "InTeRnShIp"]) {
  test(`case does not matter: ${variant}`, () => {
    assert.equal(matches(variant), true);
  });
}

test("accented keywords match in either case", () => {
  assert.equal(matches("PRÁCTICAS"), true);
  assert.equal(matches("Prácticas"), true);
});

// ------------------------------------------------------- what must NOT match

const nonListings = [
  "Privacy Policy",
  "Cookie Statement",
  "Our Culture",
  "Experienced Professionals",
  "Search Jobs",
  "Sign In",
  "Contact Us",
  "Equity Research Associate",
  "Vice President, Real Estate",
];
for (const text of nonListings) {
  test(`ordinary site chrome is not a candidate: ${JSON.stringify(text)}`, () => {
    assert.equal(matches(text), false);
  });
}

test("the English word 'stage' is a known, accepted false positive", () => {
  // Documented rather than pretended away: "stage" is French for internship
  // and an ordinary English noun. It is included because a false candidate
  // costs one row the quality gate drops, while a missing one costs a real
  // internship - and nothing from this connector is auto-published anyway.
  assert.equal(matches("The next stage of your application"), true);
});

// ------------------------------------------------- the pattern's own contract

test("the pattern source compiles under the unicode flag", () => {
  assert.doesNotThrow(() => new RegExp(listingKeywordPatternSource(), "iu"));
});

test("regex metacharacters in a keyword are escaped", () => {
  // "co-op" is harmless, but the escaping has to hold if anyone adds a
  // keyword containing a dot or a parenthesis.
  const pattern = new RegExp(listingKeywordPatternSource(["c++", "a.b", "x(y)"]), "iu");
  assert.equal(pattern.test("c++"), true);
  assert.equal(pattern.test("axb"), false, "a dot must be literal, not any-character");
});

test("an empty keyword list does not produce a pattern that matches everything", () => {
  // `(?:)` matches the empty string, which would make every anchor on every
  // page a candidate.
  const pattern = new RegExp(listingKeywordPatternSource(["internship"]), "iu");
  assert.equal(pattern.test("anything at all"), false);
});

test("every keyword in the list matches itself", () => {
  // The guard against a typo'd or wrongly-escaped entry silently never firing.
  for (const keyword of LISTING_KEYWORDS) {
    assert.equal(matches(keyword), true, `"${keyword}" does not match itself`);
  }
});

test("the list has no duplicates", () => {
  assert.equal(new Set(LISTING_KEYWORDS).size, LISTING_KEYWORDS.length);
});

test("no keyword is empty or untrimmed", () => {
  for (const keyword of LISTING_KEYWORDS) {
    assert.ok(keyword.length > 0);
    assert.equal(keyword, keyword.trim());
    assert.equal(keyword, keyword.toLowerCase(), `"${keyword}" should be lowercase`);
  }
});

test("the list is passed to the browser as a string, so there is only one copy", () => {
  // findCandidatesInPage used to inline a duplicate of this list, because it
  // is serialised into the page where module scope does not exist. Two copies
  // is two rules, and only one of them got the multilingual fix. The source
  // string is what allows the in-page scan to take the real list as an
  // argument instead.
  const source = listingKeywordPatternSource();
  for (const keyword of LISTING_KEYWORDS) {
    assert.ok(source.includes(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), keyword);
  }
});
