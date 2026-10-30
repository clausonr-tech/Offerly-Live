import "server-only";

// Scoring policy, shared by the technical and behavioral graders so a point
// means the same thing in both.
//
// Grading is deliberately split in two. A model decides only which of the
// expected concepts the candidate actually conveyed - in any wording - and
// whether anything they said is factually wrong. The three strictness levels
// are then applied here, in code. Scoring is arithmetic, not judgement, and
// keeping it out of the prompt buys three things: harsh <= medium <= lenient is
// guaranteed rather than hoped for, the thresholds can be retuned without
// re-tuning a prompt, and one model call produces all three scores instead of
// three calls disagreeing with each other.

import { GRADING_LEVELS, type GradingLevel, type QuizDifficulty } from "./question-bank/types";

// The difficulty a student picks *is* the strictness they're graded at, so the
// number they see means something concrete: pass an advanced question and you
// cleared the bar a picky interviewer would apply, not a generous one.
const DIFFICULTY_TO_LEVEL: Record<QuizDifficulty, GradingLevel> = {
  foundational: "lenient",
  intermediate: "medium",
  advanced: "harsh",
};

type Rubric = {
  /** Coverage ratio that already earns full marks. */
  fullCreditAt: number;
  /** Exponent on the coverage ratio. Above 1 punishes each gap steeply. */
  curve: number;
  /** Coverage ratio required to pass. */
  passAt: number;
  /** Points deducted per factual error. */
  errorPenalty: number;
  /** Error count at which a pass is refused outright. */
  errorsBlockPassAt: number;
};

export const RUBRICS: Record<GradingLevel, Rubric> = {
  // "Did they have the right idea?" - about half the concepts is a good answer,
  // and four fifths is full marks. Forgives omissions, not being wrong.
  lenient: { fullCreditAt: 0.8, curve: 1, passAt: 0.5, errorPenalty: 2, errorsBlockPassAt: 2 },
  // Roughly the bar an interviewer actually applies: most of it, and correct.
  medium: { fullCreditAt: 1, curve: 1, passAt: 0.7, errorPenalty: 3, errorsBlockPassAt: 1 },
  // Nothing gets through. The squared curve means one missed concept out of
  // five costs about a third of the score, not a fifth.
  harsh: { fullCreditAt: 1, curve: 2, passAt: 1, errorPenalty: 4, errorsBlockPassAt: 1 },
};

export type Grade = {
  verdict: string;
  feedback: string;
  covered: string[];
  missed: string[];
  errors: string[];
  /** The strictness applied, derived from the question's own difficulty. */
  level: GradingLevel;
  /** Out of 10, at `level`. */
  score: number;
  /** Points toward the round - the same number, so a ten-question round is
   *  out of 100. */
  points: number;
  /** Whether this answer extends the student's streak. */
  passed: boolean;
  /** All three strictnesses, kept for attempt history and analytics even
   *  though only `level` is surfaced. Computing them is free arithmetic. */
  allScores: Record<GradingLevel, number>;
};

function applyRubric(rubric: Rubric, coverage: number, errorCount: number) {
  const ratio = Math.min(1, coverage / rubric.fullCreditAt);
  const raw = 10 * Math.pow(ratio, rubric.curve);
  const score = Math.max(0, Math.min(10, Math.round(raw - rubric.errorPenalty * errorCount)));
  const passed = coverage >= rubric.passAt && errorCount < rubric.errorsBlockPassAt;
  return { score, passed };
}

/**
 * Turns a model's raw judgement - which expected points were covered, and what
 * was stated wrongly - into the three scored levels plus the round points.
 *
 * `coveredIndices` are 1-based into `expected` and are clamped here rather than
 * trusted: a hallucinated index would otherwise push coverage above 100%.
 */
export function buildGrade(input: {
  expected: string[];
  coveredIndices: number[];
  errors: string[];
  verdict: string;
  feedback: string;
  /** The question's own difficulty, which selects the strictness applied. */
  difficulty: QuizDifficulty;
}): Grade {
  const { expected } = input;

  const coveredIdx = [...new Set(input.coveredIndices)]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= expected.length)
    .sort((a, b) => a - b);

  const covered = coveredIdx.map((n) => expected[n - 1]);
  const missed = expected.filter((_, i) => !coveredIdx.includes(i + 1));
  const coverage = expected.length === 0 ? 0 : coveredIdx.length / expected.length;
  const errors = input.errors ?? [];

  const allScores = Object.fromEntries(
    GRADING_LEVELS.map((level) => [level, applyRubric(RUBRICS[level], coverage, errors.length).score]),
  ) as Record<GradingLevel, number>;

  const level = DIFFICULTY_TO_LEVEL[input.difficulty];
  const { score, passed } = applyRubric(RUBRICS[level], coverage, errors.length);

  return {
    verdict: input.verdict,
    feedback: input.feedback,
    covered,
    missed,
    errors,
    level,
    score,
    points: score,
    passed,
    allScores,
  };
}
