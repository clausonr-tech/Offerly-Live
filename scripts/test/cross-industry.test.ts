// Does the crawler work for every industry, or only for investment banking?
//
// Until today it only ever POLLED investment banking - ENABLED_CATEGORIES held
// one entry and everything else was staged. So every industry-specific path
// below has been carried by the code for weeks without ever running against a
// real posting, which is exactly the shape of a thing that is quietly broken.
//
// The asymmetry to watch for is subtle. A posting with no detected sector is
// still RELEVANT, so nothing looks wrong in a log - but auto-approval requires
// `relevant && sector && recruitingCycle && verifiable`, so an industry whose
// titles do not match the keyword list has every posting sent to a human
// forever. It fails as a silent throughput problem, not as an error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing, sectorForText } from "../../src/lib/monitoring/classify";
import { assessPostingQuality, liveCycleRange } from "../../src/lib/monitoring/posting-quality";
import { decideEnrollment, deriveTier, isWorthCrawling, ENABLED_CATEGORIES } from "../../src/lib/monitoring/enrollment";
import { seasonFor } from "../../src/lib/monitoring/season";
import { CATEGORY_TIMELINE_TRACKS, type FirmProgramCategory } from "../../src/lib/firm-metadata";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

const { min: LIVE } = liveCycleRange();
const ALL = Object.keys(CATEGORY_TIMELINE_TRACKS) as FirmProgramCategory[];

const BODY =
  "Join our team for a ten week summer programme based in New York. You will work " +
  "alongside senior professionals on live transactions and analysis, build financial " +
  "models and prepare client materials. Candidates should be pursuing a bachelor's " +
  "degree with strong academic credentials and a demonstrated interest in the field.";

const listing = (title: string, patch: Partial<NormalizedListing> = {}): NormalizedListing => ({
  externalJobId: "req-1",
  title,
  division: null,
  location: "New York, NY",
  descriptionRaw: BODY,
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  ...patch,
});

function outcome(l: NormalizedListing, sector: FirmProgramCategory | null) {
  const r = classifyListing(l, sector);
  if (!r.isPosting) return "dropped";
  if (!r.relevant) return "rejected";
  return r.needsHumanReview ? "pending_review" : "auto_approved";
}

// ------------------------------------------------- every industry is enacted

for (const category of ALL) {
  test(`${category} is enacted for polling`, () => {
    assert.equal(ENABLED_CATEGORIES.has(category), true, category);
  });
}

test("the enacted set covers every industry the directory can hold", () => {
  // A category the directory can store but the crawler will not poll is a
  // silent coverage hole - the firms are enrolled and never checked.
  for (const category of ALL) assert.ok(ENABLED_CATEGORIES.has(category), category);
});

// --------------------------------------- real titles, one industry at a time

const industryTitles: [FirmProgramCategory, string][] = [
  ["investment_banking", `${LIVE} Investment Banking Summer Analyst`],
  ["investment_banking", `${LIVE} M&A Summer Associate - New York`],
  ["investment_banking", `${LIVE} Leveraged Finance Summer Analyst`],
  ["investment_banking", `Strategic Advisory Summer Analyst ${LIVE}`],
  ["private_equity", `${LIVE} Private Equity Summer Analyst`],
  ["private_equity", `${LIVE} Buyout Summer Associate`],
  ["venture_capital", `${LIVE} Venture Capital Summer Associate`],
  ["private_credit", `${LIVE} Private Credit Summer Analyst`],
  ["private_credit", `${LIVE} Direct Lending Summer Analyst`],
  ["real_estate", `${LIVE} Real Estate Acquisitions Summer Analyst`],
  ["hedge_fund", `${LIVE} Hedge Fund Summer Analyst`],
  ["hedge_fund", `${LIVE} Long/Short Equity Summer Analyst`],
  ["sales_trading", `${LIVE} Sales and Trading Summer Analyst`],
  ["sales_trading", `${LIVE} Markets Analyst Internship`],
  ["asset_wealth_management", `${LIVE} Asset Management Summer Analyst`],
  ["asset_wealth_management", `${LIVE} Wealth Management Summer Analyst`],
  // "Equity Research Summer Analyst" is deliberately absent. It names no
  // sector of its own: sell-side research belongs to the bank that posts it
  // and buy-side research to the fund, so the phrase falls through to the
  // source's registered sector rather than claiming one. See the note on
  // asset_wealth_management in SECTOR_KEYWORDS.
  ["commercial_banking", `${LIVE} Commercial Banking Summer Analyst`],
  ["commercial_banking", `${LIVE} Corporate Banking Summer Analyst`],
  ["insurance", `${LIVE} Actuarial Summer Intern`],
  ["insurance", `${LIVE} Insurance Underwriting Internship`],
  ["fintech", `${LIVE} Fintech Product Summer Analyst`],
  ["fintech", `${LIVE} Financial Technology Summer Internship`],
  ["market_infrastructure", `${LIVE} Clearing House Operations Summer Analyst`],
  ["market_infrastructure", `${LIVE} Exchange Operations Summer Internship`],
  ["consulting", `${LIVE} Consulting Summer Associate`],
  ["consulting", `${LIVE} Associate Consultant Intern`],
  ["consulting", `Strategy Consulting Summer Analyst ${LIVE}`],
];

