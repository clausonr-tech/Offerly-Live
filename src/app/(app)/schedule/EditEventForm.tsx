"use client";

import { useActionState } from "react";
import { updateEvent, type ActionState } from "./actions";

type EventType =
  | "meeting"
  | "coffee_chat"
  | "deadline"
  | "info_session"
  | "personal"
  | "interview";

export default function EditEventForm({
  event,
  onDone,
}: {
  event: {
    id: string;
    type: EventType;
    title: string;
    notes: string | null;
    // datetime-local values on the student's clock, written on the server in
    // the zone updateEvent reads them back in, so an untouched time round-trips.
    eventDateInput: string;
    endDateInput: string;
    contactId: string | null;
    applicationId: string | null;
  };
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateEvent,
    undefined,
  );

  return (
    <form
      action={async (formData) => {
        await formAction(formData);
        onDone();
      }}
      className="w-full rounded-md border border-accent-300 bg-accent-50/40 p-3"
    >
      <input type="hidden" name="eventId" value={event.id} />
      {/* Carried through so editing a time doesn't silently unlink the contact
          or application the event was attached to. */}
      <input type="hidden" name="contactId" value={event.contactId ?? ""} />
      <input type="hidden" name="applicationId" value={event.applicationId ?? ""} />
      <input type="hidden" name="notes" value={event.notes ?? ""} />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <select
          name="type"
          defaultValue={event.type}
          className="rounded-md border border-brand-200 px-2 py-1.5 text-xs text-brand-900 focus:border-accent-500 focus:outline-none"
        >
          <option value="meeting">Meeting / call</option>
          <option value="coffee_chat">Coffee chat</option>
          <option value="deadline">Deadline</option>
          <option value="info_session">Info session</option>
          <option value="interview">Interview</option>
          <option value="personal">Personal</option>
        </select>
        <input
          name="title"
          required
          defaultValue={event.title}
          className="rounded-md border border-brand-200 px-2 py-1.5 text-xs text-brand-900 focus:border-accent-500 focus:outline-none sm:col-span-3"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-warmgray-500 sm:col-span-2">
          Starts
          <input
            name="eventDate"
            type="datetime-local"
            required
            defaultValue={event.eventDateInput}
            className="flex-1 rounded-md border border-brand-200 px-2 py-1.5 text-xs text-brand-900 focus:border-accent-500 focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-warmgray-500 sm:col-span-2">
          Ends
          <input
            name="endDate"
            type="datetime-local"
            defaultValue={event.endDateInput}
            className="flex-1 rounded-md border border-brand-200 px-2 py-1.5 text-xs text-brand-900 focus:border-accent-500 focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white shadow-card hover:bg-accent-400 disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-brand-100 px-3 py-1.5 text-xs font-medium text-warmgray-600 hover:bg-brand-50"
        >
          Cancel
        </button>
        <span className="text-[11px] text-warmgray-500">
          Changes are pushed to your Google Calendar copy too.
        </span>
      </div>
      {state?.error && <p className="mt-2 text-xs text-error-600">{state.error}</p>}
    </form>
  );
}
