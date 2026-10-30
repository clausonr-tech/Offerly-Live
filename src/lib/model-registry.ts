import "server-only";
import type { Effort, ModelConfig, Thinking } from "./model-params";

// Central model routing. Every AI feature looks its config up here instead of
// hardcoding a model string, so tier changes and model swaps are one edit.
//
// This used to pin the 4.x generation to stay Priority Tier eligible, since
// Opus 5 and Sonnet 5 cannot run on reserved capacity. That trade is off:
// Priority Tier is not on the roadmap, so holding the older generation was
// paying a capability tax for an option we were never going to exercise.
// Sonnet 5 is also cheaper than Sonnet 4.6 ($2/$10 vs $3/$15 per MTok), so the
// free tier got better and cheaper at the same time. If reserved capacity ever
// does become the plan, this is the file that has to move back.
//
// ---------------------------------------------------------------------------
// Why this file is still on the 5.0 generation, reviewed 13 October 2026
// ---------------------------------------------------------------------------
//
// It is not an oversight, and it is not a free upgrade. Checked against the
// current model table:
//
//   claude-haiku-4-5  -> claude-haiku-5-5   DONE. A tenth of the price
//                       ($0.10/$0.50 against $1/$5), newer, 1M context. Taken
//                       for every Haiku feature; 4.5 survives only as the
//                       bottom of FALLBACK_CHAIN.
//   claude-sonnet-5   -> claude-sonnet-5-5  SAME PRICE ($2/$10), so it buys
//                       capability and nothing else - and its effort levels are
//                       RECALIBRATED, so every `effort: "low"` row below needs
//                       re-sweeping before it means what it means today.
//   claude-opus-5     -> claude-opus-5-5    20% cheaper ($4/$20 against
//                       $5/$25), and NOT RECOMMENDED. Opus 5.5 cannot turn
//                       thinking off at any effort, and seven paid-tier rows
//                       below deliberately run with it off. Moving would make
//                       the paid tier slower, which is the opposite of the
//                       reason to move - and the extra thinking tokens may eat
//                       the 20%.
//
// Eleven of the thirteen features ask for `thinking: "disabled"`, which both
// 5.5 models reject. That is a 400 on every request, not a degradation, so it
// is guarded in withModelGuards rather than left to this comment - bumping
// either constant now throws with the remedy, and
// scripts/test/model-registry.test.ts catches it on the way past.

export type AiFeature =
  | "firmMatch"
  | "connectionAngle"
  | "draft"
  | "chat"
  | "behavioralFeedback"
  | "meetingTime"
  | "speakerEvent"
  | "technicalQuestion"
  | "technicalGrading"
  | "resumeReview"
  | "resumeRewrite"
  | "postingExtract"
  | "draftSuggestions";

export type Plan = "free" | "pro" | "pro_plus";

// What Pro+ buys is volume, not smarter models: both paid tiers run the same
// configs, and the REGISTRY below stays two columns wide. Pro+ differs only in
// the monthly feature quotas (lib/plan-quotas) and the daily fair-use ceiling.
type ModelTier = "free" | "pro";

const MODEL_TIER: Record<Plan, ModelTier> = {
  free: "free",
  pro: "pro",
  pro_plus: "pro",
};

// The parameter shapes and the two request translations live in
// lib/model-params, which carries no "server-only" so that code running on
// both sides of that boundary can still build a request through them. They are
// re-exported here, because this file is where you look for model decisions.
export {
  outputConfigFor,
  thinkingFor,
  type Effort,
  type ModelConfig,
  type Thinking,
} from "./model-params";
const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";

