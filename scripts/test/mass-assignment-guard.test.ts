// The two settings/onboarding actions that write to `users` with a built-up
// object - saveRecruitingAnswers (settings/recruiting-actions.ts) and
// saveProfileLinks (onboarding/links/actions.ts) - take their keys from the
// question bank and a fixed field list, never from the form's own field names.
// So a submitted field called "role" or "plan" cannot reach a column.
//
// This guard keeps that true: if a future answer key ever collides with a
// privileged, billing, auth or ownership column, this test fails before the
// change can ship. It is the mass-assignment half of the content/ownership
// story - the same reason saveRecruitingAnswers iterates DATA_ANSWER_KEYS and
// the question bank rather than Object.keys(formData).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";

import { users } from "@/db/schema";
import { DATA_ANSWER_KEYS } from "@/lib/recruiting-answer-keys";
import { ALL_DEEP_QUESTIONS, ARRAY_KEYS, CORE_QUESTIONS, SINGLE_VALUE_KEYS } from "@/lib/onboarding-questions";

// Columns a student must never be able to set by naming a form field after
// them. Account control (role/plan), credentials, firm membership and
// approval, and the share token that is itself a credential.
const FORBIDDEN_COLUMNS = [
  "id",
  "email",
  "role",
  "plan",
  "passwordHash",
  "orgApproved",
  "orgFirmId",
  "firmRole",
  "resumeShareToken",
  "schoolEmailVerifiedAt",
  "consentedPolicyVersion",
] as const;

test("every forbidden name is a real users column (so the guard cannot rot)", () => {
  const columns = new Set(Object.keys(getTableColumns(users)));
  for (const name of FORBIDDEN_COLUMNS) {
    assert.ok(columns.has(name), `${name} is not a users column - update this guard`);
  }
});

test("no onboarding/settings answer key can address a privileged column", () => {
  const answerKeys = new Set<string>([
    ...DATA_ANSWER_KEYS,
    ...ARRAY_KEYS,
    ...SINGLE_VALUE_KEYS,
    ...[...CORE_QUESTIONS, ...ALL_DEEP_QUESTIONS].map((q) => q.key),
    ...[...CORE_QUESTIONS, ...ALL_DEEP_QUESTIONS].filter((q) => q.followUp).map((q) => q.followUp!.key),
  ]);

  for (const forbidden of FORBIDDEN_COLUMNS) {
    assert.ok(
      !answerKeys.has(forbidden),
      `an answer key is named "${forbidden}", which would let a form field write that column`,
    );
  }
});
