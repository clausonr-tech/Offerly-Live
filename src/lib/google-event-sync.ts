import "server-only";
import { eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { createCalendarEvent, eventTypeWantsMeet } from "@/lib/google-calendar";

type Db = Awaited<ReturnType<typeof import("@/db/client").getDb>>;

type EventRow = Pick<
  typeof events.$inferSelect,
  "id" | "title" | "notes" | "eventDate" | "endDate" | "type"
>;

/**
 * Pushes one schedule event to the student's Google calendar and records the
 * returned ids on the row - the write-back is what makes a second export of
 * the same event a no-op. Shared by the schedule export and the discovery
 * page's "add to calendar"; callers keep their own best-effort try/catch,
 * because what a failure should abandon differs between them.
 */
export async function pushEventToGoogle(
  db: Db,
  target: { accessToken: string; calendarId: string },
  row: EventRow,
): Promise<void> {
  const created = await createCalendarEvent(target.accessToken, target.calendarId, {
    title: row.title,
    notes: row.notes,
    eventDate: row.eventDate,
    endDate: row.endDate,
    withMeet: eventTypeWantsMeet(row.type),
  });
  await db
    .update(events)
    .set({
      googleEventId: created.id,
      googleCalendarId: target.calendarId,
      googleMeetUrl: created.meetUrl,
      googleSyncStatus: "synced",
    })
    .where(eq(events.id, row.id));
}
