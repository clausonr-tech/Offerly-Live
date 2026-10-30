import "server-only";

// The interview question bank: every sector's technical questions, and the
// behavioral questions for all of them, loaded from src/lib/question-bank/data.
//
// Server-only because it is several megabytes of questions. Client components
// take the labels and lists from ./question-bank/types and
// ./question-bank/specialties, which carry no questions.
//
// Written from scratch in September 2026, in original wording (see
// question-bank-draft/GENERATION-PROMPT.md). The data files are generated: edit
// the drafts in question-bank-draft/, then run
// `npx tsx scripts/import-question-bank.ts`.
//
// The quiz layers AI-generated variations on top of this bank (see
// technical-quiz.ts), so students get variety without the question set drifting
// away from what interviewers actually ask.

import type { BehavioralQuestion } from "./question-bank/behavioral";
import type { QuizCategory, TechnicalQuestion } from "./question-bank/types";

import assetWealthManagement from "./question-bank/data/asset_wealth_management.json";
import commercialBanking from "./question-bank/data/commercial_banking.json";
import consulting from "./question-bank/data/consulting.json";
import fintech from "./question-bank/data/fintech.json";
import hedgeFund from "./question-bank/data/hedge_fund.json";
import insurance from "./question-bank/data/insurance.json";
import investmentBanking from "./question-bank/data/investment_banking.json";
import marketInfrastructure from "./question-bank/data/market_infrastructure.json";
import otherFinance from "./question-bank/data/other_finance.json";
import privateCredit from "./question-bank/data/private_credit.json";
import privateEquity from "./question-bank/data/private_equity.json";
import realEstate from "./question-bank/data/real_estate.json";
import salesTrading from "./question-bank/data/sales_trading.json";
import universalBehavioral from "./question-bank/data/universal-behavioral.json";
import ventureCapital from "./question-bank/data/venture_capital.json";

export type {
  QuizCategory,
  QuizDifficulty,
  TechnicalQuestion,
  GradingLevel,
} from "./question-bank/types";

export {
  QUIZ_CATEGORIES,
  CATEGORY_LABELS,
  QUIZ_DIFFICULTIES,
  DIFFICULTY_LABELS,
  GRADING_LEVELS,
  GRADING_LEVEL_LABELS,
} from "./question-bank/types";

export { QUIZ_SPECIALTIES, isSpecialtyOf } from "./question-bank/specialties";

/** One sector's data file, as scripts/import-question-bank.ts writes it. */
type SectorData = {
  technical: TechnicalQuestion[];
  behavioral: Omit<BehavioralQuestion, "sector">[];
};

// Cast through unknown: the importer has already validated the shape, and
// letting TypeScript infer a literal type for megabytes of JSON costs more
// than it checks.
const DATA = {
  investment_banking: investmentBanking,
  private_equity: privateEquity,
  venture_capital: ventureCapital,
  private_credit: privateCredit,
  real_estate: realEstate,
  hedge_fund: hedgeFund,
  sales_trading: salesTrading,
  asset_wealth_management: assetWealthManagement,
  commercial_banking: commercialBanking,
  insurance,
  fintech,
  market_infrastructure: marketInfrastructure,
  consulting,
  other_finance: otherFinance,
} as unknown as Record<QuizCategory, SectorData>;

export const QUESTION_BANK: Record<QuizCategory, TechnicalQuestion[]> = Object.fromEntries(
  Object.entries(DATA).map(([category, data]) => [category, data.technical]),
) as Record<QuizCategory, TechnicalQuestion[]>;

/** Every behavioral question: the universal ones (no sector), then each
 *  sector's own, tagged with the sector they belong to. */
export const BEHAVIORAL_BANK: BehavioralQuestion[] = [
  ...(universalBehavioral as unknown as { behavioral: BehavioralQuestion[] }).behavioral,
  ...Object.entries(DATA).flatMap(([sector, data]) =>
    data.behavioral.map((q) => ({ ...q, sector: sector as QuizCategory })),
  ),
];

/**
 * A sector's technical questions, in the order a round should draw on them.
 *
 * With no specialty picked, one pool: the whole sector. With specialties
 * picked, those specialties' own questions first, then the sector's general
 * questions, then the rest of the sector - so a specialty whose questions run
 * out at some difficulty (few advanced questions have one right answer, so
 * few are multiple choice) tops the round up from the same sector rather than
 * repeating itself.
 */
export function questionPools(category: QuizCategory, specialties?: readonly string[]): TechnicalQuestion[][] {
  const all = QUESTION_BANK[category] ?? [];
  if (!specialties || specialties.length === 0) return [all];
  const picked = all.filter((q) => q.specialty && specialties.includes(q.specialty));
  const general = all.filter((q) => !q.specialty);
  const rest = all.filter((q) => q.specialty && !specialties.includes(q.specialty));
  return [picked, general, rest].filter((pool) => pool.length > 0);
}

/** A sector's questions, narrowed to the specialties asked for - the first
 *  pool from questionPools that has anything in it. */
export function questionsFor(category: QuizCategory, specialties?: readonly string[]): TechnicalQuestion[] {
  return questionPools(category, specialties)[0] ?? [];
}

/**
 * Behavioral questions for a round. The universal ones always; with sectors
 * picked, those sectors' general behaviorals too, plus the behaviorals of any
 * specialty picked inside them.
 */
export function behavioralPool(
  categories: readonly QuizCategory[],
  specialties: Partial<Record<QuizCategory, readonly string[]>> = {},
): BehavioralQuestion[] {
  return BEHAVIORAL_BANK.filter((q) => {
    if (!q.sector) return true;
    if (!categories.includes(q.sector)) return false;
    if (!q.specialty) return true;
    return (specialties[q.sector] ?? []).includes(q.specialty);
  });
}
