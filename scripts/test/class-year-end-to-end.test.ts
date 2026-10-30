// Crawl to screen, for every sector.
//
// The two halves were each fixed separately, and each looks right on its own:
// the classifier now tells a graduating class from a summer, and the query
// now applies both filters. What matters is the join between them - what a
// student actually sees after a posting has been through the whole pipeline.
//
// So each case here classifies a real-shaped title, publishes it the way
// promote-approved-listings.ts would (programYear from the cycle,
// eligibleGradYears from the eligibility), and then asks the visibility rule
// who is shown it. That is the path the D.A. Davidson posting took to reach a
// 2029 graduate it was never meant for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";
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

const listing = (title: string): NormalizedListing => ({
  externalJobId: "req-1",
  title,
  division: null,
  location: "New York",
  descriptionRaw: BODY,
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  deadlineAt: null,
});

/** What promote-approved-listings.ts writes into internship_postings. */
function publish(title: string, sector: FirmProgramCategory) {
  const c = classifyListing(listing(title), sector);
  return {
    programYear: c.recruitingCycle,
    eligibleGradYears: c.eligibility.gradYears,
  };
}

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

const CLASS_YEARS = [LIVE_MIN + 1, LIVE_MAX];

for (const [sector, role] of SECTOR_ROLES) {
  for (const classYear of CLASS_YEARS) {
    const summer = targetProgramYear(classYear);
    const rightStudent = classYear;
    const yearBehind = classYear + 1;
    const yearAhead = classYear - 1;

    test(`${sector}: class of ${classYear} reaches the class of ${classYear}`, () => {
      const p = publish(`Class of ${classYear} ${role}`, sector);
      assert.equal(p.programYear, summer, "programYear");
      assert.equal(
        postingIsForStudent(p as { programYear: number; eligibleGradYears: number[] }, {
          internshipYear: targetProgramYear(rightStudent),
          gradYear: rightStudent,
        }),
        true,
      );
    });

    test(`${sector}: class of ${classYear} is hidden from the class of ${yearBehind}`, () => {
      // The screenshot case: a student a year behind, recruiting for a later
      // summer, was shown this because only the cycle was ever checked.
      const p = publish(`Class of ${classYear} ${role}`, sector);
      assert.equal(
        postingIsForStudent(p as { programYear: number; eligibleGradYears: number[] }, {
          internshipYear: targetProgramYear(yearBehind),
          gradYear: yearBehind,
        }),
        false,
      );
    });

    test(`${sector}: class of ${classYear} is hidden from the class of ${yearAhead}`, () => {
      const p = publish(`Class of ${classYear} ${role}`, sector);
      assert.equal(
        postingIsForStudent(p as { programYear: number; eligibleGradYears: number[] }, {
          internshipYear: targetProgramYear(yearAhead),
          gradYear: yearAhead,
        }),
        false,
      );
    });

    test(`${sector}: a stated summer with a class year reaches the right class`, () => {
      const p = publish(`Summer ${summer} ${role} (Class of ${classYear})`, sector);
      assert.equal(p.programYear, summer, "programYear");
      assert.equal(
        postingIsForStudent(p as { programYear: number; eligibleGradYears: number[] }, {
          internshipYear: summer,
          gradYear: classYear,
        }),
        true,
      );
    });
  }

  test(`${sector}: an undated-class posting reaches every class in that cycle`, () => {
    // A firm that names no class has restricted nobody, and the posting must
    // stay visible to whoever is recruiting for that summer.
    const p = publish(`${LIVE_MIN} ${role}`, sector);
    assert.equal(p.programYear, LIVE_MIN);
    assert.deepEqual(p.eligibleGradYears, []);
    assert.equal(
      postingIsForStudent(p as { programYear: number; eligibleGradYears: number[] }, {
        internshipYear: LIVE_MIN,
        gradYear: LIVE_MIN + 1,
      }),
      true,
    );
  });
}
