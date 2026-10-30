// Reading requirements and eligibility out of a description.
//
// This is the last stage of page analysis and the one that decides whether a
// listing can be PUBLISHED rather than merely seen: eligibility is what picks
// who the posting is shown to, and the requirements section is what a student
// reads before spending an evening on an application.
//
// Both had the same rule imposed on them after the same kind of incident, and
// it is the rule these tests are mostly about: an answer that is not stated is
// left EMPTY rather than guessed. An empty eligibility list restricts nobody;
// an invented one quietly shows the wrong students a posting, or hides it from
// the right ones, and looks exactly like a fact the employer gave us.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRequirements, splitRequirements } from "../../src/lib/monitoring/requirements";
import { readEligibility, inferFromFirmPattern } from "../../src/lib/monitoring/eligibility";

const PREAMBLE =
  "Our investment banking division advises clients on mergers, acquisitions and capital raising across every major sector. ";

// ------------------------------------------------------------- requirements

const headings = [
  "Qualifications",
  "Requirements",
  "What you'll need",
  "Who we're looking for",
  "Skills and Competencies",
  "Basic Qualifications",
];
for (const heading of headings) {
  test(`a requirements section is found under "${heading}"`, () => {
    const description = `${PREAMBLE}${heading}: Pursuing a bachelor's degree with strong academic credentials and demonstrated interest in finance and capital markets.`;
    const section = extractRequirements(description);
    assert.ok(section, heading);
    assert.match(section, /bachelor/i);
  });
}

test("the heading itself is not part of the section", () => {
  const section = extractRequirements(
    `${PREAMBLE}Qualifications: Pursuing a bachelor's degree with strong academic credentials and an interest in finance.`,
  );
  assert.ok(section);
  assert.ok(!/^qualifications/i.test(section));
});

test("a colon or dash after the heading is trimmed", () => {
  for (const sep of [":", " -", " \u2013", ":  "]) {
    const section = extractRequirements(
      `${PREAMBLE}Qualifications${sep} Pursuing a bachelor's degree with strong academic credentials and an interest in finance.`,
    );
    assert.ok(section, sep);
    assert.match(section, /^Pursuing/);
  }
});

test("a description with no requirements section returns null", () => {
  // Null is a real answer. Showing a student the firm's mission statement
  // under a "Requirements" heading would be our error presented as theirs.
  assert.equal(
    extractRequirements(
      `${PREAMBLE}We are proud of our culture and our people and we invest heavily in their development.`,
    ),
    null,
  );
});

test("the word appearing in passing is not a heading", () => {
  // "...meets the requirements of the role..." is prose, not a section.
  assert.equal(
    extractRequirements(`${PREAMBLE}The candidate meets the requirements of the role.`),
    null,
  );
});

test("a section shorter than the floor is not a section", () => {
  assert.equal(extractRequirements(`${PREAMBLE}Qualifications: None.`), null);
});

test("the section stops at the next heading", () => {
  const description =
    `${PREAMBLE}Qualifications: Pursuing a bachelor's degree with strong academic credentials. ` +
    "Compensation: The base pay scale for this role is $100,000 to $120,000 annually.";
  const section = extractRequirements(description);
  assert.ok(section);
  assert.ok(!/base pay scale/i.test(section), section);
});

test("the section is capped", () => {
  const description = `${PREAMBLE}Qualifications: ${"requirement text ".repeat(600)}`;
  const section = extractRequirements(description);
  assert.ok(section);
  assert.ok(section.length <= 2500);
});

test("whitespace is normalised before matching", () => {
  const section = extractRequirements(
    `${PREAMBLE}Qualifications:\n\n\tPursuing a bachelor's degree with strong\n academic credentials and an interest in finance.`,
  );
  assert.ok(section);
  assert.ok(!section.includes("\n"));
});

test("the heading match is case-insensitive", () => {
  for (const heading of ["QUALIFICATIONS", "qualifications", "Qualifications"]) {
    assert.ok(
      extractRequirements(
        `${PREAMBLE}${heading}: Pursuing a bachelor's degree with strong academic credentials and an interest in finance.`,
      ),
      heading,
    );
  }
});

