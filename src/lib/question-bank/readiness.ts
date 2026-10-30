import type { QuizDifficulty } from "./types";

// Onboarding asks how far along the student is technically. Without this the
// quiz served a random difficulty, so someone who answered "I haven't started"
// could open on an advanced LBO question and bounce. Only used when the student
// hasn't explicitly chosen a difficulty themselves - an explicit pick always wins.
//
// Its own module (not technical-quiz.ts) so callers that must not load the
// static question bank - the video coach reads questions from the database -
// can use it.
const READINESS_DIFFICULTY: Record<string, QuizDifficulty> = {
  "I haven't started": "foundational",
  "I've read a guide or two": "foundational",
  "I'm working through it now": "intermediate",
  "I can walk through a DCF": "intermediate",
  "I could handle a technical interview today": "advanced",
};

export function defaultDifficultyFor(technicalReadiness?: string | null): QuizDifficulty | undefined {
  if (!technicalReadiness) return undefined;
  return READINESS_DIFFICULTY[technicalReadiness];
}
