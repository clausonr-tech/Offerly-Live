"use client";

import { useActionState } from "react";
import type { ActionState } from "./actions";

const RELATIONSHIP_OPTIONS: { value: string; label: string }[] = [
  { value: "not_contacted", label: "Not contacted" },
  { value: "reached_out", label: "Reached out" },
  { value: "in_conversation", label: "In conversation" },
  { value: "ongoing", label: "Ongoing" },
  { value: "cold", label: "Cold" },
];

type ContactFormValues = {
  name?: string;
  firm?: string | null;
  role?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  school?: string | null;
  background?: string | null;
  notes?: string | null;
  relationshipStatus?: string;
  lastContactDate?: string | null;
};

export default function ContactForm({
  action,
  defaultValues,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  defaultValues?: ContactFormValues;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name" name="name" required defaultValue={defaultValues?.name} />
        <Field label="Firm" name="firm" defaultValue={defaultValues?.firm ?? ""} />
        <Field label="Role" name="role" defaultValue={defaultValues?.role ?? ""} />
        <Field label="School" name="school" defaultValue={defaultValues?.school ?? ""} />
        <Field label="Email" name="email" type="email" defaultValue={defaultValues?.email ?? ""} />
        <Field
          label="LinkedIn URL"
          name="linkedinUrl"
          defaultValue={defaultValues?.linkedinUrl ?? ""}
        />
        <div>
          <label className="mb-1 block text-sm font-medium text-warmgray-600">
            Relationship status
          </label>
          <select
            name="relationshipStatus"
            defaultValue={defaultValues?.relationshipStatus ?? "not_contacted"}
            className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
          >
            {RELATIONSHIP_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Last contact date"
          name="lastContactDate"
          type="date"
          defaultValue={defaultValues?.lastContactDate ?? ""}
        />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-warmgray-600">Background</label>
        <textarea
          name="background"
          rows={2}
          defaultValue={defaultValues?.background ?? ""}
          placeholder="Prior firm, group, how you're connected, etc."
          className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-warmgray-600">Notes</label>
        <textarea
          name="notes"
          rows={4}
          defaultValue={defaultValues?.notes ?? ""}
          className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
        />
      </div>
      {state?.error && <p className="text-sm text-error-600">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-400 disabled:opacity-60 shadow-card"
      >
        {pending ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-medium text-warmgray-600">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
      />
    </div>
  );
}
