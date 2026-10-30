// Who is shown which posting - the full truth table.
//
// `postingIsForStudent` is a two-condition rule, so a matrix over realistic
// years IS the specification rather than a sample of it. The two conditions
// were once a single ternary that checked whichever the caller supplied and
// skipped the other, and because every signed-in student has a cycle, the
// eligibility list was never consulted at any point. A table is what makes
// that shape of bug impossible to reintroduce quietly.
//
//   programYear        WHICH SUMMER the internship runs
//   eligibleGradYears  WHO the firm said it will accept
//
// Offerly carries students from several recruiting cycles at once - 2027,
// 2028 and 2029 graduates are all on it - so every one of these rows is a
// real combination somebody hits.
//
// STORED IS NOT SHOWN. Every case below also asserts the reciprocal: a
// posting hidden from one student is still shown to the student it is
// actually for. Nothing is dropped from the table for being the wrong year.

import { test } from "node:test";
import assert from "node:assert/strict";
import { postingIsForStudent } from "../../src/lib/internship-postings";
import { targetProgramYear } from "../../src/lib/internship-year";

const GRAD_YEARS = [2026, 2027, 2028, 2029, 2030, 2031];
/** How far the posting's summer sits from the one this student recruits for. */
const CYCLE_OFFSETS = [-2, -1, 0, 1, 2];

type EligShape = { label: string; of: (grad: number) => number[]; accepts: (grad: number) => boolean };

const ELIGIBILITY: EligShape[] = [
  { label: "unstated", of: () => [], accepts: () => true },
  { label: "this class", of: (g) => [g], accepts: () => true },
  { label: "the class above", of: (g) => [g - 1], accepts: () => false },
  { label: "the class below", of: (g) => [g + 1], accepts: () => false },
  { label: "this class and the one below", of: (g) => [g, g + 1], accepts: () => true },
  { label: "the class above and this one", of: (g) => [g - 1, g], accepts: () => true },
];

for (const grad of GRAD_YEARS) {
  const recruitsFor = targetProgramYear(grad);

  for (const offset of CYCLE_OFFSETS) {
    const programYear = recruitsFor + offset;
    const cycleMatches = offset === 0;

    for (const shape of ELIGIBILITY) {
      const eligibleGradYears = shape.of(grad);
      const expected = cycleMatches && shape.accepts(grad);

      test(`grad ${grad} (Summer ${recruitsFor}) | posting Summer ${programYear} | eligibility ${shape.label} -> ${expected ? "shown" : "hidden"}`, () => {
        assert.equal(
          postingIsForStudent(
            { programYear, eligibleGradYears },
            { internshipYear: recruitsFor, gradYear: grad },
          ),
          expected,
        );
      });

      // The reciprocal. A posting hidden from this student is not junk: it
      // belongs to someone, and the someone must be able to see it.
      if (!expected && eligibleGradYears.length > 0) {
        const owner = eligibleGradYears[0];
        test(`...and that posting IS shown to the class of ${owner} it names`, () => {
          assert.equal(
            postingIsForStudent(
              { programYear, eligibleGradYears },
              { internshipYear: programYear, gradYear: owner },
            ),
            true,
          );
        });
      }
    }
  }
}

// ------------------------------------------------------------- unknown inputs
//
// Unknown restricts nobody, in both directions. Three of four accounts on
// this database have no grad year set, and filtering them to nothing is how
// the whole pipeline once came back empty with no error raised anywhere.

for (const grad of GRAD_YEARS) {
  test(`a student with no grad year still sees a posting restricted to ${grad}`, () => {
    assert.equal(
      postingIsForStudent(
        { programYear: targetProgramYear(grad), eligibleGradYears: [grad] },
        { internshipYear: targetProgramYear(grad), gradYear: null },
      ),
      true,
    );
  });

  test(`a student with no cycle sees any summer, for class of ${grad}`, () => {
    assert.equal(
      postingIsForStudent(
        { programYear: 2099, eligibleGradYears: [grad] },
        { internshipYear: null, gradYear: grad },
      ),
      true,
    );
  });

  test(`an omitted cycle is the same as a null one, for class of ${grad}`, () => {
    // The caller above omitted the field entirely rather than passing null,
    // and an optional-vs-nullable mismatch is what silently unfiltered it.
    assert.equal(
      postingIsForStudent({ programYear: 2099, eligibleGradYears: [grad] }, { gradYear: grad }),
      true,
    );
  });
}

test("a null eligibility column is read as unstated, not as nobody", () => {
  assert.equal(
    postingIsForStudent(
      { programYear: 2028, eligibleGradYears: null },
      { internshipYear: 2028, gradYear: 2029 },
    ),
    true,
  );
});

test("knowing neither shows everything", () => {
  assert.equal(
    postingIsForStudent(
      { programYear: 2028, eligibleGradYears: [2028] },
      { internshipYear: null, gradYear: null },
    ),
    true,
  );
});

// ------------------------------------------------- the screenshot, exactly
//
// A 2029 graduate, on the Summer 2028 page, seeing Evercore and D.A.
// Davidson side by side. One of those is theirs.

const EVERCORE = { programYear: 2028, eligibleGradYears: [] as number[] };
// After the class-year fix this posting is correctly Summer 2027.
const DAVIDSON = { programYear: 2027, eligibleGradYears: [2028] };

test("the 2029 graduate sees Evercore", () => {
  assert.equal(postingIsForStudent(EVERCORE, { internshipYear: 2028, gradYear: 2029 }), true);
});

test("the 2029 graduate does NOT see the class-of-2028 posting", () => {
  assert.equal(postingIsForStudent(DAVIDSON, { internshipYear: 2028, gradYear: 2029 }), false);
});

test("the 2028 graduate DOES see the class-of-2028 posting", () => {
  assert.equal(postingIsForStudent(DAVIDSON, { internshipYear: 2027, gradYear: 2028 }), true);
});

test("the 2028 graduate does not see next cycle's Evercore posting", () => {
  assert.equal(postingIsForStudent(EVERCORE, { internshipYear: 2027, gradYear: 2028 }), false);
});

test("even mis-filed, the posting is never hidden from everyone", () => {
  // The guarantee behind "do not delete anything you scrape": whatever year a
  // posting ends up under, some student can still reach it.
  for (const py of [2026, 2027, 2028, 2029]) {
    for (const elig of [[], [2027], [2028], [2029]]) {
      const owner = elig.length ? elig[0] : 2028;
      assert.equal(
        postingIsForStudent({ programYear: py, eligibleGradYears: elig }, { internshipYear: py, gradYear: owner }),
        true,
        `programYear ${py}, eligibility [${elig.join(",")}]`,
      );
    }
  }
});
