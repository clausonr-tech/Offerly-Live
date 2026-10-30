// The coverage-group filter is what narrows a banking student's list. The
// sector column does not: for a banking candidate `investment_banking`
// matches practically everything crawled.
//
// The regression this guards: matching a student's raw onboarding label
// ("Healthcare Coverage") as a substring of a role title found nothing, so the
// filter looked switched off. Matching has to happen GROUP to GROUP.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverageKeyword,
  interestGroups,
  matchesCoverage,
  industryGroupOf,
  namesCoverageGroup,
} from "../../src/lib/coverage-match";

test("onboarding labels reduce to the keyword a firm would actually use", () => {
  assert.equal(coverageKeyword("Industrials Coverage"), "industrials");
  assert.equal(coverageKeyword("Healthcare Group"), "healthcare");
  assert.equal(coverageKeyword("Equity Capital Markets (ECM)"), "equity capital markets");
});

test("labels map to canonical groups, deduplicated", () => {
  assert.deepEqual(interestGroups(["Healthcare Coverage"]), ["Healthcare"]);
  assert.deepEqual(interestGroups(["Healthcare Coverage", "Healthcare Group"]), ["Healthcare"]);
  assert.deepEqual(interestGroups([]), []);
  assert.deepEqual(interestGroups(null), []);
});

test("a healthcare student matches a role titled Life Sciences", () => {
  // The exact case that made the old substring filter useless: the word
  // "healthcare" appears nowhere in the role a healthcare student wants.
  assert.equal(
    matchesCoverage(
      { roleTitle: "2027 Summer Associate - Life Sciences - New York" },
      ["Healthcare Coverage"],
    ),
    true,
  );
});

test("a stated preference actually excludes other groups", () => {
  assert.equal(
    matchesCoverage({ roleTitle: "Energy & Power Summer Analyst" }, ["Healthcare Coverage"]),
    false,
  );
});

test("no stated preference narrows nothing", () => {
  // A filter that matches nothing is indistinguishable from a broken product.
  assert.equal(matchesCoverage({ roleTitle: "Energy & Power Summer Analyst" }, []), true);
  assert.equal(matchesCoverage({ roleTitle: "Energy & Power Summer Analyst" }, null), true);
});

test("fintech in a title does not read as Technology coverage", () => {
  // Word-boundary discipline: \btech\b must not fire inside "fintech".
  assert.notEqual(industryGroupOf({ roleTitle: "Fintech Investment Banking Analyst" }), "Technology");
});

test("a bare Summer Analyst names no coverage group", () => {
  // Bulge brackets assign coverage after the offer, so an unlabelled title is
  // a generalist posting, not a mismatch.
  assert.equal(namesCoverageGroup({ roleTitle: "2027 Investment Banking Summer Analyst" }), false);
  assert.equal(namesCoverageGroup({ roleTitle: "Healthcare Summer Analyst" }), true);
});

test("a TMT student matches technology, media and telecom roles", () => {
  // Onboarding offers one TMT group now - Media & Telecom was the same group
  // under a second name. Most postings name the half they are, not "TMT".
  assert.deepEqual(interestGroups(["TMT Coverage"]).sort(), ["Media & Telecom", "TMT", "Technology"]);
  for (const roleTitle of [
    "Investment Banking Summer Analyst - TMT",
    "Technology Investment Banking Summer Analyst",
    "Media & Telecom Investment Banking Summer Analyst",
  ]) {
    assert.equal(matchesCoverage({ roleTitle }, ["TMT Coverage"]), true, roleTitle);
  }
  assert.equal(matchesCoverage({ roleTitle: "Healthcare Investment Banking Summer Analyst" }, ["TMT Coverage"]), false);
});

test("a saved Media & Telecom interest still matches media roles", () => {
  assert.equal(matchesCoverage({ roleTitle: "Media Investment Banking Summer Analyst" }, ["Media & Telecom"]), true);
});
