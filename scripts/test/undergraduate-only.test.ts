// Offerly is for undergraduates. A graduate-degree programme is not ours.
//
// The students on this product graduate in 2027, 2028 and 2029. An MBA or PhD
// programme is closed to them however plainly it says "internship", and
// showing them one is worse than showing nothing: it is a real opening they
// cannot apply to, indistinguishable on the page from one they can.
//
// Five had reached students by 20 September 2026 - BlackRock's MBA Internship
// Program, its Quantitative Master's Internship Program, D. E. Shaw's Ph.D.
// Intern, Leerink's PhD Equity Research Intern, and Morgan Stanley's
// Investment Banking Summer Associate (MBA).
//
// The rule is HARD because every one of those names a student role as well.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing, publishableWithoutReview } from "../../src/lib/monitoring/classify";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";
import type { FirmProgramCategory } from "../../src/lib/firm-metadata";

const BODY =
  "A ten week placement working alongside the team. Candidates should be pursuing a " +
  "degree with strong academic credentials. Applications are reviewed on a rolling basis.";

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

const SECTORS: FirmProgramCategory[] = [
  "investment_banking", "private_equity", "venture_capital", "private_credit",
  "real_estate", "hedge_fund", "sales_trading", "asset_wealth_management",
  "commercial_banking", "insurance", "fintech", "market_infrastructure",
  "consulting", "other_finance",
];

// Every one of these is a real title from the corpus.
const GRADUATE_ONLY = [
  "MBA Internship Program",
  "Quantitative Master’s Internship Program",
  "Quantitative Master's Internship Program",
  "Quantitative Analyst, Ph.D. Intern (New York) - Summer 2027",
  "Equity Research Intern (PhD, Summer 2027)",
  "2027 Investment Banking Summer Associate (MBA) Program (Hong Kong)",
  "2027 Investment Banking Full-Time MBA Associate",
  "2027 Machine Learning Research Associate Program - PhD (New York)",
  "2027 Quant Masters Summer Programme - London",
  "2027 Quant Fulltime Programme (Masters) - London",
  "2027 Summer Intern, MS/PhD, Software Engineer",
  "2027 Internal Audit - Business Audit Summer Analyst Master’s Program",
  "Doctoral Research Intern",
  "Summer Analyst - Graduate Degree Required",
];

for (const title of GRADUATE_ONLY) {
  test(`graduate-only, never shown: "${title.slice(0, 46)}"`, () => {
    const c = classifyListing(listing(title), "investment_banking");
    assert.equal(c.relevant, false, `still relevant: ${c.matchedEvidence.join("; ")}`);
    assert.equal(publishableWithoutReview(c), false);
  });
}

test("the exclusion is HARD - it beats an internship phrase in the title", () => {
  // Every real case names a student role too, so a soft rule would be skipped
  // by the very phrase that makes it look like ours.
  const c = classifyListing(listing("Investment Banking Summer Associate (MBA) Program"), "investment_banking");
  assert.equal(c.relevant, false);
  assert.ok(
    c.matchedEvidence.some((e) => e.includes("undergraduates")),
    c.matchedEvidence.join("; "),
  );
});

for (const sector of SECTORS) {
  test(`${sector}: an MBA programme is excluded there too`, () => {
    assert.equal(classifyListing(listing("MBA Summer Internship Program"), sector).relevant, false);
  });
}

// ------------------------------------------------- never a bare "master"
//
// The corpus has "Derivatives Master Documentation Negotiator" and "Financial
// Reporting Application and Master Data Manager". There the word means an
// ISDA master agreement and a master data set, not a degree.

const BARE_MASTER_IS_FINE = [
  "Master Data Summer Analyst Internship",
  "Derivatives Master Agreement Intern",
  "Master Agreement Documentation Summer Analyst",
];

for (const title of BARE_MASTER_IS_FINE) {
  test(`a bare "Master" is not a degree: "${title.slice(0, 44)}"`, () => {
    const c = classifyListing(listing(title), "investment_banking");
    assert.equal(c.relevant, true, `wrongly excluded: ${c.matchedEvidence.join("; ")}`);
    assert.ok(!c.matchedEvidence.some((e) => e.includes("undergraduates")));
  });
}

// ----------------------------------------------- undergraduate roles survive

const UNDERGRADUATE = [
  "2027 Investment Banking Summer Analyst",
  "Investment Banking Summer Associate - New York",
  "2027 Summer Analyst Programme - London",
  "Quantitative Researcher Intern",
  "Spring Insight Week 2027",
  "Off-Cycle Internship - Paris",
];

for (const title of UNDERGRADUATE) {
  test(`undergraduate role survives: "${title.slice(0, 44)}"`, () => {
    const c = classifyListing(listing(title), "investment_banking");
    assert.equal(c.relevant, true, `wrongly excluded: ${c.matchedEvidence.join("; ")}`);
  });
}
