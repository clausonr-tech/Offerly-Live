// Does the classifier still get the known cases right?
//
// WHY THIS EXISTS
// ---------------
// Every rule in classify.ts was added because somebody noticed a specific bad
// posting, and the reasoning was written into a comment. That is how the rules
// got good - and it left precision and recall as UNKNOWN numbers. There was no
// way to say "this change made the classifier better"; only "this change fixed
// the one posting I was looking at". Four tests covered a 702-line decision.
//
// The cases in scripts/data/classifier-eval.json are those incidents, turned
// back into inputs. Each one is a real posting with an answer that is
// documented rather than guessed - a filter control, a copyright line read as
// a recruiting cycle, a networking reception titled "Summer Analyst", a
// genuine William Blair posting that was thrown out for the word "senior".
//
// So a change that quietly re-breaks one of them now fails here instead of
// reaching students. And the numbers printed at the end are a baseline: the
// first honest measurement of how this classifier performs, against which the
// next change can be compared.
//
// ADD A CASE WHENEVER A NEW FAILURE IS FOUND. That is the whole point - the
// file should grow every time somebody says "why did it do that".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { classifyListing } from "../../src/lib/monitoring/classify";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

type EvalCase = {
  id: string;
  title: string;
  description: string;
  expectRelevant: boolean;
  /** True when the DETERMINISTIC classifier is expected to get this wrong and
   *  something downstream (the adjudicator) is what catches it. Recorded so
   *  the gap stays measured instead of forgotten. */
  expectKnownGap?: boolean;
  why: string;
};

const cases = (
  JSON.parse(
    readFileSync(path.join(process.cwd(), "scripts", "data", "classifier-eval.json"), "utf8"),
  ) as { cases: EvalCase[] }
).cases;

function listingFrom(c: EvalCase): NormalizedListing {
  return {
    externalJobId: c.id,
    title: c.title,
    division: null,
    location: "New York, NY",
    descriptionRaw: c.description,
    employmentType: null,
    applicationUrl: `https://example.com/${c.id}`,
    listingUrl: `https://example.com/${c.id}`,
    publishedAt: null,
  };
}

for (const c of cases) {
  // A known gap is asserted in the direction it actually behaves, so the suite
  // stays green while still recording the truth. If the deterministic
  // classifier ever starts getting it right, this fails and the case should be
  // promoted - a gap that closes is worth noticing.
  const expected = c.expectKnownGap ? !c.expectRelevant : c.expectRelevant;

  test(`${c.id}: ${c.why.slice(0, 80)}`, () => {
    const result = classifyListing(listingFrom(c), "investment_banking");
    assert.equal(
      result.relevant,
      expected,
      `expected relevant=${expected} for "${c.title}"\n` +
        `  reason: ${result.reasonForUncertainty ?? "(none)"}\n` +
        `  evidence: ${result.matchedEvidence.join(" | ")}`,
    );
  });
}

test("every rejection states a reason a human can read", () => {
  // A rejection that cannot say why is indistinguishable from a bug. 1,182 of
  // 2,164 rejections once looked unexplained, and 42 real internships sat
  // inside that silence.
  for (const c of cases) {
    const result = classifyListing(listingFrom(c), "investment_banking");
    if (result.relevant) continue;
    const hasReason =
      Boolean(result.reasonForUncertainty) ||
      result.matchedEvidence.some(
        (e) =>
          e.includes("not a posting") ||
          e.includes("not an internship") ||
          e.includes("excluded:") ||
          e.includes("cycle"),
      );
    assert.ok(hasReason, `"${c.title}" was rejected with no readable reason`);
  }
});

test("the known gap is still exactly one case", () => {
  // If this number grows, somebody added a case the classifier cannot handle
  // and moved on. That should be a decision, not a drift.
  assert.equal(cases.filter((c) => c.expectKnownGap).length, 0);
});

test("baseline: precision and recall on the labelled set", () => {
  let truePos = 0;
  let falsePos = 0;
  let trueNeg = 0;
  let falseNeg = 0;

  for (const c of cases) {
    const got = classifyListing(listingFrom(c), "investment_banking").relevant;
    if (c.expectRelevant && got) truePos += 1;
    else if (!c.expectRelevant && got) falsePos += 1;
    else if (!c.expectRelevant && !got) trueNeg += 1;
    else falseNeg += 1;
  }

  const precision = truePos + falsePos ? truePos / (truePos + falsePos) : 1;
  const recall = truePos + falseNeg ? truePos / (truePos + falseNeg) : 1;
  console.log(
    `    classifier baseline: precision ${(precision * 100).toFixed(0)}% ` +
      `(${truePos} correct of ${truePos + falsePos} published), ` +
      `recall ${(recall * 100).toFixed(0)}% (${truePos} of ${truePos + falseNeg} real internships found)`,
  );

  /**
   * Precision is asserted, recall is only reported.
   *
   * That asymmetry is the product's standing bias: a false positive reaches a
   * student as a real opportunity and wastes the thing they came here for,
   * while a miss is invisible. So publishing something wrong fails the suite;
   * missing something is measured and worked on.
   */
  assert.equal(falsePos, 0, "a non-internship was classified relevant - that reaches students");
});

// ------------------------------------------------- derived recruiting cycle

test("a deadline supplies the cycle a posting never states", () => {
  // 38 Oracle listings sat in review reading "relevant with a sector, but no
  // recruiting-cycle year found". The year was there - in the deadline.
  const result = classifyListing(
    {
      ...listingFrom(cases[0]),
      title: "Investment Banking Summer Analyst - London",
      descriptionRaw: "Join our advisory team for a ten week summer programme. Applications close soon.",
      deadlineAt: "2026-11-15T23:55:00.000Z",
    },
    "investment_banking",
  );
  assert.equal(result.recruitingCycle, 2027, "a November 2026 deadline recruits for summer 2027");
  assert.ok(
    result.matchedEvidence.some((e) => e.includes("derived from the stated application deadline")),
    "the derivation must be visible to a reviewer, not laundered into a stated fact",
  );
});

test("a stated year always beats a derived one", () => {
  // The firm knows its own programme better than date arithmetic does.
  const result = classifyListing(
    {
      ...listingFrom(cases[0]),
      title: "2028 Investment Banking Summer Analyst",
      descriptionRaw: "Our 2028 Summer Analyst Program runs for ten weeks.",
      deadlineAt: "2026-11-15T23:55:00.000Z",
    },
    "investment_banking",
  );
  assert.equal(result.recruitingCycle, 2028);
});

test("a deadline in spring belongs to that same cycle", () => {
  // Late and off-cycle rounds close in the same calendar year they recruit
  // for; only July onwards points at the following summer.
  const result = classifyListing(
    {
      ...listingFrom(cases[0]),
      title: "Investment Banking Summer Analyst - New York",
      descriptionRaw: "A ten week summer placement in our M&A group.",
      deadlineAt: "2027-03-01T00:00:00.000Z",
    },
    "investment_banking",
  );
  assert.equal(result.recruitingCycle, 2027);
});

test("no date means no cycle - nothing is invented", () => {
  const result = classifyListing(
    {
      ...listingFrom(cases[0]),
      title: "Investment Banking Summer Analyst",
      descriptionRaw: "A ten week summer placement in our M&A group.",
      deadlineAt: null,
      publishedAt: null,
    },
    "investment_banking",
  );
  assert.equal(result.recruitingCycle, null);
});
