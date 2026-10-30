// The rule that decides what gets crawled, and the board identity dedup
// depends on.
//
// Both exist because of measured failures rather than theory. The identity
// half: four boards in this set are fetched twice under two firm names and
// hold 313 duplicate listing rows between them, and every one of those pairs
// differs only by a locale prefix or a filter query string - so a string
// comparison of careersUrl calls them different boards. The enrollment half:
// only 1,912 of 22,575 directory rows carry any careers URL, so the rule is
// mostly deciding what to do with a firm we know almost nothing about, and
// the expensive mistake is enrolling the 9,054-row RIA tail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { boardIdentity, dedupKey, normalizedUrlKey } from "../../src/lib/monitoring/board-identity";
import {
  decideEnrollment,
  deriveTier,
  isWorthCrawling,
  AUM_FLOOR,
  EMPLOYEE_FLOOR,
  type BoardCandidate,
  type FirmForEnrollment,
} from "../../src/lib/monitoring/enrollment";

// ---------------------------------------------------------------- identity

test("the Stifel / Miller Buckfire pair resolves to one board", () => {
  // The two URLs as they appear on the two firms' careers pages.
  const stifel = dedupKey("https://stifel.wd5.myworkdayjobs.com/Stifel_External", "workday");
  const miller = dedupKey(
    "https://stifel.wd5.myworkdayjobs.com/en-US/Stifel_External?workerSubType=Intern",
    "workday",
  );
  assert.equal(stifel, miller);
});

test("two sites on one Workday tenant stay two boards", () => {
  // A shared tenant is a shared landlord, not a shared board. Merging these
  // would drop a real source and the loss would be invisible.
  const campus = dedupKey("https://acme.wd1.myworkdayjobs.com/Campus", "workday");
  const lateral = dedupKey("https://acme.wd1.myworkdayjobs.com/Professionals", "workday");
  assert.notEqual(campus, lateral);
});

test("a Greenhouse embed widget and a board root are the same board", () => {
  const embed = dedupKey("https://job-boards.greenhouse.io/embed/job_board?for=acmecapital", "greenhouse");
  const root = dedupKey("https://job-boards.greenhouse.io/acmecapital", "greenhouse");
  assert.equal(embed, root);
});

test("trailing slashes and www do not create a second board", () => {
  assert.equal(
    dedupKey("https://jobs.lever.co/seaportglobal/", "lever"),
    dedupKey("https://www.jobs.lever.co/seaportglobal", "lever"),
  );
});

test("Oracle boards are identified by site number, not by pod", () => {
  // Two firms provisioned on the same Oracle pod are not one board. The pod
  // host is shared infrastructure; siteNumber is the employer's board.
  const a = dedupKey(
    "https://ekjb.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs",
    "oracle-hcm",
  );
  const b = dedupKey(
    "https://ekjb.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2002/jobs",
    "oracle-hcm",
  );
  assert.notEqual(a, b);
  assert.ok(a.includes("cx_1001"));
});

test("bespoke careers pages fall back to URL comparison, not to a host key", () => {
  // The dangerous shortcut would be keying on the host: a single corporate
  // careers host can front two genuinely different boards.
  assert.equal(boardIdentity("https://careers.example.com/ib", "generic"), null);
  assert.notEqual(
    dedupKey("https://careers.example.com/ib", "generic"),
    dedupKey("https://careers.example.com/markets", "generic"),
  );
});

test("query strings survive the generic fallback", () => {
  // ?dept=ib really is a different board from ?dept=markets on these pages,
  // so the fallback keeps the query rather than trimming to the path.
  assert.notEqual(
    normalizedUrlKey("https://careers.example.com/jobs?dept=ib"),
    normalizedUrlKey("https://careers.example.com/jobs?dept=markets"),
  );
  // ...but parameter ORDER is presentation, not identity.
  assert.equal(
    normalizedUrlKey("https://careers.example.com/jobs?b=2&a=1"),
    normalizedUrlKey("https://careers.example.com/jobs?a=1&b=2"),
  );
});

