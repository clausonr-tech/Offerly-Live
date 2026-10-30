"use client";

import { useActionState, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import ContactPicker, { type PickerContact } from "../ContactPicker";
import { createEvent, type ActionState } from "./actions";

export type QuickAddDraft = {
  /** Start, already snapped to the grid. Its local fields are the wall clock
   *  in the student's zone - see CalendarView's timeZone. */
  start: Date;
  /** Local end. Defaults to 30 minutes after start. */
  end: Date;
  /** True when the click came from a month cell, which carries no time of day. */
  allDayOrigin: boolean;
};

const TYPES = [
  ["meeting", "Meeting"],
  ["coffee_chat", "Coffee chat"],
  ["info_session", "Info session"],
  ["interview", "Interview"],
  ["deadline", "Application due"],
  ["personal", "Personal"],
] as const;

/**
 * False on the server, true once the client has it. The same shape
 * CommunityNav uses, rather than a `useState` flipped in an effect - that
 * form sets state during the first committed render, which is both a lint
 * error and an extra pass.
 */
const subscribeNoop = () => () => {};
function useMounted() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/** `2026-09-19T14:30` - what datetime-local wants, read from the draft's local
 *  fields, which CalendarView puts on the student's clock. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The event composer that opens when you click an empty slot.
 *
 * A centred modal rather than the small card this started as. The card was
 * anchored to the click and held four fields, which is the right shape for a
 * two-second gesture but the wrong one for actually describing an event - the
 * moment you wanted a note or a linked contact you had to abandon it and go
 * to the form at the bottom of the page.
 *
 * Portalled to <body>, and that is load-bearing rather than tidy. The time
 * grid scrolls inside its own max-height box and app/(app)/template.tsx wraps
 * every page in a transformed element; a fixed child of either is clipped by
 * the first and positioned against the second. CommunityNav hit the same trap.
 */
export default function QuickAddDialog({
  draft,
  contactOptions,
  applicationOptions,
  onClose,
}: {
  draft: QuickAddDraft;
  contactOptions: PickerContact[];
  applicationOptions: { id: string; label: string }[];
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createEvent, undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const mounted = useMounted();

  // Focus the title on open. It is the one field that is always empty and
  // always required, and a dialog that opens with focus still on the page
  // behind it strands anyone navigating by keyboard.
  useEffect(() => {
    if (mounted) titleRef.current?.focus();
  }, [mounted]);

  // Escape closes. WCAG 2.2 wants an escape route from anything modal, and it
  // is also simply what every calendar does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The page behind a modal must not scroll under it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      // Only a click on the backdrop itself closes - a click that started
      // inside the panel and drifted out while selecting text must not.
      onMouseDown={(e) => {
        if (!panelRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-add-heading"
        // rounded-xl: the dialog step of the app's corner scale (globals.css).
        className="rounded-xl my-auto w-full max-w-3xl border border-brand-100 bg-white p-6 shadow-2xl sm:p-8"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 id="quick-add-heading" className="text-lg font-semibold text-brand-900">
            New event
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-2 rounded-md p-2 text-warmgray-500 hover:text-brand-900"
          >
            ✕
          </button>
        </div>

        <form
          action={async (fd) => {
            await formAction(fd);
            onClose();
          }}
          className="space-y-5"
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-warmgray-500">Title</span>
            <input
              ref={titleRef}
              name="title"
              required
              maxLength={300}
              placeholder="Coffee chat with..."
              className="w-full rounded-md border border-brand-100 px-3 py-2.5 text-base text-brand-900 placeholder:text-warmgray-500"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-warmgray-500">Starts</span>
              <input
                type="datetime-local"
                name="eventDate"
                defaultValue={localInputValue(draft.start)}
                required
                className="w-full rounded-md border border-brand-100 px-3 py-2 text-sm text-brand-900"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-warmgray-500">Ends</span>
              <input
                type="datetime-local"
                name="endDate"
                defaultValue={localInputValue(draft.end)}
                className="w-full rounded-md border border-brand-100 px-3 py-2 text-sm text-brand-900"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-warmgray-500">Type</span>
              <select
                name="type"
                defaultValue="meeting"
                className="w-full rounded-md border border-brand-100 px-3 py-2 text-sm text-brand-900"
              >
                {TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-warmgray-500">Notes</span>
            <textarea
              name="notes"
              rows={3}
              maxLength={2000}
              placeholder="What is this for, what to prepare, where it is"
              className="w-full rounded-md border border-brand-100 px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-500"
            />
          </label>

          {/* Linking is what the small card could not offer, and it is the
              reason an event is worth more than a reminder: a coffee chat
              attached to a person shows up against them, and a deadline
              attached to an application keeps the two in step. */}
          <div>
            <span className="mb-1 block text-xs font-medium text-warmgray-500">
              Link a contact <span className="font-normal">(optional)</span>
            </span>
            <ContactPicker contacts={contactOptions} allowNone showLabels={false} />
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-warmgray-500">
              Link an application <span className="font-normal">(optional)</span>
            </span>
            <select
              name="applicationId"
              defaultValue=""
              className="w-full rounded-md border border-brand-100 px-3 py-2 text-sm text-brand-900"
            >
              <option value="">No linked application</option>
              {applicationOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          {state?.error && <p className="text-sm text-error-500">{state.error}</p>}

          <div className="flex items-center justify-end gap-3 border-t border-brand-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm text-warmgray-500 hover:text-brand-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-brand-900 px-5 py-2 text-sm font-medium text-[#ffffff] disabled:opacity-60"
            >
              {pending ? "Saving..." : "Save event"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
