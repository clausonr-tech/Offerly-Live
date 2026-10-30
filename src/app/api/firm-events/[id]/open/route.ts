import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { firmRecruitingEvents, firms } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { recordEngagement } from "@/lib/firm-engagement";
import { eventDestination, isUuid } from "@/lib/firm-links";

/**
 * A firm-posted event's link: counts the click for the firm's analytics, then
 * opens the firm's RSVP page - or the firm's page on Offerly when the firm
 * gave no RSVP link. Crawled events link straight to their source and never
 * come through here.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fallback = new URL("/discovery", request.url);
  if (!isUuid(id)) return NextResponse.redirect(fallback);

  const db = await getDb();
  const [event] = await db
    .select({
      id: firmRecruitingEvents.id,
      firmId: firmRecruitingEvents.firmId,
      rsvpUrl: firmRecruitingEvents.rsvpUrl,
      slug: firms.slug,
      isActive: firmRecruitingEvents.isActive,
      takenDownAt: firmRecruitingEvents.takenDownAt,
      isDemo: firmRecruitingEvents.isDemo,
    })
    .from(firmRecruitingEvents)
    .innerJoin(firms, eq(firms.id, firmRecruitingEvents.firmId))
    .where(eq(firmRecruitingEvents.id, id))
    .limit(1);
  if (!event) return NextResponse.redirect(fallback);

  // A cancelled or taken-down event, or the demo firm's outside the demo,
  // goes back to Discovery rather than to the RSVP page.
  const user = await getSessionUser();
  if (!event.isActive || event.takenDownAt || (event.isDemo && !user?.isDemo)) {
    return NextResponse.redirect(fallback);
  }
  if (user?.accountType === "student") {
    await recordEngagement({ firmId: event.firmId, userId: user.id, kind: "event_click", eventId: event.id });
  }

  const destination = new URL(eventDestination(event.rsvpUrl, event.slug), request.url).toString();
  return NextResponse.redirect(destination);
}
