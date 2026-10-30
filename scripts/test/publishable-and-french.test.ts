// Two rules that only make sense together.
//
// 1. What `auto_approved` MEANS. Three writers were each deciding it
//    separately - monitor-run on insert, reclassify-listings on a rule change,
//    promote-approved-listings at publication - and the third had a stricter
//    test than the other two, because internship_postings.program_year is NOT
//    NULL. So cycle-less rows looped: promotion held them for review, the next
//    reclassify pass approved them again, promotion held them again. Measured
//    20 September 2026, one dry run moved 44 rows that way; with one shared
//    rule it moves 7, and those 7 can actually publish.
//
// 2. French internship vocabulary, which is what produces cycle-less rows in
//    volume. Rothschild & Co's Paris board publishes its whole pipeline in
//    French across investment banking AND private equity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing, publishableWithoutReview } from "../../src/lib/monitoring/classify";
import { liveCycleRange } from "../../src/lib/monitoring/posting-quality";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

const YEAR = liveCycleRange().min;

const listing = (patch: Partial<NormalizedListing>): NormalizedListing => ({
  externalJobId: "req-1",
  title: "Investment Banking Summer Analyst",
  division: null,
  location: "Paris",
  descriptionRaw:
    "Une opportunite au sein de l'equipe. Candidates should be pursuing a bachelor's " +
    "degree with strong academic credentials. Applications are reviewed on a rolling basis.",
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  deadlineAt: null,
  ...patch,
});

// ------------------------------------------------- what auto_approved means

test("confident AND dated is publishable", () => {
  assert.equal(
    publishableWithoutReview({ needsHumanReview: false, recruitingCycle: YEAR }),
    true,
  );
});

test("confident but undated is NOT publishable - it needs a programme year", () => {
  // The case that was looping. Not a rejection: it goes to a human, who can
  // supply the year.
  assert.equal(
    publishableWithoutReview({ needsHumanReview: false, recruitingCycle: null }),
    false,
  );
});

test("dated but uncertain is not publishable either", () => {
  assert.equal(
    publishableWithoutReview({ needsHumanReview: true, recruitingCycle: YEAR }),
    false,
  );
});

// ------------------------------------------------------- French internships

const FRENCH_INTERNSHIPS = [
  "Stage Global Advisory / Debt Advisory and Restructuring – Janvier/mars 2027",
  "Stage d'Analyste en Private Equity - Fonds Impact Environnemental - Janvier 2027",
  "Stage – Transaction R & Co - Global Advisory – Janvier/Mars 2027",
  "Stage Infrastructure Debt Advisory - Global Advisory – Janvier 2027",
  "Stage - Private Equity Investment Analyst - FAPI - Janvier / Mars 2027",
  "Alternance - M&A Small & Mid Cap - Transaction R & Co",
];

for (const title of FRENCH_INTERNSHIPS) {
  test(`a French internship is relevant: "${title.slice(0, 44)}..."`, () => {
    const c = classifyListing(listing({ title }), "investment_banking");
    assert.equal(c.relevant, true, `expected relevant, evidence: ${c.matchedEvidence.join("; ")}`);
  });
}

test("stagiaire is recognised wherever it appears", () => {
  const c = classifyListing(listing({ title: "Analyste stagiaire - Fusions & Acquisitions" }), "investment_banking");
  assert.equal(c.relevant, true);
});

// ------------------------------------- the English word that is not French
//
// "Stage" anchored, because venture capital titles are full of it.

const NOT_FRENCH = [
  "Early Stage Investment Analyst",
  "Growth Stage Portfolio Associate",
  "Late Stage Venture Investor",
];

for (const title of NOT_FRENCH) {
  test(`a company-maturity adjective is not an internship: "${title}"`, () => {
    const c = classifyListing(
      listing({
        title,
        descriptionRaw: "A full-time role on the investment team. Several years of experience required.",
      }),
      "venture_capital",
    );
    assert.equal(c.relevant, false, `evidence: ${c.matchedEvidence.join("; ")}`);
  });
}

// -------------------------------------------- recognised is not published
//
// The off-profession rules already speak some French, so making these
// relevant surfaces them to the right rule rather than publishing them.

test("a French legal internship is recognised, then excluded as legal", () => {
  const c = classifyListing(
    listing({ title: "Stage H/F – Juriste Corporate - Juillet 2027" }),
    "investment_banking",
  );
  assert.equal(
    publishableWithoutReview(c),
    false,
    "a legal role must never publish as a finance internship",
  );
});

// ------------------------------------- French vocabulary, both lists at once
//
// Recognising "Stage" as an internship is what made Rothschild's Paris and
// Luxembourg board visible - and the first live run auto-approved "Stage
// Comptabilité et Reporting Luxembourg" as an INVESTMENT BANKING internship.
// The English side of the off-profession rule was working: two dozen
// "Internal Audit Summer Analyst" rows are correctly rejected. It had no word
// for the same job in French.
//
// So these two lists move together. A relevance list that can see a posting
// the exclusion list cannot classify produces a confident wrong answer, which
// is worse than the silent miss it replaced.

const FRENCH_OFF_PROFESSION = [
  ["Stage Comptabilité et Reporting Luxembourg – Janvier 2027 (Internship – 6 months)", "accounting"],
  ["Stage H/F - Assistant Juridique en Asset Management – Juillet 2027", "legal"],
  ["Stage H/F – Juriste Corporate - Juillet 2027", "legal"],
  ["Stage Fiscalité Internationale – Janvier 2027", "tax"],
];

