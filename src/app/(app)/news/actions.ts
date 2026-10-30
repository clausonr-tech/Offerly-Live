"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { newsDigests, users } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { isPaidPublisherId } from "@/lib/news/access";
import { isReportReason, recordReport } from "@/lib/news/takedown";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A student flagging a story. A story id and one of four fixed reasons -
 * nothing typed. Enough reports take the story down until an admin reviews it
 * (src/lib/news/takedown.ts).
 */
export async function reportNewsStory(itemId: string, reason: string): Promise<{ ok: boolean; hidden?: boolean }> {
  const userId = await getCurrentUserId();
  if (!UUID_RE.test(itemId) || !isReportReason(reason)) return { ok: false };
  const db = await getDb();
  const { hidden } = await recordReport(db, userId, itemId, reason);
  if (hidden) revalidatePath("/news");
  return { ok: true, hidden };
}

/**
 * The paid news sources a student can read. Fixed choices only (publisher
 * ids from src/lib/news/access.ts); anything else is ignored. Today's stored
 * digest is dropped so the next visit rebuilds it around what they can open.
 */
export async function saveNewsAccess(_prev: { ok: boolean } | undefined, formData: FormData): Promise<{ ok: boolean }> {
  const userId = await getCurrentUserId();
  const chosen = [...new Set(formData.getAll("access").filter(isPaidPublisherId))];
  const db = await getDb();
  await db.update(users).set({ newsAccess: chosen }).where(eq(users.id, userId));
  await db.delete(newsDigests).where(eq(newsDigests.userId, userId));
  revalidatePath("/news");
  return { ok: true };
}
