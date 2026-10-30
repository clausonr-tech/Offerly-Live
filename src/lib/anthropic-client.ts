import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Thrown when an AI feature is used before a key is configured.
 *
 * Its own class, rather than a bare Error, for the same reason
 * QuotaExceededError has one: callers show `message` to the person directly,
 * and a refusal they can act on has to be distinguishable from a genuine
 * failure they cannot. A missing key is not a bug and must not read like one.
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "This feature needs your own Anthropic API key. Add ANTHROPIC_API_KEY to .env.local in the project root, then restart the server. You can create a key at console.anthropic.com/settings/keys.",
    );
    this.name = "MissingApiKeyError";
  }
}

/**
 * Whether API-backed AI features can run at all.
 *
 * Separate from getAnthropicClient() so a page can ASK without throwing —
 * the banner in (app)/layout.tsx uses this to say the key is missing before
 * anyone clicks something that needs it.
 *
 * Note this is only about the API. The news pipeline does not come through
 * here: it shells out to the signed-in `claude` CLI (lib/news/claude-cli.ts)
 * and deliberately strips ANTHROPIC_API_KEY from the child environment, so
 * news and the crawler keep working with no key set.
 */
export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;

export function getAnthropicClient() {
  if (!hasAnthropicKey()) throw new MissingApiKeyError();
  if (!client) {
    client = new Anthropic();
  }
  return client;
}
