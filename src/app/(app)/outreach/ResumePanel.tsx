"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { assignFileToInput, useFileDrop } from "@/lib/use-file-drop";
import { Check, Copy, FileText, Upload } from "lucide-react";
import { reviewUploadedResume, type ResumeActionState } from "./resume-actions";
import type { ResumeReview, ResumeRewrite } from "@/lib/resume-review";
import { placeholdersIn } from "@/lib/resume-placeholders";
import type { RevisedResume } from "@/lib/resume-rewrite";
import RewriteActions from "./RevisedResume";
import StagedProgress, { type ProgressStage } from "@/components/StagedProgress";

// The review's true order: parse, five parallel critics, then the merge.
// Time-based on the client (the action is one await), but the proportions
// mirror the real pipeline, and the checked result still arrives at once.
const RESUME_STAGES: ProgressStage[] = [
  { at: 0, label: "Reading your resume…" },
  { at: 8, label: "Five reviewers are marking it up…" },
  { at: 50, label: "Weighing their notes into one review…" },
];

// Copy is best-effort: the clipboard API needs a secure context and a user
// gesture, and throws rather than resolving false when it is unavailable. A
// failure leaves the button in its resting state - the text is on screen and
// selectable either way, so there is nothing to recover from.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable - the text is still selectable on the page */
        }
      }}
      className="shrink-0 rounded-sm p-1 text-warmgray-500 transition-colors hover:bg-brand-50 hover:text-brand-900"
      aria-label={copied ? "Copied" : "Copy rewrite"}
    >
      {copied ? <Check size={13} className="text-success-700" /> : <Copy size={13} />}
    </button>
  );
}

// Score bands. Deliberately not a pass/fail line: a resume is a draft a student
// iterates on, and the useful signal is which direction it moved.
function band(score: number): { label: string; tone: string } {
  if (score >= 85) return { label: "Interview-ready", tone: "text-success-700" };
  if (score >= 70) return { label: "Nearly there", tone: "text-brand-900" };
  if (score >= 50) return { label: "Good base to build on", tone: "text-brand-900" };
  // Deliberately not red. The lowest band is where a first draft lands, and
  // colouring it as an error tells the student they failed at something they
  // have only just started.
  return { label: "Early draft - plenty to work with", tone: "text-brand-900" };
}

type LatestReview = ResumeReview & {
  id: string;
  revised: RevisedResume | null;
  filename: string;
  reviewedAt: string;
};

