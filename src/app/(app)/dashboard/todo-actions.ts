"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { emailDrafts, events, todoDismissals } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { recordOutreachSend } from "@/lib/outreach-ladder-db";
import { getAllTasks } from "@/lib/today-tasks";
import { loadNextBatch, recordCompleted } from "@/lib/today-list";

import { completeThankYouPrompt } from "../nudge-actions";
import { closeNotificationByKey, outreachNotificationKey } from "@/lib/notifications";
import { interviewNotificationKey } from "@/lib/prompt-flash";
import { applyNotificationKey } from "@/lib/application-outreach";
import { markReminderApplied } from "@/lib/application-reminders-db";
import { reconcileThankYouJobs } from "@/lib/thank-you-db";

// The to-do list's two buttons. Neither takes typed words - a task id the
// server checks against the student's own list, or nothing - which is why
// neither carries a language check (see the EXEMPT list in
// scripts/content-limits-coverage-test.ts).

function refresh() {
  revalidatePath("/dashboard");
  revalidatePath("/todo");
  // The bell and the bubble read some of the same work.
  revalidatePath("/", "layout");
}

/**
 * "Done" on one task.
 *
 * Only a task that is on this student's list right now - anything else is
 * ignored, so an id from the browser can do nothing it was not offered. Where
 * ticking it off means something happened, that is recorded too, so the rest
 * of the app agrees:
 *
 *   - a follow-up: that email is on the ladder, and the next one is a week out
 *   - a Schedule entry: marked done there
 *   - a draft waiting to go out: marked sent
 *   - a thank-you: its job under the bell closes
 *
 * And every tick is remembered, so the task stays off the list even where the
 * app cannot see the work (a firm the student has decided against).
 */
export async function completeTask(taskId: string) {
  const user = await getCurrentUser();
  const task = (await getAllTasks(user)).find((t) => t.id === taskId);
  if (!task) return;

  const db = await getDb();

  const ladder = /^ladder-([0-9a-f-]{36})-\d$/.exec(task.id);
  if (ladder) {
    await recordOutreachSend({ userId: user.id, contactId: ladder[1], source: "manual" });
  } else if (task.id.startsWith("event-")) {
    await db
      .update(events)
      .set({ completed: true })
      .where(and(eq(events.id, task.id.slice("event-".length)), eq(events.userId, user.id)));
  } else if (task.id.startsWith("draft-")) {
    await db
      .update(emailDrafts)
      .set({ sentAt: new Date() })
      .where(
        and(
          eq(emailDrafts.id, task.id.slice("draft-".length)),
          eq(emailDrafts.userId, user.id),
          isNull(emailDrafts.sentAt),
        ),
      );
  } else if (task.doneKey) {
    await completeThankYouPrompt(task.doneKey);
  }

  // A prompt that also lives under the bell is finished there too, and its
  // banner stops (getOutreachNudges and getInterviewPrepNudges skip anything
  // ticked here): "I have decided against this firm" is the student's call.
  const outreach = /^outreach-(.+)-(\d{4}-\d{2}-\d{2})$/.exec(task.id);
  if (outreach) {
    await closeNotificationByKey(user.id, outreachNotificationKey(outreach[1], outreach[2]), "manual");
  }
  // A deadline reminder ticked off is "I applied".
  if (task.id.startsWith("deadline-")) await markReminderApplied(user, task.id.slice("deadline-".length));
  const apply = /^apply-(.+)-(\d{4}-\d{2}-\d{2})$/.exec(task.id);
  if (apply) await closeNotificationByKey(user.id, applyNotificationKey(apply[1], apply[2]), "manual");
  const prep = /^interview-(.+)-(?:prep|refresh)$/.exec(task.id);
  if (prep) await closeNotificationByKey(user.id, interviewNotificationKey(prep[1]), "manual");
  // A thank-you draft ticked as sent answers what it was for.
  if (task.id.startsWith("draft-")) await reconcileThankYouJobs(user.id);

  // Into the permanent history, as ticked by hand, with what it said.
  await recordCompleted(user.id, [task], "manual");
  await db.insert(todoDismissals).values({ userId: user.id, taskId: task.id }).onConflictDoNothing();
  refresh();
}

/** "Load the next 5" - only once all five on screen are done. */
export async function loadNextTasks() {
  const user = await getCurrentUser();
  await loadNextBatch(user);
  refresh();
}
