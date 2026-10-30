import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";

type Answered = {
  id: string;
  preferredCategories: string[] | null;
  recruitingStage: string | null;
  onboardingCompletedAt: Date | null;
  profileLinksPromptedAt: Date | null;
};

/**
 * Repairs an account that has ANSWERS but is missing the flag that records it.
 *
 * That state is reachable without anyone skipping anything: an account seeded
 * directly, or created before the questionnaire existed, has preferences on it
 * and no `onboardingCompletedAt` - and the layout gate then sends it back to
 * "Add your LinkedIn" on every single navigation, forever. This ends that loop
 * by trusting the answers that are already there.
 *
 * It reads only the account's OWN row. An earlier version copied the most
 * recent answers from whichever account last completed onboarding, which made
 * a new signup inherit a stranger's sectors and their free-text answers about
 * their own background. Onboarding is first-run guidance - a genuinely new
 * account should see it.
 */
export async function repairOnboardingFlag(user: Answered): Promise<boolean> {
  if (user.onboardingCompletedAt) return true;

  // "Has answered" is the core question the wizard requires. Anything less and
  // there is nothing to remember, so the questionnaire should still run.
  const hasAnswers = !!user.preferredCategories?.length || !!user.recruitingStage;
  if (!hasAnswers) return false;

  try {
    const db = await getDb();
    await db
      .update(users)
      .set({
        onboardingCompletedAt: new Date(),
        // The links step is optional and this account is past it.
        profileLinksPromptedAt: user.profileLinksPromptedAt ?? new Date(),
      })
      .where(eq(users.id, user.id));
    return true;
  } catch (err) {
    // Never break a page load over this; worst case the gate fires as before.
    console.error("[onboarding] flag repair failed", err);
    return false;
  }
}