/**
 * The current Haiku, and the Haiku every feature here runs on.
 *
 * Haiku 4.5 is $1.00 / $5.00 per million tokens. Haiku 5.5 is $0.10 / $0.50 -
 * a TENTH of the price, newer, and 1M context instead of 200K. There was no
 * tradeoff to weigh: the older model is both dearer and less capable.
 *
 * It arrived here scoped to `postingExtract` alone, deliberately, because
 * moving the shared constant on the strength of a price list is an unmeasured
 * change. What justifies the rest of the move is that the price list is not the
 * only argument any more:
 *
 * - `postingExtract` has been running on it, and its answers are
 *   quote-verified, so a regression would have shown up as discarded answers.
 * - 4.5 is the one model in this file that rejects BOTH `effort` and adaptive
 *   thinking, which is why it needs the two guard sets below. Every feature
 *   that ran on it was silently having those parameters stripped - `chat` had
 *   given up on them entirely (`effort: null, thinking: null`). On 5.5 they
 *   work, so those features can be tuned rather than left at the default.
 * - `scripts/help-assistant-eval.ts` is a real eval for the one feature where
 *   quality is user-facing and load-bearing (`chat`), so the move is checkable
 *   rather than assumed.
 *
 * The sizing that prompted the original check, for scale: clearing the
 * rejection queue is 4,601 listings at roughly 1,500 input tokens and ~200
 * output - about $11.50 a pass on 4.5, about $1.15 on 5.5.
 */
const HAIKU = "claude-haiku-5-5";

/**
 * The previous Haiku, kept ONLY as the bottom of FALLBACK_CHAIN.
 *
 * Nothing selects it: it exists so a capacity blip on 5.5 degrades to an older
 * model instead of failing the request. It is the reason
 * MODELS_WITHOUT_EFFORT and MODELS_WITHOUT_ADAPTIVE_THINKING are still
 * non-empty - a fallback can land here, and an unguarded parameter would turn
 * a degraded request into a failed one.
 */
const HAIKU_4_5 = "claude-haiku-4-5";

// When a model is rate-limited or overloaded, drop to the next one rather than
// failing the request. Ordered most- to least-capable; Haiku is the floor.
const FALLBACK_CHAIN: Record<string, string | null> = {
  [OPUS]: SONNET,
  [SONNET]: HAIKU,
  // Falls back to the previous Haiku rather than to nothing: an older model
  // answering is better than no answer, and every Haiku feature here is either
  // quote-verified or short enough to re-ask.
  [HAIKU]: HAIKU_4_5,
  [HAIKU_4_5]: null,
};

export function nextFallbackModel(model: string): string | null {
  return FALLBACK_CHAIN[model] ?? null;
}

/**
 * A second model call that belongs to a feature rather than being one.
 *
 * `AiFeature` is the METERED set - it is the `aiUsage.feature` enum column, so
 * every name in it is a row in the database and a line in the student's quota.
 * A sub-call is not any of those: it runs inside another feature's
 * `runAiFeature`, bills into that feature's single usage row, and spends one
 * unit of that feature's quota. Adding one here needs no migration; adding one
 * to `AiFeature` does.
 *
 * It still belongs in this file. The point of the registry is that no model
 * string is chosen anywhere else, and a sub-call is exactly the kind of call
 * that drifts out of sight - see `draftReview` below for what that cost.
 */
export type AiSubCall = "draftReview";

  /**
   * The second call in the draft pipeline: read the draft against the facts it
   * was given and fix what is wrong with it.
   *
   * This lived in lib/draft-pipeline as a hardcoded DRAFT_REVIEW_CONFIG until
   * 12 October 2026, which is why it is here now. This file's own header
   * promises that every AI feature looks its config up here instead of
   * hardcoding a model string, and the one call that did not was the most
   * expensive call in the product: it sat at medium effort with adaptive
   * thinking for a month, unexamined, fifty lines from the `draft` entry below
   * and the comment that explains why THAT one is cheap.
   *
   * Sonnet on both plans, and identical columns deliberately: the review is
   * checking an email against a short list of facts, which Sonnet does well,
   * and an Opus reviewer has never been measured. lib/generate-draft therefore
   * resolves it with "free" whatever the student's plan, and a test asserts the
   * two columns stay identical so that shortcut fails loudly if they diverge.
   *
   * `low` + `disabled`, MEASURED on the API path - three arms of 20 situations
   * in audit/REVIEW-CONFIG-2026-10-12.md. Against the medium + adaptive it
   * replaced: review call 21.5s -> 5.8s, pipeline p50 31.2s -> 13.1s, p90
   * 61.5s -> 24.3s, cost per 20 situations $0.72 -> $0.40, would-reply 14 of 14
   * either way, and emails shipping with no contraction 4 -> 0. The thinking
   * was spending ~2,200 tokens a call to produce ~320 tokens of answer.
   */
