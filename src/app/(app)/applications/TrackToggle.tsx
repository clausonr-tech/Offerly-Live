"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { BookmarkCheck, BookmarkPlus } from "lucide-react";
import { quickAddApplication, untrackApplication } from "./actions";
import { externalHref } from "@/lib/safe-url";

// Track / stop tracking, on any posting card anywhere in the app.
//
// A toggle rather than the one-way "Track" button this replaced: postings now
// arrive in the pipeline on their own when a firm is matched, so the student's
// first interaction with a tracked posting is at least as likely to be "not
// this one" as "yes, this one". A control that could only add left them with a
// pipeline they never chose and no way to prune it from the page they were
// looking at.
//
// Optimistic: the icon flips on click and reverts if the write fails. The
// alternative is a checkbox that does nothing for a round trip, on a grid where
// a student is triaging dozens of postings in a row.

export default function TrackToggle({
  firm,
  role,
  applicationUrl,
  category,
  tracked: initialTracked,
  className = "",
}: {
  firm: string;
  role: string;
  applicationUrl?: string | null;
  category?: string | null;
  tracked: boolean;
  className?: string;
}) {
  const [tracked, setTracked] = useState(initialTracked);
  const [warning, setWarning] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = () => {
    const next = !tracked;
    setTracked(next);
    setWarning(null);
    startTransition(async () => {
      try {
        if (next) {
          await quickAddApplication({
            firm,
            role,
            // Only a public web link is carried into the tracked row. The
            // value comes from a crawled posting card, and the pipeline
            // renders it as an href later, so a `javascript:`, `data:` or
            // scheme-less value has no business being stored. A courtesy,
            // not the check - the server action is where that belongs.
            applicationUrl: externalHref(applicationUrl) ?? "",
            category: category ?? null,
          });
        } else {
          const result = await untrackApplication({ firm, role });
          // Deleting a row the student had actually worked on is not something
          // to let pass silently just because the click was one pixel wide.
          if (result.hadProgress) setWarning("Removed - that one had your notes or status on it.");
        }
      } catch {
        setTracked(!next);
      }
    });
  };

  const label = tracked ? `Stop tracking ${role}` : `Track ${role}`;

  // A custom tooltip rather than the native `title`, because the browser owns
  // the native one's delay and will not let us set it. These toggles sit on
  // every posting card, so a tooltip that fires on a passing cursor covers the
  // card next to it; 1.5s means it only appears when someone actually rests
  // there. aria-label still carries the same text for screen readers, which is
  // what `title` was really doing for accessibility.
  const [hinted, setHinted] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHinted(true), 1500);
  };
  const closeHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = null;
    setHinted(false);
  };
  // Clearing on unmount matters: these cards are filtered and re-rendered
  // constantly, and a pending timer would setState on a gone component.
  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  return (
    <span
      className={`relative inline-flex ${className}`}
      onMouseEnter={openHint}
      onMouseLeave={closeHint}
    >
      <button
        type="button"
        onClick={(e) => {
          // These sit inside cards that are themselves buttons or links, so the
          // click must not also open the row it is drawn on top of.
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }}
        disabled={isPending}
        aria-label={label}
        // Keyboard focus should not wait 1.5s - there is no "resting" cursor
        // to measure, and a focused control has already been chosen.
        onFocus={() => setHinted(true)}
        onBlur={closeHint}
        aria-pressed={tracked}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
          tracked
            ? "border-success-200 bg-success-50 text-success-700 hover:border-error-200 hover:bg-error-50 hover:text-error-600"
            : "border-brand-100 bg-white text-warmgray-400 hover:border-accent-400 hover:text-accent-500"
        }`}
      >
        {tracked ? (
          <BookmarkCheck size={13} aria-hidden />
        ) : (
          <BookmarkPlus size={13} aria-hidden />
        )}
      </button>
      {hinted && !warning && (
        <span
          role="tooltip"
          className="pointer-events-none absolute right-0 top-7 z-20 w-max max-w-[15rem] rounded-md bg-brand-900 px-2 py-1 text-[11px] leading-snug text-white shadow-card"
        >
          {label}
        </span>
      )}
      {warning && (
        <span
          role="status"
          className="absolute right-0 top-7 z-10 w-44 rounded-md border border-brand-100 bg-white p-2 text-[11px] leading-snug text-warmgray-600 shadow-card"
        >
          {warning}
        </span>
      )}
    </span>
  );
}
