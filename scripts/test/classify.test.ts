// Off-profession rules are checked FIRST and cannot be overturned by
// internship language. The regression this guards: 61 tax/assurance/audit
// postings were promoted into the internship feed as investment banking,
// because "Summer Intern" in the title outranked every exclusion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { offProfessionReason } from "../../src/lib/monitoring/classify";

test("accounting-practice titles are off-profession however they are dressed", () => {
  for (const title of [
    "Tax Summer Intern",
    "Assurance Summer Associate",
    "Audit Intern - Financial Services",
    "Auditor, Summer Analyst Program",
  ]) {
    assert.ok(offProfessionReason(title), `expected a reason for: ${title}`);
  }
});

test("the division is judged too, not only the title", () => {
  assert.ok(offProfessionReason("2027 Summer Analyst", "Assurance"));
});

test("genuine finance roles are not swept up", () => {
  for (const title of [
    "2027 Investment Banking Summer Analyst",
    "Sales & Trading Summer Analyst",
    "Private Equity Summer Associate",
    "Equity Research Intern",
  ]) {
    assert.equal(offProfessionReason(title), null, `unexpected reason for: ${title}`);
  }
});

test("a word merely containing 'tax' does not trigger it", () => {
  // Word boundaries matter: "Syntax", "Taxonomy" are not accounting.
  assert.equal(offProfessionReason("Taxonomy Data Summer Analyst"), null);
});

test("a bank's Internal Audit division is finance, not an accounting practice", () => {
  /**
   * The accounting rule's `audit` arm fired on the word wherever it appeared,
   * which caught a bank's own Internal Audit division - a finance function
   * that recruits undergraduates into the same summer-analyst programmes as
   * markets and banking.
   *
   * Measured 11 October 2026: every firm in the corpus posting an
   * internal-audit role is a bank, all registered investment_banking - MUFG
   * (13), Citigroup (13), Morgan Stanley (10), Nomura (10), Mizuho (4),
   * Greenhill (4), Raymond James (3), Barclays (2), Jefferies (2). Not one is
   * an accounting practice. 83 listings were excluded as "not finance".
   */
  for (const title of [
    "2027 Internal Audit Summer Analyst Program",
    "2027 Internal Audit - Business Audit Summer Analyst Master",
    "Internal Audit Analytics Intern",
    "2027 Internal Audit Summer Analyst Program – New York",
  ]) {
    // The sector is required now: see "the internal-audit exemption only
    // applies at a bank" below for the Coinbase row that forced that.
    assert.equal(
      offProfessionReason(title, null, "investment_banking"),
      null,
      `rejected a bank internal-audit role: ${title}`,
    );
  }
});

test("an accounting practice is still an accounting practice", () => {
  // The rule's actual target, which narrowing must not weaken. Note "Audit
  // Intern" alone is still rejected - only the phrase "internal audit" is
  // exempt, because that names the bank function.
  for (const title of [
    "Tax Intern, Core Tax Services - Summer 2027 (Orange County)",
    "Assurance Intern - Summer 2027 (Richmond)",
    "Audit Intern - Summer 2027",
    "Stage Comptabilite et Reporting Luxembourg - Janvier 2027",
    "Tax Intern, International Tax Services - Summer 2028 (Dallas)",
  ]) {
    assert.ok(
      offProfessionReason(title)?.startsWith("accounting practice role"),
      `let an accounting-practice role through: ${title}`,
    );
  }
});

test("the internal-audit exemption only applies at a bank", () => {
  /**
   * The exemption shipped without this gate, on a premise a per-firm query
   * seemed to support and that was false: "every firm posting an
   * internal-audit role is a bank". One is not. Blockchain Capital, LLC - a
   * venture firm - has a monitoring source scraping Coinbase's Greenhouse
   * board, so "Internal Audit Analytics Intern" became publishable under the
   * venture firm's name. Coinbase is not a bank and Blockchain Capital is not
   * an accounting practice; the rule had nothing to check against.
   *
   * Caught by the all-fourteen-sector regression audit, not by the work that
   * introduced it.
   */
  // Exempt where internal audit really is a bank division.
  assert.equal(offProfessionReason("2027 Internal Audit Summer Analyst Program", null, "investment_banking"), null);
  assert.equal(offProfessionReason("Internal Audit Analyst", null, "commercial_banking"), null);

  // NOT exempt anywhere else - including the real Coinbase/Blockchain Capital row.
  for (const sector of ["venture_capital", "asset_wealth_management", "hedge_fund", "private_equity"]) {
    assert.ok(
      offProfessionReason("Internal Audit Analytics Intern", null, sector),
      `exempted an internal-audit role in ${sector}, where it is not a bank division`,
    );
  }

  // An unknown sector is not evidence of being a bank.
  assert.ok(offProfessionReason("Internal Audit Summer Analyst", null, null));
  assert.ok(offProfessionReason("Internal Audit Summer Analyst", null, undefined));
});

/**
 * The rule is only as good as what its callers hand it.
 *
 * `sector` is optional, which is what let `retire-off-profession-postings.ts`
 * call `offProfessionReason(p.title)` and lose the bank-audit exemption. That
 * script sets `isActive = false` on `internship_postings` - the table students
 * read - so the omission would have deactivated 83 genuine summer analyst
 * programmes across MUFG, Citigroup, Morgan Stanley, Nomura and six more.
 *
 * Asserted against the source because there is nothing to assert against at
 * runtime: the call compiles, runs, and quietly answers a different question.
 * The same shape as the script that forgot `DATABASE_URL` and read a dead
 * database for three weeks.
 */
test("every caller that retires a live posting passes the firm's sector", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(
    path.join(process.cwd(), "scripts/retire-off-profession-postings.ts"),
    "utf8",
  );

  assert.match(
    src,
    /offProfessionReason\(\s*p\.title\s*,\s*null\s*,\s*c\s*\)/,
    "retire-off-profession-postings.ts calls the rule without a sector again",
  );
  assert.match(
    src,
    /categories:\s*schema\.internshipPostings\.categories/,
    "the sector is no longer selected, so nothing could be passed",
  );
  assert.doesNotMatch(
    src,
    /offProfessionReason\(p\.title\)/,
    "the title-only call is back",
  );
});