const emptyDescriptions = ["", " ", "\n\n", "\u0000"];
for (const description of emptyDescriptions) {
  test(`an empty description yields null: ${JSON.stringify(description)}`, () => {
    assert.equal(extractRequirements(description), null);
  });
}

test("extractRequirements never throws", () => {
  for (const description of ["<", "x".repeat(100000), "Qualifications:", "\u0000\u0000"]) {
    assert.doesNotThrow(() => extractRequirements(description));
  }
});

// ------------------------------------------------------------ splitting them

test("bullet characters split a list", () => {
  const lines = splitRequirements(
    "• Pursuing a bachelor's degree in finance • Strong analytical and quantitative skills • Excellent written communication",
  );
  assert.equal(lines.length, 3);
});

for (const bullet of ["•", "·", "●", "▪"]) {
  test(`the ${bullet} bullet splits a list`, () => {
    const lines = splitRequirements(
      `${bullet} Pursuing a bachelor's degree in finance ${bullet} Strong analytical and quantitative skills`,
    );
    assert.equal(lines.length, 2, bullet);
  });
}

test("a spaced dash splits a list", () => {
  const lines = splitRequirements(
    "Pursuing a bachelor's degree in finance - Strong analytical and quantitative skills - Excellent communication skills",
  );
  assert.ok(lines.length >= 2);
});

test("sentence breaks split a list when nothing else does", () => {
  const lines = splitRequirements(
    "Pursuing a bachelor's degree in finance. Strong analytical and quantitative skills required. Excellent written communication expected.",
  );
  assert.ok(lines.length >= 2);
});

test("a hyphenated word is not a bullet", () => {
  // The separator is a SPACED dash, so "penultimate-year" stays one word.
  const lines = splitRequirements(
    "Open to penultimate-year students with strong academic credentials and a demonstrated interest in finance",
  );
  assert.equal(lines.length, 1);
});

test("a single prose paragraph comes back as one line, not fragments", () => {
  // It is not split into invented bullets. A short paragraph IS one
  // requirement, and a long one is dropped rather than chopped arbitrarily.
  assert.deepEqual(splitRequirements("Strong academic credentials required"), [
    "Strong academic credentials required",
  ]);
  assert.deepEqual(splitRequirements("x".repeat(500)), []);
});

test("null yields an empty array, never a throw", () => {
  assert.deepEqual(splitRequirements(null), []);
});

test("fragments too short or too long are dropped", () => {
  const lines = splitRequirements(`• ok • ${"x".repeat(500)} • Pursuing a bachelor's degree in finance`);
  assert.equal(lines.length, 1);
});

test("the list is capped at twenty lines", () => {
  const section = Array.from({ length: 40 }, (_, i) => `• Requirement number ${i} with enough text`).join(" ");
  assert.ok(splitRequirements(section).length <= 20);
});

test("every returned line is trimmed of leading punctuation", () => {
  for (const line of splitRequirements(
    "• Pursuing a bachelor's degree in finance • Strong analytical and quantitative skills",
  )) {
    assert.ok(!/^[\s:\u2013\u2014-]/.test(line), JSON.stringify(line));
  }
});

// -------------------------------------------------------------- eligibility

test("a stated Class of year wins outright", () => {
  // The employer answering this exact question.
  const result = readEligibility("Open to students in the Class of 2028.", 2027);
  assert.deepEqual(result.gradYears, [2028]);
  assert.equal(result.basis, "stated");
});

test("several stated years are all kept", () => {
  const result = readEligibility("Open to the Class of 2028 and Class of 2029.", 2027);
  assert.ok(result.gradYears.includes(2028));
  assert.ok(result.gradYears.includes(2029));
});

test("a stated year beats a named year of study", () => {
  const result = readEligibility(
    "Open to penultimate-year students. Class of 2028 preferred.",
    2027,
  );
  assert.deepEqual(result.gradYears, [2028]);
});

const levels: [string, number][] = [
  ["rising senior", 1],
  ["penultimate-year", 1],
  ["junior", 1],
];
for (const [phrase] of levels) {
  test(`a named year of study is read: ${phrase}`, () => {
    const result = readEligibility(`Open to ${phrase} students with strong academics.`, 2027);
    assert.equal(result.basis, "stated");
    assert.ok(result.gradYears.length > 0, phrase);
  });
}

