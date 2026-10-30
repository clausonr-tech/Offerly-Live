"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { LABEL_TONES, type LabelTone } from "@/lib/label-colors";

import { completeThankYouPrompt, markAppliedFromReminder, markPromptFlashSeen } from "./nudge-actions";

/** What the bubble needs to render, whichever prompt it came from. Built in
 *  lib/prompt-flash.ts, beside the rules that produce it. */
export type FlashRow = {
  /** Identifies this firing, and what gets recorded when it mounts. */
  flashKey: string;
  chip: string;
  subject: string;
  detail: string;
  href: string;
  cta: string;
  /** A second button that finishes the job here: "That's everyone". */
  doneKey?: string;
  doneLabel?: string;
  /** Which job the second button finishes: a thank-you, or an application. */
  doneAction?: "thank_you" | "applied";
  /** What kind of job it is, for its colour - the same one its chip has on
   *  the to-do list and in the bell (lib/label-colors). */
  tone?: LabelTone;
};

/**
 * How long the bar holds before it leaves, in milliseconds.
 *
 * Long enough to read the whole sentence - up to two lines - and decide
 * whether to click. At 4.5s a student who glanced away came back to an empty
 * space. The countdown also stops while the pointer is over the bubble or
 * focus is inside it, so someone mid-sentence never loses it.
 */
const HOLD_MS = 8000;
/** Slower in than out: arriving is information, leaving is just tidying up. */
const ENTER_MS = 420;
const LEAVE_MS = 300;

/**
 * The one-time heads-up: an application opening, an interview coming up.
 *
 * A notification bubble rather than a system bar: it drops into the content
 * column - beside the rail, not over it - holds for a few seconds, then shoots
 * back up the way it came.
 * There is no "remind me later" because it never comes back on its own: the
 * server records it as shown the moment this mounts, and from three weeks out
 * the standing row in the Opportunities to-do list carries the same work
 * without interrupting anybody.
 *
 */