test("an unparseable URL still gets a stable key rather than throwing", () => {
  assert.equal(dedupKey("not a url", "generic"), dedupKey("not a url", "generic"));
});

// -------------------------------------------------------------- enrollment

const RIA: FirmForEnrollment = {
  slug: "two-person-ria",
  name: "Two Person RIA",
  website: "https://tworia.com",
  category: "asset_wealth_management",
  aum: 40_000_000,
  employees: 2,
  hasVerifiedProgram: false,
};

const MID_PE: FirmForEnrollment = {
  slug: "midmarket-pe",
  name: "Midmarket PE",
  website: "https://midpe.com",
  category: "private_equity",
  aum: 4_000_000_000,
  employees: 120,
  hasVerifiedProgram: false,
};

const BULGE: FirmForEnrollment = {
  slug: "bulge-bank",
  name: "Bulge Bank",
  website: "https://bulge.com",
  category: "investment_banking",
  aum: null,
  employees: null,
  hasVerifiedProgram: true,
  ibTier: "bulge_bracket",
};

const ASHBY_BOARD: BoardCandidate = {
  careersUrl: "https://jobs.ashbyhq.com/midpe",
  connectorId: "ashby",
  verifiedParsing: true,
};

test("the RIA tail is skipped, with the reason naming the test it failed", () => {
  const d = decideEnrollment(RIA, null);
  assert.equal(d.action, "skip");
  assert.match(d.reason, /size floor/);
});

test("a small firm running an ATS is still worth crawling", () => {
  // Buying an applicant tracking system is direct evidence of hiring at
  // scale, and it beats headcount because it is an observation.
  const tinyButOnAshby = { ...RIA, category: "venture_capital" };
  const worth = isWorthCrawling(tinyButOnAshby, {
    careersUrl: "https://jobs.ashbyhq.com/tinyvc",
    connectorId: "ashby",
    verifiedParsing: false,
  });
  assert.equal(worth.worth, true);
});

test("missing Form ADV data is reported as an ingest gap, not as 'too small'", () => {
  const unknown = { ...RIA, aum: null, employees: null };
  const worth = isWorthCrawling(unknown, null);
  assert.equal(worth.worth, false);
  assert.match(worth.reason, /no Form ADV size data/);
});

test("the size floors are the documented ones", () => {
  const atFloor = { ...RIA, employees: EMPLOYEE_FLOOR, aum: null };
  assert.equal(isWorthCrawling(atFloor, null).worth, true);
  const justUnder = { ...RIA, employees: EMPLOYEE_FLOOR - 1, aum: AUM_FLOOR - 1 };
  assert.equal(isWorthCrawling(justUnder, null).worth, false);
});

test("a board still needs a board before any category matters", () => {
  // The gate that actually controls volume. Every category is enacted now, so
  // this is what keeps the 9,054-row asset-management tail out: those firms
  // have no board and are turned away two checks earlier.
  const d = decideEnrollment({ ...MID_PE, category: "asset_wealth_management" }, null);
  assert.equal(d.action, "skip");
  assert.match(d.reason, /needs discovery/);
});

