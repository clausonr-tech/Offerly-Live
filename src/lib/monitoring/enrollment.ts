import "server-only";
import { normalizeBoardUrl } from "./board-url";
import { dedupKey } from "./board-identity";

/**
 * The rule that turns a row in the firm directory into something the crawler
 * polls - or says, out loud and with a reason, why it does not.
 *
 * WHY THIS IS A RULE AND NOT A SCRIPT
 * -----------------------------------
 * Firms arrive from four places: the curated seeds, the 22,575-row bulk
 * import, board discovery, and CSV import. Before this file, only the first
 * could produce a monitoring source, because the logic lived inside
 * `scripts/seed-monitoring-sources.ts` and hardcoded `investment_banking`.
 * Everything else added firms that were never polled and never reported as
 * unpolled - the directory grew and coverage silently did not.
 *
 * Every path that adds a firm calls `decideEnrollment`, so "added to the
 * directory" and "considered for the crawler" become the same event.
 *
 * THE COUNT THAT SETS THE DESIGN
 * ------------------------------
 * Of 22,575 directory rows, 17,772 have a website and only 1,912 have any
 * careers URL - and just five of those point at a known ATS. So the common
 * case this rule has to handle well is not "which connector" but "we have a
 * domain and nothing else", and the expensive mistake is enrolling thousands
 * of two-person RIAs that will never run a summer analyst programme. Coverage
 * of all 22,575 is the wrong goal; coverage of the ones that actually recruit
 * is the right one.
 *
 * REJECTIONS ARE RECORDED, NEVER SILENT
 * -------------------------------------
 * Every negative outcome carries a `reason` string meant to be stored and
 * read by a human. This codebase has already paid for the alternative once:
 * 1,182 listing rejections looked reasonless because the reason was written to
 * a field no reviewer saw, and hidden inside that invisibility were 59
 * internships being wrongly dropped. A firm that is not being crawled is the
 * same kind of fact.
 */

/**
 * Categories the crawler is allowed to poll.
 *
 * ALL OF THEM, as of 19 September - and the reason that is safe is the ORDER
 * of the checks below rather than anything about the list.
 *
 * This gate is the LAST test in decideEnrollment. A firm reaches it only after
 * it has a website, has cleared isWorthCrawling (a confirmed programme, an
 * ATS, or the Form ADV size floors), has a board URL that survived
 * board-url.ts, and is not a duplicate of a board already monitored. So
 * enabling a category cannot enroll the 9,054-row asset-management tail this
 * file's header calls the expensive mistake: those firms have no board, and
 * they are turned away two checks earlier with "needs discovery".
 *
 * What it actually enacts today is the 82 probed, verified boards already
 * staged across private equity, hedge funds, venture capital, real estate and
 * other finance - taking the crawl from 106 sources to 188 - plus whatever the
 * asset & wealth management probe returns when it lands.
 *
 * WHAT NOW CONTROLS VOLUME
 * ------------------------
 * Board discovery and the size floors, which is where the control belongs. A
 * category with no probed boards enacts nothing at all; seven of the fourteen
 * are in exactly that position today and will stay there until someone probes
 * them. That is a sourcing question, not a crawler setting.
 *
 * The original decision (also 19 Sep) was to perfect investment banking first
 * and translate outward, with everything else discovered, deduped and tiered
 * but staged. That worked, and this is the translation: no other code changed,
 * and no re-discovery was needed, exactly as that note predicted.
 */
export const ENABLED_CATEGORIES: ReadonlySet<string> = new Set([
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
]);

/**
 * Size floors, used ONLY when nothing stronger is known about a firm.
 *
 * A firm that bought an applicant tracking system, or that we have already
 * confirmed runs a student programme, is past this test before it is taken -
 * those are direct evidence of recruiting, and headcount is a proxy for it.
 * The floors exist for the residual: a domain, a category, and a Form ADV
 * filing. Both are deliberately generous, because the cost of wrongly staging
 * a firm is that a human can flip it on, while the cost of wrongly enrolling
 * thousands is a crawl nobody can afford to run.
 */
