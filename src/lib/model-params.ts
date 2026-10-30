// The model PARAMETERS, split from the registry that chooses them.
//
// lib/model-registry imports "server-only", because what it holds is a routing
// table for a student's plan. These three types and two functions hold no
// table: they are the shapes a config has and the two pure translations from a
// config into request fields. Keeping them here lets code that must run on both
// sides of the boundary - lib/draft-pipeline, whose flow test deliberately runs
// without --conditions=react-server - build a request correctly instead of
// hand-rolling the same two lines.
//
// Everything is re-exported from lib/model-registry, so every existing import
// keeps working and the registry stays the one place to look.

// `high` is the API default. `xhigh` and `max` sit above it and are what
// intelligence-sensitive work wants - anything below `high` is asking the model
// to think less than it otherwise would.
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Whether the model reasons before answering.
//
// "adaptive" lets it decide how much to think; "disabled" turns it off. This is
// explicit on every feature rather than left to the model default, because the
// default MOVED underneath us: on Opus 4.8 omitting `thinking` meant no
// thinking, and on Opus 5 it means adaptive. Spelling it out is what stops a
// model swap from silently switching reasoning on for a feature whose
// maxTokens has no room for it - thinking tokens are billed as output and
// count against the same ceiling.
/**
 * `adaptive` lets the model decide how much to think; `disabled` turns it off.
 *
 * `between_tools` is Claude Sonnet 5.5's thinking-off mode - the 5.5 generation
 * removed plain `disabled`, and that is the replacement, accepted at effort
 * `high` or below. It exists here so the Sonnet migration can be MEASURED
 * before it is decided: no registry row selects it, and
 * ACCEPTS_BETWEEN_TOOLS below stops a row giving it to a model that would
 * reject it. The installed SDK does not type the value, so thinkingFor() casts
 * at the request boundary and says so.
 */
export type Thinking = "adaptive" | "disabled" | "between_tools";

export type ModelConfig = {
  model: string;
  // Null when the resolved model rejects the effort parameter - see
  // MODELS_WITHOUT_EFFORT. Always build request output_config through
  // outputConfigFor() rather than reading this directly.
  effort: Effort | null;
  // Null when the resolved model rejects adaptive thinking - see
  // MODELS_WITHOUT_ADAPTIVE_THINKING. Always build the request parameter
  // through thinkingFor() rather than reading this directly.
  thinking: Thinking | null;
  maxTokens: number;
  /**
   * "fast" runs the same model at roughly double the output speed for a
   * premium per-token price - a pure latency-for-cost trade with no quality
   * change, so it is set only on the paid tier's longest Opus waits. Only
   * Opus accepts it (MODELS_WITH_FAST_MODE); build the request through
   * lib/fast-mode's parseWith, and the AI runner drops speed before it ever
   * drops models when capacity pushes back.
   */
  speed?: "fast" | null;
};


// Build a request's `thinking` parameter. Null means omit it entirely, which is
// what a model that rejects adaptive thinking needs - it is NOT the same as
// "disabled", because the model default differs by generation and omitting is
// the only safe thing to send to a model that understands neither form.
export function thinkingFor(config: ModelConfig): { thinking?: { type: "adaptive" | "disabled" } } {
  // The cast covers `between_tools` only, which the installed SDK does not type
  // yet. It is a real wire value - upgrading the SDK removes the cast and
  // nothing else. withModelGuards has already refused any mode the resolved
  // model rejects, so what reaches here is always something that model takes.
  return config.thinking ? { thinking: { type: config.thinking as "adaptive" | "disabled" } } : {};
}

// Build a request's output_config, including `effort` only when the resolved
// model supports it. Every feature should go through this rather than
// hand-assembling output_config, so a model swap can't reintroduce the 400.
// Generic in `extra` so the SDK can still infer the parsed response type from
// the `format` field passed through - a widened return type here would erase
// `parsed_output` at every call site.
export function outputConfigFor<T extends Record<string, unknown>>(
  config: ModelConfig,
  extra?: T,
): T & { effort?: Effort } {
  return {
    ...((extra ?? {}) as T),
    ...(config.effort ? { effort: config.effort } : {}),
  };
}
