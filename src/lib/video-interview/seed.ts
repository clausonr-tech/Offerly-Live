import "server-only";

import { inArray, sql } from "drizzle-orm";
import { interviewQuestions } from "@/db/schema";
import { BEHAVIORAL_BANK, QUESTION_BANK } from "../technical-question-bank";
import { QUIZ_CATEGORIES } from "../question-bank/types";

/**
 * Imports the authored question bank (src/lib/question-bank/data) into
 * interview_questions. The ONLY place the video coach touches the static bank:
 * at runtime every question comes from the database.
 *
 * Idempotent by construction: an upsert keyed by the authored stable id.
 * Re-running it updates wording, metadata and grading criteria in place,
 * inserts questions that are new, and never deletes or duplicates a row. It
 * deliberately does NOT touch `active` - a question someone retired stays
 * retired through a re-seed.
 */

/** Opens every interview that has a behavioral question. */
export const BEHAVIORAL_ANCHOR_ID = "universal.behavioral.b001";

/**
 * The rotating behavioral core, in rotation order: motivation, then the STAR
 * stories (leadership, teamwork, challenge, failure, initiative, integrity),
 * then strengths and weaknesses. All universal - asked in every sector.
 */
export const BEHAVIORAL_CORE_IDS = [
  "universal.behavioral.b002", // Why finance?
  "universal.behavioral.b070", // A time you led
  "universal.behavioral.b047", // A group project and your role
  "universal.behavioral.b093", // A challenge you overcame
  "universal.behavioral.b094", // A time you failed
  "universal.behavioral.b072", // Initiative without being asked
  "universal.behavioral.b116", // Honesty when it was uncomfortable
  "universal.behavioral.b027", // Greatest strength
  "universal.behavioral.b028", // A weakness you're working on
] as const;

export type SeedRow = typeof interviewQuestions.$inferInsert;

/** Every authored question as a row. Throws on an authored question without
 *  a stable id - an id-less row could never be updated in place. */
export function authoredQuestionRows(): SeedRow[] {
  const coreRank = new Map<string, number>([[BEHAVIORAL_ANCHOR_ID, 0], ...BEHAVIORAL_CORE_IDS.map((id, i) => [id, i + 1] as [string, number])]);
  const rows: SeedRow[] = [];
  for (const category of QUIZ_CATEGORIES) {
    for (const q of QUESTION_BANK[category] ?? []) {
      if (!q.id) throw new Error(`Authored technical question without an id: ${q.prompt.slice(0, 60)}`);
      rows.push({
        id: q.id,
        kind: "technical",
        prompt: q.prompt,
        topic: q.topic,
        category,
        specialty: q.specialty ?? null,
        difficulty: q.difficulty,
        expectedPoints: q.expectedPoints,
        isBehavioralCore: false,
        rotationPriority: 0,
        source: "authored",
      });
    }
  }
  for (const q of BEHAVIORAL_BANK) {
    if (!q.id) throw new Error(`Authored behavioral question without an id: ${q.prompt.slice(0, 60)}`);
    const rank = coreRank.get(q.id);
    rows.push({
      id: q.id,
      kind: "behavioral",
      prompt: q.prompt,
      topic: q.category,
      category: q.sector ?? null,
      specialty: q.specialty ?? null,
      difficulty: q.difficulty,
      expectedPoints: q.expectedPoints,
      isBehavioralCore: rank !== undefined,
      rotationPriority: rank ?? 0,
      source: "authored",
    });
  }
  const missingCore = [...coreRank.keys()].filter((id) => !rows.some((r) => r.id === id));
  if (missingCore.length) throw new Error(`Behavioral core ids missing from the authored bank: ${missingCore.join(", ")}`);
  return rows;
}

type SeedDb = {
  select: (...a: never[]) => unknown;
  insert: (...a: never[]) => unknown;
};

/** Upserts the authored bank. Returns how many rows were new vs updated. */
export async function seedInterviewQuestions(database: SeedDb, rows = authoredQuestionRows()): Promise<{ inserted: number; updated: number; total: number }> {
  // Loosely typed parameter: scripts pass either driver's drizzle instance.
  const d = database as unknown as Awaited<ReturnType<typeof import("@/db/client").getDb>>;
  let inserted = 0;
  let updated = 0;
  const BATCH = 400;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const existing = await d
      .select({ id: interviewQuestions.id })
      .from(interviewQuestions)
      .where(inArray(interviewQuestions.id, batch.map((r) => r.id)));
    updated += existing.length;
    inserted += batch.length - existing.length;
    await d
      .insert(interviewQuestions)
      .values(batch)
      .onConflictDoUpdate({
        target: interviewQuestions.id,
        // Not `active`: a retired question stays retired.
        set: {
          kind: sql`excluded.kind`,
          prompt: sql`excluded.prompt`,
          topic: sql`excluded.topic`,
          category: sql`excluded.category`,
          specialty: sql`excluded.specialty`,
          difficulty: sql`excluded.difficulty`,
          expectedPoints: sql`excluded.expected_points`,
          isBehavioralCore: sql`excluded.is_behavioral_core`,
          rotationPriority: sql`excluded.rotation_priority`,
          source: sql`excluded.source`,
          updatedAt: sql`now()`,
        },
      });
  }
  return { inserted, updated, total: rows.length };
}
