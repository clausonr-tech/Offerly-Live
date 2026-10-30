import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { trainingExamples } from "@/db/schema";
import { deidentifyDeep, type Identities } from "./deidentify";
import { POLICY_VERSION } from "./policy";
import { mayTrainOn } from "./training-consent";

/**
 * Writes de-identified examples into the training corpus.
 *
 * Everything here is best-effort and swallows its own errors. Capture is a
 * side benefit of an action the student took for their own reasons - saving a
 * draft, exporting a resume - and it must never be the reason one of those
 * fails. A lost training example costs one row; a save button that throws
 * because a background concern broke costs the user's work.
 */

type CaptureInput = {
  userId: string;
  task: "email_draft" | "resume_tailor";
  outcome: "accepted" | "edited" | "delivered" | "discarded";
  /** The row this came from - one example per source, updated in place. */
  sourceId: string;
  promptContext: unknown;
  modelOutput: unknown;
  humanOutput?: unknown;
  identities: Identities;
};

/**
 * The consent check, and the reason this function exists rather than callers
 * inserting directly.
 *
 * Two answers have to be yes: the account agreed to the policy currently in
 * force, AND the student said yes to Training Use under that same version
 * (lib/training-consent). Agreeing to the terms alone is not a yes to training,
 * and a student who has not been asked yet contributes nothing.
 */
async function mayCapture(userId: string): Promise<boolean> {
  return mayTrainOn(userId);
}

export async function captureExample(input: CaptureInput): Promise<void> {
  try {
    if (!(await mayCapture(input.userId))) return;

    const db = await getDb();
    const promptContext = deidentifyDeep(input.promptContext, input.identities);
    const modelOutput = deidentifyDeep(input.modelOutput, input.identities);
    const humanOutput =
      input.humanOutput === undefined
        ? null
        : deidentifyDeep(input.humanOutput, input.identities);

    await db
      .insert(trainingExamples)
      .values({
        userId: input.userId,
        task: input.task,
        outcome: input.outcome,
        policyVersion: POLICY_VERSION,
        sourceId: input.sourceId,
        promptContext: promptContext as object,
        modelOutput: modelOutput as object,
        humanOutput: humanOutput as object | null,
      })
      // The same draft gets edited, then sent, then maybe marked as
      // replied to. Each of those is new information about the SAME example,
      // so it updates the row rather than appending another near-copy.
      .onConflictDoUpdate({
        target: [trainingExamples.task, trainingExamples.sourceId],
        set: {
          outcome: input.outcome,
          humanOutput: humanOutput as object | null,
          updatedAt: new Date(),
        },
      });
  } catch {
    // Deliberately silent - see the note at the top of this file.
  }
}

/**
 * Deletes the example a row left behind, when the student deletes that row.
 *
 * training_examples.source_id is deliberately not a foreign key - the corpus
 * outlives the tables it was drawn from - which also meant deleting a draft
 * left its example in place, while the published policy says deleting a draft
 * deletes the training example taken from it too. So the delete has to be
 * made explicitly, by whoever deletes the source row.
 *
 * Owner-scoped, so a source id from another account cannot reach anyone
 * else's example. Returns how many went, for the caller's tests.
 */
export async function forgetExample(input: {
  userId: string;
  task: CaptureInput["task"];
  sourceId: string;
}): Promise<number> {
  const db = await getDb();
  const gone = await db
    .delete(trainingExamples)
    .where(
      and(
        eq(trainingExamples.userId, input.userId),
        eq(trainingExamples.task, input.task),
        eq(trainingExamples.sourceId, input.sourceId),
      ),
    )
    .returning();
  return gone.length;
}

/**
 * Whether the student changed anything the model wrote.
 *
 * Whitespace-insensitive on purpose: a trailing newline from a textarea is not
 * an edit, and counting it as one would relabel a large share of untouched
 * drafts as corrections - which is exactly backwards, since "the model got it
 * right" is the rarer and more valuable label of the two.
 */
export function wasEdited(before: string, after: string): boolean {
  const normalise = (s: string) => s.replace(/\s+/g, " ").trim();
  return normalise(before) !== normalise(after);
}
