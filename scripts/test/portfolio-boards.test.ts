/**
 * A portfolio board's jobs belong to someone other than the firm.
 *
 * A Getro board aggregates openings at a venture firm's PORTFOLIO companies.
 * The connector read one as the firm's own careers page, so every listing was
 * published under the board owner's name.
 *
 * Measured 12 October 2026: 26 `getro` sources, 64 live postings across four
 * firms. Group 11 carried 55 - every application URL on careers.munichre.com,
 * so a student browsing a venture firm saw Munich Re's German Praktikant and
 * actuarial roles. Blockchain Capital carried six Coinbase roles, none of them
 * a finance internship.
 *
 * The handoff recorded this as one source scraping Coinbase's board, about six
 * postings. That was one firm's symptom; the cause is the connector.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isPortfolioBoard, PORTFOLIO_BOARD_CONNECTORS } from "@/lib/monitoring/portfolio-boards";

test("getro is a portfolio board; a firm's own ATS is not", () => {
  assert.equal(isPortfolioBoard("getro"), true);
  // The ATSes a firm genuinely uses for its OWN jobs must not be caught: a
  // blanket "apply link is off-domain" rule would reject almost every real
  // posting this crawler finds.
  for (const own of ["greenhouse", "workday", "eightfold", "icims", "generic", "lever"]) {
    assert.equal(isPortfolioBoard(own), false, `${own} is the firm's own board`);
  }
  assert.equal(isPortfolioBoard(null), false);
  assert.equal(isPortfolioBoard(undefined), false);
  assert.ok(PORTFOLIO_BOARD_CONNECTORS.has("getro"));
});

test("the crawl refuses to publish from a portfolio board", () => {
  // Asserted on the source: the routing decision needs a source row and a
  // database, and the regression it guards is an omitted condition.
  const src = fs.readFileSync(path.join(process.cwd(), "scripts/monitor-run.ts"), "utf8");
  assert.match(
    src,
    /isPortfolioBoard\(/,
    "monitor-run publishes without asking whether the board is the firm's own",
  );
  const start = src.indexOf("const reviewStatus =");
  assert.ok(start > 0, "the routing decision has moved - update this test");
  /**
   * The EXPRESSION, not a window around it.
   *
   * This read a fixed 400 characters after the assignment, and passed only
   * while the call sat inline. Extracting `fromPortfolioBoard` one line up - to
   * attach the rejection's reason - moved the call above the window and the
   * assertion broke with the guard fully in place. A window is the wrong unit;
   * what matters is that the decision itself depends on the check, under
   * whatever name it is bound to.
   */
  const expr = src.slice(start, src.indexOf(";", start));
  assert.match(
    expr,
    /[pP]ortfolioBoard/,
    "the publish decision does not consult the portfolio-board check",
  );
  // And the name it depends on really is that check, not an unrelated local.
  assert.match(
    src,
    /const fromPortfolioBoard = isPortfolioBoard\(/,
    "the guard is bound to something other than isPortfolioBoard()",
  );
});
