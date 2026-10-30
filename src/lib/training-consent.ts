import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailArchive, trainingExamples, users } from "@/db/schema";
import { POLICY_VERSION } from "@/lib/policy";
import { recordConsentEvents, type ConsentSource } from "@/lib/consent-ledger";
import { allowsTraining } from "./training-rule";

/**
 * Training Use: whether a student's writing may train Offerly's models.
 *
 * The one place that decides it. Capture (lib/training-capture), the sent-email
 * archive (lib/email-archive) and the export script all ask here, so the answer
 * a student gave on the consent screen, at sign-up or in Settings is the only
 * thing that decides whether their writing is kept for training.
 *
 * Only an explicit yes counts: `opted_in`, given under the current policy
 * version, by an account that has agreed to that version. Null (never asked),
 * `opted_out`, or a yes given under an older policy all mean no.
 */

export { allowsTraining } from "./training-rule";

export async function mayTrainOn(userId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { consentedPolicyVersion: true, trainingChoice: true, trainingChoicePolicyVersion: true },
  });
  return allowsTraining(row);
}

/**
 * Records a student's Training Use answer, on the account and in the ledger.
 *
 * Saying no also deletes what was being kept for training: their captured
 * examples and their sent-email archive. The privacy policy promises that
 * opting out removes their content from datasets not yet used; a model that
 * has already been trained cannot be untrained, and the policy says so.
 */
export async function setTrainingChoice(
  userId: string,
  optedIn: boolean,
  source: ConsentSource,
  email?: string,
): Promise<void> {
  const db = await getDb();
  await db
    .update(users)
    .set({
      trainingChoice: optedIn ? "opted_in" : "opted_out",
      trainingChoiceAt: new Date(),
      trainingChoicePolicyVersion: POLICY_VERSION,
    })
    .where(and(eq(users.id, userId), eq(users.accountType, "student")));

  if (!optedIn) {
    await db.delete(trainingExamples).where(eq(trainingExamples.userId, userId));
    await db.delete(emailArchive).where(eq(emailArchive.userId, userId));
  }

  await recordConsentEvents(userId, [optedIn ? "training_opted_in" : "training_opted_out"], source, email);
}
