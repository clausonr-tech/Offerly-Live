// Which summer an internship runs, and who the firm will accept.
//
// Two different facts, with a field each - `recruitingCycle` and
// `eligibleGradYears` - and conflating them shows a posting to the wrong year
// of student, which is the one thing the cycle filter exists to prevent.
//
// They WERE conflated, twice over, and the two faults hid each other:
//
//  1. "class" is one of CYCLE_WORDS, so "Class of 2028" read as cycle 2028.
//     Measured on Supabase, 20 September 2026: "Summer 2027 Financial Analyst
//     (Class of 2028), Portfolio Valuation" was stored as programYear 2028.
//     The title says Summer 2027 in words and the class year beat it.
//
//  2. getRelevantPostings checked the cycle OR the eligibility list, never
//     both - a ternary, where whichever the caller supplied was checked and
//     the other skipped. Every signed-in student has a cycle, so eligibility
//     was never consulted at all.
//
// Together: a student graduating in 2029 recruits for Summer 2028, matched
// D.A. Davidson's mis-filed "Class of 2028 Equity Capital Markets Research
// Intern", and was shown a posting for the class a year ahead of them.
//
// Nothing here is about deleting listings. Every posting stays stored for
// whoever it IS for; this is only what one student is shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyListing,
  maskClassYears,
  cycleFromClassYear,
} from "../../src/lib/monitoring/classify";
import { postingIsForStudent } from "../../src/lib/internship-postings";
import { targetProgramYear } from "../../src/lib/internship-year";
import { liveCycleRange } from "../../src/lib/monitoring/posting-quality";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";
import type { FirmProgramCategory } from "../../src/lib/firm-metadata";

const { min: LIVE_MIN, max: LIVE_MAX } = liveCycleRange();

const BODY =
  "Join the team for a ten week summer placement working alongside experienced " +
  "professionals. Candidates should be pursuing a bachelor's degree with strong " +
  "academic credentials. Applications are reviewed on a rolling basis.";

const listing = (title: string, body = BODY): NormalizedListing => ({
  externalJobId: "req-1",
  title,
  division: null,
  location: "New York",
  descriptionRaw: body,
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  deadlineAt: null,
});

const judge = (title: string, sector: FirmProgramCategory, body = BODY) =>
  classifyListing(listing(title, body), sector);

// Every sector, in its own house style. A fix that names only investment
// banking firms is not finished.
const SECTOR_ROLES: [FirmProgramCategory, string][] = [
  ["investment_banking", "Investment Banking Summer Analyst"],
  ["private_equity", "Private Equity Summer Analyst"],
  ["venture_capital", "Venture Capital Summer Associate"],
  ["private_credit", "Private Credit Summer Analyst"],
  ["real_estate", "Real Estate Acquisitions Summer Analyst"],
  ["hedge_fund", "Quantitative Research Summer Analyst"],
  ["sales_trading", "Sales and Trading Summer Analyst"],
  ["asset_wealth_management", "Wealth Management Summer Analyst"],
  ["commercial_banking", "Commercial Banking Summer Analyst"],
  ["insurance", "Actuarial Summer Intern"],
  ["fintech", "Fintech Product Summer Analyst"],
  ["market_infrastructure", "Clearing House Operations Summer Analyst"],
  ["consulting", "Consulting Summer Associate"],
  ["other_finance", "Summer Analyst Internship"],
];

// Classes whose internship summer is inside the live range, so nothing here
// is rejected for staleness and the file does not rot when the calendar moves.
const CLASS_YEARS = [LIVE_MIN + 1, LIVE_MAX];

// ---------------------------------------------------------------- masking

test("maskClassYears removes the class and leaves the summer", () => {
  const out = maskClassYears("Summer 2027 Financial Analyst (Class of 2028)");
  assert.ok(!out.includes("2028"), out);
  assert.ok(out.includes("2027"), out);
});

for (const phrase of [
  "Class of 2028",
  "class of 2028",
  "Classes of 2028",
  "Class of 2028 and 2029",
  "Class of 2028, 2029",
  "Class of 2028-2029",
]) {
  test(`"${phrase}" is masked out of cycle text`, () => {
    assert.ok(!/20\d{2}/.test(maskClassYears(phrase)), maskClassYears(phrase));
  });
}

