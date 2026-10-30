// A row nobody can judge is not a hard case, it is an unanswerable one.
//
// monitor-run retires a listing from the review queue when it closes one it
// never managed to read: no text, and no live posting to go and look at, so a
// reviewer can only skip it every time they open the queue.
//
// reclassify-listings then recovered them straight back, because its rule is
// that "a MACHINE rejection is not a decision, and has to be revisitable".
// That is right for a rejection a fixed rule might overturn, and wrong for a
// row no rule can ever speak to. Measured 20 September 2026: retiring 46
// Morgan Stanley listings and running one reclassify pass put all 46 back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnreviewable } from "../../src/lib/monitoring/listing-lifecycle";

const REAL_BODY =
  "Join the team for a ten week placement. Candidates should be pursuing a bachelor's " +
  "degree with strong academic credentials. Applications are reviewed on a rolling basis.";

test("closed and never readable is unreviewable", () => {
  assert.equal(
    isUnreviewable({
      status: "closed",
      title: "2027 Fixed Income Off-Cycle Internship (Milan)",
      descriptionRaw: "",
    }),
    true,
  );
});

test("a title echoed back as the description is not readable either", () => {
  // The other half of isThinDescription: some connectors synthesise the title
  // as a placeholder body.
  const title = "2027 Corporate Treasury Summer Analyst Program (New York)";
  assert.equal(isUnreviewable({ status: "closed", title, descriptionRaw: title }), true);
});

test("closed WITH a description stays reviewable", () => {
  // A human can read it and decide, and a changed rule can overturn it.
  assert.equal(
    isUnreviewable({ status: "closed", title: "Summer Analyst", descriptionRaw: REAL_BODY }),
    false,
  );
});

test("open and unreadable stays reviewable", () => {
  // Still live, so enrichment can go and fetch the text on a later check.
  // Retiring these would throw away listings that are about to become
  // judgeable - Lazard's 49 were exactly this, and enrichment filled them.
  assert.equal(
    isUnreviewable({ status: "open", title: "Quantitative Researcher Intern", descriptionRaw: "" }),
    false,
  );
});

test("an ordinary open listing is reviewable", () => {
  assert.equal(
    isUnreviewable({ status: "open", title: "Summer Analyst", descriptionRaw: REAL_BODY }),
    false,
  );
});
