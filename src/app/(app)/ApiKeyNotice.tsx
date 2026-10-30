import { hasAnthropicKey } from "@/lib/anthropic-client";

/**
 * Says the AI features are switched off, and what to do about it.
 *
 * A self-hosted copy runs perfectly well with no key at all — onboarding, the
 * tracker, contacts, discovery, the news tab and the crawler are all unaffected
 * — so this is not an error state and does not look like one. It is the one
 * piece of setup that is not obvious from the app itself, shown where it will
 * be read instead of waiting for someone to click Draft and get a refusal.
 *
 * Renders nothing once the key is set, so it disappears after a restart.
 */
export default function ApiKeyNotice() {
  if (hasAnthropicKey()) return null;

  return (
    <div
      role="status"
      className="mx-auto w-full max-w-7xl px-4 pt-6 sm:px-6 lg:px-10"
    >
      <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
        <p className="font-medium">AI features are off — no API key configured</p>
        <p className="mt-1 text-brand-800">
          Email drafts, résumé review, connection suggestions and the interview
          coach each call the Anthropic API on your own key. Create one at{" "}
          <a
            className="underline underline-offset-2 hover:opacity-80"
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer noopener"
          >
            console.anthropic.com
          </a>
          , then add it to <code className="font-mono">.env.local</code> in the
          project root and restart:
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-white/70 px-3 py-2 font-mono text-xs text-brand-900">
          ANTHROPIC_API_KEY=sk-ant-...
        </pre>
        <p className="mt-2 text-xs text-warmgray-600">
          Everything else works without it. The News tab and the job crawler use
          the signed-in <code className="font-mono">claude</code> CLI instead of
          the API, so they need no key either.
        </p>
      </div>
    </div>
  );
}
