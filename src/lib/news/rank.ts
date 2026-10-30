import { SECTORS, type Sector } from "./types";

// Stage 4: how high an event sits on each tab. A formula, not a model - every
// input is already a number the classifier or the database produced, and a
// formula can be read, tuned against the golden set and explained.
//
//   score = worthiness x the sector's interest in this kind of story
//         x source tier x corroboration x firm salience x deal size x freshness
//
// Corroboration is the strongest accuracy signal there is: an event three
// outlets reported independently is far less likely to be wrong than one only
// a single trade site carried.

// Worthiness 1 ("relevant but thin") weighs nothing, so it never reaches a
// tab: a thin tab is better than one padded with stories nobody would raise.
const WORTHINESS_WEIGHT: Record<number, number> = { 4: 1, 3: 0.6, 2: 0.25, 1: 0 };
// A single outlet citing unnamed sources ranks below the same story confirmed.
const UNCONFIRMED_WEIGHT = 0.6;

/**
 * How much each sector cares about each kind of story, 0-1. Data, not logic:
 * reviewing it is reviewing what each tab is for. Unlisted types get 0.5.
 */
const STORY_TYPE_PRIORS: Record<Sector, Partial<Record<string, number>>> = {
  investment_banking: { ma: 1, ecm_ipo: 1, debt_financing: 0.8, people_move: 0.7, earnings: 0.6, strategy: 0.6, distress: 0.6, regulation: 0.5, markets_macro: 0.4, industry_trend: 0.5 },
  private_equity: { ma: 1, fund_raise: 0.9, people_move: 0.7, strategy: 0.7, debt_financing: 0.6, distress: 0.6, ecm_ipo: 0.6, industry_trend: 0.6, regulation: 0.5 },
  venture_capital: { startup_round: 1, fund_raise: 0.9, ma: 0.7, ecm_ipo: 0.7, people_move: 0.6, strategy: 0.6, industry_trend: 0.6, distress: 0.5 },
  private_credit: { debt_financing: 1, fund_raise: 0.9, distress: 0.8, ma: 0.6, strategy: 0.7, regulation: 0.6, people_move: 0.6, industry_trend: 0.7 },
  real_estate: { ma: 1, debt_financing: 0.9, fund_raise: 0.8, distress: 0.8, strategy: 0.7, industry_trend: 0.7, earnings: 0.6, people_move: 0.5 },
  hedge_fund: { activism: 1, people_move: 0.9, fund_raise: 0.8, strategy: 0.8, earnings: 0.7, markets_macro: 0.6, distress: 0.7, enforcement: 0.6, industry_trend: 0.6 },
  sales_trading: { markets_macro: 1, earnings: 0.8, people_move: 0.7, strategy: 0.6, regulation: 0.6, industry_trend: 0.6 },
  asset_wealth_management: { ma: 0.9, strategy: 0.9, fund_raise: 0.7, earnings: 0.7, people_move: 0.7, industry_trend: 0.8, regulation: 0.6 },
  commercial_banking: { earnings: 1, ma: 0.9, regulation: 0.9, distress: 0.9, enforcement: 0.7, strategy: 0.7, people_move: 0.6, markets_macro: 0.5 },
  insurance: { strategy: 0.9, ma: 0.9, earnings: 0.9, distress: 0.8, debt_financing: 0.7, industry_trend: 0.8, regulation: 0.7, people_move: 0.6 },
  fintech: { startup_round: 0.9, ma: 0.9, ecm_ipo: 0.9, strategy: 0.9, regulation: 0.8, earnings: 0.8, enforcement: 0.7, people_move: 0.6 },
  market_infrastructure: { strategy: 1, regulation: 1, ma: 0.9, earnings: 0.8, enforcement: 0.7, industry_trend: 0.7, people_move: 0.6 },
  consulting: { people_move: 1, strategy: 1, earnings: 0.9, ma: 0.8, industry_trend: 0.8 },
  // Commentary (opinion and analysis about a sector) is welcome but ranks
  // below reported events: unlisted, it takes the 0.5 default everywhere.
  other_finance: { distress: 0.9, regulation: 0.8, markets_macro: 0.8, strategy: 0.7, debt_financing: 0.7, people_move: 0.6 },
};

export type RankInput = {
  worthiness: number; // the highest any member got
  storyType: string | null;
  /** Sectors this event may appear under: labelled for it AND from a source trusted for it. */
  eligibleSectors: Sector[];
  primarySector: Sector | null;
  /** "primary" | "major" | "trade" - the best any member came from. */
  bestTier: string;
  publisherCount: number;
  salientFirm: boolean;
  amountUsd: number | null;
  firstSeenAt: Date;
  /** One outlet, rumour language, no filing or regulator behind it. See quality.ts. */
  unconfirmed?: boolean;
};

export function prior(sector: Sector, storyType: string | null): number {
  return STORY_TYPE_PRIORS[sector][storyType ?? "other"] ?? 0.5;
}

function baseScore(input: RankInput, now: Date): number {
  const worth = WORTHINESS_WEIGHT[input.worthiness] ?? 0;
  const tier = input.bestTier === "trade" ? 0.9 : 1;
  const corroboration = 1 + 0.25 * Math.min(Math.max(input.publisherCount - 1, 0), 4);
  const salience = input.salientFirm ? 1.3 : 1;
  const size = input.amountUsd ? 1 + 0.1 * Math.min(Math.max(Math.log10(input.amountUsd / 1e8), 0), 3) : 1;
  const ageHours = Math.max(0, (now.getTime() - input.firstSeenAt.getTime()) / 3_600_000);
  const freshness = Math.exp(-ageHours / 36);
  const confirmation = input.unconfirmed ? UNCONFIRMED_WEIGHT : 1;
  return worth * tier * corroboration * salience * size * freshness * confirmation;
}

/**
 * { [sector]: score, main: score } - zero is omitted, so a missing key means
 * "not on that tab". An unconfirmed event also carries `unconfirmed: 1`, which
 * is not a tab name, so no tab query ever matches it.
 */
export function scoreEvent(input: RankInput, now: Date = new Date()): Record<string, number> {
  const base = baseScore(input, now);
  const scores: Record<string, number> = {};
  for (const sector of SECTORS) {
    if (!input.eligibleSectors.includes(sector)) continue;
    const s = base * prior(sector, input.storyType);
    if (s > 0) scores[sector] = Number(s.toFixed(5));
  }
  // Main takes the event at its primary sector's interest, and only from a
  // newsroom or an official source: trade press fills its own tabs and never
  // Main, so the front page is the reporting anyone in finance would recognise.
  // An event a trade site broke reaches Main once a major covers it too.
  if (input.bestTier !== "trade" && input.primarySector && input.eligibleSectors.includes(input.primarySector)) {
    const main = base * prior(input.primarySector, input.storyType);
    if (main > 0) scores.main = Number(main.toFixed(5));
  }
  if (input.unconfirmed && Object.keys(scores).length > 0) scores.unconfirmed = 1;
  return scores;
}
