"use client";

import { useActionState } from "react";
import { Download, Sparkles } from "lucide-react";
import { generateRevision, type RevisionState } from "./resume-actions";
import { collectPlaceholders } from "@/lib/resume-placeholders";
import type { RevisedResume } from "@/lib/resume-rewrite";

/**
 * Sits under the change list: rewrite the ticked changes, then export.
 *
 * There is no editor here any more. The student fills in what the rewrite needs
 * in the table above, BEFORE it runs, so the document that comes back is
 * finished rather than something they then have to go and patch.
 */
export default function RewriteActions({
  reviewId,
  initial,
  selectedIds,
  selectedCount,
  totalCount,
  answers,
  unanswered,
}: {
  reviewId: string;
  initial: RevisedResume | null;
  selectedIds: string[];
  selectedCount: number;
  totalCount: number;
  /** One entry per answered row - see the note where these are built. */
  answers: { line: string; question: string; answer: string }[];
  /** Ticked rows that asked for a figure and have not been given one. */
  unanswered: number;
}) {
  const [genState, generate, generating] = useActionState<RevisionState, FormData>(
    generateRevision,
    undefined,
  );

  const gaps = initial ? collectPlaceholders(initial) : [];

  return (
    <div className="mt-5 border-t border-brand-100 pt-4">
      <form action={generate} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="reviewId" value={reviewId} />
        <input type="hidden" name="selected" value={JSON.stringify(selectedIds)} />
        <input type="hidden" name="answers" value={JSON.stringify(answers)} />
        <button
          type="submit"
          disabled={generating || selectedCount === 0 || unanswered > 0}
          className="inline-flex items-center gap-2 rounded-md bg-accent-500 px-5 py-2.5 text-sm font-semibold text-white shadow-card hover:bg-accent-400 disabled:opacity-60"
        >
          <Sparkles size={15} />
          {generating ? "Rewriting..." : `Rewrite these changes for me (${selectedCount})`}
        </button>
        <span className="text-xs text-warmgray-500">
          {selectedCount === 0
            ? "Tick the changes you want applied."
            : unanswered > 0
              ? `Fill in the ${unanswered} highlighted box${unanswered === 1 ? "" : "es"} first - rewriting without them would put a gap in your resume.`
              : `${selectedCount} of ${totalCount} selected.`}
        </span>
      </form>
      {genState?.error && <p className="mt-2 text-sm text-error-600">{genState.error}</p>}

      {initial && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-brand-100 bg-brand-50 p-3">
          <span className="text-sm font-medium text-brand-900">Your rewritten resume is ready</span>
          {gaps.length > 0 && (
            // Deliberately not a count. This describes the file already
            // generated, while the number under the button describes boxes the
            // student still has to type into - two different quantities, and
            // showing both as numbers side by side read as one of them being
            // broken when only one of them moved.
            <span className="rounded-sm bg-gold-50 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-gold-700">
              This version still has gaps - rewrite to replace them
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <a
              href={`/api/resume/${reviewId}/export?format=docx`}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-900 hover:border-accent-400"
            >
              <Download size={12} /> Word
            </a>
            <a
              href={`/api/resume/${reviewId}/export?format=pdf`}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-900 hover:border-accent-400"
            >
              <Download size={12} /> PDF
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
