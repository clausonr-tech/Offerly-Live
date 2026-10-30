import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { events } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { buildICS } from "@/lib/calendar";

export async function GET() {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const rows = await db.query.events.findMany({
    where: eq(events.userId, userId),
  });

  const ics = buildICS(
    rows.map((r) => ({ id: r.id, title: r.title, notes: r.notes, eventDate: r.eventDate })),
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="recruit-os-schedule.ics"',
    },
  });
}