export const EMPLOYEE_FLOOR = 50;
export const AUM_FLOOR = 1_000_000_000; // $1B regulatory AUM

/** Tier names, fastest first. Mirrors the ladder in scripts/assign-tiers.ts. */
export type TierName = "critical" | "high" | "standard" | "discovery" | "inactive";

export type FirmForEnrollment = {
  slug: string;
  name: string;
  /** Root domain. Absent for 4,803 directory rows, which end the rule early. */
  website: string | null;
  category: string;
  /** Regulatory AUM in whole dollars, from Form ADV. Null for firms that
   *  manage no assets - pure advisory shops file no ADV at all, so null here
   *  is "unknown", never "zero". */
  aum: number | null;
  /** Total employees, Form ADV Item 5.A. Null when unfiled or unparsed. */
  employees: number | null;
  /** The curated-set flag: a student programme somebody actually confirmed. */
  hasVerifiedProgram: boolean;
  /** Investment-banking league tier, when the firm has one. */
  ibTier?: "bulge_bracket" | "elite_boutique" | string | null;
};

/** What discovery (or a seed) believes it found for this firm. */
export type BoardCandidate = {
  careersUrl: string;
  /** The connector that claimed the URL. "generic" is a valid answer. */
  connectorId: string;
  /**
   * True when a real fetch against this URL parsed real listings.
   *
   * This is the difference between "an ATS host appears in the URL" and "we
   * read jobs off it", and the tier depends on it. `apply-discovered-boards.ts`
   * already only assigns a specialist connector after a fetch succeeded, which
   * is the same standard.
   */
  verifiedParsing: boolean;
};

export type EnrollmentDecision =
  | {
      action: "enroll";
      connectorId: string;
      sourceType: "greenhouse" | "jobposting_jsonld" | "generic_html";
      careersUrl: string;
      dedupKey: string;
      tier: TierName;
      reason: string;
    }
  | {
      action: "stage";
      connectorId: string;
      sourceType: "greenhouse" | "jobposting_jsonld" | "generic_html";
      careersUrl: string;
      dedupKey: string;
      /** Always "inactive" - a staged row is written and never polled. */
      tier: "inactive";
      reason: string;
    }
  | { action: "duplicate"; dedupKey: string; reason: string }
  | { action: "skip"; reason: string };

/**
 * `firm_monitoring_sources.source_type` is a three-value enum and the
 * connector registry is open-ended text, so the two have to be mapped rather
 * than assumed equal. Anything with a real API is `generic_html` today -
 * the column describes how the page is READ, and only these three answers
 * exist in the schema.
 */
function sourceTypeFor(connectorId: string): "greenhouse" | "jobposting_jsonld" | "generic_html" {
  if (connectorId === "greenhouse") return "greenhouse";
  if (connectorId === "jsonld") return "jobposting_jsonld";
  return "generic_html";
}

/**
 * Is this a firm worth reading at all?
 *
 * Any ONE of these is enough. They are ordered by how directly they evidence
 * student recruiting, and the first two are qualitatively better than the
 * third: they are observations, where headcount is an inference.
 */
export function isWorthCrawling(
  firm: FirmForEnrollment,
  board: BoardCandidate | null,
): { worth: true; because: string } | { worth: false; reason: string } {
  if (firm.hasVerifiedProgram) {
    return { worth: true, because: "a confirmed student programme" };
  }
  if (board && board.verifiedParsing) {
    return { worth: true, because: "a board that parsed real listings" };
  }
  if (board && board.connectorId !== "generic") {
    return { worth: true, because: `runs ${board.connectorId}, so it hires through an ATS` };
  }
  if (firm.employees !== null && firm.employees >= EMPLOYEE_FLOOR) {
    return { worth: true, because: `${firm.employees} employees (Form ADV)` };
  }
  if (firm.aum !== null && firm.aum >= AUM_FLOOR) {
    return { worth: true, because: `$${Math.round(firm.aum / 1e9)}B regulatory AUM` };
  }

  // Everything below is the 9,054-row asset-management tail the roadmap
  // explicitly does not want crawled. Saying which test it failed matters,
  // because "no ADV data" and "small" are different problems with different
  // fixes - the first is an ingest gap, the second is a correct exclusion.
  if (firm.employees === null && firm.aum === null) {
    return {
      worth: false,
      reason: "no programme, no ATS, and no Form ADV size data to judge by",
    };
  }
  return {
    worth: false,
    reason:
      `below the size floor (${firm.employees ?? "?"} employees, ` +
      `${firm.aum === null ? "unknown" : `$${Math.round(firm.aum / 1e6)}M`} AUM) ` +
      "and no ATS or confirmed programme",
  };
}

