"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/current-user";
import { closeNotificationByKey, upsertNotification } from "@/lib/notifications";
import { getPendingFlash, markFlashShown, thankYouNotification } from "@/lib/prompt-flash";
import { getThankYouPrompts } from "@/lib/thank-you-db";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { markReminderApplied } from "@/lib/application-reminders-db";

/**
 * Record that this student has now seen one prompt bubble, and file it under
 * the bell.
 *
 * The bubble is gone in five seconds whether or not they read it, so the
 * notification is the durable half of the same event: same moment, same job,
 * one row that keeps it until it is done. A job that prompts again - an
 * interview at the three-day mark after the seven - bumps its row to the top
 * rather than adding a second.
 *
 * Everything is re-derived on the server from the prompt this student is
 * actually being shown; the browser only says which one it saw. So the client
 * cannot file a notification about something it was never shown, and nothing
 * that lands in the database was typed by anyone. That is also why this action
 * needs no language check.
 */
export async function markPromptFlashSeen(flashKey: string) {
  const user = await getCurrentUser();
  const pending = await getPendingFlash(user);
  // Gone between the render and the mount - the work was finished, or the date
  // passed. Nothing to record.
  if (!pending || pending.flashKey !== flashKey) return;

  // File the job FIRST, then record the bubble.
  //
  // In that order a failed write costs the student one repeated bubble; in the
  // other order it costs them the job entirely - the flash is marked shown, so
  // it never fires again, and nothing ever reaches the bell. That is not
  // hypothetical: it is exactly what happened when the notification kind was
  // added to the code but not to the database.
  for (const notification of pending.notifications) {
    await upsertNotification({ userId: user.id, ...notification });
  }
  await markFlashShown(user.id, pending.flashKey);
}

/**
 * "I sent the thank-you" - ticked on the to-do list, for one sent outside
 * Offerly.
 *
 * Takes the key of a prompt and nothing else, and only acts on a thank-you
 * this student actually owes right now, so nothing typed reaches the database
 * and a made-up key does nothing. Files the job first if the bubble never did,
 * then closes it: the closed row is the record that it is done.
 */
export async function completeThankYouPrompt(key: string) {
  const user = await getCurrentUser();
  const owed = (await getThankYouPrompts(user.id)).find((t) => t.key === key);
  if (!owed) return;

  await upsertNotification({ userId: user.id, ...thankYouNotification(owed, await getStudentTimeZone()) });
  await closeNotificationByKey(user.id, owed.key, "manual");
  revalidatePath("/", "layout");
}

/**
 * "I applied" - on a deadline reminder's banner.
 *
 * Takes the key of a reminder and nothing else, and acts only on one this
 * student has right now (see markReminderApplied): their tracker entry is
 * marked submitted, or the posting added to it as submitted, and the job
 * under the bell closes.
 */
export async function markAppliedFromReminder(key: string) {
  const user = await getCurrentUser();
  if (typeof key !== "string" || key.length > 200) return;
  if (await markReminderApplied(user, key)) {
    revalidatePath("/", "layout");
    revalidatePath("/applications");
  }
}
