"use client";

// The email arriving, and the moment the checked one takes its place.
//
// This is deliberately NOT a composer. It has no To field, no editable body,
// no Copy and no "I sent this", because every word in it is the drafting
// model's first pass: it has not been through the review call, the
// deterministic fixes, the student-notes pass or the final blocked-language
// gate, and the row in the database has not been written. A student who copied
// text out of here would be sending an email Offerly had not finished
// checking, so there is nothing here to copy text out of.
//
// Every colour is a literal hex, never a theme token, for the reason Composer
// gives: the dark theme redefines bg-white and text-white, which turned that
// white email into dark grey on black. The provisional card has to look like
// the composer it turns into, so it is pinned the same way.
//
// What it decides: nothing. ./draft-stream-view turns the frames into one of
// three views and this renders them.

import { useState } from "react";
import { previewView, type DraftStreamState } from "./draft-stream-view";

const BODY_STYLE = {
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: "15px",
  lineHeight: 1.6,
  color: "#202124",
} as const;

export default function DraftStreamPreview({ state }: { state: DraftStreamState }) {
  const view = previewView(state);
  const [showFirstPass, setShowFirstPass] = useState(false);

  if (view.kind === "hidden") return null;

  if (view.kind === "resolved") {
    // Green when the email was checked; amber when the review did not run,
    // because "saved" and "checked" are not the same promise and the colour
    // should not say the stronger one.
    const checked = !view.skippedReason;
    const tone = checked
      ? { border: "border-[#1e8e3e]", bg: "bg-[#e6f4ea]", text: "text-[#137333]", card: "border-[#c4e3cd]" }
      : { border: "border-[#f9ab00]", bg: "bg-[#fef7e0]", text: "text-[#7a4f01]", card: "border-[#f5dca0]" };
    return (
      // The swap, said out loud. Keyed to the draft by the parent, so a new
      // email gets a fresh strip rather than the previous one's open
      // disclosure, and announced via role="status" for a screen reader.
      // The pulse is three beats and motion-safe: enough to catch an eye that
      // was on the provisional text a second ago, gone before it nags.
      <div
        role="status"
        className={`rounded-lg border-2 ${tone.border} ${tone.bg} px-4 py-3 text-[13px] ${tone.text} motion-safe:animate-[pulse_0.9s_ease-in-out_3]`}
      >
        <p className="font-semibold">{view.headline}</p>
        {view.firstPass && (
          <>
            <button
              type="button"
              onClick={() => setShowFirstPass((open) => !open)}
              aria-expanded={showFirstPass}
              className="mt-1 underline underline-offset-2"
            >
              {showFirstPass ? "Hide the first pass" : "Show the first pass"}
            </button>
            {showFirstPass && (
              <div className={`mt-2 rounded-md border ${tone.card} bg-[#ffffff] p-3`}>
                <p className="mb-2 text-[12px] font-semibold text-[#5f6368]">
                  The first pass, before the review. Kept so you can see what changed - not the email to send.
                </p>
                <div className="whitespace-pre-wrap break-words" style={BODY_STYLE}>
                  {view.firstPass}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div
      aria-busy="true"
      className="overflow-hidden rounded-xl border-2 border-dashed border-[#f9ab00] bg-[#ffffff]"
      style={{ colorScheme: "light" }}
    >
      {/* The provisional banner. Amber, at the top, before any email text, and
          it says the two things that matter: this is not finished, and it is
          not yours to send yet. */}
      <div className="bg-[#fef7e0] px-4 py-3 text-[#7a4f01]">
        <p className="flex items-center gap-2 text-[14px] font-semibold">
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[#f9ab00] border-t-transparent"
          />
          {/* aria-live so the stage change is announced rather than silently repainted. */}
          <span role="status" aria-live="polite">
            {view.label}
          </span>
        </p>
        <p className="mt-1 text-[12px]">{view.sublabel}</p>
      </div>

      <div className="px-5 py-4">
        {/* Before any email text there is the model's outline - the one thing
            the plan-first schema gives back for the seconds it costs. */}
        {!view.body && view.plan.length > 0 && (
          <div className="text-[13px] text-[#5f6368]">
            <p className="font-semibold text-[#202124]">What it&apos;s going to say</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              {view.plan.map((sentence, i) => (
                <li key={`${i}-${sentence}`}>{sentence}</li>
              ))}
            </ol>
          </div>
        )}

        {view.subject && (
          <p className="border-b border-[#e0e0e0] pb-3 text-[15px] font-medium text-[#202124]">
            <span className="mr-2 text-[13px] font-normal text-[#5f6368]">Subject</span>
            {view.subject}
          </p>
        )}

        {view.body && (
          <div className="whitespace-pre-wrap break-words py-4" style={BODY_STYLE}>
            {view.body}
            {/* The caret: where the next word is going. Only while it is still
                being written - during the review the text has stopped moving. */}
            {view.writing && (
              <span
                aria-hidden="true"
                className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] bg-[#5f6368] motion-safe:animate-pulse"
              />
            )}
          </div>
        )}

        {!view.body && view.plan.length === 0 && (
          <div aria-hidden="true" className="space-y-2 py-2">
            <div className="h-3 w-2/3 rounded bg-[#f1f3f4]" />
            <div className="h-3 w-1/2 rounded bg-[#f1f3f4]" />
          </div>
        )}
      </div>

      <p className="border-t border-[#e0e0e0] bg-[#f8f9fa] px-5 py-3 text-[12px] text-[#5f6368]">
        Nothing to copy yet. Your email, checked and saved, opens here when it&apos;s ready.
      </p>
    </div>
  );
}
