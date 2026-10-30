import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { resumeReviews } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { rescoreReview } from "@/lib/resume-review";
import type { ResumeReview } from "@/lib/resume-review";
import type { RevisedResume } from "@/lib/resume-rewrite";
import ResumePanel from "../ResumePanel";

// A review is several model calls in a row; the upload action runs under this
// page's limit, the same as it did as a tab on /outreach.
export const maxDuration = 120;

/**
 * The resume builder, under Outreach in the rail. It used to be the second
 * tab on /outreach; every review taken lives at /outreach/resume/history.
 */
export default async function ResumeBuilderPage() {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const [row, reviewCount] = await Promise.all([
    db.query.resumeReviews.findFirst({
      where: eq(resumeReviews.userId, userId),
      orderBy: [desc(resumeReviews.createdAt)],
    }),
    db.query.resumeReviews
      .findMany({ where: eq(resumeReviews.userId, userId), columns: { id: true } })
      .then((rows) => rows.length),
  ]);

  // The jsonb columns come back as `unknown`; they were written from
  // ResumeReview in this same codebase, so the shape is ours rather than
  // user-supplied.
  // Scores are re-derived from the stored issues rather than read back raw, so
  // a review taken under an older penalty curve shows today's numbers.
  const rescored = row ? rescoreReview(row.dimensions as ResumeReview["dimensions"]) : null;

  const latestReview =
    row && rescored
      ? {
          score: rescored.score,
          summary: row.summary,
          strengths: row.strengths,
          dimensions: rescored.dimensions,
          improvements: rescored.improvements,
          // Null for reviews written before the rewrite critics existed.
          rewrites: (row.rewrites ?? []) as ResumeReview["rewrites"],
          id: row.id,
          revised: (row.revised ?? null) as RevisedResume | null,
          filename: row.filename,
          reviewedAt: new Date(row.createdAt).toLocaleDateString(),
        }
      : null;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-brand-900">Resume builder</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          Upload your resume and get it read by five critics: an honest first-screen read, your
          bullets rewritten for measurable results, an ATS and keyword check, an industry tone
          match, and a final polish pass.
        </p>
      </div>

      <ResumePanel latest={latestReview} />

      {reviewCount > 0 && (
        <Link
          href="/outreach/resume/history"
          className="mt-8 flex items-center justify-between gap-4 rounded-lg border border-brand-100 bg-white px-4 py-3 hover:border-brand-200 hover:bg-brand-50"
        >
          <span>
            <span className="block text-sm font-medium text-brand-900">Your past resumes</span>
            <span className="block text-xs text-warmgray-500">
              Every resume you have had reviewed, and how it scored.
            </span>
          </span>
          <span className="shrink-0 text-sm font-medium text-brand-900">View →</span>
        </Link>
      )}
    </div>
  );
}