const SUB_CALL_REGISTRY: Record<AiSubCall, Record<ModelTier, ModelConfig>> = {
  draftReview: {
    free: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 6000 },
    pro: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 6000 },
  },
};

const REGISTRY: Record<AiFeature, Record<ModelTier, ModelConfig>> = {
  // --- Judgment work: quality is the product, paid tier gets Opus ---
  // Sized against the pick count, which is 100: each pick is a slug plus a
  // one-sentence reason, so a full list runs ~4.5k tokens of structured output.
  // At the old 1500 - set when the matcher asked for 12-14 firms - the response
  // was truncated long before the hundredth pick, and a truncated list looks
  // exactly like a model that only found thirty good firms.
  firmMatch: {
    free: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 8000 },
    // A hundred picks is ~4.5k tokens of output - the longest single wait in
    // the product, and rare (once per profile change) - so the paid tier buys
    // it back at fast-mode pricing.
    pro: { model: OPUS, effort: "medium", thinking: "disabled", maxTokens: 8000, speed: "fast" },
  },
  connectionAngle: {
    free: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 300 },
    pro: { model: OPUS, effort: "low", thinking: "disabled", maxTokens: 300 },
  },
  // Suggested answers for the drafter's fields: short, structured, once per
  // recipient and cached - the same tier as the connection angle it extends.
  draftSuggestions: {
    free: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 900 },
    pro: { model: OPUS, effort: "low", thinking: "disabled", maxTokens: 900 },
  },
  draft: {
    // The review pass that follows every draft is `draftReview` above - Sonnet
    // on both plans, and deliberately cheap for the reasons recorded there.
    //
    // The reply is JSON: subject, body, gaps and notes for the student. 1024
    // tokens cut long emails off mid-string, which surfaced as a JSON parse
    // error. Output is billed on what's written, so the headroom costs nothing.
    free: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 4096 },
    // The drafting call is the front half of every email wait; fast mode
    // halves it for the paid tier without touching what gets written.
    pro: { model: OPUS, effort: "low", thinking: "disabled", maxTokens: 4096, speed: "fast" },
  },
  // The Help assistant on /help (lib/help-assistant). Haiku on both plans: it
  // answers "where is X / how do I Y" from a knowledge file it is handed, which
  // is reading, not judgment, and students can ask as many questions as they
  // like - volume is the constraint. Answers are a handful of short bullets, so
  // 450 tokens is a ceiling it should never reach. Haiku never degrades to a
  // pricier model - FALLBACK_CHAIN only goes down from here - which is what
  // lets the global daily budget in lib/help-chat-rules price every row at
  // Haiku rates. Metered separately from DAILY_LIMITS - see ai-runner.
  //
  // `effort`/`thinking` were null here because Haiku 4.5 rejected both and the
  // guards stripped them anyway. On Haiku 5.5 they work - and until 12 October
  // 2026 they were silently dropped on the way to the API regardless, because
  // helpMessageParams sent only model and max_tokens. Both are now sent (see
  // the comment there); thinking is OFF because a thinking model spends the
  // whole 450-token ceiling thinking and returns an empty reply.
  //
  // `medium`, not `low`, and MEASURED on scripts/help-assistant-eval.ts - 316
  // questions, the only feature here whose quality a student sees directly:
  //
  //   Haiku 5.5, medium   310/316 (98.1%)   <- shipped
  //   Haiku 5.5, low      307/316 (97.2%)
  //   Haiku 4.5           ~313/316, upper bound: it passed 6 of the 9 that
  //                       5.5-at-low failed, measured on a slice chosen to be
  //                       5.5's worst, so the true figure is at or below this
  //
  // Three questions in 316 against a TENTH of the price, and medium is also
  // 5.5's own default. It is the better arm on the two safety-relevant
  // categories: injection 29/30 -> 30/30 and off-topic 24/25 -> 25/25.
  chat: {
    free: { model: HAIKU, effort: "medium", thinking: "disabled", maxTokens: 450 },
    pro: { model: HAIKU, effort: "medium", thinking: "disabled", maxTokens: 450 },
  },
  behavioralFeedback: {
    free: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 500 },
    pro: { model: OPUS, effort: "low", thinking: "disabled", maxTokens: 500 },
  },

  // Generating a question variation from a curated seed is light work - the
  // hard thinking already went into the bank entry it's varying.
  technicalQuestion: {
    free: { model: HAIKU, effort: "low", thinking: "disabled", maxTokens: 600 },
    pro: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 600 },
  },
  // Grading is the opposite: judging whether an answer actually demonstrates
  // understanding is the part students are paying for, so it gets real models.
  technicalGrading: {
    free: { model: SONNET, effort: "low", thinking: "disabled", maxTokens: 800 },
    pro: { model: OPUS, effort: "medium", thinking: "disabled", maxTokens: 800 },
  },

  // Reading a resume is judgement, not extraction: the model has to weigh
  // whether a bullet actually shows impact and whether the page reads cleanly
  // under a six-second skim. It also carries a whole PDF as input, so the token
  // budget is larger than any other feature here.
  //
  // This is the deepest judgment call in the product, and it was running with
  // reasoning off at below-default effort - which is most of why its output
  // read generic. Adaptive thinking and xhigh effort are the fix; both cost
  // more per review, and a review is worth more than any other single call a
  // student makes.
  //
  // maxTokens is now PER CRITIC, not for all five together: lib/resume-review
  // gives each critic its own call so each gets a full reasoning pass instead
  // of a fifth of one. One critic's notes, issues and rewrites fit in 3000
  // comfortably; the headroom above that is for thinking tokens, which are
  // billed as output and count against this same ceiling.
  resumeReview: {
    // `disabled`, not `adaptive`, since 13 October 2026 - and `high` on both
    // tiers, because Opus 5 rejects thinking-off above `high` effort.
    //
    // MEASURED twice over, audit/RESUME-REVIEW-2026-10-13.md:
    //
    //   COVERAGE, against twelve planted flaws, one per critic brief:
    //     Sonnet high + adaptive   51,511 ms   12/12   $0.0794
    //     Sonnet high + disabled   24,035 ms   12/12   $0.0375
    //     Opus xhigh + adaptive    69,636 ms   12/12   $0.0986
    //     Opus high + disabled     30,295 ms   12/12   $0.0472
    //
    //   PROSE, which is what the old comment here was really about. It said
    //   this config ran "with reasoning off at below-default effort - which is
    //   most of why its output read generic", and that is a claim about
    //   writing, not coverage. scripts/resume-review-prose-judge.ts asks the
    //   student whose resume it is whether the feedback was written for them:
    //   10 of 10 judgements across both arms and two passes came back
    //   `written_for_me`, none `partly_generic`, none `form_letter`, and the
    //   thinking-off arms earned `gives_a_usable_rewrite` as often as the
    //   adaptive ones.
    //
    // So the student waits 24 seconds instead of 52 on the free tier and 30
    // instead of 70 on the paid one, for the same findings and the same
    // specificity, at about half the cost. The effort stays high - that half of
    // the original reasoning was never in doubt, and only the thinking was
    // measured away.
    //
    // maxTokens is PER CRITIC: lib/resume-review gives each of the five its own
    // call so each gets a full pass instead of a fifth of one. One critic's
    // notes, issues and rewrites fit in 3000 comfortably; the headroom was for
    // thinking tokens, which are billed as output against this same ceiling and
    // are no longer being spent.
    free: { model: SONNET, effort: "high", thinking: "disabled", maxTokens: 6000 },
    pro: { model: OPUS, effort: "high", thinking: "disabled", maxTokens: 6000 },
  },

  // Rewrites the whole resume from the review's findings. Output is a complete
  // document rather than a critique of one, so it needs more room than the
  // review that produced it - and more again now that thinking shares the
  // ceiling.
  resumeRewrite: {
    free: { model: SONNET, effort: "high", thinking: "adaptive", maxTokens: 16000 },
    // A whole document of output plus thinking - the single longest
    // generation in the product, so the paid tier runs it fast.
    pro: { model: OPUS, effort: "xhigh", thinking: "adaptive", maxTokens: 16000, speed: "fast" },
  },

  // --- Pure extraction: structured read of one document. Haiku matches Opus
  // here at a fifth the cost, so both tiers get the same model. ---
  meetingTime: {
    free: { model: HAIKU, effort: "low", thinking: "disabled", maxTokens: 300 },
    pro: { model: HAIKU, effort: "low", thinking: "disabled", maxTokens: 300 },
  },

  /**
   * Reading a fact out of a job posting the deterministic parser could not.
   *
   * Haiku on both tiers, and it is not a compromise: the model is asked to
   * QUOTE a sentence from text it was handed, and the answer is rejected
   * unless that sentence appears in the source. A larger model would not be
   * more correct at copying, and this runs over every posting whose
   * eligibility came back blank - volume is the constraint, not capability.
   *
   * Plan-independent because the crawler has no user. It is a background job
   * whose cost falls on us, not on whoever happens to be logged in.
   */
  postingExtract: {
    free: { model: HAIKU, effort: "low", thinking: "disabled", maxTokens: 400 },
    pro: { model: HAIKU, effort: "low", thinking: "disabled", maxTokens: 400 },
  },
  speakerEvent: {
    free: { model: HAIKU, effort: "low", thinking: "disabled", maxTokens: 400 },
    pro: { model: HAIKU, effort: "low", thinking: "disabled", maxTokens: 400 },
  },
};