for (const [expected, title] of industryTitles) {
  test(`sector read from the title: ${title.slice(0, 50)}`, () => {
    assert.equal(sectorForText(title)?.category, expected, title);
  });

  test(`relevant in ${expected}: ${title.slice(0, 44)}`, () => {
    const result = classifyListing(listing(title), null);
    assert.equal(result.relevant, true, `${title}: ${result.matchedEvidence.join("; ")}`);
  });

  test(`publishable in ${expected}: ${title.slice(0, 44)}`, () => {
    // The silent failure this file exists for: no sector means no
    // auto-approval, forever, with nothing in the log to show for it.
    assert.equal(outcome(listing(title), null), "auto_approved", title);
  });
}

test("Bain's own title shape is read as consulting", () => {
  // "Associate Consultant Intern" contains no "consulting" - the firms name
  // the role, not the practice, and six letters kept every consulting
  // internship out of auto-approval.
  assert.equal(sectorForText("Associate Consultant Intern")?.category, "consulting");
});

test("a generic title is not forced into an industry", () => {
  // "business analyst" is one of the commonest titles in any industry, and
  // this list is first-match-wins across all fourteen.
  assert.equal(sectorForText("Summer Business Analyst"), null);
  assert.equal(sectorForText("Summer Analyst"), null);
  assert.equal(sectorForText("Summer Internship Programme"), null);
});

// ------------------------------------- the registry fallback catches the rest

for (const category of ALL) {
  test(`${category} falls back to the source's registered sector`, () => {
    // A title that names no industry still has to reach students. The board it
    // came from is registered under a sector, and that is the answer.
    const result = classifyListing(listing(`${LIVE} Summer Analyst Programme`), category);
    assert.equal(result.sector, category, category);
    assert.ok(
      result.matchedEvidence.some((e) => /source registry/.test(e)),
      "the fallback must be visible as evidence, not silent",
    );
  });

  test(`${category} publishes a sector-less title via the fallback`, () => {
    assert.equal(outcome(listing(`${LIVE} Summer Analyst - New York`), category), "auto_approved", category);
  });
}

test("the title beats the registry when both name a sector", () => {
  // A real estate posting on a bank's board is a real estate posting.
  const result = classifyListing(listing(`${LIVE} Real Estate Summer Analyst`), "investment_banking");
  assert.equal(result.sector, "real_estate");
});

// ---------------------------------- exclusions must not over-fire per industry

const shouldSurvive: [FirmProgramCategory, string][] = [
  ["insurance", `${LIVE} Actuarial Summer Intern`],
  ["real_estate", `${LIVE} Real Estate Investments Summer Analyst`],
  ["asset_wealth_management", `${LIVE} Equity Research Summer Analyst`],
  ["fintech", `${LIVE} Payments Summer Analyst`],
  ["commercial_banking", `${LIVE} Credit Analysis Summer Analyst`],
  ["market_infrastructure", `${LIVE} Clearing Operations Summer Analyst`],
  ["private_equity", `${LIVE} Growth Equity Summer Analyst`],
  ["venture_capital", `${LIVE} Early Stage Investing Summer Analyst`],
];
for (const [category, title] of shouldSurvive) {
  test(`not wrongly excluded in ${category}: ${title.slice(0, 46)}`, () => {
    // Every exclusion rule in classify.ts was written against investment
    // banking titles. An industry whose ordinary vocabulary trips one of them
    // loses every posting to a rule nobody wrote for it.
    const result = classifyListing(listing(title), category);
    assert.equal(result.relevant, true, `${title}: ${result.matchedEvidence.join("; ")}`);
  });
}

const shouldStillBeExcluded: [string, string][] = [
  ["tax, in any industry", `${LIVE} Tax Summer Intern`],
  ["audit", `${LIVE} Audit Summer Intern`],
  ["legal", `${LIVE} Legal Summer Intern`],
  ["human resources", `${LIVE} Human Resources Summer Analyst`],
  ["software engineering", `${LIVE} Software Engineer Summer Internship`],
  ["full-time programme", `${LIVE} Full Time Analyst Program`],
];
for (const [name, title] of shouldStillBeExcluded) {
  test(`still excluded whatever the industry - ${name}`, () => {
    // Enacting thirteen more industries must not quietly re-admit the things
    // that were excluded for good reason.
    for (const category of ALL) {
      assert.notEqual(outcome(listing(title), category), "auto_approved", `${title} / ${category}`);
    }
  });
}

test("a real estate tax internship is still a tax internship", () => {
  // Off-profession beats the industry: it is a real, open internship and no
  // student using this product is looking for it.
  const result = classifyListing(listing(`${LIVE} Real Estate Tax Summer Intern`), "real_estate");
  assert.equal(result.relevant, false);
});

// ------------------------------------------- the quality gate, per industry

