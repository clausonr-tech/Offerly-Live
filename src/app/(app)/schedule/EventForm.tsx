"use client";

import ContactPicker, { type PickerContact } from "../ContactPicker";

import { useActionState, useState } from "react";
import { createEvent, type ActionState } from "./actions";

type Option = { id: string; label: string };
type EventType =
  | "meeting"
  | "coffee_chat"
  | "deadline"
  | "info_session"
  | "personal"
  | "interview";

const TYPE_PLACEHOLDERS: Record<EventType, string> = {
  meeting: "Call with...",
  coffee_chat: "Coffee chat with...",
  deadline: "Application deadline",
  info_session: "Goldman Sachs info session",
  interview: "Evercore first round",
  personal: "FIN 101 lecture",
};

export default function EventForm({
  contactOptions,
  applicationOptions,
  defaultTitle,
  defaultType,
}: {
  contactOptions: PickerContact[];
  applicationOptions: Option[];
  defaultTitle?: string;
  defaultType?: EventType;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createEvent,
    undefined,
  );
  const [type, setType] = useState<EventType>(defaultType ?? "meeting");
  const [formKey, setFormKey] = useState(0);

  return (
    <form
      key={formKey}
      action={async (formData) => {
        await formAction(formData);
        setFormKey((k) => k + 1);
      }}
      className="rounded-lg border border-brand-100 bg-white p-4"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <select
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value as EventType)}
          className="rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        >
          <option value="meeting">Meeting / call</option>
          <option value="coffee_chat">Coffee chat</option>
          <option value="deadline">Deadline</option>
          <option value="info_session">Info session / speaker event</option>
          <option value="interview">Interview</option>
          <option value="personal">Personal (class, club, etc.)</option>
        </select>
        <input
          name="title"
          required
          defaultValue={defaultTitle}
          placeholder={TYPE_PLACEHOLDERS[type]}
          className="col-span-2 rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        />
        <input
          name="eventDate"
          type="datetime-local"
          required
          title="Start"
          className="rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-400 disabled:opacity-60 shadow-card"
        >
          {pending ? "Adding..." : "Add"}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Same company -> division -> person picker as the draft form, so
            linking a contact works identically wherever it is done. Spans the
            row because it is three controls, not one. */}
        <div className="sm:col-span-3">
          <ContactPicker contacts={contactOptions} allowNone />
        </div>
        <select
          name="applicationId"
          defaultValue=""
          className="rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        >
          <option value="">No linked application</option>
          {applicationOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-warmgray-500">
          Ends
          <input
            name="endDate"
            type="datetime-local"
            title="End (optional) - e.g. set this for a 1-3pm class so it spans the full block on the calendar"
            className="flex-1 rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          />
        </label>
      </div>
      {state?.error && <p className="mt-2 text-sm text-error-600">{state.error}</p>}
    </form>
  );
}
