// What the crawler collects, what it stores, and what it must refuse to store
// - in every sector.
//
// Storage is where a mistake becomes permanent. A wrong identity silently
// duplicates a posting or silently loses one; a row stored with nothing in it
// becomes an unanswerable question in a human queue; a review status decided
// by the wrong rule publishes something nobody read. All three have happened
// here, and all three were invisible afterwards because the database looked
// perfectly healthy.
//
// Every rule below reads a listing and knows nothing about the industry it
// came from, and this file is the standing proof. The sectors with the fewest
// sources are the ones a silent storage fault empties out first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupKey, normalizedUrlKey, listingDedupKey } from "../../src/lib/monitoring/board-identity";
import { isThinDescription, shouldRetryEnrichment, isUnreviewable } from "../../src/lib/monitoring/listing-lifecycle";
import { assessPostingQuality, isStaleCycle, liveCycleRange } from "../../src/lib/monitoring/posting-quality";
import { readEligibility } from "../../src/lib/monitoring/eligibility";
import { classifyListing, publishableWithoutReview } from "../../src/lib/monitoring/classify";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";
import type { FirmProgramCategory } from "../../src/lib/firm-metadata";

const { min: LIVE_MIN } = liveCycleRange();

const SECTORS: FirmProgramCategory[] = [
  "investment_banking", "private_equity", "venture_capital", "private_credit",
  "real_estate", "hedge_fund", "sales_trading", "asset_wealth_management",
  "commercial_banking", "insurance", "fintech", "market_infrastructure",
  "consulting", "other_finance",
];

const REAL_BODY =
  "Join the team for a ten week summer placement working alongside experienced " +
  "professionals. Candidates should be pursuing a bachelor's degree with strong " +
  "academic credentials. Applications are reviewed on a rolling basis.";

const listing = (patch: Partial<NormalizedListing>): NormalizedListing => ({
  externalJobId: "req-1",
  title: "Summer Analyst Internship",
  division: null,
  location: "New York",
  descriptionRaw: REAL_BODY,
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  deadlineAt: null,
  ...patch,
});

// ------------------------------------------------------------ board identity
//
// Two firms pointing at one board is what left Stifel and Miller Buckfire both
// polling careers-stifel.icims.com, behind 353 duplicate listing rows.

const SAME_BOARD: [string, string, string][] = [
  ["https://job-boards.greenhouse.io/acme", "https://job-boards.greenhouse.io/acme/", "a trailing slash"],
  ["https://job-boards.greenhouse.io/acme", "http://job-boards.greenhouse.io/acme", "the scheme"],
  ["https://acme.recruitee.com", "https://acme.recruitee.com/", "a trailing slash"],
];

for (const [a, b, why] of SAME_BOARD) {
  test(`one board, one key - despite ${why}`, () => {
    assert.equal(normalizedUrlKey(a), normalizedUrlKey(b), `${a} vs ${b}`);
  });
}

test("a board key KEEPS its query string, deliberately", () => {
  // Unlike a listing key, which strips tracking parameters. On several boards
  // the token IS a query parameter, so dropping the query here would merge
  // two different firms' boards into one - the opposite of the duplicate this
  // function exists to prevent.
  assert.notEqual(
    normalizedUrlKey("https://jobs.lever.co/acme"),
    normalizedUrlKey("https://jobs.lever.co/acme?utm_source=x"),
  );
  // Order within the query does not matter, because that is not identity.
  assert.equal(
    normalizedUrlKey("https://b.io/jobs?b=2&a=1"),
    normalizedUrlKey("https://b.io/jobs?a=1&b=2"),
  );
});

test("a board key ignores www and case", () => {
  assert.equal(normalizedUrlKey("https://WWW.Example.com/Careers"), normalizedUrlKey("https://example.com/careers"));
});

test("different boards on one vendor keep different keys", () => {
  assert.notEqual(
    normalizedUrlKey("https://job-boards.greenhouse.io/acme"),
    normalizedUrlKey("https://job-boards.greenhouse.io/zenith"),
  );
});

test("the same path on two vendors is two boards", () => {
  assert.notEqual(
    dedupKey("https://job-boards.greenhouse.io/acme", "greenhouse"),
    dedupKey("https://jobs.lever.co/acme", "lever"),
  );
});

test("dedupKey never throws, whatever it is handed", () => {
  for (const u of ["", "not a url", "://", "mailto:x@y.com", "javascript:alert(1)"]) {
    assert.doesNotThrow(() => dedupKey(u, "generic"), u);
  }
});

// ---------------------------------------------------------- listing identity

test("a tracking parameter does not create a second listing", () => {
  // Portfolio boards append their own attribution to the very same posting.
  assert.equal(
    listingDedupKey({ listingUrl: "https://b.io/jobs/5", title: "Summer Analyst" }),
    listingDedupKey({ listingUrl: "https://b.io/jobs/5?gh_src=abc&utm_medium=x", title: "Summer Analyst" }),
  );
});

test("two different jobs are two listings", () => {
  assert.notEqual(
    listingDedupKey({ listingUrl: "https://b.io/jobs/5", title: "Summer Analyst" }),
    listingDedupKey({ listingUrl: "https://b.io/jobs/6", title: "Summer Analyst" }),
  );
});

test("the application URL wins over the listing URL when both exist", () => {
  // Two board pages can point at one application; that is one posting.
  assert.equal(
    listingDedupKey({ listingUrl: "https://board-a.io/1", applicationUrl: "https://apply.io/9", title: "X" }),
    listingDedupKey({ listingUrl: "https://board-b.io/2", applicationUrl: "https://apply.io/9", title: "X" }),
  );
});

