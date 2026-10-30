import "server-only";

import { runAiFeature } from "./ai-runner";
import { costEquivalentInputTokens, type HelpMessage } from "./help-chat-rules";
import { buildHelpRequest, extractHelpReply, helpMessageParams, type HelpStudent } from "./help-assistant-prompt";
import { outputConfigFor, thinkingFor } from "./model-registry";

// The Help assistant on /help: answers any question a student has about
// Offerly or about recruiting, from a knowledge file written by
// scripts/help-knowledge-learn.ts (every page of the app, relearned whenever a
// page's code changes).
//
// The request is built by lib/help-assistant-prompt, which the tests and the
// live eval use directly. This file only makes the call, through the AI runner
// with the Help assistant's own gates (quota: "help") - one question at a
// time, a minute window, a daily ceiling and a global budget - so asking
// questions never uses a student's DAILY_LIMITS.

export { buildHelpRequest };

export async function getHelpReply(history: HelpMessage[], student: HelpStudent & { id: string }): Promise<string> {
  const request = buildHelpRequest(history, student);

  const response = await runAiFeature(
    {
      feature: "chat",
      userId: student.id,
      quota: "help",
      // Cost-equivalent input, so the global budget counts cached tokens at what they cost.
      meter: (usage) => ({ input_tokens: costEquivalentInputTokens(usage), output_tokens: usage.output_tokens }),
    },
    // The registry's effort and thinking for "chat" have to be spread in here:
    // helpMessageParams is client-safe and cannot reach the server-only
    // registry to build them itself. Dropping them is not a no-op - on a model
    // that thinks by default it silently spends the whole 450-token ceiling on
    // thinking and returns an empty reply.
    (client, cfg) =>
      client.messages.create({ ...helpMessageParams(request, cfg), ...thinkingFor(cfg), output_config: outputConfigFor(cfg) }),
  );

  return extractHelpReply(response);
}
