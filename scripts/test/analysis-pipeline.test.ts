// The whole analysis chain, on the rows that actually broke it.
//
// The per-stage files test each gate alone. This one runs a scraped listing
// through the real sequence - quality gate, then classifier - and asserts the
// OUTCOME, because that is what a student sees and because the two stages have
// been wrong about each other before: the classifier used to answer "is this
// an internship" for things that were not postings, and the quality gate used
// to answer "not a posting" for postings that were merely ordinary.
//
// Three outcomes exist and they are not interchangeable:
//
//   dropped         - not a posting. Never queued, nothing to overturn.
//   rejected        - a posting, not a relevant one. Filed and overturnable.
//   published-able  - relevant, verifiable, and cycle-bearing.
//
// Filing one as another is the bug class this file guards.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";
import { liveCycleRange } from "../../src/lib/monitoring/posting-quality";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";
import type { FirmProgramCategory } from "../../src/lib/firm-metadata";

const { min: LIVE } = liveCycleRange();

const BODY =
  "Join our investment banking division in New York for a ten week summer programme. " +
  "You will support live M&A and capital markets transactions, build financial models " +
  "and prepare client materials alongside the deal teams. Candidates should be pursuing " +
  "a bachelor's degree with strong academic credentials and an interest in finance.";

function scraped(patch: Partial<NormalizedListing>): NormalizedListing {
  return {
    externalJobId: "req-1",
    title: "Investment Banking Summer Analyst",
    division: null,
    location: "New York, NY",
    descriptionRaw: BODY,
    employmentType: null,
    applicationUrl: "https://example.com/jobs/1",
    listingUrl: "https://example.com/jobs/1",
    publishedAt: null,
    ...patch,
  };
}

/** The outcome monitor-run would file this under. */
function outcome(
  listing: NormalizedListing,
  sector: FirmProgramCategory | null = "investment_banking",
): "dropped" | "rejected" | "pending_review" | "auto_approved" {
  const result = classifyListing(listing, sector);
  if (!result.isPosting) return "dropped";
  if (!result.relevant) return "rejected";
  return result.needsHumanReview ? "pending_review" : "auto_approved";
}

// ------------------------------------- page furniture must be DROPPED, not rejected

const furniture: [string, string][] = [
  ["Nomura's filter control", "Clear Region EMEA (Europe, Middle East and Africa) (22 Results) AEJ (Asi"],
  ["Deutsche Bank's nav link", "Internship Programme"],
  ["Rothschild's apprenticeships page", "Apprenticeships"],
  ["Rothschild's early-insights page", "Early Insights"],
  ["a pagination control", "Show more"],
  ["a cookie link", "Cookie preferences"],
];
for (const [name, title] of furniture) {
  test(`dropped, not rejected - ${name}`, () => {
    // All of these were AUTO-APPROVED by the first live crawl. Dropping them
    // is right; rejecting them would bury the review queue in furniture.
    assert.equal(outcome(scraped({ title, descriptionRaw: title, externalJobId: null })), "dropped", title);
  });
}

test("Deutsche Bank's marketing sentence is dropped", () => {
  const title = "Our internship opportunities are your steppingstone to a career a Deutsc";
  assert.equal(outcome(scraped({ title, descriptionRaw: title, externalJobId: null })), "dropped");
});

// ------------------------------------ real postings must be REJECTED, not dropped

const rejectable: [string, string][] = [
  ["a compliance officer", "Commercial Banking Compliance Officer"],
  ["a property administrator", "Property Administrator"],
  ["a front desk agent", "Front Desk Agent"],
  ["a payroll technician", "Payroll Technician"],
];
for (const [name, title] of rejectable) {
  test(`rejected, not dropped - ${name}`, () => {
    // A non-posting is dropped without review; a posting that is not relevant
    // is REJECTED, which is a different record and an overturnable one.
    // Mislabelling the second as the first hides a real listing behind the
    // wrong reason.
    assert.equal(outcome(scraped({ title })), "rejected", title);
  });
}