test("a year of study needs a programme year to become a graduation year", () => {
  // The offset has to be anchored to the summer the programme runs. Using the
  // programme year as a graduation year is the bug this replaced.
  const result = readEligibility("Open to penultimate-year students.", null);
  assert.deepEqual(result.gradYears, []);
});

test("nothing stated leaves the list empty rather than guessing", () => {
  // An empty list restricts nobody; an invented one hides the posting from
  // the right students and looks like a fact the employer gave us.
  const result = readEligibility(
    "Join our investment banking division for a ten week programme in New York.",
    2027,
  );
  assert.deepEqual(result.gradYears, []);
  assert.equal(result.basis, "unknown");
});

test("every eligibility answer carries its evidence", () => {
  const result = readEligibility("Open to students in the Class of 2028.", 2027);
  assert.ok(result.evidence.length > 0);
});

test("readEligibility never throws", () => {
  for (const text of ["", "\u0000", "x".repeat(50000), "Class of "]) {
    assert.doesNotThrow(() => readEligibility(text, 2027));
    assert.doesNotThrow(() => readEligibility(text, null));
  }
});

// ----------------------------------------------------- the firm-wide pattern

const agreeing = [
  { gradYears: [2028], cycleYear: 2027 },
  { gradYears: [2028], cycleYear: 2027 },
  { gradYears: [2028], cycleYear: 2027 },
];

test("a firm that agrees with itself fills the gap", () => {
  const result = inferFromFirmPattern(agreeing, 2027);
  assert.ok(result);
  assert.deepEqual(result.gradYears, [2028]);
  assert.equal(result.basis, "inferred");
});

test("an inferred answer says so, and says how it got there", () => {
  // basis is what stops an inference being read as the employer's statement.
  const result = inferFromFirmPattern(agreeing, 2027);
  assert.equal(result?.basis, "inferred");
  assert.match(result?.evidence[0] ?? "", /every other 2027 posting/);
});

test("disagreement returns null rather than a majority verdict", () => {
  // If a firm's postings for one cycle disagree, that disagreement is real -
  // the programmes differ - and guessing between them would invent the answer
  // this function exists to avoid.
  const result = inferFromFirmPattern(
    [
      { gradYears: [2028], cycleYear: 2027 },
      { gradYears: [2028], cycleYear: 2027 },
      { gradYears: [2029], cycleYear: 2027 },
    ],
    2027,
  );
  assert.equal(result, null);
});

test("a different cycle is not evidence about this one", () => {
  assert.equal(inferFromFirmPattern([{ gradYears: [2028], cycleYear: 2026 }], 2027), null);
});

test("no cycle year means no inference", () => {
  assert.equal(inferFromFirmPattern(agreeing, null), null);
});

test("no siblings means no inference", () => {
  assert.equal(inferFromFirmPattern([], 2027), null);
});

test("siblings that state nothing are not counted as agreement", () => {
  assert.equal(inferFromFirmPattern([{ gradYears: [], cycleYear: 2027 }], 2027), null);
});

test("a single agreeing sibling is enough", () => {
  const result = inferFromFirmPattern([{ gradYears: [2028], cycleYear: 2027 }], 2027);
  assert.ok(result);
  assert.deepEqual(result.gradYears, [2028]);
});

test("multi-year agreement is matched on the whole set, not one member", () => {
  const matching = inferFromFirmPattern(
    [
      { gradYears: [2028, 2029], cycleYear: 2027 },
      { gradYears: [2029, 2028], cycleYear: 2027 },
    ],
    2027,
  );
  assert.ok(matching, "the same set in a different order is the same set");

  const mismatched = inferFromFirmPattern(
    [
      { gradYears: [2028, 2029], cycleYear: 2027 },
      { gradYears: [2028], cycleYear: 2027 },
    ],
    2027,
  );
  assert.equal(mismatched, null, "a subset is not agreement");
});

test("inferFromFirmPattern never throws", () => {
  assert.doesNotThrow(() => inferFromFirmPattern([], null));
  assert.doesNotThrow(() => inferFromFirmPattern([{ gradYears: [], cycleYear: null }], 2027));
});