for (const [category, title] of industryTitles) {
  test(`quality gate accepts a real ${category} title: ${title.slice(0, 40)}`, () => {
    // posting-quality.ts is structural and industry-blind by design. This
    // asserts that it really is - a rule tuned on banking titles could refuse
    // an ordinary insurance one for being differently shaped.
    assert.equal(assessPostingQuality(listing(title)).ok, true, title);
  });
}

// ------------------------------------------------ enrollment, per industry

const FIRM = {
  slug: "acme",
  name: "Acme",
  category: "investment_banking",
  website: "acme.com",
  hasVerifiedProgram: true,
  employees: 500,
  aum: 5_000_000_000,
  ibTier: null,
  peTier: null,
} as unknown as Parameters<typeof decideEnrollment>[0];

const BOARD = {
  careersUrl: "https://jobs.lever.co/acme",
  connectorId: "lever",
  verifiedParsing: true,
} as unknown as Parameters<typeof decideEnrollment>[1];

for (const category of ALL) {
  test(`${category} enrolls when it has a verified board`, () => {
    const decision = decideEnrollment({ ...FIRM, category }, BOARD);
    assert.equal(decision.action, "enroll", category);
  });

  test(`${category} derives a real tier, never inactive`, () => {
    const tier = deriveTier({ ...FIRM, category }, BOARD);
    assert.notEqual(tier, "inactive", category);
  });

  test(`${category} is judged worth crawling on the same evidence`, () => {
    const worth = isWorthCrawling({ ...FIRM, category }, BOARD);
    assert.equal(worth.worth, true, category);
  });

  test(`${category} without a board is a discovery task`, () => {
    const decision = decideEnrollment({ ...FIRM, category }, null);
    assert.equal(decision.action, "skip", category);
    assert.match(decision.reason, /needs discovery/, category);
  });
}

// ---------------------------------------------- scheduling, per industry

for (const category of ALL) {
  test(`${category} has a recruiting timeline`, () => {
    assert.ok(CATEGORY_TIMELINE_TRACKS[category].length > 0, category);
  });

  test(`${category} is never silenced by its own calendar`, () => {
    for (let month = 1; month <= 12; month++) {
      const verdict = seasonFor(category, new Date(Date.UTC(2026, month - 1, 15)));
      assert.ok(verdict.intervalMultiplier > 0 && verdict.intervalMultiplier <= 4, `${category} ${month}`);
    }
  });

  test(`${category} reaches full cadence at some point in the year`, () => {
    // A sector that is never at full cadence is one whose openings we are
    // always half looking for.
    const best = Math.min(
      ...Array.from({ length: 12 }, (_, m) =>
        seasonFor(category, new Date(Date.UTC(2026, m, 15))).intervalMultiplier),
    );
    assert.ok(best <= 2, `${category} never gets above x${best}`);
  });
}

// --------------------------------------------------------- degenerate input

test("nothing in the industry path throws on an empty listing", () => {
  for (const category of ALL) {
    assert.doesNotThrow(() => classifyListing(listing(""), category), category);
    assert.doesNotThrow(() => classifyListing(listing("", { descriptionRaw: "" }), category), category);
  }
});

test("sectorForText never throws", () => {
  for (const text of ["", " ", " ", "x".repeat(10000)]) {
    assert.doesNotThrow(() => sectorForText(text));
  }
});

test("every industry produces evidence for its verdict", () => {
  for (const [category, title] of industryTitles) {
    const result = classifyListing(listing(title), category);
    assert.ok(result.matchedEvidence.length > 0, title);
  }
});

// ------------------------------------------------- the legal rule, in detail

const legalTitles = [
  `${LIVE} Legal Summer Intern`,
  "Legal Internship",
  "Legal & Compliance Summer Analyst",
  "Stage H/F - Juriste Corporate",
  "Paralegal Intern",
  "Attorney Summer Programme",
];
for (const title of legalTitles) {
  test(`a legal role is excluded in every industry: ${title.slice(0, 40)}`, () => {
    // The list was built from the specific titles the corpus happened to show
    // and missed the plainest English form. "Legal Summer Intern" was
    // auto-approved and would have reached students as a finance opening.
    for (const category of ALL) {
      assert.notEqual(outcome(listing(title), category), "auto_approved", `${title} / ${category}`);
    }
  });
}

test("Legal Entity Control is a finance function, not a legal one", () => {
  // Staffed by accountants at every bank. Excluding it would lose a real
  // finance internship to a rule about lawyers.
  const result = classifyListing(listing(`${LIVE} Legal Entity Control Summer Analyst`), "investment_banking");
  assert.equal(result.relevant, true, result.matchedEvidence.join("; "));
});

test("a legal exclusion is reviewable, not dropped", () => {
  // Off-profession postings are REAL postings. They are rejected, which an
  // admin can overturn, rather than filed as page furniture.
  const result = classifyListing(listing(`${LIVE} Legal Summer Intern`), "investment_banking");
  assert.equal(result.isPosting, true);
  assert.equal(result.needsHumanReview, true);
});
