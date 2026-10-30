"use server";

import { getDraftSuggestions, type DraftSuggestions } from "@/lib/draft-suggestions-db";
import { paidActionUser } from "@/lib/plan-access";

/**
 * Suggested answers for the drafter's fields, for the person just picked.
 *
 * Called twice by the form: first without the model (instant, free, the facts
 * alone), then with it (one call per recipient, cached). Takes a recipient key
 * and nothing typed; the key is looked up against the signed-in student's own
 * contacts or the directory, so a made-up key returns nothing.
 */
export async function suggestDraftFields(recipientKey: string, withAi: boolean): Promise<DraftSuggestions | null> {
  // The drafter is a Pro feature. The layout gate covers the page; this guards
  // the action against a free account invoking it directly (the withAi path
  // spends a model call). Null reads as "no suggestions" in the form.
  const user = await paidActionUser();
  if (!user) return null;
  if (typeof recipientKey !== "string" || recipientKey.length > 100) return null;
  return getDraftSuggestions(user.id, recipientKey, { withAi: withAi === true });
}