// Not every model accepts `effort`. Haiku 4.5 rejects it outright with a 400,
// and because Haiku sits at the bottom of the fallback chain there is nothing
// below it to degrade to - the request just fails. Strip the parameter for
// those models instead of letting it reach the API.
const MODELS_WITHOUT_EFFORT = new Set<string>([HAIKU_4_5]);

export function supportsEffort(model: string): boolean {
  return !MODELS_WITHOUT_EFFORT.has(model);
}

// Same trap, different parameter. Adaptive thinking arrived with the 4.6
// generation; Haiku 4.5 predates it and takes the older fixed-budget form
// instead, so sending `{ type: "adaptive" }` there is a 400. Haiku is again the
// bottom of the fallback chain, so an unguarded parameter would turn a capacity
// blip on Opus into a failed request rather than a degraded one.
const MODELS_WITHOUT_ADAPTIVE_THINKING = new Set<string>([HAIKU_4_5]);

export function supportsAdaptiveThinking(model: string): boolean {
  return !MODELS_WITHOUT_ADAPTIVE_THINKING.has(model);
}

// Thinking-off is not one parameter across generations, and getting it wrong is
// a 400 on every request rather than a degradation.
//
// The 5.0 models this file selects today all accept `{type: "disabled"}`, so
// nothing below fires. It exists because the obvious next move - bumping SONNET
// and OPUS to the 5.5 generation - breaks ELEVEN of the thirteen features
// silently, and a comment would not have stopped it:
//
//   claude-sonnet-5-5  `disabled` is a 400. Send `between_tools` instead, which
//                      is accepted at effort `high` or below.
//   claude-opus-5-5    `disabled` is a 400 at EVERY effort. There is no
//                      thinking-off mode; lower the effort instead.
//
// So a model with a substitute gets one, and a model with none throws here,
// where scripts/test/model-registry.ts resolves every feature on every plan and
// will catch it, rather than in front of a student.
const NO_DISABLED_THINKING: Record<string, string> = {
  "claude-sonnet-5-5":
    'Claude Sonnet 5.5 rejects thinking "disabled"; its thinking-off mode is {type: "between_tools"}, accepted at ' +
    "effort `high` or below. The installed SDK does not type that value yet, so upgrading the SDK is part of this move.",
  "claude-opus-5-5":
    "Claude Opus 5.5 has no thinking-off mode at all - `disabled` is rejected at every effort level. Lower the effort " +
    "on this row instead. Note that its effort default is `medium`, one level below Claude Opus 5's.",
};

