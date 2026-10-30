import "server-only";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { technicalQuizAttempts } from "@/db/schema";
import { runAiFeature } from "./ai-runner";
import { findBlockedLanguage } from "./content-limits";
import { outputConfigFor } from "./model-registry";
import { defaultDifficultyFor } from "./question-bank/readiness";
import {
  CATEGORY_LABELS,
  questionPools,
  type QuizCategory,
  type QuizDifficulty,
  type TechnicalQuestion,
} from "./technical-question-bank";

// Hybrid question sourcing: a curated bank supplies the backbone, and Claude
// produces a variation on the chosen seed so a student working through the same
// sector repeatedly doesn't see identical prompts. The seed's expected points
// travel with the variation, which keeps grading anchored to the real bar
// rather than to whatever the model happened to invent.

const variationSchema = z.object({
  prompt: z.string(),
  expectedPoints: z.array(z.string()).min(3).max(6),
});

export type QuizQuestion = {
  topic: string;
  difficulty: QuizDifficulty;
  prompt: string;
  expectedPoints: string[];
};

// The onboarding-readiness mapping lives in question-bank/readiness so the
// video coach can use it without loading this module's static bank.
export { defaultDifficultyFor };

function pickSeed(
  category: QuizCategory,
  specialties: readonly string[] | undefined,
  recentPrompts: string[],
  difficulty?: QuizDifficulty,
): TechnicalQuestion | null {
  // The first pool (specialty, then the sector's general questions, then the
  // rest of it) with anything at this difficulty.
  const pool =
    questionPools(category, specialties)
      .map((p) => p.filter((q) => !difficulty || q.difficulty === difficulty))
      .find((p) => p.length > 0) ?? [];
  if (pool.length === 0) return null;

  // Prefer topics the student hasn't just seen, so a short session spreads
  // across accounting/valuation/M&A rather than hammering one topic.
  const recent = new Set(recentPrompts);
  const unseen = pool.filter((q) => !recent.has(q.topic));
  const candidates = unseen.length > 0 ? unseen : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export async function generateTechnicalQuestion(input: {
  userId: string;
  category: QuizCategory;
  /** The specialties inside the sector to draw from. Empty or absent is the
   *  whole sector. */
  specialties?: readonly string[];
  difficulty?: QuizDifficulty;
  /** From onboarding. Used only when `difficulty` is not set explicitly. */
  technicalReadiness?: string | null;
}): Promise<QuizQuestion> {
  const db = await getDb();

  const recent = await db.query.technicalQuizAttempts.findMany({
    where: and(
      eq(technicalQuizAttempts.userId, input.userId),
      eq(technicalQuizAttempts.category, input.category),
    ),
    orderBy: [desc(technicalQuizAttempts.createdAt)],
    limit: 5,
    columns: { topic: true },
  });

  const effectiveDifficulty = input.difficulty ?? defaultDifficultyFor(input.technicalReadiness);
  const seed = pickSeed(
    input.category,
    input.specialties,
    recent.map((r) => r.topic),
    effectiveDifficulty,
  );
  if (!seed) {
    throw new Error(
      input.difficulty
        ? `No ${input.difficulty} questions available for that sector yet.`
        : "No questions available for that sector yet.",
    );
  }

  try {
    const response = await runAiFeature(
      { feature: "technicalQuestion", userId: input.userId },
      (client, cfg) =>
        client.messages.parse({
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          output_config: outputConfigFor(cfg, { format: zodOutputFormat(variationSchema) }),
          system:
            "You write technical interview questions for undergraduate finance recruiting. " +
            "You will be given a real interview question and the points a strong answer must hit. " +
            "Produce a VARIATION on it: same topic, same difficulty, same underlying concept being tested, " +
            "but different specifics - change the numbers, the framing, the company situation, or the angle of attack. " +
            "The variation must be a question a real interviewer would plausibly ask. Do not make it harder or easier than the original. " +
            "Return the new prompt and the 3-6 points a strong answer to YOUR version must cover. " +
            "Never include the answer in the prompt itself.",
          messages: [
            {
              role: "user",
              content: `Sector: ${CATEGORY_LABELS[input.category]}\nTopic: ${seed.topic}\nDifficulty: ${seed.difficulty}\n\nOriginal question:\n${seed.prompt}\n\nPoints a strong answer covers:\n${seed.expectedPoints.map((p) => `- ${p}`).join("\n")}\n\nWrite a variation.`,
            },
          ],
        }),
    );

    const variation = response.parsed_output;
    // What the model wrote is shown to the student, so it is checked like
    // anything a person typed. A variation that trips the check is dropped for
    // the bank question it was based on, which was written and checked by hand.
    if (
      response.stop_reason !== "refusal" &&
      variation &&
      !findBlockedLanguage([variation.prompt, ...variation.expectedPoints].join("\n"))
    ) {
      return {
        topic: seed.topic,
        difficulty: seed.difficulty,
        prompt: variation.prompt,
        expectedPoints: variation.expectedPoints,
      };
    }
  } catch (err) {
    // Quota exhaustion or a model hiccup shouldn't block practice - the
    // curated bank is a perfectly good question set on its own.
    console.error("technical question variation failed, using bank entry:", err);
  }

  return {
    topic: seed.topic,
    difficulty: seed.difficulty,
    prompt: seed.prompt,
    expectedPoints: seed.expectedPoints,
  };
}