test("listingDedupKey never throws on a malformed URL", () => {
  for (const u of ["", "not a url", "://", "   "]) {
    assert.doesNotThrow(() => listingDedupKey({ listingUrl: u, title: "X" }), JSON.stringify(u));
  }
});

// ------------------------------------------------- thin, retryable, unreviewable

for (const sector of SECTORS) {
  test(`${sector}: an empty description is thin`, () => {
    assert.equal(isThinDescription("", "Summer Analyst"), true);
  });

  test(`${sector}: a description echoing the title is thin`, () => {
    assert.equal(isThinDescription("Summer Analyst", "Summer Analyst"), true);
  });

  test(`${sector}: a real description is not thin`, () => {
    assert.equal(isThinDescription(REAL_BODY, "Summer Analyst"), false);
  });

  test(`${sector}: a thin internship is retried; a thin non-internship is not`, () => {
    // The description of a compliance officer is a request we would spend to
    // reject it either way.
    assert.equal(shouldRetryEnrichment({ title: "Summer Analyst Internship", descriptionRaw: "" }), true);
    assert.equal(shouldRetryEnrichment({ title: "Head of Strategic Initiatives", descriptionRaw: "" }), false);
  });

  test(`${sector}: open and thin stays reviewable - enrichment may still fill it`, () => {
    assert.equal(isUnreviewable({ status: "open", title: "Summer Analyst", descriptionRaw: "" }), false);
  });

  test(`${sector}: closed and never readable is unreviewable`, () => {
    assert.equal(isUnreviewable({ status: "closed", title: "Summer Analyst", descriptionRaw: "" }), true);
  });
}

// ------------------------------------------------- what must never be stored

const NOT_POSTINGS: [string, string][] = [
  ["Home > Internship Program", "a breadcrumb"],
  ["View internship programmes", "a nav link"],
  ["Show more", "a pagination control"],
  ["Sort by relevance", "a sort control"],
  ["Clear filters", "a filter control"],
  ["Internship Programme", "a bare programme heading"],
  ["Our internship opportunities are your steppingstone to a career.", "marketing prose"],
];

for (const [title, why] of NOT_POSTINGS) {
  test(`not stored as a posting: "${title}" (${why})`, () => {
    const v = assessPostingQuality(listing({ title }));
    assert.ok(v.reasons.length > 0, `accepted: ${title}`);
  });
}

test("a mailto link is never a posting, in any sector", () => {
  const v = assessPostingQuality(listing({ title: "Contact us about internships", listingUrl: "mailto:a@b.com" }));
  assert.ok(v.reasons.some((r) => r.includes("email address")), v.reasons.join("; "));
});

// ------------------------------------------ the three review states, per sector
//
// `rejected` was the state that was missing, and its absence auto-approved 221
// full-time roles on the strength of a flag meaning the opposite.

const SECTOR_ROLE: Record<string, string> = {
  investment_banking: "Investment Banking Summer Analyst",
  private_equity: "Private Equity Summer Analyst",
  venture_capital: "Venture Capital Summer Associate",
  private_credit: "Private Credit Summer Analyst",
  real_estate: "Real Estate Acquisitions Summer Analyst",
  hedge_fund: "Quantitative Research Summer Analyst",
  sales_trading: "Sales and Trading Summer Analyst",
  asset_wealth_management: "Wealth Management Summer Analyst",
  commercial_banking: "Commercial Banking Summer Analyst",
  insurance: "Actuarial Summer Intern",
  fintech: "Fintech Product Summer Analyst",
  market_infrastructure: "Clearing House Operations Summer Analyst",
  consulting: "Consulting Summer Associate",
  other_finance: "Summer Analyst Internship",
};

for (const sector of SECTORS) {
  const role = SECTOR_ROLE[sector];

  test(`${sector}: a dated internship is publishable`, () => {
    const c = classifyListing(listing({ title: `${LIVE_MIN} ${role}` }), sector);
    assert.equal(c.relevant, true);
    assert.equal(publishableWithoutReview(c), true);
  });

  test(`${sector}: an undated internship is relevant but not publishable`, () => {
    const c = classifyListing(listing({ title: role }), sector);
    assert.equal(c.relevant, true, c.matchedEvidence.join("; "));
    assert.equal(publishableWithoutReview(c), false, "needs a programme year");
  });

  test(`${sector}: a full-time role is not relevant`, () => {
    const c = classifyListing(listing({ title: "Head of Strategic Initiatives" }), sector);
    assert.equal(c.relevant, false);
  });
}

// ---------------------------------------------------------- stale cycles

test("a dead cycle is stale and a live one is not, in every sector", () => {
  const { min, max } = liveCycleRange();
  assert.equal(isStaleCycle(min - 1), true);
  assert.equal(isStaleCycle(max + 1), true);
  for (let y = min; y <= max; y++) assert.equal(isStaleCycle(y), false, String(y));
  assert.equal(isStaleCycle(null), false, "unknown is a different problem");
});

// ----------------------------------------------------------- eligibility

test("an unstated eligibility is empty, never invented", () => {
  const e = readEligibility(REAL_BODY, LIVE_MIN);
  assert.deepEqual(e.gradYears, []);
  assert.notEqual(e.basis, "stated");
});

for (const year of [2027, 2028, 2029, 2030]) {
  test(`a stated class of ${year} is read as that class`, () => {
    const e = readEligibility(`Open to the class of ${year}. ${REAL_BODY}`, LIVE_MIN);
    assert.ok(e.gradYears.includes(year), JSON.stringify(e.gradYears));
  });
}
