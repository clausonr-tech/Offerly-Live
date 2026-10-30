import type { QuestionChoices } from "../types";

// Multiple-choice options kept apart from their questions, keyed by the
// question's exact prompt.
//
// Empty: the previous bank and its options were removed on 23 September 2026
// and are being rewritten from scratch. A new question can carry its options
// inline on its own `choices` field instead, which the round builder reads
// first - this map only exists for options authored separately.
//
// DISTRACTOR CLOSENESS IS MATCHED TO THE QUESTION'S TIER. That is what makes
// difficulty mean something in a format where you only have to recognise the
// answer, not produce it:
//   foundational - wrong options are a different concept entirely
//   intermediate - wrong options are the right shape but wrong in one step
//   advanced     - wrong options are near-misses a half-prepared candidate
//                  would pick, separated by a single detail
//
// Only technical questions take options. Behavioural questions are
// written-only by nature - they have no correct option.
//
// A round is ten questions drawn from one difficulty, so every sector needs at
// least ten questions with options per tier or the round repeats itself and
// then falls back to a generated written question. `npx tsx
// scripts/check-choices.ts` reports that floor.
export const QUESTION_CHOICES: Record<string, QuestionChoices> = {};

// Technical questions deliberately left written-only, with the reason. Listed
// rather than silently absent so the coverage check can tell an intentional
// omission from one nobody has got to yet.
export const WRITTEN_ONLY_PROMPTS: Record<string, string> = {};
