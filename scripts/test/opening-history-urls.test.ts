// Reading release dates out of archived job URLs.
//
// The content search reads archived PAGES, which is why it is blind to half
// the directory: a Workday, Oracle or Eightfold board is a JavaScript
// application, so the Archive holds an empty shell and there is nothing in the
// capture to read.
//
// The URL index has no such problem, and this is where that pays. The fixtures
// below are real URL shapes from this corpus - including the two that produced
// observed-openings.ts's only Workday dates, on boards the content method
// cannot read at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readJobUrl,
  observationsFromJobUrls,
  deriveWindow,
  type Snapshot,
} from "../../src/lib/monitoring/opening-history";

const at = (ts: string, url: string): Snapshot => ({ timestamp: ts, original: url, digest: ts });

// ------------------------------------------------------- real URL shapes

const internshipUrls: [string, string][] = [
  ["Baird", "https://www.bairdcareers.com/jobs/r20261002/internship-marketing-year-round/"],
  [
    "Raymond James on Workday",
    "https://raymondjames.wd1.myworkdayjobs.com/en-US/RJ/job/XMLNAME-2026-Summer-Internship-Program-Finance_R-123",
  ],
  ["Greenhouse", "https://job-boards.greenhouse.io/acme/jobs/4567890-2027-summer-analyst"],
  ["Jobvite", "https://jobs.jobvite.com/acme/job/oetmzfwm/2027-sreit-operations-summer-analyst"],
  ["iCIMS", "https://careers-acme.icims.com/jobs/1234/summer-analyst-internship/job"],
  ["Lever", "https://jobs.lever.co/acme/uuid/2027-investment-banking-summer-analyst"],
  ["TalentLink", "https://acme.tal.net/vacancy/2027-summer-analyst-programme-london/1234"],
];
for (const [vendor, url] of internshipUrls) {
  test(`an internship URL is read: ${vendor}`, () => {
    const reading = readJobUrl(url);
    assert.ok(reading, url);
    assert.equal(reading.isInternship, true);
  });
}

test("a Workday URL is legible even though its page is not", () => {
  // The whole argument for this method. observed-openings.ts got its Raymond
  // James date from exactly this slug, on a board the content search reads as
  // an empty shell.
  const reading = readJobUrl(
    "https://raymondjames.wd1.myworkdayjobs.com/en-US/RJ/job/XMLNAME-2026-Summer-Internship-Program-Finance_R-123",
  );
  assert.ok(reading);
  assert.equal(reading.cycleYearInSlug, 2026);
});

// --------------------------------------------------------- what is ignored

const notInternships = [
  "https://job-boards.greenhouse.io/acme/jobs/999-vice-president-compliance",
  "https://www.bairdcareers.com/the-baird-difference/our-culture/",
  "https://www.bairdcareers.com/jobs/",
  "https://acme.com/assets/logo.png",
  "https://acme.com/styles/main.css",
  "https://careers-acme.icims.com/jobs/search?ss=1&mode=job",
  "https://acme.com/",
];
for (const url of notInternships) {
  test(`not an internship URL: ${url.slice(8, 58)}`, () => {
    assert.equal(readJobUrl(url), null, url);
  });
}

test("an opaque requisition id yields nothing, and should", () => {
  // A board whose URLs are pure ids gives us no role to read. Returning
  // something here would be inventing it.
  assert.equal(readJobUrl("https://acme.wd1.myworkdayjobs.com/en-US/careers/job/R-123456"), null);
  assert.equal(readJobUrl("https://jobs.lever.co/acme/0e6a1c8f-1111-2222-3333-444455556666"), null);
});

test("a very long path is refused rather than mined for a match", () => {
  // A search query string listing every filter a board offers will contain
  // "intern" somewhere, and is not a posting.
  const long = `https://acme.com/search?${"facet=x&".repeat(60)}intern=1`;
  assert.equal(readJobUrl(long), null);
});

test("malformed input never throws", () => {
  for (const url of ["", "not a url", "https://", "javascript:alert(1)", "://x"]) {
    assert.doesNotThrow(() => readJobUrl(url));
    assert.equal(readJobUrl(url), null, url);
  }
});

// ------------------------------------------------------------- industries

const byIndustry: [string, string][] = [
  ["investment_banking", "https://x.com/jobs/1/2027-investment-banking-summer-analyst"],
  ["real_estate", "https://x.com/jobs/2/2027-real-estate-summer-analyst"],
  ["sales_trading", "https://x.com/jobs/3/2027-sales-and-trading-summer-analyst"],
  ["private_equity", "https://x.com/jobs/4/2027-private-equity-summer-analyst"],
  // Wealth management rather than equity research: the latter names no sector
  // of its own any more, because sell-side research belongs to the bank and
  // buy-side research to the fund.
  ["asset_wealth_management", "https://x.com/jobs/5/2027-wealth-management-summer-analyst"],
];
for (const [industry, url] of byIndustry) {
  test(`the slug names its industry: ${industry}`, () => {
    assert.equal(readJobUrl(url)?.industry, industry);
  });
}

