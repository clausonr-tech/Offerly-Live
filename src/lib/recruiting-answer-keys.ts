/**
 * The answers the wizard builds from data rather than from the question bank:
 * sectors, tiers, coverage groups, locations.
 *
 * Shared by the settings form and the action that saves it. They were defined
 * only in the form, so the action - which iterated the question bank alone -
 * rendered five editable fields and then silently discarded every one of them.
 * One list, imported by both, is what stops that recurring.
 *
 * Not in the "use server" action file on purpose: a server-action module may
 * only export async functions, so a constant shared with a client component
 * has to live somewhere neutral.
 */
export const DATA_ANSWER_KEYS = [
  "preferredCategories",
  "ibTierPreferences",
  "peTierPreferences",
  "nicheInterests",
  "targetLocations",
] as const;

/**
 * Sentinel for the "Other" chip. The typed answer arrives in a companion field
 * named `<key>__other`, and the action swaps the sentinel for it on save, so
 * nothing downstream ever sees this string.
 */
export const OTHER = "__other__";

export const otherFieldName = (key: string) => `${key}__other`;

/**
 * Questions that accept a typed answer.
 *
 * Deliberately NOT the sectors or the tier questions: those are stored as
 * fixed keys that firm matching compares against ("investment_banking",
 * "Bulge Bracket"). A free-text sector would satisfy no firm and silently
 * empty the student's list, so free text is only offered where the answer is
 * descriptive rather than something the matcher has to match on.
 */
export const OTHER_ALLOWED_KEYS: readonly string[] = ["targetLocations", "nicheInterests"];
