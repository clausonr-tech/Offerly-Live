import "server-only";

/**
 * Connectors whose boards belong to someone OTHER than the firm.
 *
 * A Getro board is a venture firm's PORTFOLIO job board: it aggregates
 * openings at the companies the firm has invested in. The connector reads one
 * as though it were the firm's own careers page, so every listing it finds is
 * attributed to the board's owner rather than to the employer who posted it.
 *
 * Measured 12 October 2026: 26 `getro` sources, four with live postings, 64 in
 * total. Group 11 carried 55 - every single application URL on
 * careers.munichre.com, so a student browsing a venture firm was shown Munich
 * Re's German Praktikant and actuarial roles. Blockchain Capital carried six
 * Coinbase roles (Product Design, Sales, User Research), none of them a
 * finance internship at all.
 *
 * The handoff recorded this as one source scraping Coinbase's board, affecting
 * about six postings. That was the symptom at one firm. The cause is the
 * connector, and it is an order of magnitude larger.
 *
 * WHY A BLANKET REFUSAL RATHER THAN HOST-MATCHING. The obvious rule - require
 * the apply link to be on the firm's own domain - rejects almost every real
 * posting this crawler finds, because legitimate boards live on greenhouse.io,
 * myworkdayjobs.com, eightfold.ai and a dozen other ATS hosts. There is no
 * cheap test that separates "a bank's Workday" from "a VC's portfolio feed".
 *
 * WHAT THIS GIVES UP, and it is real: a Getro board genuinely carries
 * internships, and some are finance ones at portfolio companies. Attributing
 * them correctly means reading the employer per listing - Getro's API does
 * carry it - and either matching it to a firm already in the directory or
 * creating one. That is a feature, not a guard, and until it exists publishing
 * these does more harm than withholding them: a posting under the wrong
 * employer's name is worse than no posting, because a student cannot tell.
 */
export const PORTFOLIO_BOARD_CONNECTORS: ReadonlySet<string> = new Set(["getro"]);

/** Is this connector's board someone else's jobs? */
export function isPortfolioBoard(connectorId: string | null | undefined): boolean {
  return connectorId != null && PORTFOLIO_BOARD_CONNECTORS.has(connectorId);
}