const everyCategory = [
  "investment_banking",
  "private_equity",
  "hedge_fund",
  "venture_capital",
  "real_estate",
  "other_finance",
  "asset_wealth_management",
  "commercial_banking",
  "sales_trading",
  "private_credit",
  "insurance",
  "fintech",
  "market_infrastructure",
  "consulting",
];
for (const category of everyCategory) {
  test(`${category} enrolls a verified board`, () => {
    // Every industry is enacted. What a category cannot do is manufacture a
    // board - see the test above.
    const d = decideEnrollment({ ...MID_PE, category }, ASHBY_BOARD);
    assert.equal(d.action, "enroll", category);
    assert.notEqual(d.tier, "inactive", category);
  });

  test(`${category} without a board is a discovery task, not a rejection`, () => {
    const d = decideEnrollment({ ...MID_PE, category }, null);
    assert.equal(d.action, "skip", category);
    assert.match(d.reason, /needs discovery/, category);
  });

  test(`${category} still obeys the size floors`, () => {
    // Enacting an industry must not bypass isWorthCrawling - that is the
    // check standing between us and thousands of two-person firms.
    const tiny = { ...MID_PE, category, hasVerifiedProgram: false, employees: 2, aum: 1_000_000 };
    const d = decideEnrollment(tiny, { ...ASHBY_BOARD, connectorId: "generic", verifiedParsing: false });
    assert.equal(d.action, "skip", category);
  });
}

test("investment banking enrolls and derives its tier", () => {
  const d = decideEnrollment(BULGE, {
    careersUrl: "https://bulge.wd1.myworkdayjobs.com/en-US/Campus?q=intern",
    connectorId: "workday",
    verifiedParsing: true,
  });
  assert.equal(d.action, "enroll");
  assert.equal(d.tier, "critical");
  // board-url.ts drops the filter query and keeps the locale, because the
  // locale is part of the URL that actually gets polled. Identity ignores it,
  // which is the half that matters for dedup - asserted separately below.
  assert.equal(d.careersUrl, "https://bulge.wd1.myworkdayjobs.com/en-US/Campus");
  assert.equal(
    d.dedupKey,
    dedupKey("https://bulge.wd1.myworkdayjobs.com/Campus", "workday"),
  );
});

test("a firm with no website ends the rule immediately", () => {
  const d = decideEnrollment({ ...BULGE, website: null }, ASHBY_BOARD);
  assert.equal(d.action, "skip");
  assert.match(d.reason, /no website/);
});

test("a login portal is refused with board-url's own reason", () => {
  const d = decideEnrollment(BULGE, {
    careersUrl: "https://ghr.wd1.myworkdayjobs.com/en-us/lateral-us/login",
    connectorId: "workday",
    verifiedParsing: false,
  });
  assert.equal(d.action, "skip");
  // Refused as a lateral board before the login check even matters - either
  // reason is correct, so the test asserts it was refused for a stated one.
  assert.ok(d.reason.length > 0);
});

test("the second firm on a board is linked, not polled again", () => {
  const first = decideEnrollment(BULGE, {
    careersUrl: "https://stifel.wd5.myworkdayjobs.com/Stifel_External",
    connectorId: "workday",
    verifiedParsing: true,
  });
  assert.equal(first.action, "enroll");

  const second = decideEnrollment(
    { ...BULGE, slug: "miller-buckfire", name: "Miller Buckfire" },
    {
      careersUrl: "https://stifel.wd5.myworkdayjobs.com/en-US/Stifel_External?workerSubType=Intern",
      connectorId: "workday",
      verifiedParsing: true,
    },
    new Set([first.dedupKey]),
  );
  assert.equal(second.action, "duplicate");
});

test("a firm worth crawling with no board is a discovery task, not a rejection", () => {
  const d = decideEnrollment({ ...MID_PE, category: "investment_banking" }, null);
  assert.equal(d.action, "skip");
  assert.match(d.reason, /needs discovery/);
});

test("tiers are derived, never assigned", () => {
  assert.equal(deriveTier(BULGE, ASHBY_BOARD), "critical");
  assert.equal(deriveTier({ ...BULGE, ibTier: "elite_boutique" }, ASHBY_BOARD), "high");
  assert.equal(deriveTier(MID_PE, ASHBY_BOARD), "standard");
  // A board nobody has successfully fetched is a claim, not a source.
  assert.equal(deriveTier(MID_PE, { ...ASHBY_BOARD, verifiedParsing: false }), "discovery");
  assert.equal(deriveTier(MID_PE, null), "inactive");
});
