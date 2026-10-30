import type { QuizCategory } from "./types";

// The specialties inside each sector - the site's one list of them. The
// practice page lists them when a student opens a sector, so they can study
// Restructuring rather than all of banking at once; onboarding and the
// profile's Interests page offer the same list (lib/niche-sectors builds its
// groups from this), so a student's profile and their practice describe the
// same group the same way.
//
// Renaming one orphans it everywhere it is stored: students' saved
// nicheInterests, and every question in the bank tagged with it. A question's
// `specialty` must be one of these strings exactly, or it will never be served
// to a student who picked that specialty.
export const QUIZ_SPECIALTIES: Record<QuizCategory, readonly string[]> = {
  investment_banking: [
    "M&A Advisory",
    "Leveraged Finance",
    "Equity Capital Markets (ECM)",
    "Debt Capital Markets (DCM)",
    "Restructuring",
    "TMT Coverage",
    "Healthcare Coverage",
    "Energy & Power Coverage",
    "Consumer & Retail Coverage",
    "Financial Institutions (FIG) Coverage",
    "Industrials Coverage",
    "Real Estate Coverage",
    "Natural Resources",
  ],
  private_equity: [
    "Buyout / LBO",
    "Distressed / Special Situations",
    "Infrastructure",
    "Secondaries",
    "Fund of Funds",
  ],
  venture_capital: [
    "Seed & Early Stage",
    "Growth Stage",
    "Growth Equity",
    "Corporate Venture Capital",
  ],
  private_credit: [
    "Direct Lending",
    "Mezzanine & Structured Credit",
    "Distressed & Special Situations Credit",
    "Asset-Based Lending",
  ],
  real_estate: [
    "Real Estate Private Equity",
    "REIT Investing",
    "Real Estate Investment Banking",
    "Real Estate Debt / Lending",
    "Real Estate Development",
    "Real Estate Brokerage",
  ],
  hedge_fund: [
    "Long/Short Equity",
    "Global Macro",
    "Quantitative / Systematic",
    "Credit & Distressed",
    "Event-Driven / Merger Arb",
    "Multi-Strategy",
    "Commodities Trading",
  ],
  sales_trading: [
    "Equities Trading",
    "Fixed Income Trading",
    "FX Trading",
    "Commodities Trading",
    "Derivatives / Structured Products",
    "Electronic / Algo Trading",
  ],
  asset_wealth_management: [
    "Public Equities AM",
    "Fixed Income AM",
    "Multi-Asset / Allocation",
    "Private Wealth Management",
    "Institutional Client Coverage",
  ],
  commercial_banking: [
    "Corporate & Middle-Market Lending",
    "Credit Analysis & Underwriting",
    "Treasury & Cash Management",
    "Commercial Real Estate Lending",
  ],
  insurance: [
    "Underwriting",
    "Actuarial",
    "Insurance Investment Management",
    "Reinsurance",
  ],
  fintech: [
    "Payments",
    "Digital Lending",
    "Wealthtech & Brokerage",
    "Crypto & Digital Assets",
  ],
  market_infrastructure: [
    "Exchanges & Trading Venues",
    "Clearing & Settlement",
    "Market Data & Indices",
    "Custody & Securities Services",
  ],
  consulting: [
    "Strategy Consulting",
    "Management Consulting (generalist)",
    "Operations & Performance Improvement",
    "Restructuring & Turnaround",
    "Deals / Transaction Services",
    "Economic & Financial Consulting",
    "Actuarial & Risk Consulting",
    "Technology & Digital Consulting",
  ],
  other_finance: [
    "Corporate Finance / FP&A",
    "Corporate Development",
    "Treasury",
    "Credit Ratings & Research",
  ],
};

// Specialties that were folded into another, by their old label. A student's
// saved nicheInterests keep whatever label they picked, so an old one is read
// as its replacement rather than silently matching nothing.
//
// "Media & Telecom" sat beside "TMT Coverage", which already is technology,
// media and telecom - two chips for one group. Its questions moved into TMT.
export const RETIRED_SPECIALTIES: Record<string, string> = {
  "Media & Telecom": "TMT Coverage",
};

/** A saved specialty label, as the list names it today. */
export function currentSpecialty(label: string): string {
  return RETIRED_SPECIALTIES[label] ?? label;
}

/** Saved specialty labels mapped to today's names, deduped. */
export function currentSpecialties(labels: readonly string[] | null | undefined): string[] {
  return [...new Set((labels ?? []).map(currentSpecialty))];
}

export function isSpecialtyOf(category: QuizCategory, specialty: string): boolean {
  return QUIZ_SPECIALTIES[category]?.includes(specialty) ?? false;
}
