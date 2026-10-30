import type { QuizCategory, QuizDifficulty } from "./types";

// The shape of a behavioral question in the practice round. The questions
// themselves are loaded, server-side, by lib/technical-question-bank
// (BEHAVIORAL_BANK): the universal ones every interview asks, and each sector's
// and specialty's own.
//
// expectedPoints describe what a *good answer contains*, not facts to recall.
// The grader matches on meaning, so a student telling their own story in their
// own words scores full marks as long as the substance is present.

export type BehavioralQuestion = {
  /** Stable id from the authored bank, e.g. "universal.behavioral.b004". */
  id?: string;
  category: string;
  prompt: string;
  expectedPoints: string[];
  difficulty: QuizDifficulty;
  /** The sector a question is specific to ("why private credit?"). Absent
   *  means it is asked in every sector. */
  sector?: QuizCategory;
  /** The specialty within that sector, from QUIZ_SPECIALTIES. Absent means
   *  the whole sector. */
  specialty?: string;
};

