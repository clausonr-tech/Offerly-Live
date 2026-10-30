// Fast mode: the same model generating output tokens roughly twice as fast,
// at premium per-token pricing. Because it is the SAME model with the same
// prompt, output quality is untouched - it is purely a latency-for-cost
// trade, which is why only the paid tier's longest Opus calls opt in
// (model-registry sets `speed` per feature and plan).
//
// The API requires three things on a fast request: the beta messages
// endpoint, the beta flag, and `speed: "fast"` as a top-level parameter.
// This helper owns all three so call sites stay one line.
//
// Not "server-only" for the same reason as draft-pipeline: the offline eval
// scripts run these pipelines directly.

import type Anthropic from "@anthropic-ai/sdk";

const FAST_MODE_BETA = "fast-mode-2026-02-01";

type SpeedConfig = { speed?: "fast" | null };

/**
 * The `parse` to call for a config: the beta endpoint with `speed: "fast"`
 * when the config asks for it, the stable endpoint otherwise.
 *
 * The beta surface takes the same request shape plus `speed` and `betas`,
 * and returns the same parsed message shape for everything our call sites
 * read (`parsed_output`, `usage`, `stop_reason`), so it is presented under
 * the stable signature to keep `parsed_output` inference at the call site.
 * A fast-mode rate limit surfaces as an ordinary capacity error, which the
 * AI runner answers by retrying the same model at standard speed before it
 * ever downgrades models - speed is given up before capability.
 */
export function parseWith(client: Anthropic, cfg: SpeedConfig): typeof client.messages.parse {
  if (cfg.speed !== "fast") return client.messages.parse.bind(client.messages);
  return ((params: Record<string, unknown>) =>
    client.beta.messages.parse({
      ...params,
      speed: "fast",
      betas: [FAST_MODE_BETA],
    } as never)) as typeof client.messages.parse;
}
