"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { getCurrentUserId } from "@/lib/current-user";
import { paidActionUser } from "@/lib/plan-access";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { practiceSessions } from "@/db/schema";
import { claimSeal, issueReceipt, releaseSeal, sealQuestion, tallyReceipts, unsealQuestion } from "@/lib/practice-seal";
import {
  finishPracticeRound,
  generatePracticeQuestion,
  gradePracticeAnswer,
  ROUND_LENGTH,
  type PracticeQuestion,
  type RoundSummary,
} from "@/lib/practice-session";
import { parseRoundConfig as parseConfig, type RawRoundConfig as RawConfig } from "@/lib/practice-config";
import type { Grade } from "@/lib/grading";
import { getRecentGamePlayers, type RecentGamePlay } from "@/lib/game-leaderboard";

export type { RecentGamePlay };

export async function getPracticeQuestion(
  config: RawConfig,
  seenPrompts: string[],
): Promise<{ question?: PracticeQuestion; error?: string }> {
  const parsed = parseConfig(config);
  if (!parsed) return { error: "Pick at least one sector to practise." };

  const user = await paidActionUser();
  if (!user) return { error: "Interview Prep is a Pro feature. Upgrade to practice." };
  const userId = user.id;
  try {
    const question = await generatePracticeQuestion({
      userId,
      config: parsed,
      seenPrompts: (seenPrompts ?? []).slice(0, ROUND_LENGTH),
    });
    return { question: sealQuestion(userId, question) };
  } catch (err) {
    console.error("practice question generation failed:", err);
    return { error: "Couldn't load a question. Try again." };
  }
}

/** What grading hands back: the grade, the answer key now that it has been
 *  answered, and the receipt the round is later tallied from. */
export type GradedAnswer = Grade & {
  currentStreak: number;
  bestStreak: number;
  /** A multiple-choice question's right option - revealed only after grading. */
  correctOption?: string;
  /** Signed proof of this grade; completePracticeRound counts only these. */
  receipt: string;
};

/** The longest answer graded - the grader reads no more than this. */
const MAX_ANSWER_CHARS = 4000;

export async function submitPracticeAnswer(
  question: PracticeQuestion,
  answer: string,
): Promise<{ grade?: GradedAnswer; error?: string }> {
  if (typeof answer !== "string" || !answer.trim()) return { error: "Write an answer before submitting." };
  // Cheapest checks first: a request can carry megabytes, and nothing below
  // should run on one that could never be graded.
  if (answer.length > MAX_ANSWER_CHARS) {
    return { error: `Keep your answer under ${MAX_ANSWER_CHARS.toLocaleString()} characters.` };
  }

  const user = await paidActionUser();
  if (!user) return { error: "Interview Prep is a Pro feature. Upgrade to practice." };
  const userId = user.id;
  // Graded only against a question this server served to this student, with
  // the answer key it was served with (lib/practice-seal), and each question once.
  const opened = unsealQuestion(userId, question);
  if (!opened) return { error: "That question has expired. Load a new one." };

  const blocked = blockedLanguageError([["Your answer", answer]]);
  if (blocked) return { error: blocked };

  if (!(await claimSeal(userId, opened.issuedAt))) return { error: "That question has already been graded." };
  try {
    const grade = await gradePracticeAnswer({ userId, question: opened.question, answer: answer.trim() });
    return {
      grade: {
        ...grade,
        ...(opened.question.correctOption ? { correctOption: opened.question.correctOption } : {}),
        receipt: issueReceipt(userId, opened.issuedAt, grade.points, grade.passed),
      },
    };
  } catch (err) {
    await releaseSeal(userId, opened.issuedAt).catch(() => {});
    console.error("practice grading failed:", err);
    return { error: "Couldn't grade that answer. Try again." };
  }
}

/**
 * Saves a finished round. Its score, answer count and best streak are worked
 * out here from the receipts grading issued - never taken from the browser,
 * whose numbers land on classmates' leaderboards and the feed.
 */
export async function completePracticeRound(
  config: RawConfig,
  receipts: string[],
): Promise<{ summary?: RoundSummary; error?: string }> {
  const parsed = parseConfig(config);
  if (!parsed) return { error: "Round configuration was invalid." };

  const user = await paidActionUser();
  if (!user) return { error: "Interview Prep is a Pro feature. Upgrade to practice." };
  const userId = user.id;
  try {
    // A receipt counts toward one round only: the round after the last one saved.
    const db = await getDb();
    const [previous] = await db
      .select({ at: practiceSessions.createdAt })
      .from(practiceSessions)
      .where(eq(practiceSessions.userId, userId))
      .orderBy(desc(practiceSessions.createdAt))
      .limit(1);
    const tally = tallyReceipts(userId, receipts, previous?.at ?? null, ROUND_LENGTH);
    if (!tally) return { error: "Nothing in this round was graded." };

    const summary = await finishPracticeRound({
      userId,
      config: parsed,
      score: tally.score,
      questionsAnswered: tally.questionsAnswered,
      bestStreakInRound: tally.bestStreak,
      // The round this tally was counted against. finishPracticeRound refuses
      // to save a tally that a competing round has already superseded, which
      // closes the sub-millisecond window where two saves each counted the
      // same receipts.
      countedAfter: previous?.at ?? null,
    });
    return { summary };
  } catch (err) {
    console.error("finishing practice round failed:", err);
    return { error: "Couldn't save that round." };
  }
}

// The platformer game's own "recently played" feed - see game-leaderboard.ts
// for why this is recency-ordered rather than a school-wide, all-time board.
export async function fetchRecentGamePlayers(): Promise<{ players: RecentGamePlay[] }> {
  const userId = await getCurrentUserId();
  const players = await getRecentGamePlayers({ userId, limit: 8 });
  return { players };
}
