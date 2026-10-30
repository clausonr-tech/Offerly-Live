"use client";

import { useEffect, useId, useRef } from "react";
import { Loader2, X } from "lucide-react";

import { trapFocusIndex } from "@/lib/video-interview/start-flow";
import {
  TRAINING_CHOICES,
  TRAINING_DIALOG_NO_STORAGE,
  TRAINING_DIALOG_POINTS,
  TRAINING_DIALOG_TITLE,
  type TrainingChoice,
} from "@/lib/video-interview/types";

/**
 * The training question, asked once - at the student's first "Start
 * interview", before the session exists or the camera is requested. The
 * answer stands for every interview after; they change it on the setup page.
 *
 * Deliberately even-handed: both answers are the same size, weight and
 * colour, side by side, and NEITHER has focus when the dialog opens (the
 * dialog itself does), so nothing is preselected by a stray Enter. Escape or
 * the close button backs out without starting anything.
 *
 * A modal: focus stays inside while it is open and goes back to whatever
 * opened it when it closes.
 */

/** Both choices share this exact style - no option is visually dominant. */
export const CHOICE_CLASS =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-brand-200 bg-[#ffffff] px-4 py-3 text-sm font-semibold text-brand-900 hover:border-accent-500 hover:bg-accent-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-wait disabled:opacity-60";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function TrainingConsentDialog({
  open,
  storageAvailable,
  busy,
  pendingChoice,
  error,
  onChoose,
  onCancel,
}: {
  open: boolean;
  storageAvailable: boolean;
  busy: boolean;
  pendingChoice: TrainingChoice | null;
  error: string | null;
  onChoose: (choice: TrainingChoice) => void;
  onCancel: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  // Focus the dialog (not a choice) on open; give focus back on close.
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      const back = returnTo.current;
      returnTo.current = null;
      if (back && document.contains(back)) back.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const next = trapFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    e.preventDefault();
    if (next >= 0) items[next].focus();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-[#0b1526]/55 p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg rounded-xl border border-brand-100 bg-[#ffffff] p-5 shadow-card outline-none sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-brand-900">
            {TRAINING_DIALOG_TITLE}
          </h2>
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Close without starting" className="rounded-md p-1.5 text-warmgray-500 hover:bg-brand-50 hover:text-brand-900 focus-visible:outline-2 focus-visible:outline-accent-500 disabled:opacity-50">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div id={descId}>
          <p className="mt-1 text-sm text-warmgray-600">This is optional. Your answer applies to every interview you do, so we won&apos;t ask again.</p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-brand-900">
            {TRAINING_DIALOG_POINTS.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {!storageAvailable && (
            <p role="note" className="mt-3 rounded-md border border-gold-200 bg-gold-50 px-3 py-2 text-sm text-brand-900">
              {TRAINING_DIALOG_NO_STORAGE}
            </p>
          )}
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {TRAINING_CHOICES.map((c) => (
            <button key={c.value} type="button" className={CHOICE_CLASS} disabled={busy} onClick={() => onChoose(c.value)}>
              {busy && pendingChoice === c.value && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />}
              {c.label}
            </button>
          ))}
        </div>
        {busy && (
          <p role="status" className="mt-3 text-center text-xs text-warmgray-600">
            Starting your interview…
          </p>
        )}
        {error && !busy && (
          <p role="alert" className="mt-3 text-sm text-error-600">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