test("a slug naming no industry leaves it null rather than guessing", () => {
  assert.equal(readJobUrl("https://x.com/jobs/9/2027-summer-analyst")?.industry, null);
});

// ------------------------------------------------------- the year in a slug

test("a cycle year in the slug is read", () => {
  assert.equal(readJobUrl("https://x.com/jobs/1/2027-summer-analyst")?.cycleYearInSlug, 2027);
});

test("a year embedded in a requisition id is not mined out of it", () => {
  // Baird's id is `r20261002`. The digits are there; they are not a year.
  const reading = readJobUrl("https://www.bairdcareers.com/jobs/r20261002/internship-marketing/");
  assert.ok(reading);
  assert.equal(reading.cycleYearInSlug, null);
});

test("an implausible year is not a cycle", () => {
  assert.equal(readJobUrl("https://x.com/jobs/1/1999-summer-analyst")?.cycleYearInSlug, null);
});

// --------------------------------------------------- observations per year

test("the earliest internship URL in each year becomes that year's observation", () => {
  const observations = observationsFromJobUrls([
    at("20250915120000", "https://x.com/jobs/1/2026-summer-analyst"),
    at("20250901120000", "https://x.com/jobs/2/2026-summer-associate"),
    at("20251120120000", "https://x.com/jobs/3/2026-summer-analyst-london"),
    at("20240905120000", "https://x.com/jobs/4/2025-summer-analyst"),
  ]);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].year, 2024);
  assert.equal(observations[1].firstSeen.toISOString().slice(0, 10), "2025-09-01");
});

test("observations come back in year order", () => {
  const observations = observationsFromJobUrls([
    at("20260101120000", "https://x.com/jobs/1/2027-summer-analyst"),
    at("20240101120000", "https://x.com/jobs/2/2025-summer-analyst"),
    at("20250101120000", "https://x.com/jobs/3/2026-summer-analyst"),
  ]);
  assert.deepEqual(observations.map((o) => o.year), [2024, 2025, 2026]);
});

test("non-internship URLs contribute nothing", () => {
  const observations = observationsFromJobUrls([
    at("20250101120000", "https://x.com/assets/logo.png"),
    at("20250201120000", "https://x.com/about/our-culture/"),
    at("20250901120000", "https://x.com/jobs/1/2026-summer-analyst"),
  ]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].firstSeen.toISOString().slice(0, 10), "2025-09-01");
});

test("a malformed timestamp drops its row rather than dating it wrongly", () => {
  const observations = observationsFromJobUrls([
    at("20251301120000", "https://x.com/jobs/1/2026-summer-analyst"),
    at("20250901120000", "https://x.com/jobs/2/2026-summer-analyst"),
  ]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].firstSeen.toISOString().slice(0, 10), "2025-09-01");
});

