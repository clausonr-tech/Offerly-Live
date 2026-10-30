/**
 * A rejection that states no reason cannot be recovered.
 *
 * "A rejection states its reason and is recoverable; a queued row nobody reads
 * is not" is the argument the review queue's removal rests on. Measured
 * 12 October 2026 it was false for half of them: 10,473 of 20,693 rejected
 * rows carried no `reasonForUncertainty`, and 9,138 of those were written in
 * the previous two days.
 *
 * The cause was not a missing reason - it was a reason in the wrong field.
 * Three early returns in `classifyListing` compute exactly why they are
 * rejecting, put it in `matchedEvidence`, and leave `reasonForUncertainty`
 * null. Every recovery path selects on `reasonForUncertainty`:
 * `adjudicate-rejections.ts` by substring, `classifier-report.ts` the same,
 * and `review-agent.ts` through its `--reason` cohort filter. So those 10,473
 * rows were invisible to every mechanism built to rescue them.
 *
 * Nothing about any DECISION changes here. The same listings are rejected for
 * the same causes; the explanation moves to the field that is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyListing } from "@/lib/monitoring/classify";

const base = {
  externalJobId: "x1",
  division: null,
  location: "New York",
  employmentType: null,
  applicationUrl: "https://example.com/apply/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  deadlineAt: null,
};

test("page furniture is rejected WITH a reason", () => {
  // The real shapes the crawler stores: a navigation link and a page heading.
  for (const title of ["Internships", "View internship programmes"]) {
    const c = classifyListing({ ...base, title, descriptionRaw: title }, "investment_banking");
    assert.equal(c.relevant, false, `${title} should not be relevant`);
    assert.ok(
      c.reasonForUncertainty,
      `"${title}" was rejected with no reason - invisible to every recovery path`,
    );
  }
});

test("a dead cycle year is rejected WITH a reason", () => {
  const c = classifyListing(
    {
      ...base,
      title: "2019 Investment Banking Summer Analyst Programme",
      descriptionRaw:
        "Our 2019 summer analyst programme for penultimate-year undergraduates in New York. " +
        "Applications are open to students graduating in 2020. Ten weeks, full training provided.",
    },
    "investment_banking",
  );
  assert.equal(c.relevant, false);
  assert.ok(c.reasonForUncertainty, "a stale-cycle rejection stated no reason");
});

test("an off-profession role is rejected WITH a reason", () => {
  const c = classifyListing(
    {
      ...base,
      title: "Tax Summer Intern, Core Tax Services",
      descriptionRaw:
        "Join our tax practice as a summer intern. You will work with the core tax services " +
        "team on compliance engagements for a portfolio of clients, supporting senior staff.",
    },
    "investment_banking",
  );
  assert.equal(c.relevant, false);
  assert.ok(c.reasonForUncertainty, "an off-profession rejection stated no reason");
});

test("a publishable listing still states NO reason", () => {
  /**
   * The field means "what held this back". A listing nothing held back must
   * leave it null, or `publishableWithoutReview` and every report that counts
   * reasons start seeing one on rows that were never rejected.
   */
  const c = classifyListing(
    {
      ...base,
      title: "2027 Investment Banking Summer Analyst Programme - New York",
      descriptionRaw:
        "Our 2027 Summer Analyst Programme runs for ten weeks in New York. Open to students " +
        "in their penultimate year of an undergraduate degree, graduating in 2028. You will " +
        "join a deal team and receive full training alongside the incoming analyst class.",
    },
    "investment_banking",
  );
  assert.equal(c.relevant, true);
  assert.equal(c.reasonForUncertainty, null, "a publishable listing claimed a reason");
});
