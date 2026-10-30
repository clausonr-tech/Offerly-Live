import { POLICY_VERSION } from "./policy";

/**
 * The Training Use rule on its own, with no database or server-only imports, so
 * the app (lib/training-consent) and scripts/export-training.ts apply exactly
 * the same test.
 *
 * Yes only when the account agreed to the current policy AND said yes to
 * Training Use under that same version. Never asked (null), no, or a yes under
 * an older policy all mean no.
 */
export type TrainingRow = {
  consentedPolicyVersion: string | null;
  trainingChoice: "opted_in" | "opted_out" | null;
  trainingChoicePolicyVersion: string | null;
};

export function allowsTraining(row: TrainingRow | null | undefined, policyVersion = POLICY_VERSION): boolean {
  return (
    !!row &&
    row.consentedPolicyVersion === policyVersion &&
    row.trainingChoice === "opted_in" &&
    row.trainingChoicePolicyVersion === policyVersion
  );
}