test("a year that is not a class year survives masking", () => {
  for (const t of ["Summer 2027", "2027 Summer Analyst", "Analyst Programme 2027"]) {
    assert.ok(/2027/.test(maskClassYears(t)), t);
  }
});

test("cycleFromClassYear uses the app's own offset", () => {
  for (const y of [2027, 2028, 2029, 2030]) {
    assert.equal(cycleFromClassYear(`Class of ${y}`), targetProgramYear(y));
  }
});

test("the earliest class named wins - it is recruiting for the nearer summer", () => {
  assert.equal(cycleFromClassYear("Class of 2029 and 2028"), targetProgramYear(2028));
});

test("no class named yields nothing", () => {
  assert.equal(cycleFromClassYear("2027 Investment Banking Summer Analyst"), null);
});

// ------------------------------------------- class year never becomes a cycle
//
// 14 sectors x 2 class years x 3 title shapes.

for (const [sector, role] of SECTOR_ROLES) {
  for (const classYear of CLASS_YEARS) {
    const summer = targetProgramYear(classYear);

    test(`${sector}: "Class of ${classYear} ${role}" is Summer ${summer}`, () => {
      const c = judge(`Class of ${classYear} ${role}`, sector);
      assert.equal(c.recruitingCycle, summer, "cycle");
      assert.deepEqual(c.eligibility.gradYears, [classYear], "eligibility");
    });

    test(`${sector}: a stated summer beats a class year`, () => {
      // The exact shape that was stored wrong: the summer is in the title and
      // the class year is in brackets after it.
      const c = judge(`Summer ${summer} ${role} (Class of ${classYear})`, sector);
      assert.equal(c.recruitingCycle, summer, "cycle");
      assert.deepEqual(c.eligibility.gradYears, [classYear], "eligibility");
    });

    test(`${sector}: a leading year beats a trailing class year`, () => {
      const c = judge(`${summer} ${role} - New York (Class of ${classYear})`, sector);
      assert.equal(c.recruitingCycle, summer, "cycle");
      assert.deepEqual(c.eligibility.gradYears, [classYear], "eligibility");
    });
  }

  test(`${sector}: a plain dated title carries no eligibility claim`, () => {
    // No class stated means the firm did not say, which must stay empty
    // rather than becoming an invented restriction.
    const c = judge(`${LIVE_MIN} ${role}`, sector);
    assert.equal(c.recruitingCycle, LIVE_MIN, "cycle");
    assert.deepEqual(c.eligibility.gradYears, [], "eligibility");
  });
}

// ------------------------------------------------- the real corpus regressions

const REAL: [string, number, number[]][] = [
  ["Summer 2027 Financial Analyst (Class of 2028), Portfolio Valuation and Fund Advisory Services", 2027, [2028]],
  ["Summer 2027 Financial Analyst (Class of 2028), Corporate Valuation Advisory Services", 2027, [2028]],
  ["2027 Summer Financial Analyst - General Partner Advisory (Class of 2028) - New York", 2027, [2028]],
  ["Class of 2028 Equity Capital Markets Research Intern", 2027, [2028]],
  ["Class of 2028 Diversified Industrials Group, Investment Banking - Summer Analyst", 2027, [2028]],
  ["Class of 2028 Financial Institutions Group, Investment Banking - Summer Analyst", 2027, [2028]],
];

for (const [title, cycle, elig] of REAL) {
  test(`real posting: "${title.slice(0, 52)}..." is Summer ${cycle}`, () => {
    const c = judge(title, "investment_banking");
    assert.equal(c.recruitingCycle, cycle, "cycle");
    assert.deepEqual(c.eligibility.gradYears, elig, "eligibility");
  });
}

test("Evercore's dated title is untouched by any of this", () => {
  // The control: a posting with a real cycle and no class year must keep it.
  const c = judge("2028 Strategic Advisory: Real Estate Summer Analyst Program – New York", "investment_banking");
  assert.equal(c.recruitingCycle, 2028);
  assert.deepEqual(c.eligibility.gradYears, []);
});
