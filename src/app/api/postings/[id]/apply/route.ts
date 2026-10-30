import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { internshipPostings } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { recordEngagement } from "@/lib/firm-engagement";
import { applyDestination, isUuid } from "@/lib/firm-links";

/**
 * The Apply button: counts the click for the firm's analytics, then sends the
 * student to the firm's application page.
 *
 * A GET that redirects, so the button stays a plain link that opens in a new
 * tab. Only a signed-in student's click is counted; the redirect happens for
 * anyone, because the destination is the firm's public page anyway.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fallback = new URL("/discovery/internships", request.url);
  if (!isUuid(id)) return NextResponse.redirect(fallback);

  const db = await getDb();
  const posting = await db.query.internshipPostings.findFirst({
    where: eq(internshipPostings.id, id),
    columns: { id: true, firmId: true, applicationUrl: true, recruiterEmail: true, isActive: true, takenDownAt: true, isDemo: true },
  });
  if (!posting) return NextResponse.redirect(fallback);

  // Only a posting a student could see is followed: a closed one, one Offerly
  // took down, or the demo firm's (outside the demo) goes back to Discovery,
  // so an old link cannot keep sending people to a page that was pulled.
  const user = await getSessionUser();
  if (!posting.isActive || posting.takenDownAt || (posting.isDemo && !user?.isDemo)) {
    return NextResponse.redirect(fallback);
  }

  const destination = applyDestination(posting.applicationUrl, posting.recruiterEmail);
  if (!destination) return NextResponse.redirect(fallback);

  if (user?.accountType === "student") {
    await recordEngagement({ firmId: posting.firmId, userId: user.id, kind: "apply_click", postingId: posting.id });
  }
  return NextResponse.redirect(destination);
}
