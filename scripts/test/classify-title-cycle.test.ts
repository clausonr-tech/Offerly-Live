// A year the firm wrote in its own job title, across every sector.
//
// The cycle extractor looks for a year within 40 characters of a recruiting
// word. That window has already been widened once - 20 to 40, because
// Evercore's "2027 Strategic Advisory: Summer Associate Program" missed by a
// single character - and it was still too tight for how banks route their
// titles. Measured against Supabase on 20 September 2026, eight live postings
// OPEN with the year and then put 43 to 46 characters of desk, product and
// city in front of the cycle word. Four were already auto-approved and could
// never publish, because promotion needs a programme year.
//
// A title is not prose, which is the whole argument: it is short, curated,
// and written to identify one posting, so a year and a cycle word inside one
// title belong together at any distance. A description still uses the window,
// where distance is the only thing keeping a copyright line out.
//
// Years are taken from liveCycleRange() so this file does not start failing
// when the calendar moves past a hardcoded 2027.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";
import { liveCycleRange } from "../../src/lib/monitoring/posting-quality";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

const { min: LIVE_MIN } = liveCycleRange();
const YEAR = LIVE_MIN;

const listing = (patch: Partial<NormalizedListing>): NormalizedListing => ({
  externalJobId: "req-1",
  title: "Investment Banking Summer Analyst",
  division: null,
  location: "London",
  descriptionRaw:
    "A ten week placement working alongside the team. Candidates should be pursuing " +
    "a bachelor's degree with strong academic credentials. Applications are reviewed " +
    "on a rolling basis and early submission is encouraged.",
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  deadlineAt: null,
  ...patch,
});

// ------------------------------------- the real titles that were being lost
//
// Each is a live posting, reproduced with its real spacing - the doubled
// spaces and en-dashes are how the boards actually emit them, and both are
// exactly what a distance-based rule trips over.

const REAL_TITLES = [
  `${YEAR} - Global Markets - Rates Sales  - 6 Month Off Cycle Internship – Paris`,
  `${YEAR} - Global Markets - Structured Solution Sales  -  Off Cycle Internship – Paris`,
  `${YEAR} - Investment Banking - Coverage & Advisory  - Summer Internship - London`,
  `${YEAR} Financial Resources & Strategy Industrial Placement Internship (London)`,
  `${YEAR} Investment Banking and Global Capital Markets Strats Summer Associate Program (New York)`,
];

for (const title of REAL_TITLES) {
  test(`the stated year is read from "${title.slice(0, 46)}..."`, () => {
    const c = classifyListing(listing({ title }), "investment_banking");
    assert.equal(c.recruitingCycle, YEAR);
  });
}

test("the distance the window could not cross is genuinely over 40 characters", () => {
  // Guards the premise rather than the code: if these titles were actually
  // within the window, these tests would pass without the new rule and prove
  // nothing.
  const title = REAL_TITLES[0];
  const gap = title.toLowerCase().indexOf("off cycle") - String(YEAR).length;
  assert.ok(gap > 40, `expected a gap over 40, got ${gap}`);
});

// ------------------------------------------------ sectors other than banking
//
// The standing rule is that a fix naming only IB firms is not finished. A
// title-stated year is vocabulary-free, so it has to work wherever the year
// is written - and these are the house styles of the sectors that the cycle
// requirement was punishing in the first place.

const OTHER_SECTORS: [string, string, string][] = [
  ["private_equity", `${YEAR} - Private Equity - Value Creation Team  - Summer Internship`, "private equity"],
  ["hedge_fund", `${YEAR} - Systematic Trading - Quantitative Research  - Summer Analyst`, "hedge fund"],
  ["real_estate", `${YEAR} - Real Estate - Acquisitions & Asset Management  - Summer Intern`, "real estate"],
  ["venture_capital", `${YEAR} - Venture Capital - Platform & Portfolio Support  - Summer Analyst`, "venture capital"],
  ["consulting", `${YEAR} - Management Consulting - People & Strategy  - Summer Associate`, "consulting"],
  ["asset_wealth_management", `${YEAR} - Wealth Management - Client Advisory Group  - Summer Analyst`, "wealth management"],
];

for (const [sector, title] of OTHER_SECTORS) {
  test(`${sector} reads its own title-stated year`, () => {
    const c = classifyListing(listing({ title }), sector as never);
    assert.equal(c.recruitingCycle, YEAR);
  });
}

// ------------------------------------------------------- what must stay null
//
// A year in a title is not a recruiting cycle on its own. All three of these
// are live titles carrying a year and no programme.

const NOT_CYCLES = [
  `APAC | Japan | ${YEAR} Boston Career Forum Recruitment Event: Global Capital Markets`,
  `${YEAR} Women Who Lead: Quantitative Finance (EMEA)`,
  `${YEAR} Cohort: CEO in Residence`,
];

for (const title of NOT_CYCLES) {
  test(`a year with no cycle word stays null: "${title.slice(0, 40)}..."`, () => {
    const c = classifyListing(
      listing({ title, descriptionRaw: "An event for students interested in the industry." }),
      "investment_banking",
    );
    assert.equal(c.recruitingCycle, null);
  });
}

test("a title with no year at all is unaffected", () => {
  const c = classifyListing(
    listing({
      title: "Quantitative Researcher Intern",
      descriptionRaw: "A twelve week placement on the research team. Rolling applications.",
    }),
    "hedge_fund",
  );
  assert.equal(c.recruitingCycle, null);
});

test("a description's year is still read when the title has none", () => {
  // The windowed rule has to keep working - the title rule is an addition,
  // not a replacement.
  const c = classifyListing(
    listing({
      title: "Investment Banking Intern",
      descriptionRaw: `Applications for the Summer ${YEAR} programme are now open. Candidates should be pursuing a bachelor's degree.`,
    }),
    "investment_banking",
  );
  assert.equal(c.recruitingCycle, YEAR);
});

test("a title year beats a different year in the description", () => {
  // The title is the firm identifying this posting; the description is prose
  // that may mention any number of cycles.
  const c = classifyListing(
    listing({
      title: `${YEAR} - Investment Banking - Coverage & Advisory  - Summer Internship - London`,
      descriptionRaw: `Our summer ${YEAR + 1} programme details are published separately. Candidates should be pursuing a degree.`,
    }),
    "investment_banking",
  );
  assert.equal(c.recruitingCycle, YEAR);
});
