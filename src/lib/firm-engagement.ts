import "server-only";
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firmEngagement } from "@/db/schema";

// The click log behind a firm's Analytics tab. Only ever read in aggregate
// (lib/firm-analytics.ts); a firm never sees who clicked.

export type EngagementKind = "apply_click" | "event_click" | "event_calendar_add";

/**
 * Records one click. A student clicking Apply three times in a minute is one
 * act, so a repeat within DEDUPE_MS is not written again - the firm's numbers
 * count intent, not double-clicks.
 */
const DEDUPE_MS = 10 * 60 * 1000;

export async function recordEngagement(input: {
  firmId: string;
  userId: string;
  kind: EngagementKind;
  postingId?: string | null;
  eventId?: string | null;
}): Promise<void> {
  try {
    const db = await getDb();
    const since = new Date(Date.now() - DEDUPE_MS);
    const recent = await db.query.firmEngagement.findFirst({
      where: and(
        eq(firmEngagement.userId, input.userId),
        eq(firmEngagement.kind, input.kind),
        input.postingId ? eq(firmEngagement.postingId, input.postingId) : undefined,
        input.eventId ? eq(firmEngagement.eventId, input.eventId) : undefined,
        gte(firmEngagement.createdAt, since),
      ),
      columns: { id: true },
    });
    if (recent) return;
    await db.insert(firmEngagement).values({
      firmId: input.firmId,
      userId: input.userId,
      kind: input.kind,
      postingId: input.postingId ?? null,
      eventId: input.eventId ?? null,
    });
  } catch (err) {
    // Analytics must never stand between a student and the page they asked
    // for. A failed write is logged and the redirect goes ahead.
    console.error("[firm-engagement]", err);
  }
}
