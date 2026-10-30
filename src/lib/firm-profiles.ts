import type { IBTier } from "./firm-metadata";

/**
 * Bank tier and coverage focus, kept as an overlay on the seeds.
 *
 * Why an overlay rather than editing FIRM_SEEDS in place: the seeds are one
 * 5,000-line file plus a 22,000-firm bulk JSON, and tier/coverage is research
 * that gets revisited as firms are acquired, launch groups or wind them down.
 * Holding it here keeps the whole judgement reviewable on one screen, and
 * leaves the seeds as a record of what the import found.
 *
 * ON THE TIER LABELS. "Bulge bracket", "elite boutique" and "middle-market"
 * are industry vernacular with no governing body, and the boundaries are
 * genuinely argued over - Jefferies sits between BB and EB depending on who
 * you ask, and the large non-US balance-sheet banks (RBC, BMO, MUFG, SMBC,
 * Scotiabank, TD, Truist, BNP, CIBC, Macquarie, Mizuho, Nomura, SocGen, HSBC)
 * are often given their own "IBAB" bucket that this three-way vocabulary has
 * no room for. This file follows the convention the existing seeds already
 * set: those banks are recorded as middle-market, because that is where the
 * three available labels put them, not because anyone calls Scotiabank a
 * middle-market bank.
 *
 * COVERAGE is only set where a firm's focus is definitional (a healthcare-only
 * bank) or was checked against the firm's own site. A generalist bank that
 * covers everything is left empty on purpose: tagging it with fifteen groups
 * would make a coverage filter match every firm and quietly switch itself off,
 * which is the exact failure coverage-match.ts was written to fix.
 *
 * Labels must come from GROUP_PATTERNS in coverage-match.ts, so the firm side
 * and the student's onboarding answers speak the same vocabulary.
 */
export type FirmProfile = {
  ibTier?: IBTier;
  coverage?: string[];
  /** Overrides the seed's headquarters, which for most curated firms was
      imported as the useless placeholder "United States". */
  headquarters?: string;
  /** Overrides the seed's keyOffices, same reason. */
  keyOffices?: string;
};

/**
 * Head office and principal offices, for firms whose seed rows carry only
 * "United States". Applied over the seeds at load, so the catalog sync's
 * update path carries them into the firms table on the next
 * `npm run db:sync-firms`.
 *
 * Scoped to the bulge brackets and elite boutiques deliberately: those are the
 * rows a student sees first, and each is a firm whose head office is a matter
 * of public record rather than a judgement call. The middle-market rows still
 * read "United States" - they are next, not done.
 */
export const FIRM_LOCATIONS: Record<string, { headquarters: string; keyOffices: string }> = {
  // Bulge bracket
  "goldman-sachs": { headquarters: "New York, NY", keyOffices: "New York - London - Hong Kong - Tokyo - Bengaluru" },
  jpmorgan: { headquarters: "New York, NY", keyOffices: "New York - London - Mumbai - Hong Kong" },
  "morgan-stanley": { headquarters: "New York, NY", keyOffices: "New York - London - Tokyo - Hong Kong" },
  citigroup: { headquarters: "New York, NY", keyOffices: "New York - London - Hong Kong - Singapore" },
  "bank-of-america": { headquarters: "Charlotte, NC", keyOffices: "Charlotte - New York - London - Hong Kong" },
  "barclays-us": { headquarters: "New York, NY (US); group HQ London", keyOffices: "New York - London" },
  "deutsche-bank-us": { headquarters: "New York, NY (US); group HQ Frankfurt", keyOffices: "New York - Frankfurt - London" },
  "ubs-incl-credit-suisse-ib-us": { headquarters: "New York, NY (US); group HQ Zurich", keyOffices: "Zurich - New York - London" },

  // Elite boutique
  jefferies: { headquarters: "New York, NY", keyOffices: "New York - London - Hong Kong" },
  evercore: { headquarters: "New York, NY", keyOffices: "New York - London - San Francisco" },
  lazard: { headquarters: "New York, NY and Paris", keyOffices: "New York - London - Paris" },
  "moelis-and-company": { headquarters: "New York, NY", keyOffices: "New York - London - Los Angeles" },
  "centerview-partners": { headquarters: "New York, NY", keyOffices: "New York - London - San Francisco" },
  "pjt-partners": { headquarters: "New York, NY", keyOffices: "New York - London" },
  "perella-weinberg-partners": { headquarters: "New York, NY", keyOffices: "New York - London" },
  "houlihan-lokey": { headquarters: "Los Angeles, CA", keyOffices: "Los Angeles - New York - London" },
  "rothschild-and-co-us": { headquarters: "New York, NY (US); group HQ Paris", keyOffices: "New York - London - Paris" },
  "guggenheim-securities": { headquarters: "New York, NY", keyOffices: "New York - Chicago" },
};