export default function ResumePanel({ latest }: { latest: LatestReview | null }) {
  const [state, formAction, pending] = useActionState<ResumeActionState, FormData>(
    reviewUploadedResume,
    undefined,
  );
  // The input is visually hidden, so the browser's own "no file chosen" label
  // is not there to confirm a pick. Without echoing the name back, a drop looks
  // like nothing happened.
  const inputRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  // Not a resume: the form has reset its file input, so the name it showed
  // goes too - the box reads "choose a resume" again, ready for another file.
  useEffect(() => {
    if (state?.notResume) setChosen(null);
  }, [state]);

  const { dragging, dropProps } = useFileDrop({
    accept: "application/pdf,.pdf",
    disabled: pending,
    onFile: (file) => {
      setDropError(null);
      assignFileToInput(inputRef.current, file);
      setChosen(file.name);
    },
    onReject: (reason) => {
      setChosen(null);
      setDropError(`${reason} The review needs a PDF.`);
    },
  });

  return (
    <div>
      <div>
        <form action={formAction} className="mb-8">
          <label
            {...dropProps}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-5 py-6 transition-colors ${
              dragging ? "border-accent-500 bg-accent-50" : "border-brand-200 bg-white hover:border-accent-400"
            }`}
          >
            <Upload size={18} className="shrink-0 text-warmgray-500" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-brand-900">
                {chosen ?? (dragging ? "Drop it here" : "Choose a PDF resume, or drag one here")}
              </span>
              <span className="block text-xs text-warmgray-500">
                PDF only, under 4MB - the review looks at how the page is laid out, not just the
                words, so an exported PDF is what it needs.
              </span>
            </span>
            <input
              ref={inputRef}
              type="file"
              name="resume"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(e) => {
                setDropError(null);
                setChosen(e.target.files?.[0]?.name ?? null);
              }}
            />
          </label>

          <label className="mt-3 block">
            <span className="block text-sm font-medium text-brand-900">
              Target job description <span className="font-normal text-warmgray-500">(optional)</span>
            </span>
            <span className="mt-0.5 block text-xs text-warmgray-500">
              Paste one and the ATS check names the exact keywords the posting asks for that your
              resume is missing. Leave it empty and that check just confirms the file parses cleanly.
            </span>
            <textarea
              name="jobDescription"
              rows={4}
              placeholder="Paste the full posting here"
              className="mt-1.5 w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
            />
          </label>

          <button
            type="submit"
            disabled={pending}
            className="mt-3 rounded-md bg-accent-500 px-5 py-2.5 text-sm font-semibold text-white shadow-card hover:bg-accent-400 disabled:opacity-60"
          >
            {pending ? "Reading your resume..." : "Review my resume"}
          </button>

          {pending && <StagedProgress stages={RESUME_STAGES} sublabel="A minute or two" className="mt-4 text-center" />}

          {state?.notResume && !dropError ? (
            // Not a failure to retry - a different file to choose. Said as a
            // prompt with the way forward, not as a red error line.
            <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-gold-200 bg-gold-50 px-4 py-3">
              <p className="min-w-0 flex-1 text-sm text-brand-900">
                <span className="block font-medium">That doesn&apos;t look like a resume</span>
                <span className="block text-warmgray-600">{state.error}</span>
              </p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="shrink-0 rounded-md border border-brand-200 bg-white px-3 py-1.5 text-sm font-medium text-brand-900 hover:border-accent-400"
              >
                Choose another file
              </button>
            </div>
          ) : (
            (dropError ?? state?.error) && (
              <p className="mt-3 text-sm text-error-600">{dropError ?? state?.error}</p>
            )
          )}
        </form>

        {latest ? <ReviewResult review={latest} /> : (
          <p className="text-sm text-warmgray-500">No review yet. Upload a resume to get one.</p>
        )}
      </div>
    </div>
  );
}

function ReviewResult({ review }: { review: LatestReview }) {
  const b = band(review.score);
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-brand-100 bg-white p-5">
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-normal text-brand-900">{review.score}</span>
          <span className="text-sm text-warmgray-500">/ 100</span>
          <span className={`ml-auto text-sm font-medium ${b.tone}`}>{b.label}</span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-warmgray-600">{review.summary}</p>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-warmgray-500">
          <FileText size={12} />
          {review.filename} · reviewed {review.reviewedAt}
        </p>
      </div>

      {review.strengths.length > 0 && (
        <div className="rounded-lg border border-brand-100 bg-white p-5">
          <h3 className="mb-2 text-sm font-medium text-brand-900">Keep these</h3>
          <ul className="space-y-1.5">
            {review.strengths.map((s) => (
              <li key={s} className="flex gap-2 text-sm text-warmgray-600">
                <span className="text-success-700">✓</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-brand-100 bg-white p-5">
        <h3 className="mb-3 text-sm font-medium text-brand-900">Breakdown</h3>
        <div className="space-y-3">
          {review.dimensions.map((d) => (
            <div key={d.id}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-brand-900">{d.label}</span>
                <span className="text-warmgray-500">
                  {d.score} / {d.max}
                </span>
              </div>
              {/* Width from the ratio, so a 30-point dimension and a 15-point
                  one are visually comparable rather than one always looking
                  worse for being worth less. */}
              <div className="mt-1 h-1 w-full rounded-sm bg-brand-100">
                <div
                  className="h-1 rounded-sm bg-accent-500"
                  style={{ width: `${Math.round((100 * d.score) / d.max)}%` }}
                />
              </div>
              <p className="mt-1 text-xs leading-relaxed text-warmgray-500">{d.notes}</p>
            </div>
          ))}
        </div>
      </div>

      {(review.improvements.length > 0 || review.rewrites.length > 0) && (
        <Changes review={review} />
      )}
    </div>
  );
}

// Major and minor sit behind a switch rather than in one ranked list. Mixed
// together, the small stuff pads the list and makes the whole thing read as a
// pile of failures; separated, "what actually costs me interviews" is a short,
// finishable list, and the polish is there when the student wants it.
//
// Rewrites are filed into the same two tabs as the issues rather than sitting
// in a section of their own: a suggested bullet IS the fix for the bullet being
// weak, and splitting them meant reading the problem in one place and the
// answer in another.
// `id` is the contract with the server: it rebuilds these same two lists from
// the stored review in the same order, so "issue-3" means the same entry on
// both sides and the form only has to send ids.
type ChangeRow =
  | {
      id: string;
      row: "issue";
      severity: "major" | "minor";
      title: string;
      detail: string;
      area: string;
    }
  | {
      id: string;
      row: "rewrite";
      severity: "major" | "minor";
      title: string;
      note: string;
      after: string;
      area: string;
    };

const REWRITE_AREA: Record<ResumeRewrite["kind"], string> = {
  bullet: "Experience & impact",
  summary: "Industry fit",
  skills: "Industry fit",
};

function toRows(
  improvements: ResumeReview["improvements"],
  rewrites: ResumeRewrite[],
): ChangeRow[] {
  const issues: ChangeRow[] = improvements.map((i, n) => ({
    id: `issue-${n}`,
    row: "issue",
    severity: i.severity,
    title: i.title,
    detail: i.detail,
    area: i.dimension,
  }));

  const rw: ChangeRow[] = rewrites.map((r, n) => ({
    id: `rewrite-${n}`,
    row: "rewrite",
    // Reviews written before rewrites carried a severity fall back on kind: a
    // weak bullet is usually what costs the interview, a summary reword rarely is.
    severity: r.severity ?? (r.kind === "bullet" ? "major" : "minor"),
    title: r.kind === "bullet" ? "Rewrite this bullet" : `Rewrite your ${r.kind}`,
    note: r.note,
    after: r.after,
    area: REWRITE_AREA[r.kind] ?? "Industry fit",
  }));

  return [...issues, ...rw];
}

const MAX_PER_TAB = 20;

/**
 * Every gap in a row's suggested wording.
 *
 * A bullet can carry several - "[add figure: how many startups]", "[sector(s)]"
 * and "[method]" in one line - and each needs its own box. One box per row
 * asked three questions in a single field and, worse, counted the row as done
 * the moment any one of them was answered.
 */
function gapsFor(r: ChangeRow): string[] {
  return r.row === "rewrite" ? placeholdersIn(r.after) : [];
}

/** Answers are keyed per gap, not per row. */
function gapKey(rowId: string, index: number): string {
  return `${rowId}#${index}`;
}

/**
 * The prompt shown in a fill-in box.
 *
 * The bracketed text IS the question the student has to answer, so it is used
 * verbatim rather than swapped for a generic label they then have to decode.
 */
function gapLabel(gap: string): string {
  return gap.replace(/^\[|\]$/g, "").replace(/^add figure:\s*/i, "");
}

function Changes({ review }: { review: LatestReview }) {
  // Capped per tab. Thirty-odd rows is a list nobody finishes, and the tail of
  // it is always the least valuable - the model is asked for at most this many
  // of each, and this enforces it whatever comes back.
  const all = toRows(review.improvements, review.rewrites);
  const major = all.filter((r) => r.severity === "major").slice(0, MAX_PER_TAB);
  const minor = all.filter((r) => r.severity === "minor").slice(0, MAX_PER_TAB);
  const rows = [...major, ...minor];
  // Land on whichever tab has something in it, preferring the one that matters.
  const [tab, setTab] = useState<"major" | "minor">(major.length > 0 ? "major" : "minor");

  // Everything starts ticked: the common case is "apply the lot", and a student
  // who wants a subset unticks a few rather than hunting for the ones to keep.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.map((r) => r.id)));

  // What the student types against each row. Collected BEFORE the rewrite runs,
  // so the model can use a real number instead of leaving "[add figure: ...]"
  // for them to patch up afterwards.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const shown = tab === "major" ? major : minor;
  const hasRewrite = shown.some((r) => r.row === "rewrite");
  const allShownTicked = shown.length > 0 && shown.every((r) => selected.has(r.id));

  const picked = rows.filter((r) => selected.has(r.id));

  const answered = picked.flatMap((r) => {
    const gaps = gapsFor(r);
    if (gaps.length === 0) {
      const free = answers[gapKey(r.id, 0)]?.trim();
      return free ? [{ line: r.title, question: "", answer: free }] : [];
    }
    const line = r.row === "rewrite" ? r.after : r.title;
    return gaps.flatMap((gap, gi) => {
      const a = answers[gapKey(r.id, gi)]?.trim();
      return a ? [{ line, question: gapLabel(gap), answer: a }] : [];
    });
  });

  // Counted per gap: a bullet with three blanks is three things still to do,
  // not one, and the number under the button has to say so.
  const unanswered = picked.reduce(
    (n, r) => n + gapsFor(r).filter((_, gi) => !answers[gapKey(r.id, gi)]?.trim()).length,
    0,
  );

  const tabClass = (active: boolean) =>
    `border-b-2 px-3 py-1.5 text-sm transition-colors ${
      active
        ? "border-accent-500 text-brand-900"
        : "border-transparent text-warmgray-500 hover:text-brand-900"
    }`;

  return (
    <div className="rounded-lg border border-brand-100 bg-white p-5">
      <h3 className="text-sm font-medium text-brand-900">Where to focus next</h3>
      <div className="mt-3 flex gap-1 border-b border-brand-100">
        <button type="button" onClick={() => setTab("major")} className={tabClass(tab === "major")}>
          High impact ({major.length})
        </button>
        <button type="button" onClick={() => setTab("minor")} className={tabClass(tab === "minor")}>
          Finishing touches ({minor.length})
        </button>
      </div>

      {hasRewrite && (
        <p className="mt-3 text-xs leading-relaxed text-warmgray-500">
          Suggested wording is there to copy - use it only where it is true. Anything in [square
          brackets] is a number your resume didn&apos;t have, so you need to supply it yourself.
        </p>
      )}

      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-warmgray-500">
          {tab === "major"
            ? "Nothing here is costing you interviews - have a look at the finishing touches."
            : "No smaller points outstanding."}
        </p>
      ) : (
        // Scrolls inside its own box so a long list cannot push the page wide.
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-brand-100 text-xs uppercase tracking-wide text-warmgray-500">
              <tr>
                <th className="w-8 py-2 pr-2 font-medium">
                  <input
                    type="checkbox"
                    checked={allShownTicked}
                    aria-label={allShownTicked ? "Untick all shown" : "Tick all shown"}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const r of shown) {
                          if (allShownTicked) next.delete(r.id);
                          else next.add(r.id);
                        }
                        return next;
                      })
                    }
                  />
                </th>
                <th className="py-2 pr-3 font-medium">Change</th>
                <th className="py-2 pr-3 font-medium">What to do</th>
                <th className="w-56 py-2 font-medium">Your input</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-100">
              {shown.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Apply: ${r.title}`}
                    />
                  </td>
                  <td className="py-2 pr-3 font-medium text-brand-900">{r.title}</td>
                  <td className="py-2 pr-3 leading-snug text-warmgray-600">
                    {r.row === "issue" ? (
                      r.detail
                    ) : (
                      // Recommendation, then the replacement wording. The
                      // original line is deliberately not repeated: the student
                      // has it in front of them on their own resume, and
                      // printing it doubled every row's height.
                      <>
                        {r.note && <p className="mb-1 text-xs text-warmgray-500">{r.note}</p>}
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-brand-900">
                            {r.after}
                            {gapsFor(r).some((_, gi) => !answers[gapKey(r.id, gi)]?.trim()) && (
                              // This wording cannot be used as-is: it needs a
                              // number the resume never gave, and saying so
                              // stops it being pasted in with brackets left on.
                              <span className="ml-2 inline-block whitespace-nowrap rounded-sm bg-gold-50 px-1.5 py-px align-middle text-[10px] font-medium uppercase tracking-wide text-gold-700">
                                Needs your input
                              </span>
                            )}
                          </span>
                          <CopyButton text={r.after} />
                        </span>
                      </>
                    )}
                  </td>
                  <td className="py-2">
                    {gapsFor(r).length > 0 ? (
                      <div className="space-y-1">
                        {gapsFor(r).map((gap, gi) => {
                          const key = gapKey(r.id, gi);
                          const filled = Boolean(answers[key]?.trim());
                          return (
                            <input
                              key={key}
                              type="text"
                              value={answers[key] ?? ""}
                              onChange={(e) =>
                                setAnswers((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              placeholder={gapLabel(gap)}
                              aria-label={`${gapLabel(gap)} - for: ${r.title}`}
                              className={`w-full rounded-md border px-2 py-1 text-xs text-brand-900 focus:border-accent-500 focus:outline-none ${
                                filled ? "border-brand-200" : "border-gold-400 bg-gold-50"
                              }`}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={answers[gapKey(r.id, 0)] ?? ""}
                        onChange={(e) =>
                          setAnswers((prev) => ({ ...prev, [gapKey(r.id, 0)]: e.target.value }))
                        }
                        placeholder="Anything to add? (optional)"
                        aria-label={`Your input for: ${r.title}`}
                        className="w-full rounded-md border border-brand-200 px-2 py-1 text-xs text-brand-900 focus:border-accent-500 focus:outline-none"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RewriteActions
        reviewId={review.id}
        initial={review.revised}
        selectedIds={[...selected]}
        selectedCount={selected.size}
        totalCount={rows.length}
        // A list, not a map keyed by title: several rows are called "Rewrite
        // this bullet", so a map would collapse them and the model would not
        // know which bullet a figure belonged to. Each entry carries the line
        // it applies to and the gap it fills.
        answers={answered}
        unanswered={unanswered}
      />
    </div>
  );
}
