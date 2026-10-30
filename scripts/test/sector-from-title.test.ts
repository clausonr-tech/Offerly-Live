// Which industry a posting belongs to, across all fourteen.
//
// sectorForText returns the first category in SECTOR_KEYWORDS order whose
// keyword appears anywhere in the text, and investment_banking is first. Run
// over title + division + DESCRIPTION that makes any posting whose body says
// "M&A" a banking posting - and a bank's boilerplate says it on every posting
// it publishes, whatever the job is.
//
// Measured on Supabase, 20 September 2026: 31 of 764 relevant listings were
// filed under a sector their own title contradicts, most already published.
// "2028 Equities: Sales & Trading Summer Intern Program" was live under
// investment banking, so a student filtering for sales and trading saw
// nothing - which reads as no coverage and is really a labelling fault.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

// A real bank's boilerplate: it names M&A and strategic advisory on every
// posting, which is exactly what used to capture the sector.
const BANK_BOILERPLATE =
  "Since 1935 we have been a global leader in financial services. In the Investment " +
  "Banking division we offer expertise in M&A and strategic advisory and capital-raising " +
  "services for corporations, institutions and governments. Candidates should be pursuing " +
  "a bachelor's degree with strong academic credentials. Applications are reviewed on a rolling basis.";

const listing = (title: string): NormalizedListing => ({
  externalJobId: "req-1",
  title,
  division: null,
  location: "London",
  descriptionRaw: BANK_BOILERPLATE,
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  deadlineAt: null,
});

// Every one of these is a real title from the corpus, and every one was
// stored as investment_banking.
const TITLE_WINS: [string, string][] = [
  ["2028 Equities: Sales & Trading Summer Intern Program – New York", "sales_trading"],
  ["2027 Private Credit Investment Summer Internship Programme - London", "private_credit"],
  ["International Corporate Banking Off Cycle Internship Programme 2027", "commercial_banking"],
  ["2027 Five Arrows Private Equity Long Term Internship - London", "private_equity"],
  ["2027 UK Wealth Management Summer Analyst Programme", "asset_wealth_management"],
];

for (const [title, expected] of TITLE_WINS) {
  test(`"${title.slice(0, 48)}..." is ${expected}`, () => {
    const c = classifyListing(listing(title), "investment_banking");
    assert.equal(c.sector, expected);
  });
}

// Sell-side equity research names no sector of its own, so it falls through
// to the source's registered sector. "equity research" used to be an
// asset_wealth_management keyword, which made seven live bank postings wealth
// management - Morgan Stanley Singapore, Hong Kong, London, Evercore. Removed
// rather than moved to banking, because a hedge fund's equity research intern
// is not a banking role either, and the source registry answers both.

test("sell-side equity research follows the bank that posted it", () => {
  const c = classifyListing(listing("2027 Equity Research Summer Analyst Program - Singapore"), "investment_banking");
  assert.equal(c.sector, "investment_banking");
});

test("buy-side equity research follows the fund that posted it", () => {
  const c = classifyListing(
    {
      ...listing("2027 Equity Research Summer Analyst"),
      descriptionRaw:
        "A ten week placement on the research team. Candidates should be pursuing a bachelor's " +
        "degree with strong academic credentials. Applications are reviewed on a rolling basis.",
    },
    "hedge_fund",
  );
  assert.equal(c.sector, "hedge_fund");
});

test("wealth management in the title is still wealth management", () => {
  const c = classifyListing(listing("2027 Evercore Wealth Management Summer Analyst Program"), "investment_banking");
  assert.equal(c.sector, "asset_wealth_management");
});

test("a banking title in banking boilerplate is still banking", () => {
  const c = classifyListing(
    listing("2027 - Investment Banking - Coverage & Advisory - Summer Internship - London"),
    "investment_banking",
  );
  assert.equal(c.sector, "investment_banking");
});

test("the evidence says where the sector came from", () => {
  const c = classifyListing(listing("2028 Equities: Sales & Trading Summer Intern Program"), "investment_banking");
  assert.ok(
    c.matchedEvidence.some((e) => e.includes("from the title")),
    `evidence: ${c.matchedEvidence.join("; ")}`,
  );
});

test("a title naming no sector still falls back to the description", () => {
  // 458 of the 764 relevant listings name no sector in the title at all, so
  // the body has to keep working - this is a tie-break, not a replacement.
  const c = classifyListing(listing("2027 Summer Internship Programme - London"), null);
  assert.equal(c.sector, "investment_banking");
  assert.ok(c.matchedEvidence.some((e) => e.includes("from the description")));
});

test("no sector anywhere falls back to the source registry", () => {
  const c = classifyListing(
    {
      ...listing("2027 Summer Internship Programme"),
      descriptionRaw:
        "A ten week placement with our team. Candidates should be pursuing a bachelor's degree " +
        "with strong academic credentials. Applications are reviewed on a rolling basis.",
    },
    "real_estate",
  );
  assert.equal(c.sector, "real_estate");
});
