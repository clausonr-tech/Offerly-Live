"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/current-user";
import {
  recordOutreachSend,
  setContactReplied,
  undoOutreachSend,
} from "@/lib/outreach-ladder-db";

// The networking table's outreach column: what the student says happened with
// one contact's cold emails. None of these take typed words - ids and a flag -
// which is why none carries a language check (see the EXEMPT list in
// scripts/content-limits-coverage-test.ts).

/** Everywhere the table renders, and the prompts that read the same rows. */
function refresh() {
  // The sheet lives at /contacts (External Network). The layout, because the
  // bell and the bubble in it read the ladder too.
  revalidatePath("/contacts", "layout");
  revalidatePath("/dashboard");
}

/**
 * "I sent this person the next email" - for one written outside Offerly.
 * Emails copied out of the composer record themselves (recordDraftCopied).
 */
export async function markOutreachSent(contactId: string) {
  const user = await getCurrentUser();
  const sent = await recordOutreachSend({ userId: user.id, contactId, source: "manual" });
  refresh();
  return sent ? { step: sent.step, sendId: sent.sendId } : { error: "No emails left to send on this ladder." };
}

/** Take back the most recent email - a copy that was not a send, or a mis-click. */
export async function undoOutreachSendAction(sendId: string) {
  const user = await getCurrentUser();
  const ok = await undoOutreachSend(user.id, sendId);
  refresh();
  return ok ? {} : { error: "Only the most recent email can be taken back." };
}

/** They replied, or they did not after all. A reply stops every follow-up prompt. */
export async function setContactRepliedAction(input: { contactId: string; replied: boolean }) {
  const user = await getCurrentUser();
  await setContactReplied(user.id, input.contactId, input.replied);
  refresh();
}
