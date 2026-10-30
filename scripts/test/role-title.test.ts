// shortRoleTitle keeps the part of a crawled title that tells roles apart and
// drops what every card already says. Cases are real 2028 titles from
// internship_postings, across banks, markets desks and accounting firms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNamedRoleTitle, shortRoleTitle } from "../../src/lib/role-title";

const cases: [string, string][] = [
  [
    "2028 Strategic Advisory: Mergers & Acquisitions Summer Analyst Program – Chicago Industrials",
    "Mergers & Acquisitions – Chicago Industrials",
  ],
  [
    "2028 Capital Markets Advisory: Equity Capital Markets Summer Analyst Program – New York",
    "Equity Capital Markets – New York",
  ],
  ["2028 Equities: Sales & Trading Summer Intern Program – New York", "Sales & Trading – New York"],
  ["2028 Summer Analyst Program: Global Technology – New York", "Global Technology – New York"],
  [
    "2028 Private Capital Advisory: Private Capital Advisory Summer Analyst Program – New York",
    "Private Capital Advisory – New York",
  ],
  [
    "2028 Liability Management & Restructuring Summer Analyst Program – New York",
    "Liability Management & Restructuring – New York",
  ],
  ["2028 Investment Banking Summer Analyst Program", "Investment Banking"],
  ["2028 Investment Associate Intern", "Investment Associate Intern"],
  ["Equity Research - Summer Analyst", "Equity Research"],
  ["M&A Advisory (Technology, US) - Summer Analyst", "M&A Advisory (Technology, US)"],
  [
    "Consumer Group, Investment Banking – Summer Analyst – 2028 Grads",
    "Consumer Group, Investment Banking",
  ],
  [
    "Class of 2028 Financial Institutions Group, Investment Banking - Summer Analyst",
    "Financial Institutions Group, Investment Banking",
  ],
  ["Class of 2028 Equity Capital Markets Research Intern", "Equity Capital Markets Research Intern"],
  [
    "2027 - Global Markets (Sales, Trading, Structuring & Research) - Summer Internship - London (for 2028 Graduates)",
    "Global Markets (Sales, Trading, Structuring & Research) – London",
  ],
  ["Assurance Intern - Summer 2028 (Atlanta)", "Assurance Intern (Atlanta)"],
  [
    "Tax Intern Leadership Program (TILP) - Winter & Summer 2028 (Dallas)",
    "Tax Intern Leadership Program (TILP) (Dallas)",
  ],
  ["Summer 2027/Winter 2028 Tax or Audit Internship", "Summer 2027/Winter 2028 Tax or Audit Internship"],
];

test("shortRoleTitle keeps the distinguishing part of real titles", () => {
  for (const [input, expected] of cases) assert.equal(shortRoleTitle(input), expected, input);
});

test("shortRoleTitle falls back to the original rather than returning nothing", () => {
  assert.equal(shortRoleTitle("Summer Analyst"), "Summer Analyst");
  assert.equal(shortRoleTitle("  2028 Summer Analyst Program  "), "2028 Summer Analyst Program");
});

// The merge of 21 September stored these in role_title. None names a role, so
// none may be saved or shown.
test("isNamedRoleTitle rejects timestamps, blanks and numbers", () => {
  for (const bad of [
    "2028-01-01 00:00:00+00",
    "2027-01-01 05:00:00+00",
    "2001-01-01 00:00:00+00",
    "6344-01-01 00:00:00+00",
    "2027-03-01",
    "2027-01-01T00:00:00.000Z",
    "",
    "   ",
    "13611",
    "- 2027 -",
    null,
    undefined,
  ]) {
    assert.equal(isNamedRoleTitle(bad), false, String(bad));
  }
});

test("isNamedRoleTitle accepts real titles in any language", () => {
  for (const good of [
    "Summer Analyst, Investment Banking, BDO Capital Advisors - Summer 2028 (Richmond)",
    "Internship, Credit Analysis Department 1",
    "Stage H/F - Assistant de Gestion Privée – Bruxelles – Mars 2027",
    "2028 Investment Banking Summer Analyst Program",
    "M&A Analyst Intern",
    "投资银行实习生",
  ]) {
    assert.equal(isNamedRoleTitle(good), true, good);
  }
});