/** Whether `thinking: "disabled"` reaches this model as written. */
export function acceptsDisabledThinking(model: string): boolean {
  return !(model in NO_DISABLED_THINKING);
}

// `between_tools` is Claude Sonnet 5.5's only thinking-off mode, and no other
// model accepts it. Same shape as the guards above: a row that asks a model for
// a mode it rejects fails here, where the registry test resolves every feature
// on every plan, rather than as a 400 in front of a student.
const ACCEPTS_BETWEEN_TOOLS = new Set<string>(["claude-sonnet-5-5"]);

export function acceptsBetweenTools(model: string): boolean {
  return ACCEPTS_BETWEEN_TOOLS.has(model);
}

// Fast mode is an Opus-only research preview; `speed: "fast"` anywhere else
// is a 400. Strip it when a fallback lands on Sonnet or Haiku, exactly like
// effort and thinking above.
const MODELS_WITH_FAST_MODE = new Set<string>([OPUS]);

/**
 * Whether this ACCOUNT has fast-mode capacity, as distinct from whether the
 * model supports it.
 *
 * `false` since 13 October 2026, MEASURED: every fast-mode request to
 * claude-opus-5 comes back
 *
 *   rate_limit_error: This request would exceed your rate limit of 0 fast mode
 *   input tokens per minute (model: claude-opus-5)
 *
 * Zero tokens a minute - the capacity was never provisioned. Nothing was
 * broken by that, because the runner drops `speed` and retries the same model
 * before descending the model chain (lib/ai-runner), which is exactly what
 * that fallback is for. But it means every paid-tier invocation of the four
 * rows below that ask for fast mode spent a guaranteed failed round-trip on a
 * feature that could not be delivered.
 *
 * The four `speed: "fast"` rows are deliberately LEFT AS THEY ARE rather than
 * edited out. They record a real intention - those are the paid tier's longest
 * waits and fast mode is the right tool for them - and deleting them would
 * lose that. Flip this one boolean when the capacity exists and they start
 * working again, with no other change and nothing to rediscover.
 *
 * `audit/RESUME-REVIEW-2026-10-13.md` §5 has the measurement.
 */
