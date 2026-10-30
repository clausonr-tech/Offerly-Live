/**
 * The current version of the privacy policy and terms, and the record of what
 * changed in each one.
 *
 * Date-stamped rather than numbered: every consent row stores the version the
 * user actually agreed to, and the only question anyone ever asks of that
 * record - in a support thread or in diligence - is "what did the document say
 * on the day they agreed to it?" A date answers that directly.
 *
 * RULE: bump this whenever the policy changes in a way that affects what may
 * be done with user data. Bumping it re-gates every existing account on their
 * next page load (see the consent check in (app)/layout.tsx), which is the
 * point - a consent record that silently carries forward across a material
 * change is not a consent record.
 *
 * Cosmetic edits (typos, formatting, a clearer sentence that does not change
 * meaning) should NOT bump it; re-prompting every user over a comma trains
 * them to click through without reading, which devalues every future prompt.
 */
export const POLICY_VERSION = "2026-09-28";

/**
 * What a user is agreeing to at POLICY_VERSION, in the words the consent UI
 * shows them. Kept here rather than inline in the form so the signup checkbox,
 * the re-consent interstitial, and the settings page cannot drift apart and
 * describe the same agreement three different ways.
 */
export const CONSENT_SUMMARY = [
  "Offerly stores your profile, resume, contacts, drafts and messages to run the product for you.",
  "If you allow it (below), Offerly uses your drafts and resume edits - with names and contact details removed - to improve the models behind its writing tools. You can turn this off at any time.",
  "Offerly never sells your data. It shares your profile with firms only if you choose to, and you can stop at any time.",
] as const;

/**
 * What opting in to firm sharing hands a firm, in the words every place that
 * asks for it uses: the last onboarding step, the consent screen, Settings and
 * the privacy policy. One list, so the promise cannot differ between the place
 * a student said yes and the place they read what they said yes to.
 *
 * Keep it in step with lib/firm-sharing.ts SHARED_PROFILE, which is what the
 * code actually selects. The test in scripts/test/firm-sharing.test.ts checks
 * that no field outside that list - GPA, visa sponsorship, contacts, drafts,
 * messages - ever reaches a firm.
 */
export const FIRM_SHARING_SHARED = [
  "Your name, school, class year, degree and major",
  "The sectors, roles and cities you are recruiting for",
  "Your email address, LinkedIn and resume",
] as const;

export const FIRM_SHARING_NOT_SHARED = [
  "Your GPA or visa sponsorship answer",
  "Your contacts, drafts, notes or messages with anyone else",
] as const;
