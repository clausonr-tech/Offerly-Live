"use client";

import { useActionState, useState } from "react";
import { updateAccount, type AccountState } from "./actions";
import InternshipsField, { type Internship } from "./InternshipsField";

const inputClass =
  "w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none";
const lockedClass =
  "w-full cursor-not-allowed rounded-md border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-warmgray-500";

export default function AccountForm({
  defaultValues,
}: {
  defaultValues: {
    name: string | null;
    school: string | null;
    major: string | null;
    aboutMe: string | null;
    showHometownOnProfile: boolean;
    showInterestsOnProfile: boolean;
    internships: Internship[];
  };
}) {
  const [state, formAction, pending] = useActionState<AccountState, FormData>(updateAccount, undefined);
  const [name, setName] = useState(defaultValues.name ?? "");
  const [school] = useState(defaultValues.school ?? "");
  const [major, setMajor] = useState(defaultValues.major ?? "");
  const [aboutMe, setAboutMe] = useState(defaultValues.aboutMe ?? "");
  const [showHometown, setShowHometown] = useState(defaultValues.showHometownOnProfile);
  const [showInterests, setShowInterests] = useState(defaultValues.showInterestsOnProfile);

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-warmgray-600">Name</span>
            <input name="name" required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-warmgray-600">Major</span>
            <input name="major" value={major} onChange={(e) => setMajor(e.target.value)} className={inputClass} />
          </label>
          {/* Read-only, always. A school is not something you type here any
              more - it comes from confirming an address at that school, so
              changing it means verifying again. The field stays visible
              because the answer still belongs on this form; only the editing
              moved. */}
          <div className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-warmgray-600">School</span>
            <div className={`${lockedClass} flex items-center justify-between gap-3`}>
              <span className="truncate">{school || "Not set"}</span>
              <a
                href="#school-email"
                className="shrink-0 text-xs font-medium text-brand-900 underline-offset-2 hover:underline"
              >
                {school ? "Change" : "Verify"}
              </a>
            </div>
          </div>
        </div>

        <InternshipsField initial={defaultValues.internships} />

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-warmgray-600">About me</span>
          <textarea
            name="aboutMe"
            rows={3}
            maxLength={600}
            value={aboutMe}
            onChange={(e) => setAboutMe(e.target.value)}
            placeholder="e.g. Junior at USC studying finance, focused on breaking into healthcare IB."
            className={inputClass}
          />
        </label>

        {/* Hometown and interests are edited on the Interests tab; whether they
            show publicly is decided here, next to the rest of the public profile. */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-brand-900">
            <input
              type="checkbox"
              name="showHometownOnProfile"
              value="true"
              checked={showHometown}
              onChange={(e) => setShowHometown(e.target.checked)}
              className="h-4 w-4 accent-accent-500"
            />
            Show my hometown on my public profile
          </label>
          <label className="flex items-center gap-2 text-sm text-brand-900">
            <input
              type="checkbox"
              name="showInterestsOnProfile"
              value="true"
              checked={showInterests}
              onChange={(e) => setShowInterests(e.target.checked)}
              className="h-4 w-4 accent-accent-500"
            />
            Show my interests on my public profile
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-400 disabled:opacity-60 shadow-card"
          >
            {pending ? "Saving..." : "Save"}
          </button>
          {state?.saved && <p className="text-sm text-success-700">Saved.</p>}
          {state?.error && <p className="text-sm text-error-600">{state.error}</p>}
        </div>
      </form>
    </div>
  );
}