test("each observation carries an openable archive URL", () => {
  const [observation] = observationsFromJobUrls([
    at("20250901120000", "https://x.com/jobs/1/2026-summer-analyst"),
  ]);
  assert.match(observation.snapshotUrl, /^https:\/\/web\.archive\.org\/web\/20250901120000\//);
  assert.match(observation.snapshotUrl, /2026-summer-analyst/);
});

test("an empty index yields no observations", () => {
  assert.deepEqual(observationsFromJobUrls([]), []);
});

// -------------------------------------------------------- per industry

test("an industry filter keeps only that industry's URLs", () => {
  const rows = [
    at("20250801120000", "https://x.com/jobs/1/2026-investment-banking-summer-analyst"),
    at("20251101120000", "https://x.com/jobs/2/2026-real-estate-summer-analyst"),
  ];
  const banking = observationsFromJobUrls(rows, "investment_banking");
  const realEstate = observationsFromJobUrls(rows, "real_estate");

  assert.equal(banking.length, 1);
  assert.equal(realEstate.length, 1);
  assert.equal(banking[0].firstSeen.toISOString().slice(0, 10), "2025-08-01");
  assert.equal(realEstate[0].firstSeen.toISOString().slice(0, 10), "2025-11-01");
});

test("a URL naming no industry is excluded from every industry", () => {
  // Counting it everywhere would hand each industry the same date and make
  // the per-industry split meaningless.
  const rows = [at("20250701120000", "https://x.com/jobs/1/2026-summer-analyst")];
  assert.equal(observationsFromJobUrls(rows, "investment_banking").length, 0);
  assert.equal(observationsFromJobUrls(rows).length, 1, "but it still counts firm-wide");
});

// --------------------------------------------------- feeding deriveWindow

test("two years of URL evidence become a window", () => {
  const observations = observationsFromJobUrls([
    at("20240910120000", "https://x.com/jobs/1/2026-summer-analyst"),
    at("20250905120000", "https://x.com/jobs/2/2027-summer-analyst"),
  ]);
  const window = deriveWindow(observations, new Date("2026-06-01T00:00:00Z"));
  assert.ok(window, "two consistent Septembers should yield a window");
  assert.equal(window.observations.length, 2);
});

test("one year of URL evidence is still an anecdote", () => {
  const observations = observationsFromJobUrls([
    at("20250905120000", "https://x.com/jobs/1/2027-summer-analyst"),
  ]);
  assert.equal(deriveWindow(observations, new Date("2026-06-01T00:00:00Z")), null);
});

test("URL evidence obeys the same span refusal as page evidence", () => {
  // January one year and November the next is a shrug with dates on it.
  const observations = observationsFromJobUrls([
    at("20240115120000", "https://x.com/jobs/1/2026-summer-analyst"),
    at("20251101120000", "https://x.com/jobs/2/2027-summer-analyst"),
  ]);
  assert.equal(deriveWindow(observations, new Date("2026-06-01T00:00:00Z")), null);
});

test("a window from URL evidence quotes archive URLs a reviewer can open", () => {
  const observations = observationsFromJobUrls([
    at("20240910120000", "https://x.com/jobs/1/2026-summer-analyst"),
    at("20250905120000", "https://x.com/jobs/2/2027-summer-analyst"),
  ]);
  const window = deriveWindow(observations, new Date("2026-06-01T00:00:00Z"));
  assert.match(window!.evidence, /web\.archive\.org/);
});

// ------------------------------- archived SEARCH urls are not job postings
//
// The single worst false positive this method had, caught only by reading the
// evidence behind a result that looked fine. The Archive captures search-
// result pages like any other page, and their query strings carry whatever
// somebody typed into the box. Reading the query as role text gave JPMorgan a
// confident opening window of 13 January to 8 February, derived entirely from
// two strangers' searches - and that window would have driven the crawler.
//
// These are the exact URLs, verbatim from the run that produced it.

const archivedSearches = [
  "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions/preview/210141614/?keyword=%2522summer+analyst%2522&location=Hong+Kong&locationId=300000000289330&locationLevel=country&mode=location",
  "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions/preview/210175336/?keyword=intern&location=India&locationId=300000000289360&locationLevel=country",
  "https://careers-acme.icims.com/jobs/search?ss=1&searchKeyword=summer%20analyst",
  "https://boards.greenhouse.io/acme?q=internship",
  "https://acme.com/careers/results/?search=summer+associate&page=2",
];
for (const url of archivedSearches) {
  test(`an archived search URL is not a posting: ${url.slice(8, 52)}`, () => {
    assert.equal(readJobUrl(url), null, url);
  });
}

test("a real posting keeps its reading despite tracking parameters", () => {
  // The fix must not throw away genuine postings that carry a campaign tag -
  // the role is in the path, and that is all this reads.
  const reading = readJobUrl(
    "https://www.bairdcareers.com/jobs/r20261002/internship-marketing-year-round/?src=linkedin&utm_campaign=x",
  );
  assert.ok(reading);
  assert.match(reading.text, /internship marketing year round/);
});

test("a search URL cannot produce an observation", () => {
  // End to end: two archived searches a year apart must not become a window.
  const observations = observationsFromJobUrls([
    at("20220120101254", archivedSearches[0]),
    at("20230201201525", archivedSearches[1]),
  ]);
  assert.deepEqual(observations, []);
  assert.equal(deriveWindow(observations, new Date("2026-06-01T00:00:00Z")), null);
});

test("the query string is never read, even when the path is a real posting", () => {
  // A posting page reached through a search still has the search in its URL.
  // What it is called comes from the path either way.
  const withQuery = readJobUrl("https://x.com/jobs/1/2027-real-estate-summer-analyst?keyword=intern");
  const without = readJobUrl("https://x.com/jobs/1/2027-real-estate-summer-analyst");
  assert.deepEqual(withQuery, without);
});

test("a path that names nothing is not rescued by a promising query", () => {
  assert.equal(readJobUrl("https://x.com/careers/browse/12345?q=summer+analyst+internship"), null);
});