// ------------------------------------------------------- the published incidents

const mustNotPublish: [string, string][] = [
  ["Lazard's software engineer internship", `${LIVE} Software Engineer Summer Internship`],
  ["the developer variant that plain English missed", `Software Developer, Winter ${LIVE} (Internship)`],
  ["a French AI internship", "Stage H/F - Ingénieur IA Multi-Équipes"],
  ["a French AI manager role", "Stage H/F - IA Manager"],
  ["Kroll's transfer pricing intern", "Intern, Transfer Pricing"],
  ["Kroll's trade and customs intern", "Intern, Trade and Customs"],
  ["a tax internship", `Tax Intern, Core Tax Services - Summer ${LIVE} (Dallas)`],
  ["an assurance internship", `Assurance Intern - Summer ${LIVE} (Atlanta)`],
  ["a French legal internship", "Stage H/F - Juriste Corporate"],
  ["an HR summer analyst", `${LIVE} Human Resources Summer Analyst Program - New York`],
  ["Evercore's full-time analyst programme", `${LIVE} Strategic Advisory: Mergers & Acquisitions Full Time Analyst Program - Richmond`],
  ["Evercore's full-time associate programme", "Full Time Associate Program - New York"],
  ["Evercore's networking reception", `${LIVE} Summer Analyst Evercore Networking Reception - University of Southern California`],
  ["Evercore's coffee chats", `${LIVE} Evercore Summer Analyst Chicago - Industrials Coffee Chats`],
  ["an experienced-hire landing page", "Lateral / Experienced Hires (US/Canada/APAC) - Summer Analyst"],
];
for (const [name, title] of mustNotPublish) {
  test(`never published - ${name}`, () => {
    // Every one of these reached students, or was one script away from it.
    assert.notEqual(outcome(scraped({ title })), "auto_approved", title);
  });
}

for (const [name, title] of mustNotPublish) {
  test(`overturnable, not dropped - ${name}`, () => {
    // These are all REAL postings. Filing them as "not a posting" would hide
    // a genuine listing behind the wrong reason and remove the appeal.
    assert.notEqual(outcome(scraped({ title })), "dropped", title);
  });
}

// ------------------------------------------------- real internships must survive

const mustSurvive: [string, string][] = [
  ["a plain summer analyst", `${LIVE} Investment Banking Summer Analyst - New York`],
  ["a summer associate", `${LIVE} M&A Summer Associate (Boston)`],
  ["an off-cycle analyst", `${LIVE} January Off-Cycle Analyst`],
  ["a spring week", `Spring Week ${LIVE} - Markets, London`],
  ["a desk-qualified internship", "Summer Internship, Equity Research"],
  ["a year-round internship", "Internship - Marketing (Year-Round)"],
  ["a financial engineer internship", "Internship - Financial Engineer - Corporate & Investment banking"],
  ["William Blair's real London role", `London Investment Banking Summer Analyst, Summer ${LIVE} Programme`],
  ["Houlihan Lokey's shape", `Summer ${LIVE} Financial Analyst (Class of ${LIVE + 1}), Corporate Valuation Advisory`],
];
for (const [name, title] of mustSurvive) {
  test(`survives as a posting - ${name}`, () => {
    assert.notEqual(outcome(scraped({ title })), "dropped", title);
  });
}

for (const [name, title] of mustSurvive) {
  test(`judged relevant - ${name}`, () => {
    const result = classifyListing(scraped({ title }), "investment_banking");
    assert.equal(result.relevant, true, `${name}: ${result.matchedEvidence.join("; ")}`);
  });
}

// ---------------------------------------------------- formatting must not decide

