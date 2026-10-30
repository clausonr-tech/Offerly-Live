"use client";

import { useActionState, useState } from "react";
import { Megaphone } from "lucide-react";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { reportOpening, type ReportOpeningState } from "./actions";

/**
 * "I saw this open" - the student-side counterpart to the crawler.
 *
 * Worth having because the crawler cannot reach every firm: a good share of
 * these career sites are client-rendered or behind a bot wall, and a student
 * who is already on the page looking at the posting has information the
 * monitor does not. `opening_signals` has ranked `student_report` above our
 * own predictions since it was written; this is the first thing that actually
 * produces one.
 *
 * Collapsed by default. It is a secondary action on a page whose job is to
 * describe the firm, and an always-open form with four fields would read as
 * the point of the page rather than a footnote to it.
 */
export default function ReportOpeningForm({
  firmId,
  slug,
  firmName,
  categories,
  cycleYears,
  defaultCycle,
  existingReportCount,
}: {
  firmId: string;
  slug: string;
  firmName: string;
  /** The sectors this firm actually runs programmes in - offering the full
   *  14-value list would ask a student to pick a desk the firm does not have. */
  categories: FirmProgramCategory[];
  cycleYears: number[];
  defaultCycle: number;
  existingReportCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ReportOpeningState, FormData>(
    reportOpening,
    undefined,
  );

  // Collapse once it has been accepted. Leaving the form open invites the same
  // student to report again, which the action would treat as a correction
  // rather than a second sighting - harmless, but confusing to watch.
  if (state?.success) {
    return (
      <div className="mt-8 rounded-lg border border-brand-100 bg-white p-4">
        <p className="text-sm text-brand-900">{state.success}</p>
        <p className="mt-1 text-xs text-warmgray-500">
          It&apos;s recorded as a student sighting, which ranks above our own estimates and below
          anything {firmName} publishes itself.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-lg border border-brand-100 bg-white p-4">
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-brand-900">
              Seen {firmName} open applications?
            </p>
            <p className="text-xs text-warmgray-500">
              {existingReportCount > 0
                ? `${existingReportCount} student${existingReportCount === 1 ? " has" : "s have"} reported this cycle. `
                : ""}
              Tell us and everyone tracking this firm hears about it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white shadow-card hover:bg-accent-400"
          >
            <Megaphone className="h-3.5 w-3.5" aria-hidden />
            Report an opening
          </button>
        </div>
      ) : (
        <form action={action} className="space-y-3">
          <input type="hidden" name="firmId" value={firmId} />
          <input type="hidden" name="slug" value={slug} />

          <p className="text-sm font-medium text-brand-900">
            What did you see at {firmName}?
          </p>

          <div className="flex flex-wrap gap-3">
            <label className="flex-1 min-w-[10rem] text-xs text-warmgray-500">
              Which programme
              <select
                name="programCategory"
                defaultValue={categories[0] ?? ""}
                className="mt-1 w-full rounded-md border border-brand-200 bg-white px-2 py-1.5 text-sm text-brand-900"
              >
                {/* Deliberately first and always present: a student who saw a
                    careers-page banner rather than a specific desk's posting
                    should not have to guess a sector to be heard. */}
                <option value="">Not sure / the firm generally</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex-1 min-w-[8rem] text-xs text-warmgray-500">
              Which cycle
              <select
                name="cycleYear"
                defaultValue={defaultCycle}
                className="mt-1 w-full rounded-md border border-brand-200 bg-white px-2 py-1.5 text-sm text-brand-900"
              >
                {cycleYears.map((y) => (
                  <option key={y} value={y}>
                    Summer {y}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-xs text-warmgray-500">
            Link to what you saw <span className="text-warmgray-400">(optional, but very helpful)</span>
            <input
              type="url"
              name="sourceUrl"
              placeholder="https://..."
              className="mt-1 w-full rounded-md border border-brand-200 bg-white px-2 py-1.5 text-sm text-brand-900"
            />
          </label>

          <label className="block text-xs text-warmgray-500">
            Anything worth adding <span className="text-warmgray-400">(optional)</span>
            <textarea
              name="note"
              rows={2}
              maxLength={300}
              placeholder="e.g. 2028 Summer Analyst app went live today, deadline says 14 Nov"
              className="mt-1 w-full resize-none rounded-md border border-brand-200 bg-white px-2 py-1.5 text-sm text-brand-900"
            />
          </label>

          <p className="text-xs text-warmgray-500">
            We record this as &ldquo;it had opened by today&rdquo; - not as an opening date, since
            seeing a posting doesn&apos;t say when it went up.
          </p>

          {state?.error && <p className="text-xs text-error-600">{state.error}</p>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white shadow-card hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "Sending..." : "Submit report"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-warmgray-500 hover:text-brand-900"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
