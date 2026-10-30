// Reading WHICH industry an archived careers page was recruiting for.
//
// A firm-level opening window is wrong for the 33 tiered firms that run more
// than one programme: Morgan Stanley's markets programme and its banking
// programme are not one event, and a window spanning both describes neither.
// So the archived page's listing TITLES are classified, and a window derived
// per industry.
//
// The rule these tests mostly guard is the refusal: a title naming no industry
// is not forced into one. A page of unclassifiable titles yields a firm-wide
// window and no industry windows, rather than a confident wrong one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { countInternshipPostings, sectorsInHtml } from "../../src/lib/monitoring/opening-history";
import { sectorForText } from "../../src/lib/monitoring/classify";

const board = (...titles: string[]) =>
  `<html><body>${titles.map((t, i) => `<li><a href="/jobs/${i}">${t}</a></li>`).join("")}</body></html>`;

// ------------------------------------------------------- titles are carried

test("every distinct internship title is returned, not just a sample", () => {
  // The sample alone answers "was this firm posting internships". It cannot
  // answer "was this firm posting BANKING internships".
  const html = board(
    "2027 Investment Banking Summer Analyst",
    "2027 Real Estate Summer Analyst",
    "2027 Sales and Trading Summer Analyst",
  );
  assert.equal(countInternshipPostings(html).titles.length, 3);
});

test("the sample is still the first title, for callers that only want one", () => {
  const html = board("2027 Investment Banking Summer Analyst", "2027 Real Estate Summer Analyst");
  const result = countInternshipPostings(html);
  assert.equal(result.sample, result.titles[0]);
  assert.equal(result.count, result.titles.length);
});

test("a repeated role counts once", () => {
  const html = board("2027 Summer Analyst", "2027 Summer Analyst", "2027 Summer Analyst");
  assert.equal(countInternshipPostings(html).titles.length, 1);
});

test("a page with no internships carries no titles", () => {
  assert.deepEqual(countInternshipPostings(board("Vice President, Compliance")).titles, []);
});

test("an empty page does not throw", () => {
  for (const html of ["", "<html></html>", " "]) {
    assert.doesNotThrow(() => countInternshipPostings(html));
    assert.deepEqual(countInternshipPostings(html).titles, []);
  }
});

// ------------------------------------------------------- industries on a page

test("a multi-industry board yields one entry per industry", () => {
  const html = board(
    "2027 Investment Banking Summer Analyst",
    "2027 Real Estate Summer Analyst",
    "2027 Sales and Trading Summer Analyst",
    "2027 Asset Management Summer Analyst",
  );
  const found = sectorsInHtml(html);
  assert.equal(found.size, 4);
  assert.ok(found.has("investment_banking"));
  assert.ok(found.has("real_estate"));
  assert.ok(found.has("sales_trading"));
  assert.ok(found.has("asset_wealth_management"));
});

test("each industry carries the title it was read from, as evidence", () => {
  const found = sectorsInHtml(board("2027 Real Estate Summer Analyst"));
  assert.equal(found.get("real_estate"), "2027 Real Estate Summer Analyst");
});

test("the first title wins when an industry appears twice", () => {
  const found = sectorsInHtml(board("2027 M&A Summer Analyst", "2027 Leveraged Finance Summer Analyst"));
  assert.equal(found.get("investment_banking"), "2027 M&A Summer Analyst");
});

test("a title naming no industry is not forced into one", () => {
  // A page of unclassifiable titles must produce a firm window and NO
  // industry windows, rather than a wrong industry window.
  const found = sectorsInHtml(board("2027 Summer Analyst", "Summer Internship Programme"));
  assert.equal(found.size, 0);
});

test("unclassifiable titles do not suppress the classifiable ones beside them", () => {
  const found = sectorsInHtml(
    board("2027 Summer Analyst", "2027 Private Equity Summer Analyst", "Summer Internship"),
  );
  assert.equal(found.size, 1);
  assert.ok(found.has("private_equity"));
});

test("a non-internship title contributes no industry", () => {
  // The internship filter runs first - a full-time banking role is not an
  // internship opening.
  assert.equal(sectorsInHtml(board("Investment Banking Vice President")).size, 0);
});

const industryTitles: [string, string][] = [
  ["investment_banking", "2027 Investment Banking Summer Analyst"],
  ["investment_banking", "2027 M&A Summer Associate"],
  ["investment_banking", "Strategic Advisory Summer Analyst 2027"],
  ["investment_banking", "2027 Restructuring Summer Analyst"],
  ["private_equity", "2027 Private Equity Summer Analyst"],
  ["private_credit", "2027 Private Credit Summer Analyst"],
  ["real_estate", "2027 Real Estate Summer Analyst"],
  ["hedge_fund", "2027 Hedge Fund Summer Analyst"],
  ["sales_trading", "2027 Sales and Trading Summer Analyst"],
  ["asset_wealth_management", "2027 Wealth Management Summer Analyst"],
  ["commercial_banking", "2027 Commercial Banking Summer Analyst"],
  ["consulting", "2027 Consulting Summer Analyst"],
];
for (const [industry, title] of industryTitles) {
  test(`"${title.slice(0, 44)}" is read as ${industry}`, () => {
    assert.equal(sectorsInHtml(board(title)).has(industry as never), true);
  });
}

test("sectorsInHtml agrees with the classifier", () => {
  // One rule, one implementation - a title cannot be filed under one industry
  // here and another when the listing is classified for real.
  for (const [, title] of industryTitles) {
    const viaClassifier = sectorForText(title)?.category;
    const viaPage = [...sectorsInHtml(board(title)).keys()][0];
    assert.equal(viaPage, viaClassifier, title);
  }
});

test("sectorForText returns null rather than guessing", () => {
  for (const text of ["", "Summer Analyst", "Intern"]) {
    assert.equal(sectorForText(text), null, JSON.stringify(text));
  }
});

test("sectorsInHtml never throws", () => {
  for (const html of ["", "<a", " ", "<a href='x'>".repeat(400)]) {
    assert.doesNotThrow(() => sectorsInHtml(html));
  }
});

test("a firm running two programmes can be told apart day by day", () => {
  // The whole point: on the day only banking is up, only banking has opened.
  const bankingOnly = board("2027 Investment Banking Summer Analyst");
  const bothOpen = board("2027 Investment Banking Summer Analyst", "2027 Real Estate Summer Analyst");
  assert.equal(sectorsInHtml(bankingOnly).has("real_estate"), false);
  assert.equal(sectorsInHtml(bothOpen).has("real_estate"), true);
  assert.equal(sectorsInHtml(bothOpen).has("investment_banking"), true);
});
