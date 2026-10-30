"use server";

import { searchFirmNames } from "@/lib/firms";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userTopFirms } from "@/db/schema";
import { getCurrentUser, getCurrentUserId } from "@/lib/current-user";
import { matchTopFirmsForUser } from "@/lib/match-top-firms";

export type TopFirmsState = { error?: string } | undefined;

// The matching itself lives in lib/match-top-firms.ts, because Discovery runs
// the same match automatically on a student's first visit. This stays as the
// button's server-action wrapper: run it, then revalidate the pages whose
// contents the picks just changed.
export async function findTopFirmsForUser(_prevState: TopFirmsState): Promise<TopFirmsState> {
  const user = await getCurrentUser();
  const result = await matchTopFirmsForUser(user);
  if (result.error) return { error: result.error };

  revalidatePath("/dashboard");
  revalidatePath("/discovery");
  revalidatePath("/contacts");
  revalidatePath("/schedule");
  return undefined;
}

export async function addTopFirm(_prevState: TopFirmsState, formData: FormData): Promise<TopFirmsState> {
  const firmId = String(formData.get("firmId") ?? "").trim();
  if (!firmId) return { error: "Select a firm." };

  const userId = await getCurrentUserId();
  const db = await getDb();

  const existing = await db.query.userTopFirms.findFirst({
    where: and(eq(userTopFirms.userId, userId), eq(userTopFirms.firmId, firmId)),
  });
  if (existing) return undefined; // already on the list

  await db.insert(userTopFirms).values({ userId, firmId, source: "manual" });

  // No reminder is created here any more. The one this used to write was an
  // "(estimated window)" row dated from the firm's prose timing guidance and
  // the student's graduation year - a month, not a deadline. Real dates reach
  // the Schedule grid from the postings themselves; see lib/deadline-reminders.ts.

  revalidatePath("/dashboard");
  revalidatePath("/schedule");
  return undefined;
}

export async function removeTopFirm(topFirmId: string) {
  const userId = await getCurrentUserId();
  const db = await getDb();
  await db.delete(userTopFirms).where(and(eq(userTopFirms.id, topFirmId), eq(userTopFirms.userId, userId)));
  revalidatePath("/dashboard");
  // Discovery's "Your matches" tab renders the same grid from the same rows, so
  // removing a firm there has to invalidate both or the tab you did it on keeps
  // showing the firm you just dropped.
  revalidatePath("/discovery");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Saves the order the student dragged their top firms into: each id gets its
 * place in the list. Only the caller's own rows are touched (userId in every
 * WHERE), so an id from someone else's list changes nothing. Firms left out of
 * `topFirmIds` - beyond the slice on screen - keep their default order after
 * these.
 */
export async function reorderTopFirms(topFirmIds: string[]) {
  if (!Array.isArray(topFirmIds) || topFirmIds.length > 200 || !topFirmIds.every((id) => typeof id === "string" && UUID.test(id))) {
    return;
  }
  const userId = await getCurrentUserId();
  const db = await getDb();
  await Promise.all(
    topFirmIds.map((id, position) =>
      db.update(userTopFirms).set({ position }).where(and(eq(userTopFirms.id, id), eq(userTopFirms.userId, userId))),
    ),
  );
  revalidatePath("/dashboard");
  revalidatePath("/discovery");
}

/**
 * Rows for the "add a firm" picker, fetched as the student types.
 *
 * The picker used to receive every firm in the directory up front and filter
 * in the browser. At 22,569 firms that was seconds of server time and a
 * multi-megabyte payload, on every dashboard load, to render thirty rows that
 * most visits never open. This returns only what is about to be displayed.
 */
export async function searchFirmsForPicker(
  query: string,
): Promise<{ id: string; name: string; website: string }[]> {
  const user = await getCurrentUser();
  // Trimmed and capped before it reaches a LIKE pattern. This is a filter over
  // public firm names - nothing is stored, and nothing is shown to anyone but
  // the person typing - so the content rules that govern written words do not
  // apply to it, but an unbounded string still has no business reaching SQL.
  const term = query.trim().slice(0, 100);
  return searchFirmNames({
    query: term || null,
    categories: term ? null : user.preferredCategories,
  });
}
