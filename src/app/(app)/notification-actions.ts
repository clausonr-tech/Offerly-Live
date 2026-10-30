"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/current-user";
import { markNotificationDone, markNotificationsRead } from "@/lib/notifications";

/**
 * Tick one notification off by hand.
 *
 * Takes an id and nothing else - no free text, which is why it carries no
 * language check - and the id is scoped to the signed-in student inside the
 * query, so one cannot close another's.
 */
export async function completeNotification(id: string) {
  const user = await getCurrentUser();
  await markNotificationDone(user.id, id);
  // The bell lives in the app layout, so every page carries it.
  revalidatePath("/", "layout");
}

/** Opening the panel is reading it: clears the unread dot, not the count. */
export async function readNotifications() {
  const user = await getCurrentUser();
  await markNotificationsRead(user.id);
}
