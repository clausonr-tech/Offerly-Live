import type { FirmProgramCategory } from "./firm-metadata";

// Extra, sector-specific follow-up questions shown in onboarding in addition
// to the standard niche-coverage picker for that sector. These target the
// single biggest lever for narrowing down firms within each sector — e.g.
// bank tier for IB (43 firms), fund tier for PE (53 firms) — so answers here
// feed directly into firm matching/filtering, not just a profile tag.
export type TierQuestion = {
  key: "ibTierPreferences" | "peTierPreferences";
  title: string;
  subtitle?: string;
  options: string[];
};

// Note: no "Not sure yet" option here on purpose. The onboarding wizard adds
// an explicit unsure chip to these questions, and only that path records the
// answer into users.onboardingUnsure - an option string would just look the
// same to the user while silently dropping the signal.
export const SECTOR_TIER_QUESTIONS: Partial<Record<FirmProgramCategory, TierQuestion>> = {
  investment_banking: {
    key: "ibTierPreferences",
    title: "What type of investment bank appeals to you most?",
    subtitle:
      "This narrows down firms more than anything else. Pick every type you'd genuinely consider.",
    options: ["Bulge Bracket", "Elite Boutique", "Middle-Market"],
  },
  private_equity: {
    key: "peTierPreferences",
    title: "What size and type of fund are you targeting?",
    subtitle: "Mega-funds, middle-market buyout, growth equity, and venture capital are very different worlds.",
    options: ["Mega-Fund", "Middle-Market", "Growth Equity", "Venture Capital"],
  },
};

// Friendlier, category-specific wording for the standard niche-coverage
// question, in place of one generic "What area of X..." phrasing for every
// sector.
export const NICHE_QUESTION_TITLES: Partial<Record<FirmProgramCategory, string>> = {
  investment_banking: "Which product or coverage group are you targeting?",
  private_equity: "Which investing strategy interests you?",
  real_estate: "Which side of real estate are you focused on?",
  hedge_fund: "Which hedge fund strategy interests you most?",
  sales_trading: "Which desk are you targeting?",
  asset_wealth_management: "Which track interests you most?",
  consulting: "Which kind of consulting are you targeting?",
  other_finance: "Which area are you exploring?",
};
