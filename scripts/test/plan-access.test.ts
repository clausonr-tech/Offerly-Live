/**
 * The plan gate the paid server actions now call (paidActionUser → hasPaidAccess).
 *
 * hasPaidAccess is the single decision both the section layouts and the paid
 * actions (Interview Prep practice, the drafter's AI suggestions, drafts,
 * resume review, video, contact sourcing) rely on, so its branches are pinned
 * here: a free account is refused, every paid or privileged principal passes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { hasPaidAccess } from "@/lib/plan-access-rule";

test("free accounts are refused paid features", () => {
  assert.equal(hasPaidAccess({ plan: "free", email: "student@example.edu", role: null }), false);
});

test("pro and pro_plus pass", () => {
  assert.equal(hasPaidAccess({ plan: "pro", email: "student@example.edu", role: null }), true);
  assert.equal(hasPaidAccess({ plan: "pro_plus", email: "student@example.edu", role: null }), true);
});

test("an admin passes regardless of plan", () => {
  assert.equal(hasPaidAccess({ plan: "free", email: "admin@example.edu", role: "admin" }), true);
});

test("a missing role does not crash the check", () => {
  assert.equal(hasPaidAccess({ plan: "free", email: "student@example.edu" }), false);
  assert.equal(hasPaidAccess({ plan: "pro", email: null }), true);
});
