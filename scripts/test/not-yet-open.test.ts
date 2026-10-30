// A programme nobody can apply to is not an internship listing.
//
// JPMorgan's summer 2028 row rendered nine sentences of programme detail and
// an Apply button directly beneath the sentence "Summer 2028 applications are
// not open yet". It passed the older check because that only matched the
// description sentinel, and this row's description had been written properly
// - unopened all the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { saysNotYetOpen, isSkeletonPosting, isRealPosting } from "../../src/lib/internship-postings";

test("the seeder's untouched placeholder is caught", () => {
  const p = { descriptionFull: "Program description not yet captured. The summer 2028 posting is not live.", deadlineText: null };
  assert.equal(isSkeletonPosting(p), true);
  assert.equal(saysNotYetOpen(p), true);
});

test("a placeholder with a real description written over it is still caught", () => {
  // The JPMorgan case: the description no longer matches, the timing does.
  const p = {
    descriptionFull: "Nine weeks long, front-loaded with a week of technical onboarding - accounting, valuation, modeling and Excel.",
    deadlineText: "Summer 2028 applications are not open yet. Bulge-bracket firms opened their summer 2027 cycle between December 2025 and January 2026.",
  };
  assert.equal(isSkeletonPosting(p), false, "description sentinel no longer matches");
  assert.equal(saysNotYetOpen(p), true, "but the timing text still says it is not open");
});

test("the other wordings the seeder uses are caught too", () => {
  for (const deadlineText of [
    "Application timing is not published for this programme.",
    "US applications open in the spring.",
  ]) {
    assert.equal(saysNotYetOpen({ descriptionFull: "A real description.", deadlineText }), true, deadlineText);
  }
});

test("a real open posting is never hidden", () => {
  // The 2027 cycle: 137 active postings have no crawled listing behind them
  // and must still appear. Nothing about them says "not open".
  assert.equal(
    saysNotYetOpen({
      descriptionFull: "Summer analyst programme in the New York office, ten weeks.",
      deadlineText: "Applications close 14 October.",
    }),
    false,
  );
  assert.equal(saysNotYetOpen({ descriptionFull: "A real description.", deadlineText: null }), false);
});

// ---------------------------------------------------------------------------
// isRealPosting: the one gate every student-facing surface goes through.
//
// The bug these cover: "not real" used to be an opt-OUT (getRelevantPostings'
// `includeUnopened` flag), and the Upcoming panel opted out - so a seeded
// Morgan Stanley placeholder reached the home page carrying an "Est. opens"
// date derived from an Internet Archive capture. A skeleton must be unreal
// under every combination of columns, because no column on a row we wrote
// ourselves can turn it into something a firm published.
// ---------------------------------------------------------------------------

test("a skeleton is never real, whatever else it carries", () => {
  const skeleton = "Program description not yet captured. The summer 2028 posting is not live.";
  for (const deadlineStatus of ["tbd", "confirmed", "rolling", "closed", null]) {
    assert.equal(
      isRealPosting({ roleTitle: "Summer Analyst", descriptionFull: skeleton, deadlineText: "Closes 14 October", deadlineStatus }),
      false,
      `deadlineStatus ${deadlineStatus} must not promote a skeleton`,
    );
  }
});

test("a crawled posting with no not-open wording is real", () => {
  assert.equal(
    isRealPosting({
      roleTitle: "Summer Analyst",
      descriptionFull: "Summer analyst programme in the New York office, ten weeks.",
      deadlineText: "Applications close 14 October.",
      deadlineStatus: "tbd",
    }),
    true,
  );
});

test("a real posting that says it is not open yet waits for a confirmed date", () => {
  const p = {
    roleTitle: "Summer Analyst",
    descriptionFull: "Nine weeks long, front-loaded with a week of technical onboarding.",
    deadlineText: "Summer 2028 applications are not open yet.",
  };
  assert.equal(isRealPosting({ ...p, deadlineStatus: "tbd" }), false, "no date, nothing to act on");
  assert.equal(
    isRealPosting({ ...p, deadlineStatus: "confirmed" }),
    true,
    "the firm named the day - a dated heads-up is worth showing",
  );
});
