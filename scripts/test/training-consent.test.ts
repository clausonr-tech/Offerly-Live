// Training Use is a yes only when the student explicitly said yes under the
// policy currently in force. These are the rules capture, the sent-email
// archive and the export all share; see lib/training-rule.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowsTraining } from "../../src/lib/training-rule";
import { POLICY_VERSION } from "../../src/lib/policy";

const yes = {
  consentedPolicyVersion: POLICY_VERSION,
  trainingChoice: "opted_in" as const,
  trainingChoicePolicyVersion: POLICY_VERSION,
};

test("an explicit yes under the current policy allows training", () => {
  assert.equal(allowsTraining(yes), true);
});

test("never asked means no", () => {
  assert.equal(allowsTraining({ ...yes, trainingChoice: null, trainingChoicePolicyVersion: null }), false);
});

test("opting out means no", () => {
  assert.equal(allowsTraining({ ...yes, trainingChoice: "opted_out" }), false);
});

test("a yes given under an older policy is not a yes to the current one", () => {
  assert.equal(allowsTraining({ ...yes, trainingChoicePolicyVersion: "2026-09-23" }), false);
});

test("an account that has not agreed to the current terms contributes nothing", () => {
  assert.equal(allowsTraining({ ...yes, consentedPolicyVersion: "2026-09-23" }), false);
  assert.equal(allowsTraining({ ...yes, consentedPolicyVersion: null }), false);
});

test("no row means no", () => {
  assert.equal(allowsTraining(null), false);
  assert.equal(allowsTraining(undefined), false);
});
