import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { resumeReviews } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { resumeFilename, resumeToDocx, resumeToPdf } from "@/lib/resume-export";
import type { RevisedResume } from "@/lib/resume-rewrite";

// Downloads the rewritten resume. The id comes from the URL, so the row is
// fetched scoped to the signed-in user - otherwise anyone with a review id
// could pull down someone else's resume.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getCurrentUserId();
  const { id } = await params;
  const format = new URL(request.url).searchParams.get("format") === "docx" ? "docx" : "pdf";

  const db = await getDb();
  const row = await db.query.resumeReviews.findFirst({
    where: and(eq(resumeReviews.id, id), eq(resumeReviews.userId, userId)),
  });
  if (!row?.revised) {
    return NextResponse.json({ error: "No rewritten resume to export yet." }, { status: 404 });
  }

  const resume = row.revised as RevisedResume;
  const body = format === "docx" ? await resumeToDocx(resume) : await resumeToPdf(resume);

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type":
        format === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/pdf",
      "Content-Disposition": `attachment; filename="${resumeFilename(resume.name, format)}"`,
      // The draft changes as the student edits it; a cached copy would hand
      // them yesterday's resume.
      "Cache-Control": "no-store",
    },
  });
}
