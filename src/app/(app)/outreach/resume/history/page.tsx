import Link from "next/link";
import { format } from "date-fns";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { resumeReviews } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { rescoreReview } from "@/lib/resume-review";
import type { ResumeReview } from "@/lib/resume-review";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "Your past resumes" };

/**
 * Every resume the student has had reviewed, newest first - the resume side
 * of /drafts. The builder shows only the latest review, so this is where a
 * student sees whether the score moved between versions.
 */
export default async function PastResumesPage() {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const rows = await db.query.resumeReviews.findMany({
    where: eq(resumeReviews.userId, userId),
    orderBy: [desc(resumeReviews.createdAt)],
    columns: { id: true, filename: true, summary: true, dimensions: true, createdAt: true },
  });

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/outreach" className="text-sm text-warmgray-500 hover:underline">
        ← Outreach
      </Link>
      <h1 className="mt-1 text-2xl font-semibold text-brand-900">Your past resumes</h1>
      <p className="mt-1 text-sm text-warmgray-500">
        Every resume you have had reviewed, newest first.
      </p>

      {rows.length === 0 ? (
        <EmptyState className="mt-6">
          No resumes reviewed yet.{" "}
          <Link href="/outreach/resume" className="text-brand-900 underline">
            Upload your first one
          </Link>
          .
        </EmptyState>
      ) : (
        <ul className="mt-6 divide-y divide-brand-100 overflow-hidden rounded-lg border border-brand-100 bg-white">
          {rows.map((r, i) => (
            <li key={r.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-brand-900">
                  {r.filename}
                  {i === 0 && <span className="ml-2 text-xs font-normal text-warmgray-500">Latest</span>}
                </p>
                <p className="line-clamp-2 text-xs text-warmgray-500">{r.summary}</p>
              </div>
              <div className="shrink-0 text-right">
                {/* Re-derived like the builder's, so the two never disagree. */}
                <p className="text-sm font-semibold tabular-nums text-brand-900">
                  {rescoreReview(r.dimensions as ResumeReview["dimensions"]).score}
                  <span className="text-xs font-normal text-warmgray-500">/100</span>
                </p>
                <p className="text-xs text-warmgray-500">{format(r.createdAt, "MMM d, yyyy")}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <p className="mt-4 text-sm">
          <Link href="/outreach/resume" className="font-medium text-brand-900 hover:underline">
            Open the resume builder →
          </Link>
        </p>
      )}
    </div>
  );
}
