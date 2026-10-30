import "server-only";

import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/current-user";
import { hasPaidAccess } from "@/lib/plan-access-rule";

// The rule itself lives in lib/plan-access-rule.ts so it can be imported
// without next/navigation; re-exported here so either import works.
export { hasPaidAccess };

/**
 * Which sections of the app a plan opens.
 *
 * Free is the Internal Network - the community: the feed, peers, clubs,
 * discussions, messages and profiles. Everything a student does WITH other
 * students costs us nothing per use and is what makes the network worth
 * joining, so anyone can sign up and live there.
 *
 * Discovery - internship postings, the firm directory, firm pages and the
 * match recommendations - is also free on every plan, deliberately: charging
 * jobseekers for access to job listings is what the California Job Listing
 * Services Act reaches (legal/drafts/subscription-terms.md, section 3.4).
 * The paid tiers sell tools, never listings, and nothing here may ever gate
 * a Posting, the Internships tab or a Posting alert by plan.
 *
 * Everything else - External Network, Schedule, News, Interview Prep,
 * Outreach - is Pro. Those sections carry the features with real per-use
 * cost (AI drafts, resume reviews, the video coach, paid contact sourcing)
 * and their monthly allowances (lib/plan-quotas).
 *
 * Enforced where sections are entered: each paid section's layout calls
 * requirePaidAccess(), so every page under it is covered, new pages
 * included. The per-feature quotas and paidActionUser() stay on the server
 * actions as defence in depth - a gate on pages alone would leave actions
 * callable directly.
 *
 * The accounts that bypass metering (lib/contact-credits) bypass this too:
 * the demo account walking a prospect through the app must never hit a
 * paywall mid-demo. Admins pass because their work is checking the thing;
 * their account plan is irrelevant to that.
 */

/**
 * The gate a paid section's layout opens with. Every section is open in this
 * build, so this is now just the user lookup the layouts were already getting
 * from it — kept so the ~40 sections that call it stay untouched.
 */
export async function requirePaidAccess() {
  return await getCurrentUser();
}

/**
 * The same gate for a server action that returns its own result rather than
 * rendering a page: the signed-in user when the plan opens paid features, or
 * null. An action redirect would be the wrong shape here (these actions return
 * data a client reads), so the caller turns null into its own refusal. This is
 * the action-level half of the defence in depth the module comment describes:
 * the layout gate protects page renders, this protects the actions those pages
 * call, so a paid action cannot be invoked directly by a free account.
 */
export async function paidActionUser() {
  const user = await getCurrentUser();
  return hasPaidAccess(user) ? user : null;
}