/**
 * The tier a source should start on, derived rather than assigned.
 *
 * Hand-assigning tiers across 22,575 rows is a maintenance job nobody does,
 * so every input here is something already known about the firm. The ladder
 * matches scripts/assign-tiers.ts, which re-derives tiers later from run
 * history - this is the starting position, not the last word.
 */
export function deriveTier(firm: FirmForEnrollment, board: BoardCandidate | null): TierName {
  if (firm.ibTier === "bulge_bracket") return "critical";
  if (firm.ibTier === "elite_boutique") return "high";

  // A parsing board earns the normal cadence. Note this is deliberately not
  // "has a specialist connector": a Workday URL that has never been fetched
  // proves only that somebody linked to Workday.
  if (board?.verifiedParsing) return "standard";

  // Large firms with a board we have not yet read are worth a slow look; the
  // 30-day discovery cadence exists precisely so this costs almost nothing.
  if (board) return "discovery";

  return "inactive";
}

/**
 * The whole rule.
 *
 * `seenDedupKeys` is every board key already registered. Pass it and the
 * function will refuse a second copy of a board; pass an empty set and it
 * will not, which is the right behaviour for a caller that is about to check
 * the database itself.
 */
export function decideEnrollment(
  firm: FirmForEnrollment,
  board: BoardCandidate | null,
  seenDedupKeys: ReadonlySet<string> = new Set(),
): EnrollmentDecision {
  if (!firm.website) {
    return { action: "skip", reason: "no website in the directory row" };
  }

  const worth = isWorthCrawling(firm, board);
  if (!worth.worth) {
    return { action: "skip", reason: worth.reason };
  }

  if (!board) {
    // Worth crawling and nowhere to point. This is the common shape for the
    // 20,663 rows with no careers URL, and it is a discovery task rather than
    // a rejection - so it is recorded as one instead of being dropped.
    return {
      action: "skip",
      reason: `worth crawling (${worth.because}) but no board URL found yet - needs discovery`,
    };
  }

  // The URL still has to survive board-url.ts, which refuses login portals,
  // single postings, CDN assets and experienced-hire-only boards. Its reasons
  // are already written for a human, so they are passed through unchanged.
  const normalized = normalizeBoardUrl(board.careersUrl);
  if (!normalized.ok) {
    return { action: "skip", reason: normalized.reason };
  }

  const key = dedupKey(normalized.url, board.connectorId);
  if (seenDedupKeys.has(key)) {
    return {
      action: "duplicate",
      dedupKey: key,
      reason: `the same board is already monitored (${key}) - linked, not polled twice`,
    };
  }

  const sourceType = sourceTypeFor(board.connectorId);

  if (!ENABLED_CATEGORIES.has(firm.category)) {
    return {
      action: "stage",
      connectorId: board.connectorId,
      sourceType,
      careersUrl: normalized.url,
      dedupKey: key,
      tier: "inactive",
      reason: `${firm.category} is built but not enacted - row written, not polled`,
    };
  }

  return {
    action: "enroll",
    connectorId: board.connectorId,
    sourceType,
    careersUrl: normalized.url,
    dedupKey: key,
    tier: deriveTier(firm, board),
    reason: worth.because + (normalized.note ? ` (${normalized.note})` : ""),
  };
}