export default function PromptFlash({ row }: { row: FlashRow }) {
  const tone = LABEL_TONES[row.tone ?? "outreach"];
  const router = useRouter();
  const [phase, setPhase] = useState<"entering" | "held" | "leaving" | "gone">("entering");
  // Being read: the pointer is over the bubble, or focus is inside it. Either
  // one holds the countdown where it is.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  // What is left of the hold. The entry animation counts toward it, as it did
  // when this was one fixed timer, and a pause banks whatever had not run.
  const remaining = useRef(ENTER_MS + HOLD_MS);
  // Marking it seen is a write, and React runs effects twice in development.
  // The row is idempotent server-side, but there is no reason to send two.
  const marked = useRef(false);

  useEffect(() => {
    if (marked.current) return;
    marked.current = true;
    // Deliberately not awaited and deliberately swallowed: the bar is already
    // on screen, and a failed write means the student sees this once more,
    // which is a far better failure than a crash in a layout.
    void markPromptFlashSeen(row.flashKey).catch(() => {});
  }, [row.flashKey]);

  useEffect(() => {
    const t = setTimeout(() => setPhase((p) => (p === "entering" ? "held" : p)), 20);
    return () => clearTimeout(t);
  }, []);

  // The hold, as a countdown that can stop. Each run times only the stretch
  // since it started; the cleanup banks what was used, so pausing and resuming
  // picks up where it left off rather than starting the full hold again.
  useEffect(() => {
    if (phase !== "held" || paused) return;
    const started = performance.now();
    const t = setTimeout(() => setPhase("leaving"), Math.max(0, remaining.current));
    return () => {
      clearTimeout(t);
      remaining.current -= performance.now() - started;
    };
  }, [phase, paused]);

  // Gone one leave-animation after it starts leaving, whether the countdown
  // ran out or the student dismissed it - so a dismissed bubble no longer sits
  // invisible (and clickable) until its original timer would have ended.
  useEffect(() => {
    if (phase !== "leaving") return;
    const t = setTimeout(() => {
      setPhase("gone");
      // Once it is off screen, ask the server for the page again. Two things
      // depend on it: the bell's count, which is rendered server-side and
      // would otherwise sit one navigation behind the notification this
      // bubble just filed, and the next firm waiting its turn, which drops
      // after this one rather than waiting for the student to navigate.
      router.refresh();
    }, LEAVE_MS);
    return () => clearTimeout(t);
  }, [phase, router]);

  if (phase === "gone") return null;

  const visible = phase === "held";

  return (
    <div
      // The content column only, not the whole window: the rail keeps its own
      // top-left corner and the bubble centres in the space beside it. The
      // padding reads --rail-w, set by .app-shell in globals.css, so it follows
      // the rail when it retracts - a fixed lg:pl-60 left the bubble centred
      // on a 15rem rail that was no longer there. Same timing as the shell's
      // own padding, so the two move together. z-50 clears the rail and the
      // floating message bubble.
      className="pointer-events-none fixed inset-x-0 top-0 z-50 transition-[padding] duration-[220ms] ease-[cubic-bezier(0.2,0,0,1)] lg:pl-[var(--rail-w)] print:hidden"
      // It announces itself and then leaves, which is exactly what aria-live
      // polite is for. Not a dialog: it takes no focus and traps nothing.
      role="status"
      aria-live="polite"
    >
      {/* Three-quarters of the content area, centred in it, so the sentence
          reads in full in one or two lines (720px beside the full rail on a
          1280px screen). The cap stops it becoming a banner on a wide monitor;
          the floor stops three-quarters getting too narrow on a small one.
          Below the sm breakpoint it takes the full width. */}
      <div className="flex justify-center px-4 pt-3 sm:px-6 lg:px-10">
        <div
          // Grey and rounded, like a notification rather than a system bar. The
          // same light surface in both themes - literal hex, because the dark
          // theme redefines --color-white to near-black and a token here would
          // invert the whole thing (the trap the Opportunities header card and
          // the draft composer both document).
          // A fixed 28px rather than rounded-full. At the 55px height of a
          // one-line bubble that IS the full pill - the cap radius maxes out at
          // half the height - while on a phone, where the sentence wraps and
          // the bubble grows to 87px, rounded-full turned the caps into 43px
          // bites that squeezed the text until it clipped.
          className="pointer-events-auto w-full rounded-[28px] sm:w-3/4 sm:min-w-[min(34rem,100%)] sm:max-w-[60rem] shadow-[0_20px_44px_-16px_rgba(11,21,38,0.55)] ring-1 backdrop-blur-sm"
          style={{
            // Its kind's colour, so a thank-you and a deadline look different
            // before a word is read (lib/label-colors). f2 = 95% opacity.
            background: `${tone.tint}f2`,
            ["--tw-ring-color" as string]: `${tone.fg}33`,
            // Transform and opacity only, so nothing under the bubble reflows
            // while it moves. It comes down past its resting place and settles
            // - the overshoot in the easing is what makes it read as a
            // notification dropping in rather than a panel being revealed - and
            // leaves the way it came, straight up and faster than it arrived.
            transform: visible ? "translateY(0)" : "translateY(calc(-100% - 1rem))",
            opacity: phase === "leaving" ? 0 : visible ? 1 : 0,
            // Opacity is deliberately much shorter than the movement at both
            // ends. Matched to it, the bubble spent its whole arrival
            // half-transparent - a ghost sliding in rather than a notification
            // dropping - and on the way out it faded in place instead of
            // looking like it went back where it came from. So: solid almost
            // immediately, and still solid for most of the trip back up.
            transition: visible
              ? `transform ${ENTER_MS}ms cubic-bezier(0.34, 1.42, 0.64, 1), opacity 130ms ease-out`
              : `transform ${LEAVE_MS}ms cubic-bezier(0.55, 0, 1, 0.45), opacity 120ms ease-in ${LEAVE_MS - 120}ms`,
          }}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          // Only when focus leaves the bubble altogether: tabbing from the
          // link to the close button is still reading it.
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
        >
          {/* Wider gutters than a square panel would need: the horizontal
              padding has to clear the curve before the first character, not
              just the edge. */}
          {/* Wraps when there are two buttons: on a phone they take a line
              of their own under the sentence rather than squeezing it. */}
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap sm:px-6">
            {/* Chip and sentence wrap as a pair. At 390px the chip, the link and
                the close cross left the sentence about eight characters, so it
                truncated to "Evercore - 2..." - which is the one thing this
                exists to say. Nothing here truncates or clamps: the sentence
                wraps and the bubble grows. From the small breakpoint up it sits
                beside the chip in at most two lines - the copy in
                lib/prompt-flash.ts is written to that length. */}
            <div
              className={`flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 ${
                row.doneKey ? "basis-full sm:basis-0" : ""
              }`}
            >
              <span
                className="shrink-0 rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: "#ffffffb3", color: tone.fg }}
              >
                {row.chip}
              </span>
              {/* w-full below sm, so the sentence takes its own line under the
                  chip instead of being squeezed into the column the chip leaves
                  it - flex-1 alone let it shrink to eight characters a line. */}
              <p className="w-full min-w-0 text-sm text-[#0b1526] sm:w-auto sm:flex-1">
                <span className="font-medium">{row.subject}</span>
                <span className="text-[#4a5a72]"> — {row.detail}</span>
              </p>
            </div>
            {row.doneKey && row.doneLabel && (
              <button
                type="button"
                onClick={() => {
                  const key = row.doneKey!;
                  // Closed on the server, then the bubble leaves - and its
                  // leaving refreshes the page, which takes the to-do row and
                  // the bell job with it.
                  const finish = row.doneAction === "applied" ? markAppliedFromReminder : completeThankYouPrompt;
                  void finish(key)
                    .catch(() => {})
                    .finally(() => setPhase("leaving"));
                }}
                className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-[#0b1526] ring-1 ring-[#0b1526]/25 transition-colors hover:bg-[#0b1526]/8"
              >
                {row.doneLabel}
              </button>
            )}
            <Link
              href={row.href}
              className="shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium text-[#ffffff] transition-[filter] hover:brightness-110"
              style={{ background: tone.fg }}
            >
              {row.cta}
            </Link>
            <button
              type="button"
              onClick={() => setPhase("leaving")}
              aria-label="Dismiss"
              className="shrink-0 rounded-sm px-1 text-lg leading-none text-[#4a5a72] transition-colors hover:text-[#0b1526]"
            >
              ×
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
