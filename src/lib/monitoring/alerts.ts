import "server-only";
import { eq } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { userAlerts, userTopFirms } from "@/db/schema";

type Db = Awaited<ReturnType<typeof getDb>>;

// Called once, right after a listing is approved and published into
// internshipPostings. Finds every student who has this firm on their own
// Top Firms list (the existing watchlist - see userTopFirms) and gives each
// one exactly one alert row. onConflictDoNothing against the
// (userId, postingId, kind) unique index is what makes this safe to call
// more than once for the same posting - a re-run after a data fix can't
// double-notify anyone.
//
// Takes `db` as a parameter rather than calling getDb() itself - see
// priority.ts's computePriorityScore for why a standalone script and
// getDb()'s own connection can't safely coexist against one PGlite file.
export async function notifyWatchersOfOpening(
  db: Db,
  input: { postingId: string; firmId: string; firmName: string; roleTitle: string },
): Promise<number> {
  const watchers = await db.query.userTopFirms.findMany({
    where: eq(userTopFirms.firmId, input.firmId),
    columns: { userId: true },
  });
  if (watchers.length === 0) return 0;

  const rows = watchers.map((w) => ({
    userId: w.userId,
    kind: "watched_firm_opening" as const,
    postingId: input.postingId,
    title: `${input.firmName} just opened: ${input.roleTitle}`,
    body: `A role you're watching for is live - ${input.firmName} · ${input.roleTitle}.`,
  }));

  const inserted = await db.insert(userAlerts).values(rows).onConflictDoNothing().returning();
  return inserted.length;
}
