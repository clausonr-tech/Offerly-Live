"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/current-user";
import {
  runContactSourcing,
  type GenerateContactsResult,
} from "@/lib/contact-sourcing-run";
import type { RequestMode } from "@/lib/sourcing-run-policy";

export type { GenerateContactsResult };

/**
 * "Generate contacts" for one firm.
 *
 * Deliberately thin. Everything that decides anything - the idempotency key,
 * the cache, the provider ladder, the email gate, the transaction and the
 * charge - lives in lib/contact-sourcing-run.ts, where it can be driven
 * against a real database in tests. What is left here is the two things that
 * genuinely need a Next request context and cannot be tested without one:
 * reading the signed-in user from cookies, and revalidating the pages whose
 * contact counts just changed.
 *
 * Nothing below makes a decision. If you find yourself adding an `if` to this
 * file, it belongs in the module.
 */
export async function generateContactsAction(input: {
  firmId: string;
  /** `generate` (the button), `refresh` (deliberately different people) or
   *  `fill` (top up a partial set under the original run, free). */
  mode?: RequestMode;
}): Promise<GenerateContactsResult> {
  const user = await getCurrentUser();

  const result = await runContactSourcing({
    user: { id: user.id, email: user.email },
    firmId: input.firmId,
    mode: input.mode,
  });

  /**
   * Revalidation happens AFTER the transaction committed, and its failure is
   * not the run's failure. The contacts are saved and the credit is spent; a
   * stale cache is a page that refreshes a moment later, not a reason to tell
   * the student their generation failed.
   */
  if (result.ok) {
    for (const path of result.revalidate) {
      try {
        revalidatePath(path);
      } catch {
        // Outside a request context, or a path that no longer exists.
      }
    }
  }

  return result;
}