const FAST_MODE_CAPACITY = false;

export function supportsFastMode(model: string): boolean {
  return FAST_MODE_CAPACITY && MODELS_WITH_FAST_MODE.has(model);
}

/**
 * A sub-call's config, with the same per-model guards getModelConfig applies -
 * a sub-call reaches the API the same way a feature does, so a parameter the
 * resolved model rejects is the same 400 either way.
 */
export function getSubCallConfig(subCall: AiSubCall, plan: Plan): ModelConfig {
  return withModelGuards(SUB_CALL_REGISTRY[subCall][MODEL_TIER[plan]]);
}

/** Strip or translate every parameter the resolved model would reject. Shared by both resolvers. */
function withModelGuards(base: ModelConfig): ModelConfig {
  const thinking = supportsAdaptiveThinking(base.model) ? base.thinking : null;
  if (thinking === "disabled" && !acceptsDisabledThinking(base.model)) {
    throw new Error(`${base.model} cannot be sent thinking "disabled". ${NO_DISABLED_THINKING[base.model]}`);
  }
  if (thinking === "between_tools" && !acceptsBetweenTools(base.model)) {
    throw new Error(
      `${base.model} does not accept thinking "between_tools" - it is Claude Sonnet 5.5's thinking-off mode and no ` +
        'other model takes it. Use "disabled" where the model accepts it, or lower the effort.',
    );
  }
  return {
    ...base,
    effort: supportsEffort(base.model) ? base.effort : null,
    thinking,
    speed: supportsFastMode(base.model) ? base.speed ?? null : null,
  };
}

export function getModelConfig(feature: AiFeature, plan: Plan): ModelConfig {
  return withModelGuards(REGISTRY[feature][MODEL_TIER[plan]]);
}


// Daily per-user ceilings. The paid tier is marketed as unlimited; this is the
// fair-use ceiling that stops a scripted client from running up an unbounded
// bill against a flat subscription fee. Set well above real usage.
//
// The Help assistant ("chat") does not count toward these: asking a question
// must never cost a student their drafts or practice. It has its own burst,
// daily and global-budget gates (HELP_LIMITS in lib/help-chat-rules).
export const DAILY_LIMITS: Record<Plan, number> = {
  free: 25,
  pro: 200,
  // Twice Pro's quotas (lib/plan-quotas) gets twice Pro's headroom. Still a
  // fair-use backstop, not a marketed number.
  pro_plus: 400,
};
