/**
 * Which plans open the paid sections - the rule on its own.
 *
 * Split out of lib/plan-access.ts so it can be imported without dragging in
 * `redirect` from next/navigation and the session lookup: the gate decision is
 * what the paid server actions and the section layouts share, and what tests
 * pin. Same reasoning as lib/post-limits.ts and lib/message-limits.ts.
 *
 * lib/plan-access.ts re-exports this, so importing either is equivalent.
 *
 * Open-source build: there are no plans and nothing to sell, so every section
 * is open. The hosted product billed for the sections with real per-use cost
 * (AI drafts, resume reviews, the video coach, paid contact sourcing); when you
 * self-host, those costs are yours directly — they are on your own API keys —
 * so there is nothing left for a paywall to protect. The gate stays in place as
 * a function rather than being deleted because the section layouts and paid
 * server actions call it in ~40 places, and a single honest `true` is clearer
 * than unpicking all of them.
 *
 * The per-feature monthly allowances in lib/plan-quotas are a separate thing
 * and still apply; they are what keeps a runaway loop from spending your API
 * budget in an afternoon.
 */

export function hasPaidAccess(_user: {
  plan: string;
  email: string | null;
  role?: string | null;
}): boolean {
  return true;
}