for (const [title, kind] of FRENCH_OFF_PROFESSION) {
  test(`a French ${kind} internship never publishes as finance: "${title.slice(0, 40)}..."`, () => {
    const c = classifyListing(listing({ title }), "investment_banking");
    assert.equal(
      publishableWithoutReview(c),
      false,
      `would have published as ${c.sector}; evidence: ${c.matchedEvidence.join("; ")}`,
    );
  });
}

test("a bank's own Internal Audit division is publishable - REVERSED 11 Oct 2026", () => {
  /**
   * THIS TEST ASSERTED THE OPPOSITE UNTIL 11 OCTOBER 2026, DELIBERATELY.
   *
   * It read `publishableWithoutReview(c) === false` for this exact Morgan
   * Stanley title, and classify.ts's own comment called the English
   * behaviour correct: "two dozen 'Internal Audit Summer Analyst' rows are
   * correctly rejected."
   *
   * WHAT CHANGED IT: firm-level evidence, which the original decision did not
   * have. Every firm in the corpus posting an internal-audit role is a bank,
   * and all are registered under investment_banking - MUFG (13), Citigroup
   * (13), Morgan Stanley (10), Nomura (10), Mizuho (4), Greenhill (4),
   * Raymond James (3), Barclays (2), Jefferies (2). Not one is an accounting
   * practice. The rule they were failing is scoped, by its own reason string,
   * to "accounting practice role (tax/assurance/audit/comptabilité), not
   * finance" - and a bank's Internal Audit division is a finance function
   * that recruits undergraduates into the same summer-analyst programmes as
   * its markets and banking divisions. 83 listings were excluded by it.
   *
   * TO REVERSE AGAIN: delete the BANK_INTERNAL_AUDIT exemption in
   * `offProfessionReason` (classify.ts) and restore this assertion to
   * `false`. The two tests in classify.test.ts covering the narrowing would
   * also need to go.
   *
   * The accounting rule itself is untouched: "Audit Intern", "Assurance
   * Intern" and "Tax Intern" are still rejected, which the next test and
   * classify.test.ts both hold.
   */
  const c = classifyListing(
    listing({ title: "2027 Internal Audit - Business Audit Summer Analyst Program (New York)" }),
    "investment_banking",
  );
  assert.equal(c.relevant, true, "a bank internal-audit summer analyst programme is in scope");
  assert.equal(publishableWithoutReview(c), true);
});

test("the accounting-practice rule still rejects an accounting practice", () => {
  // The other half of the reversal above: narrowing it must not weaken it.
  for (const title of ["Audit Intern - Summer 2027", "Assurance Intern - Summer 2027 (Richmond)"]) {
    const c = classifyListing(listing({ title }), "investment_banking");
    assert.equal(c.relevant, false, `let an accounting-practice role through: ${title}`);
  }
});

test("a real French finance internship is still publishable", () => {
  // The exclusions must not swallow the postings the vocabulary was added for.
  const c = classifyListing(
    listing({ title: `Stage - Analyste en Private Equity - Janvier ${YEAR}` }),
    "private_equity",
  );
  assert.equal(c.relevant, true);
});

test('"fiscal year" is not a French tax role', () => {
  const c = classifyListing(
    listing({ title: `Fiscal Year Planning Summer Analyst ${YEAR}` }),
    "investment_banking",
  );
  assert.equal(c.relevant, true, `evidence: ${c.matchedEvidence.join("; ")}`);
});

// ------------------------------------------------ skilled trades, not finance
//
// A private equity firm's portfolio company posts on the firm's own board, so
// its vacancies arrive under the firm's sector. Guild Garage Group fits garage
// doors, and seven of its technician apprenticeships sat in the review queue
// filed as private equity and insurance internships.

const TRADES = [
  "Garage Door Technician Apprentice",
  "Garage Door - Install Technician / Apprentice",
  "Garage Door Master Technician Apprentice",
  "Garage Door Technician/Apprentice - Paid Training",
  "Garage Door Sales/Technician Apprentice",
  "HVAC Service Technician Intern",
  "Field Technician Apprentice",
];

for (const title of TRADES) {
  test(`a trades role is excluded as trades: "${title.slice(0, 40)}"`, () => {
    const c = classifyListing(listing({ title }), "private_equity");
    // Asserting the REASON, not just that it fails to publish: most of these
    // state no cycle either, so "not publishable" would pass without the rule
    // existing at all and prove nothing.
    assert.ok(
      c.matchedEvidence.some((e) => e.includes("skilled trades")),
      `expected a trades exclusion, got: ${c.matchedEvidence.join("; ")}`,
    );
    assert.equal(publishableWithoutReview(c), false);
  });
}

// The guard, and the reason this rule keys on the trade and not the word
// "apprentice": UK and European banks recruit school leavers into real
// finance programmes with exactly that name.
const REAL_APPRENTICESHIPS = [
  "Investment Banking Apprenticeship Programme - London",
  "Apprentice Analyst, Global Markets",
  "Finance Apprenticeship 2027",
];

for (const title of REAL_APPRENTICESHIPS) {
  test(`a finance apprenticeship survives the trades rule: "${title.slice(0, 40)}"`, () => {
    const c = classifyListing(listing({ title }), "investment_banking");
    assert.ok(
      !c.matchedEvidence.some((e) => e.includes("skilled trades")),
      `wrongly excluded: ${c.matchedEvidence.join("; ")}`,
    );
  });
}
