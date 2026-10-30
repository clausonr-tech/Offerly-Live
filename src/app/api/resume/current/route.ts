import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/current-user";
import { findStudentResume, readStudentResume } from "@/lib/resume-file";

// The signed-in student's own resume, for the "View" link on their profile.
// Scoped to the session, never to an id in the URL, so it can only ever serve
// the caller's file.
export async function GET() {
  const userId = await getCurrentUserId();
  const resume = await readStudentResume(await findStudentResume(userId));
  if (!resume) {
    return NextResponse.json({ error: "No resume uploaded yet." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(resume.bytes), {
    headers: {
      "Content-Type": resume.mimeType,
      "Content-Disposition": `inline; filename="${resume.filename.replace(/["\r\n]/g, "")}"`,
      // Replaced as the student iterates; a cached copy would show the old one.
      "Cache-Control": "no-store",
      // This is the caller's own upload, but serve it with the same defenses as
      // the firm and share-link routes so a crafted file cannot run as a page
      // on Offerly's origin in the student's signed-in session.
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
