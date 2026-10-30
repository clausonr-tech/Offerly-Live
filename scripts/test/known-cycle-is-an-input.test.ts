/**
 * A year recovered by a model is an INPUT to the rule, not a patch on its
 * output.
 *
 * `review-agent.ts` recovers a missing programme year by asking a model and
 * verifying its quote verbatim against the page. It used to write the year
 * onto the classification `classifyListing` had already returned - which
 * cannot work, because `needsHumanReview` is the negation of a five-part
 * conjunction that includes having a year. Supplying it afterwards left
 * `needsHumanReview` true, `publishableWithoutReview` false, and the recovery
 * unable to complete.
 *
 * Measured 13 October 2026 on the one listing independently confirmed real -
 * Egeria's "Stagiair Private Equity June/July 2027": the adjudicator said
 * internship, the model found 2027 and quoted the title it came from, and the
 * listing still could not be released.
 *
 * Passing the year in recomputes the whole conjunction with it known,
 * including the three conditions the reason chain never reached while the year
 * was missing. So a listing released this way cleared the same gate as one
 * whose year was printed on the page.
 *
 * A NOTE ON EGERIA, because this file's own history is the clearest example of
 * why the recovery path must not be the first answer. When these tests were
 * written, "Stagiair Private Equity June/July 2027" needed the model: the year
 * was in the title and the extractor could not see it, because "stagiair" was
 * missing from CYCLE_WORDS. Adding that word made the same posting derive 2027
 * deterministically, and the first test here started failing - it asserted the
 * extractor "does not know this shape", which had stopped being true.
 *
 * That is the right outcome and the cheaper one: no model call, no quote to
 * verify, no cost. The recovery path is for postings whose year genuinely is
 * not on the page, so the no-year fixture below is what exercises it now, and
 * Egeria is kept as a regression guard that it stays deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyListing, publishableWithoutReview } from "@/lib/monitoring/classify";

const dutch = {
  externalJobId: "egeria-1",
  title: "Stagiair Private Equity June/July 2027",
  division: null,
  location: "Amsterdam",
  descriptionRaw:
    "Als stagiair ben je betrokken bij alle werkzaamheden van het investment team. " +
    "Het investeringsproces start met het identificeren en evalueren van investeringskansen. " +
    "Een bijna afgeronde master opleiding in finance of engineering. Je werkt mee aan " +
    "due diligence, financiele modellen en de voorbereiding van investeringsvoorstellen " +
    "voor het team in Amsterdam.",
  employmentType: null,
  applicationUrl: "https://egeria.recruitee.com/o/stagiair-private-equity-junejuly-2027",
  listingUrl: "https://egeria.recruitee.com/o/stagiair-private-equity-junejuly-2027",
  publishedAt: null,
  deadlineAt: null,
};

/** The same posting with every year removed - the shape the recovery path is
 *  actually for. The body keeps the student language so the ONLY thing missing
 *  is the year, which is what makes this a test of the year and nothing else. */
const noYear = {
  ...dutch,
  title: "Stagiair Private Equity",
  descriptionRaw: dutch.descriptionRaw.replace(/20\d\d/g, "").replace("June/July", "the summer"),
};

test("Egeria's year is now derived without asking a model", () => {
  // Was the motivating failure for the whole recovery path; "stagiair" in
  // CYCLE_WORDS fixed it outright, which is better than recovering it.
  const c = classifyListing(dutch, "private_equity");
  assert.equal(c.relevant, true, "the Dutch title should be relevant");
  assert.equal(c.recruitingCycle, 2027, "the year is in the title and must be read from it");
  assert.equal(
    publishableWithoutReview(c),
    true,
    "with its year read deterministically this posting needs no review at all",
  );
});

test("without a year it is held back, and says why", () => {
  const c = classifyListing(noYear, "private_equity");
  assert.equal(c.relevant, true, "the Dutch title should still be relevant");
  assert.equal(c.recruitingCycle, null, "there is no year anywhere in this posting");
  assert.equal(publishableWithoutReview(c), false);
  assert.match(String(c.reasonForUncertainty), /recruiting-cycle/);
});

test("with the year supplied, the whole conjunction is recomputed", () => {
  const c = classifyListing(noYear, "private_equity", 2027);
  assert.equal(c.recruitingCycle, 2027);
  assert.equal(
    c.needsHumanReview,
    false,
    "needsHumanReview was not recomputed - this is the bug that made recovery impossible",
  );
  assert.equal(publishableWithoutReview(c), true, "Egeria's internship still cannot be released");
});

test("a supplied year never overrules one the posting states", () => {
  // The page is the authority. An outside year can fill a gap and must not
  // rewrite a fact the firm printed.
  const stated = {
    ...dutch,
    title: "2028 Investment Banking Summer Analyst Programme",
    descriptionRaw:
      "Our 2028 Summer Analyst Programme runs ten weeks in London for students in their " +
      "penultimate year of an undergraduate degree, graduating in 2029. Full training given.",
  };
  const c = classifyListing(stated, "investment_banking", 2027);
  assert.equal(c.recruitingCycle, 2028, "a supplied year overruled the posting's own");
});

test("a supplied year cannot rescue a listing failing for another reason", () => {
  /**
   * The point of recomputing rather than patching: while the year was missing
   * the reason chain never evaluated confidence, verifiability or dead years,
   * so those could be failing invisibly. A year must not paper over them.
   */
  const stub = {
    ...dutch,
    title: "Stagiair Private Equity",
    descriptionRaw: "Stagiair Private Equity",
  };
  const c = classifyListing(stub, "private_equity", 2027);
  assert.equal(
    publishableWithoutReview(c),
    false,
    "a stub description was published because a year was supplied",
  );
});
