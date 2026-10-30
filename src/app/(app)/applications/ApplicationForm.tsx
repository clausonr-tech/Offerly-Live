"use client";

import { useActionState, useMemo, useState } from "react";
import type { ActionState } from "./actions";
import { APPLICATION_CATEGORY_LABELS } from "@/lib/badges";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "submitted", label: "Submitted" },
  { value: "interviewing", label: "Interviewing" },
  { value: "offer", label: "Offer" },
  { value: "rejected", label: "Rejected" },
];

const CATEGORY_OPTIONS = Object.entries(APPLICATION_CATEGORY_LABELS);

type ApplicationFormValues = {
  firm?: string;
  role?: string;
  status?: string;
  category?: string | null;
  compensation?: number | null;
  applicationUrl?: string | null;
  notes?: string | null;
  appliedDate?: string | null;
};

type ContactOption = { id: string; name: string; firm: string | null };

export default function ApplicationForm({
  action,
  defaultValues,
  contactOptions,
  linkedContactIds = [],
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  defaultValues?: ApplicationFormValues;
  contactOptions: ContactOption[];
  linkedContactIds?: string[];
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  // Controlled, not defaultChecked: filtering unmounts the rows it hides, and
  // an unmounted checkbox submits nothing - so a contact ticked and then
  // filtered away would be silently unlinked on save. Tracking the set here
  // means the hidden inputs below can carry those through.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set(linkedContactIds));

  const [firmFilter, setFirmFilter] = useState("");
  const [contactSearch, setContactSearch] = useState("");

  const firmChoices = useMemo(
    () =>
      [...new Set(contactOptions.map((c) => c.firm).filter((f): f is string => Boolean(f)))].sort(),
    [contactOptions],
  );

  const visibleContacts = useMemo(() => {
    const q = contactSearch.trim().toLowerCase();
    return contactOptions.filter((c) => {
      if (firmFilter && c.firm !== firmFilter) return false;
      if (q && !`${c.name} ${c.firm ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [contactOptions, firmFilter, contactSearch]);

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Firm" name="firm" required defaultValue={defaultValues?.firm} />
        <Field label="Role" name="role" required defaultValue={defaultValues?.role} />
        <div>
          <label className="mb-1 block text-sm font-medium text-warmgray-600">Status</label>
          <select
            name="status"
            defaultValue={defaultValues?.status ?? "not_started"}
            className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-warmgray-600">Industry</label>
          <select
            name="category"
            defaultValue={defaultValues?.category ?? ""}
            className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          >
            <option value="">Not specified</option>
            {CATEGORY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Applied date"
          name="appliedDate"
          type="date"
          defaultValue={defaultValues?.appliedDate ?? ""}
        />
        <Field
          label="Est. compensation (USD/yr)"
          name="compensation"
          type="number"
          defaultValue={defaultValues?.compensation != null ? String(defaultValues.compensation) : ""}
        />
        <div className="col-span-2">
          <Field
            label="Application URL"
            name="applicationUrl"
            defaultValue={defaultValues?.applicationUrl ?? ""}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-warmgray-600">Notes</label>
        <textarea
          name="notes"
          rows={4}
          defaultValue={defaultValues?.notes ?? ""}
          className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-warmgray-600">
          Linked contacts
        </label>
        {contactOptions.length === 0 ? (
          <p className="text-sm text-warmgray-500">
            No contacts yet. Add contacts first to link them here.
          </p>
        ) : (
          <>
            {/* Filters, not a cascade: this list is multi-select - a student
                links several people to one application - and narrowing to one
                person would defeat it. Narrowing the list they tick through is
                the part that actually helps. */}
            <div className="mb-2 flex flex-wrap gap-2">
              <select
                aria-label="Filter by company"
                value={firmFilter}
                onChange={(e) => setFirmFilter(e.target.value)}
                className="rounded-md border border-brand-200 px-2.5 py-1.5 text-xs text-brand-900 focus:border-accent-500 focus:outline-none"
              >
                <option value="">All companies</option>
                {firmChoices.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <input
                type="search"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder="Search name"
                aria-label="Search contacts"
                className="rounded-md border border-brand-200 px-2.5 py-1.5 text-xs text-brand-900 focus:border-accent-500 focus:outline-none"
              />
            </div>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-brand-100 p-2">
              {visibleContacts.length === 0 && (
                <p className="px-2 py-1 text-sm text-warmgray-500">No contacts match.</p>
              )}
              {visibleContacts.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-brand-50">
                <input
                  type="checkbox"
                  name="contactIds"
                  value={c.id}
                  checked={checkedIds.has(c.id)}
                  onChange={() =>
                    setCheckedIds((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(c.id)) next.add(c.id);
                      return next;
                    })
                  }
                  className="rounded border-brand-200"
                />
                <span className="text-brand-900">{c.name}</span>
                {c.firm && <span className="text-warmgray-500">· {c.firm}</span>}
                </label>
              ))}
            </div>
            {/* Ticked but filtered out of view - without these the save would
                drop the link. */}
            {[...checkedIds]
              .filter((id) => !visibleContacts.some((c) => c.id === id))
              .map((id) => (
                <input key={id} type="hidden" name="contactIds" value={id} />
              ))}
          </>
        )}
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
        className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
      />
    </div>
  );
}