/**
 * The industry groups a full-service bank runs. Recorded explicitly rather
 * than left blank, so a healthcare student passes these banks because we know
 * they cover healthcare - not merely because we know nothing about them.
 * Blank entries still pass any coverage filter, which is right for a firm
 * nobody has researched, but it is passing by ignorance and should not be how
 * the biggest banks on the list qualify.
 */
const FULL_COVERAGE = [
  "Healthcare",
  "Technology",
  "Media & Telecom",
  "Financial Institutions",
  "Industrials",
  "Consumer & Retail",
  "Energy & Power",
  "Real Estate",
];

export const FIRM_PROFILE_OVERLAY: Record<string, FirmProfile> = {
  // --- Bulge bracket: verified coverage ------------------------------------
  "goldman-sachs": { coverage: FULL_COVERAGE },
  jpmorgan: { coverage: FULL_COVERAGE },
  "morgan-stanley": { coverage: FULL_COVERAGE },
  citigroup: { coverage: FULL_COVERAGE },
  "barclays-us": { coverage: FULL_COVERAGE },
  "deutsche-bank-us": { coverage: FULL_COVERAGE },
  "ubs-incl-credit-suisse-ib-us": { coverage: FULL_COVERAGE },

  // --- Elite boutiques: generalists ----------------------------------------
  jefferies: { coverage: FULL_COVERAGE },
  evercore: { coverage: FULL_COVERAGE },
  lazard: { coverage: FULL_COVERAGE },
  "moelis-and-company": { coverage: FULL_COVERAGE },
  "centerview-partners": { coverage: FULL_COVERAGE },
  "pjt-partners": { coverage: FULL_COVERAGE },
  "perella-weinberg-partners": { coverage: FULL_COVERAGE },
  "houlihan-lokey": { coverage: FULL_COVERAGE },
  "rothschild-and-co-us": { coverage: FULL_COVERAGE },
  "guggenheim-securities": { coverage: FULL_COVERAGE },
  "greenhill-and-co": { coverage: FULL_COVERAGE },
  "solomon-partners-fka-peter-j-solomon-company": { coverage: FULL_COVERAGE },

  // --- Elite boutiques that are NOT generalists ----------------------------
  // These are why recording coverage matters: a healthcare student widening to
  // elite boutiques should not be handed a tech-only advisor.
  "qatalyst-partners": { coverage: ["Technology"] },
  "union-square-advisors": { coverage: ["Technology"] },
  "allen-and-company": { coverage: ["Media & Telecom", "Technology"] },
  liontree: { coverage: ["Media & Telecom", "Technology"] },
  "ducera-partners": { coverage: ["Restructuring"] },
  "kbw-keefe-bruyette-woods": { coverage: ["Financial Institutions"] },

  // --- Bulge bracket -------------------------------------------------------
  // Bank of America is a bulge bracket by every reckoning and was simply
  // missing a tier, which is why a "Bulge Bracket" student saw seven banks.
  "bank-of-america": { ibTier: "bulge_bracket", coverage: FULL_COVERAGE },
  "bofa-securities": { ibTier: "bulge_bracket" },
  "barclays-investment-bank": { ibTier: "bulge_bracket" },

  // --- Large balance-sheet / corporate & investment banks ------------------
  "bnp-paribas-usa": { ibTier: "mid_market" },
  "cibc-capital-markets": { ibTier: "mid_market" },
  "macquarie-group": { ibTier: "mid_market", coverage: ["Infrastructure", "Energy & Power"] },
  "mufg-securities-americas": { ibTier: "mid_market" },
  "scotiabank-global-banking-and-markets": { ibTier: "mid_market" },
  "smbc-nikko-securities-america": { ibTier: "mid_market" },
  "td-securities": { ibTier: "mid_market" },
  "truist-securities": { ibTier: "mid_market" },
  "canaccord-genuity": { ibTier: "mid_market" },
  "cantor-fitzgerald": { ibTier: "mid_market" },
  stephens: { ibTier: "mid_market" },
  "d-a-davidson-co": { ibTier: "mid_market" },
  "roth-capital-partners": { ibTier: "mid_market" },
  "seaport-global": { ibTier: "mid_market" },
  "bgc-group": { ibTier: "mid_market" },
  chardan: { ibTier: "mid_market" },

  // --- Public finance / municipal-led broker-dealers ----------------------
  "loop-capital": { ibTier: "mid_market", coverage: ["Public Finance"] },
  "academy-securities": { ibTier: "mid_market", coverage: ["Public Finance"] },
  "blaylock-van": { ibTier: "mid_market", coverage: ["Public Finance"] },
  "siebert-williams-shank-co": { ibTier: "mid_market", coverage: ["Public Finance"] },
  "samuel-a-ramirez": { ibTier: "mid_market", coverage: ["Public Finance"] },
  "roberts-ryan": { ibTier: "mid_market", coverage: ["Public Finance"] },

  // --- Healthcare specialists ---------------------------------------------
  // Leerink's own site lists biopharma, digital health, healthcare services,
  // medical technology, and tools & diagnostics - healthcare only.
  "leerink-partners": { ibTier: "mid_market", coverage: ["Healthcare"] },
  "cain-brothers": { ibTier: "mid_market", coverage: ["Healthcare"] },
  "mts-health-partners": { ibTier: "mid_market", coverage: ["Healthcare"] },
  "provident-healthcare-partners": { ibTier: "mid_market", coverage: ["Healthcare"] },
  "edgemont-partners": { ibTier: "mid_market", coverage: ["Healthcare"] },
  "bourne-partners": { ibTier: "mid_market", coverage: ["Healthcare"] },

  // --- Technology / media specialists -------------------------------------
  // FT Partners' own site: payments, lending, wealth, insurtech, capital
  // markets tech, digital banking - fintech across financial services.
  "financial-technology-partners": {
    ibTier: "mid_market",
    coverage: ["Financial Institutions", "Technology"],
  },
  "agc-partners": { ibTier: "mid_market", coverage: ["Technology"] },
  "gp-bullhound": { ibTier: "mid_market", coverage: ["Technology"] },
  "clearsight-advisors": { ibTier: "mid_market", coverage: ["Technology"] },
  "dbo-partners": { ibTier: "mid_market", coverage: ["Technology"] },
  "berkery-noyes": { ibTier: "mid_market", coverage: ["Technology", "Media & Telecom"] },
  "progress-partners": { ibTier: "mid_market", coverage: ["Technology", "Media & Telecom"] },

  // --- Restructuring / advisory-led ---------------------------------------
  "miller-buckfire": { ibTier: "mid_market", coverage: ["Restructuring"] },
  kroll: { ibTier: "mid_market", coverage: ["Restructuring"] },
  ankura: { ibTier: "mid_market", coverage: ["Restructuring"] },
  "berkeley-research-group": { ibTier: "mid_market", coverage: ["Restructuring"] },
  "g2-capital-advisors": { ibTier: "mid_market", coverage: ["Restructuring"] },
  stout: { ibTier: "mid_market" },
  deloitte: { ibTier: "mid_market" },
  "baker-tilly-capital": { ibTier: "mid_market" },
  "bdo-capital-advisors": { ibTier: "mid_market" },
  "mercer-capital": { ibTier: "mid_market" },

  // --- Sector-focused middle-market M&A -----------------------------------
  "grace-matthews": { ibTier: "mid_market", coverage: ["Industrials"] },
  "p-m-corporate-finance": { ibTier: "mid_market", coverage: ["Industrials"] },
  "tully-holland": { ibTier: "mid_market", coverage: ["Consumer & Retail"] },
  "waller-helms-advisors": { ibTier: "mid_market", coverage: ["Financial Institutions"] },
  "matrix-capital-markets-group": { ibTier: "mid_market", coverage: ["Consumer & Retail"] },
  "silverwood-partners": { ibTier: "mid_market", coverage: ["Healthcare", "Consumer & Retail"] },
  "park-lane": { ibTier: "mid_market" },

  // --- Generalist middle-market M&A ---------------------------------------
  alantra: { ibTier: "mid_market" },
  "blackarch-partners": { ibTier: "mid_market" },
  "brown-gibbons-lang": { ibTier: "mid_market" },
  "capstone-partners": { ibTier: "mid_market" },
  "cary-street-partners": { ibTier: "mid_market" },
  "cascadia-capital": { ibTier: "mid_market" },
  "founders-advisors": { ibTier: "mid_market" },
  harvey: { ibTier: "mid_market" },
  "hennepin-partners": { ibTier: "mid_market" },
  "hyde-park-capital": { ibTier: "mid_market" },
  "intrepid-investment-bankers": { ibTier: "mid_market" },
  "livingstone-partners": { ibTier: "mid_market" },
  "the-mclean-group": { ibTier: "mid_market" },
  "zachary-scott": { ibTier: "mid_market" },

  // NOT TIERED ON PURPOSE:
  // citadel-securities is a market maker, not an investment bank. It runs no
  // M&A coverage group, so giving it a bank tier would put it in front of
  // students filtering for one. Left out so the tier filter excludes it.
};

/** Coverage focus by slug, for firms whose focus is narrow enough to filter on. */
export const FIRM_COVERAGE_BY_SLUG: Record<string, string[]> = Object.fromEntries(
  Object.entries(FIRM_PROFILE_OVERLAY)
    .filter(([, p]) => p.coverage?.length)
    .map(([slug, p]) => [slug, p.coverage!]),
);
