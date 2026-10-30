"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { retractOffer } from "@/lib/activity";

/**
 * Stop tracking every role at one firm, in one click.
 *
 * The per-role toggle is the right granularity on a posting card, where the
 * student is looking at one role. It is the wrong granularity on the tracking
 * page after a 100-firm match, where a single firm can contribute nine rows and
 * "not this firm at all" is one decision, not nine.
 */
export async function untrackFirm(firm: string): Promise<{ removed: number }> {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const rows = await db.query.applications.findMany({
    where: and(eq(applications.userId, userId), eq(applications.firm, firm)),
    columns: { id: true },
  });
  if (!rows.length) return { removed: 0 };

  await db.delete(applications).where(
    and(
      eq(applications.userId, userId),
      inArray(
        applications.id,
        rows.map((r) => r.id),
      ),
    ),
  );

  // The feed announcement goes with the row. Nothing cascades: an offer event
  // finds its application through a plain text dedupe key with no foreign key,
  // so deleting the application on its own leaves the student's own feed
  // announcing an offer for a role they can no longer open from the tracker.
  // Owner-visible only (activity.visibleToViewer), so this is the student's
  // control over their own announcement rather than a disclosure.
  await retractOffer(userId, rows.map((r) => r.id));

  revalidatePath("/tracking");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");
  revalidatePath("/discovery");
  return { removed: rows.length };
}
