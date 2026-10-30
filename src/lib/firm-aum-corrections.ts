/**
 * Researched firm-wide AUM for household names, applied over the SEC figure.
 *
 * The directory's aum column comes from Form ADV filings, which report one
 * advisory ENTITY's regulatory AUM - so Goldman Sachs showed $32B (one of its
 * adviser subsidiaries) and ranked below single-office shops, while KKR,
 * Citadel and most mega funds showed nothing at all. The Firms page sorts by
 * AUM, which made the most recognisable names land at the bottom.
 *
 * Same pattern as applyLocations in firm-content.ts: corrections live in one
 * reviewable file rather than being edited into 22,000 seed rows, and the
 * seeds keep recording what the filings actually said (UNMERGED_FIRM_SEEDS is
 * untouched).
 *
 * Every figure is the firm's own published number or its press-reported AUM,
 * rounded, with what it measures and when it was taken noted per row -
 * methodologies differ (assets under supervision, regulatory AUM, committed
 * capital), and pretending they are one number would be worse than saying
 * which this is. Researched 2026-10-06; revisit roughly yearly.
 */

/** Slug (post-merge, as in FIRM_SEEDS) -> firm-wide AUM in dollars. */
export const FIRM_AUM_CORRECTIONS: Record<string, number> = {
  // --- banks and asset managers ---
  // Assets under supervision, FY2025 record ($3.61T, company reporting).
  "goldman-sachs": 3_610_000_000_000,
  // Morgan Stanley Investment Management AUM, Dec 2025 ($1.895T).
  "morgan-stanley": 1_895_000_000_000,
  // Asset & Wealth Management AUM, Dec 2025 ($4.8T).
  jpmorgan: 4_800_000_000_000,
  // Dec 2025 ($14.0T).
  blackrock: 14_000_000_000_000,
  // Global AUM, 2025 (~$11.6T).
  vanguard: 11_600_000_000_000,
  // Discretionary AUM, 2025 (~$5.5T; assets under administration are ~3x this).
  "fidelity-investments": 5_500_000_000_000,
  // State Street Investment Management, 2025 (~$4.7T).
  "state-street": 4_700_000_000_000,
  // Lazard's asset-management arm, 2025 (~$250B).
  lazard: 250_000_000_000,
  // Widely-reported firm figures, 2025: each brand's own headline number,
  // added when the sibling-entity merges (firm-merges.json) made these rows
  // the one place the brand appears.
  pimco: 2_000_000_000_000,
  "capital-group": 2_800_000_000_000,
  "franklin-templeton": 1_650_000_000_000,
  invesco: 2_000_000_000_000,
  "wellington-management": 1_200_000_000_000,

  // --- private equity ---
  // Dec 2025 ($1.3T, company reporting).
  blackstone: 1_300_000_000_000,
  // Dec 2025 ($785B).
  "apollo-global-management": 785_000_000_000,
  // Q1 2026 ($744B).
  kkr: 744_000_000_000,
  // 2025 (~$477B).
  "carlyle-group": 477_000_000_000,
  // Q4 2025 (crossed $300B).
  tpg: 300_000_000_000,
  // 2025 (~$225B; the US entity row stands for the group).
  "cvc-capital-partners-us": 225_000_000_000,
  // Firm-published, all strategies including credit (~$185B).
  "bain-capital": 185_000_000_000,
  // 2025 (~$172B).
  "thoma-bravo": 172_000_000_000,
  // Mar 2025 ($107.5B).
  "hellman-and-friedman": 107_500_000_000,
  // 2025 (~$105B).
  "warburg-pincus": 105_000_000_000,
  // 2025 (~$101B).
  "vista-equity-partners": 101_000_000_000,
  // Firm-published (~$94B).
  "advent-international": 94_000_000_000,
  // Firm-published (~$90B).
  "insight-partners": 90_000_000_000,
  // 2025 (~$80B).
  "clayton-dubilier-and-rice": 80_000_000_000,
  // 2025 (~$65B).
  "apax-partners": 65_000_000_000,
  // Brookfield Asset Management, 2025 (~$1.1T; the filed $219B was one entity).
  brookfield: 1_100_000_000_000,
  // Firm-published middle-market figures, 2024-2025 statements.
  gtcr: 40_000_000_000,
  "francisco-partners": 45_000_000_000,
  "new-mountain-capital": 55_000_000_000,
  "audax-group": 36_000_000_000,
  "leonard-green-and-partners": 75_000_000_000,

  // --- hedge funds (net AUM, press-reported, mid/late 2025) ---
  citadel: 66_000_000_000,
  "bridgewater-associates": 90_000_000_000,
  "millennium-management": 68_000_000_000,
  "point72-asset-management": 38_000_000_000,
  "two-sigma": 60_000_000_000,

  // --- venture capital (regulatory AUM from each firm's own Form ADV, which
  //     for VC includes uncalled commitments - the convention every ranking
  //     of VC firms uses) ---
  // ADV 12/31/25 ($106.5B).
  "andreessen-horowitz-a16z": 106_500_000_000,
  // ADV firm-wide 12/31/25 ($78B, venture book $41B).
  "tiger-global-management": 78_000_000_000,
  // ADV 7/6/26 ($50.5B, including Thrive X).
  "thrive-capital": 50_500_000_000,
  // ADV ($45.5B).
  "general-catalyst": 45_500_000_000,
  // Press-reported, 2025 (~$54B; runs public and private books).
  "coatue-management": 54_000_000_000,
};