const deformations: [string, (s: string) => string][] = [
  ["non-breaking spaces", (s) => s.replace(/ /g, " ")],
  ["en-dashes", (s) => s.replace(/-/g, "–")],
  ["em-dashes", (s) => s.replace(/-/g, "—")],
  ["doubled spaces", (s) => s.replace(/ /g, "  ")],
  ["leading and trailing space", (s) => `  ${s}  `],
  ["tab-joined", (s) => s.replace(/ /g, "\t")],
];
for (const [name, deform] of deformations) {
  test(`a real internship survives ${name}`, () => {
    // A false positive on a software engineering role was traced to nothing
    // more than how a scraper joined two DOM nodes.
    const title = deform(`${LIVE} Investment Banking Summer Analyst - New York`);
    const result = classifyListing(scraped({ title }), "investment_banking");
    assert.equal(result.relevant, true, `${name}: ${result.matchedEvidence.join("; ")}`);
  });
}

for (const [name, deform] of deformations) {
  test(`a technology role is still excluded under ${name}`, () => {
    const title = deform(`${LIVE} Software Engineer Summer Internship`);
    assert.notEqual(outcome(scraped({ title })), "auto_approved", name);
  });
}

// ------------------------------------------------------- evidence is always given

test("every verdict explains itself", () => {
  // A rejection that cannot say why is indistinguishable from a bug. This was
  // the single most common rejection reason and it left no trace for 1,182
  // listings.
  for (const [, title] of [...mustNotPublish, ...mustSurvive, ...rejectable]) {
    const result = classifyListing(scraped({ title }), "investment_banking");
    assert.ok(result.matchedEvidence.length > 0, `no evidence for "${title}"`);
  }
});

test("a dropped row carries a quotable reason", () => {
  for (const [, title] of furniture) {
    const result = classifyListing(
      scraped({ title, descriptionRaw: title, externalJobId: null }),
      "investment_banking",
    );
    assert.equal(result.isPosting, false, title);
    assert.ok(result.qualityIssues.length > 0, title);
  }
});

// ------------------------------------------------- the generic-connector shape

test("a generic-connector listing is never auto-approved", () => {
  // No source id, and its "description" is its link text. Verifiable is what
  // separates a posting we could not fully read from a page fragment that was
  // never a posting - and it is required for publication.
  const title = `${LIVE} Investment Banking Summer Analyst - New York`;
  const result = classifyListing(
    scraped({ title, externalJobId: null, descriptionRaw: title }),
    "investment_banking",
  );
  assert.equal(result.verifiable, false);
  assert.notEqual(outcome(scraped({ title, externalJobId: null, descriptionRaw: title })), "auto_approved");
});

test("an un-enrichable generic listing reaches review rather than vanishing", () => {
  // It used to be DROPPED - unreviewable, filed beside a filter control -
  // because it had no id and no body. A title naming a dated role in a named
  // city is evidence a posting exists even when we could not read it.
  const title = `${LIVE} Investment Banking Summer Analyst - New York`;
  assert.equal(outcome(scraped({ title, externalJobId: null, descriptionRaw: title })), "pending_review");
});

test("a vague generic candidate is still dropped", () => {
  // The exception is narrow on purpose: a role word alone is the nav link
  // Deutsche Bank published.
  assert.equal(
    outcome(scraped({ title: "Summer Analyst", externalJobId: null, descriptionRaw: "Summer Analyst" })),
    "dropped",
  );
});

test("the same listing read by a real connector can be published", () => {
  // The argument for writing connectors, stated as a test.
  const title = `${LIVE} Investment Banking Summer Analyst - New York`;
  const result = classifyListing(scraped({ title }), "investment_banking");
  assert.equal(result.verifiable, true);
  assert.equal(result.needsHumanReview, false);
});

test("nothing in the chain throws on a degenerate row", () => {
  const degenerate: Partial<NormalizedListing>[] = [
    { title: "", descriptionRaw: "" },
    { title: " ", descriptionRaw: " ", externalJobId: null },
    { title: " ", descriptionRaw: " " },
    { title: "x".repeat(5000), descriptionRaw: "y".repeat(50000) },
  ];
  for (const patch of degenerate) {
    assert.doesNotThrow(() => outcome(scraped(patch)), JSON.stringify(patch).slice(0, 60));
  }
});
