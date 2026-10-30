/**
 * The model registry's invariants.
 *
 * Written 12 October 2026, after three separate features were found choosing a
 * model outside this file - a hardcoded DRAFT_REVIEW_CONFIG, a hardcoded model
 * in help-knowledge-learn, and a request builder that dropped the registry's
 * `effort` and `thinking` on the floor. Each assertion below is one of those
 * failures, turned into something that fails the build instead.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptsBetweenTools,
  acceptsDisabledThinking,
  getModelConfig,
  getSubCallConfig,
  nextFallbackModel,
  supportsAdaptiveThinking,
  supportsEffort,
  supportsFastMode,
  type AiFeature,
  type Plan,
} from "@/lib/model-registry";

const FEATURES: AiFeature[] = [
  "firmMatch", "connectionAngle", "draft", "chat", "behavioralFeedback", "meetingTime",
  "speakerEvent", "technicalQuestion", "technicalGrading", "resumeReview", "resumeRewrite",
  "postingExtract", "draftSuggestions",
];
const PLANS: Plan[] = ["free", "pro", "pro_plus"];

test("every feature resolves on every plan", () => {
  for (const f of FEATURES) {
    for (const p of PLANS) {
      const c = getModelConfig(f, p);
      assert.ok(c.model.startsWith("claude-"), `${f}/${p}: ${c.model}`);
      assert.ok(c.maxTokens > 0, `${f}/${p} maxTokens`);
    }
  }
});

// The 400 the guards exist to prevent. A model that rejects a parameter must
// never be handed it, however the registry row is written.
test("no resolved config carries a parameter its model rejects", () => {
  const all = [
    ...FEATURES.flatMap((f) => PLANS.map((p) => [`${f}/${p}`, getModelConfig(f, p)] as const)),
    ...PLANS.map((p) => [`draftReview/${p}`, getSubCallConfig("draftReview", p)] as const),
  ];
  for (const [where, c] of all) {
    if (!supportsEffort(c.model)) assert.equal(c.effort, null, `${where} sends effort to ${c.model}`);
    if (!supportsAdaptiveThinking(c.model)) assert.equal(c.thinking, null, `${where} sends thinking to ${c.model}`);
    if (!supportsFastMode(c.model)) assert.equal(c.speed ?? null, null, `${where} sends speed to ${c.model}`);
  }
});

// Every model a feature can select must have a fallback entry, or a capacity
// blip fails the request instead of degrading it. The floor returns null.
test("every selectable model has a place in the fallback chain", () => {
  const selectable = new Set([
    ...FEATURES.flatMap((f) => PLANS.map((p) => getModelConfig(f, p).model)),
    ...PLANS.map((p) => getSubCallConfig("draftReview", p).model),
  ]);
  for (const model of selectable) {
    const next = nextFallbackModel(model);
    if (next === null) continue; // the floor
    assert.ok(next.startsWith("claude-"), `${model} -> ${next}`);
    assert.notEqual(next, model, `${model} falls back to itself`);
  }
});

// lib/generate-draft resolves draftReview with "free" whatever the student's
// plan, because runAiFeature does not hand the plan to its callback. That
// shortcut is only sound while the two columns agree.
test("draftReview is identical on both plans, which generate-draft relies on", () => {
  assert.deepEqual(
    getSubCallConfig("draftReview", "free"),
    getSubCallConfig("draftReview", "pro"),
    "generate-draft resolves this with \"free\" for every plan - thread the plan through before they diverge",
  );
});

// The Help assistant's reply ceiling is 450 tokens and thinking is billed
// against it, so a thinking model spends the whole budget and returns nothing.
// MEASURED: 74 of 316 eval questions came back empty at exactly 450 tokens.
test("chat never asks a model to think inside its 450-token ceiling", () => {
  for (const p of PLANS) {
    const c = getModelConfig("chat", p);
    assert.equal(c.thinking, "disabled", `chat/${p} must disable thinking`);
    assert.ok(c.maxTokens <= 1000, `chat/${p} ceiling is small enough that thinking would eat it`);
  }
});

// The next obvious move is bumping SONNET and OPUS to the 5.5 generation, and
// it breaks eleven of the thirteen features silently - both 5.5 models reject
// `thinking: "disabled"`, which eleven rows ask for. withModelGuards throws so
// the test above catches it; this pins the knowledge that makes it throw.
test("the 5.5 generation's thinking-off trap is guarded, not just commented", () => {
  assert.equal(acceptsDisabledThinking("claude-sonnet-5"), true, "the Sonnet in use today takes disabled");
  assert.equal(acceptsDisabledThinking("claude-opus-5"), true, "the Opus in use today takes disabled");
  assert.equal(acceptsDisabledThinking("claude-sonnet-5-5"), false, "5.5 needs between_tools instead");
  assert.equal(acceptsDisabledThinking("claude-opus-5-5"), false, "5.5 has no thinking-off mode at all");
});

// Fast mode is set on four paid rows and this account has zero capacity for it
// (FAST_MODE_CAPACITY), so no resolved config may carry `speed` - otherwise
// every one of those invocations spends a failed round-trip before doing any
// work. The rows keep the flag on purpose; this asserts the gate holds.
test("no config resolves with fast mode while the account has no capacity", () => {
  const withSpeed = [
    ...FEATURES.flatMap((f) => PLANS.map((p) => [`${f}/${p}`, getModelConfig(f, p)] as const)),
    ...PLANS.map((p) => [`draftReview/${p}`, getSubCallConfig("draftReview", p)] as const),
  ].filter(([, c]) => c.speed);
  assert.deepEqual(withSpeed.map(([w]) => w), [], "flip FAST_MODE_CAPACITY only when the capacity is real");
});

// `between_tools` exists so the Sonnet migration can be measured before it is
// decided. No row selects it, and only Claude Sonnet 5.5 takes it, so a row
// that ever does must be pointed at that model.
test("between_tools is expressible, guarded, and unused by any row", () => {
  assert.equal(acceptsBetweenTools("claude-sonnet-5-5"), true);
  assert.equal(acceptsBetweenTools("claude-sonnet-5"), false, "Sonnet 5 takes plain disabled instead");
  assert.equal(acceptsBetweenTools("claude-opus-5"), false);
  const rows = [
    ...FEATURES.flatMap((f) => PLANS.map((p) => getModelConfig(f, p))),
    ...PLANS.map((p) => getSubCallConfig("draftReview", p)),
  ];
  assert.deepEqual(
    rows.filter((c) => c.thinking === "between_tools"),
    [],
    "no registry row should select between_tools until the Sonnet migration is measured and decided",
  );
});
