// Shared vocabulary for the question bank. Kept free of any server-only import
// so client components can pull the labels and difficulty list straight from here.

// A practice round is a fixed ten questions. Fixed length is what makes a
// personal best mean anything - with an open-ended round the high score would
// only measure who kept going the longest. It lives here, with the rest of the
// shared vocabulary, so the client round UI and the server round builder agree
// on it rather than each declaring their own ten.
export const ROUND_LENGTH = 10;
export const POINTS_PER_QUESTION = 10;
export const MAX_ROUND_SCORE = ROUND_LENGTH * POINTS_PER_QUESTION;

export type QuizDifficulty = "foundational" | "intermediate" | "advanced";

/** The four options a multiple-choice question offers.
 *
 *  Authored by hand in the bank rather than generated, so no model call is
 *  needed to serve or to mark an MC question - the format is free to run.
 *
 *  Distractor CLOSENESS is matched to the question's own difficulty tier,
 *  which is what makes difficulty scale properly for this format. Recognising
 *  an answer is easier than producing one, so an advanced MC question earns its
 *  tier through near-miss options (EBIT vs EBITDA) while a foundational one
 *  uses plainly different concepts (EBIT vs WACC). Same tier, same effort. */
export type QuestionChoices = {
  /** The correct option, phrased as a short answer rather than a full essay. */
  answer: string;
  /** Exactly three wrong options, closeness matched to the question's tier. */
  distractors: [string, string, string];
};

export type TechnicalQuestion = {
  /** Stable id from the authored bank, e.g. "investment_banking.restructuring.t004". */
  id?: string;
  topic: string;
  prompt: string;
  /** Present only on questions that can also be asked as multiple choice.
   *  Questions without it are written-only and are skipped in an MC round. */
  choices?: QuestionChoices;
  // What a strong answer has to contain. Used to ground the grader so feedback
  // is measured against the real bar rather than the model's impression.
  // Written as concepts, not phrasing - the grader matches on meaning, so a
  // student who says the same thing in their own words still gets the credit.
  expectedPoints: string[];
  difficulty: QuizDifficulty;
  /** The specialty within its sector, from QUIZ_SPECIALTIES ("Restructuring",
   *  "Direct Lending"). Absent means a general question for the whole sector,
   *  served whichever specialty the student picked. */
  specialty?: string;
};

// Every sector a student can pick in the app, in the same order as the
// firm_program_category enum, so a quiz category is always a valid value for
// the sector columns it is written to.
export const QUIZ_CATEGORIES = [
  "investment_banking",
  "private_equity",
  "venture_capital",
  "private_credit",
  "real_estate",
  "hedge_fund",
  "sales_trading",
  "asset_wealth_management",
  "commercial_banking",
  "insurance",
  "fintech",
  "market_infrastructure",
  "consulting",
  "other_finance",
] as const;

export type QuizCategory = (typeof QUIZ_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<QuizCategory, string> = {
  investment_banking: "Investment Banking",
  private_equity: "Private Equity",
  venture_capital: "Venture Capital",
  private_credit: "Private Credit",
  real_estate: "Real Estate",
  hedge_fund: "Hedge Fund",
  sales_trading: "Sales & Trading",
  asset_wealth_management: "Asset & Wealth Management",
  commercial_banking: "Commercial Banking",
  insurance: "Insurance",
  fintech: "Fintech",
  market_infrastructure: "Market Infrastructure",
  consulting: "Consulting",
  other_finance: "Corporate & Other Finance",
};

// How a round asks its questions. Written is the original behaviour: the
// student types an answer and a model grades it. Multiple choice is marked
// deterministically - no model call, so it is both instant and free.
export const PRACTICE_FORMATS = ["written", "multiple_choice", "mixed"] as const;
export type PracticeFormat = (typeof PRACTICE_FORMATS)[number];

export const FORMAT_LABELS: Record<PracticeFormat, string> = {
  written: "Written",
  multiple_choice: "Multiple choice",
  mixed: "Mixed",
};

export const QUIZ_DIFFICULTIES: QuizDifficulty[] = ["foundational", "intermediate", "advanced"];

export const DIFFICULTY_LABELS: Record<QuizDifficulty, string> = {
  foundational: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

// How strictly an answer is marked. The scoring rubric behind each level lives
// in lib/technical-quiz; the names live here because this module is safe to
// import from client components and that one is server-only.
export const GRADING_LEVELS = ["lenient", "medium", "harsh"] as const;
export type GradingLevel = (typeof GRADING_LEVELS)[number];

export const GRADING_LEVEL_LABELS: Record<GradingLevel, string> = {
  lenient: "Lenient",
  medium: "Medium",
  harsh: "Harsh",
};
