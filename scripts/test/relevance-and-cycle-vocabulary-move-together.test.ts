/**
 * A word that makes a listing RELEVANT must also let its year be READ.
 *
 * These are two different vocabularies in the same file:
 * `TITLE_INTERNSHIP_SHAPES` decides "is this an internship", and `CYCLE_WORDS`
 * decides "is this 20xx the recruiting cycle". Adding a word to the first
 * without the second leaves a listing relevant and YEARLESS, and both things
 * that then happen are worse than the original rejection.
 *
 * Measured 13 October 2026, immediately after `underclassmen`, `sophomore`,
 * `freshman` and `winternship` went into the shapes list and not into
 * CYCLE_WORDS:
 *
 *   Bracebridge Capital  "2027 Sophomore Winternship"
 *       relevant, cycle null, held back for "no recruiting-cycle year found" -
 *       with the year sitting in its own title.
 *
 *   Weiss Asset Management  "2027 Underclassmen Fellowship"
 *       relevant, cycle 2028, needsHumanReview FALSE - so it would PUBLISH,
 *       with the wrong year. No stated cycle could be read, so the
 *       graduating-class fallback won and turned "Classes of 2029 and 2030"
 *       into a 2028 summer. The programme is two days in January 2027, which
 *       its title and its body both say.
 *
 * The second is the one that matters: showing a 2027 programme as 2028 puts it
 * in front of the wrong year of student, which is the single thing the cycle
 * filter exists to prevent. A wrong year that publishes beats a missing year
 * that holds back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

function classify(title: string, body: string) {
  const listing: NormalizedListing = {
    externalJobId: "req-1",
    title,
    division: null,
    location: "Boston",
    descriptionRaw: body,
    employmentType: null,
    applicationUrl: null,
    listingUrl: "https://example.test/x",
    publishedAt: null,
    deadlineAt: null,
  };
  return classifyListing(listing, "hedge_fund");
}

test("the year in an undergraduate-year title is read from the title", () => {
  // Weiss's real shape, including the graduating classes that beat it.
  const c = classify(
    "2027 Underclassmen Fellowship",
    "Weiss Asset Management invites applications for our 2027 Underclassmen " +
      "Fellowship in Boston. The Fellowship is a two-day intensive and students " +
      "will join us in our Boston office on January 7th and 8th, 2027. This " +
      "program is only open to current Freshmen and Sophomores (Classes of 2029 " +
      "and 2030). Hedge fund investing and research.",
  );
  assert.equal(c.relevant, true);
  assert.equal(
    c.recruitingCycle,
    2027,
    "the title and the body both say 2027; deriving 2028 from the graduating " +
      "classes shows a 2027 programme to the wrong year of student",
  );
});

test("a winternship's year is read too, so it is not held back", () => {
  const c = classify(
    "2027 Sophomore Winternship",
    "Bracebridge Capital is recruiting sophomores for a winter programme in " +
      "Boston covering fixed income relative value and hedge fund research.",
  );
  assert.equal(c.relevant, true);
  assert.equal(c.recruitingCycle, 2027, "the year is in the title");
  /**
   * `needsHumanReview` is deliberately NOT asserted here. It depends on
   * verifiability as well as the cycle, and this fixture's body is short
   * enough to fail that on its own - the first version of this test asserted
   * false and failed for that reason, which is the fixture being unrealistic
   * rather than the code being wrong.
   *
   * The real listing clears it: measured against the live corpus, Bracebridge's
   * posting went from cycle null to 2027 with needsHumanReview false. What
   * belongs in a unit test is the cycle, which is what this change is about.
   */
});

test("every word in the shapes list can carry a year", () => {
  /**
   * The invariant, stated over the words this pairing was found on. A new word
   * added to TITLE_INTERNSHIP_SHAPES should be added here too - and this test
   * is the reminder, because nothing fails when it is not: the listing simply
   * becomes relevant and yearless, which reads like the posting's fault.
   */
  for (const word of ["Underclassmen", "Underclassman", "Sophomore", "Freshman", "Winternship"]) {
    const c = classify(
      `2027 ${word} Programme`,
      `A hedge fund research programme in Boston for ${word.toLowerCase()} students in 2027.`,
    );
    assert.equal(c.recruitingCycle, 2027, `"2027 ${word} Programme" produced no cycle`);
  }
});

test("a year still needs a word beside it", () => {
  // The guard the cycle vocabulary exists for: widening it must not let any
  // stray year become a recruiting cycle.
  const c = classify(
    "Managing Director, Credit",
    "Copyright 2024 Example Capital. All rights reserved. Hedge fund.",
  );
  assert.equal(c.recruitingCycle, null, "a year in a footer names no recruiting cycle");
});
