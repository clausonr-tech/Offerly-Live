"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import SchoolCombobox from "@/app/(app)/SchoolCombobox";
import { assignFileToInput, useFileDrop } from "@/lib/use-file-drop";
import { RESUME_ACCEPT, RESUME_TYPES_LABEL } from "@/lib/resume-formats";
import { saveProfileLinks, skipProfileLinks, type ActionState } from "./actions";

export default function LinksForm({
  schools,
}: {
  schools: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    saveProfileLinks,
    undefined,
  );
  const resumeRef = useRef<HTMLInputElement>(null);
  const [schoolName, setSchoolName] = useState("");
  const schoolNames = useMemo(() => schools.map((s) => s.name), [schools]);
  const [dropError, setDropError] = useState<string | null>(null);

  // The input here is a styled-but-visible file control, so the browser prints
  // the chosen filename itself once assignFileToInput fires `change` - only the
  // rejection case needs its own message.
  const ACCEPT = RESUME_ACCEPT;
  const { dragging, dropProps } = useFileDrop({
    accept: ACCEPT,
    onFile: (file) => {
      setDropError(null);
      assignFileToInput(resumeRef.current, file);
    },
    onReject: () => setDropError(`Resume must be a ${RESUME_TYPES_LABEL}.`),
  });

  return (
    <div className="w-full max-w-lg">
      <p className="label-eyebrow text-xs text-accent-500">One more thing</p>
      <h1 className="mt-2 text-2xl font-normal text-brand-900">
        Add your school, phone, LinkedIn and resume
      </h1>
      <p className="mt-1.5 text-sm text-warmgray-500">
        Helps personalize firm matches and connection-angle suggestions. You can always add these
        later from your profile.
      </p>

      <form id="profile-links-form" action={formAction} className="mt-6 space-y-4">
        <div>
          <label htmlFor="schoolName" className="mb-1 block text-sm font-medium text-warmgray-600">
            School
          </label>
          {/* A combobox, not a <select>. The allowlist is ~2,500 schools now,
              and a native select of that length is a scroll with no way to
              search it. */}
          <SchoolCombobox
            name="schoolName"
            idName="claimedSchoolId"
            options={schools}
            schools={schoolNames}
            value={schoolName}
            onChange={setSchoolName}
            className="w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="linkedinUrl" className="mb-1 block text-sm font-medium text-warmgray-600">
            LinkedIn profile URL
          </label>
          <input
            id="linkedinUrl"
            name="linkedinUrl"
            type="url"
            placeholder="https://www.linkedin.com/in/your-name"
            className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="phone" className="mb-1 block text-sm font-medium text-warmgray-600">
            Phone number <span className="font-normal text-warmgray-500">(optional)</span>
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            placeholder="(555) 123-4567"
            className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-warmgray-500">
            Goes in the signature of the emails you draft here, so people can call you back.
          </p>
        </div>

        <div>
          <label htmlFor="resume" className="mb-1 block text-sm font-medium text-warmgray-600">
            Resume
          </label>
          <div
            {...dropProps}
            className={`rounded-md border border-dashed p-3 transition-colors ${
              dragging ? "border-accent-500 bg-accent-50" : "border-brand-200"
            }`}
          >
            <input
              ref={resumeRef}
              id="resume"
              name="resume"
              type="file"
              accept={ACCEPT}
              onChange={() => setDropError(null)}
              className="w-full text-sm text-warmgray-600 file:mr-3 file:rounded-md file:border file:border-brand-200 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-900 hover:file:border-accent-400"
            />
            <p className="mt-1.5 text-xs text-warmgray-500">
              PDF, Word (.docx), image or text file, up to 4MB - or drag one anywhere onto this box.
            </p>
            {dropError && <p className="mt-1 text-xs text-error-600">{dropError}</p>}
          </div>
        </div>

        {state?.error && <p className="text-sm text-error-600">{state.error}</p>}
      </form>

      <div className="mt-6 flex items-center justify-between">
        <form action={skipProfileLinks}>
          <button type="submit" className="px-4 py-2 text-base font-semibold text-brand-900 hover:text-brand-900">
            Skip for now
          </button>
        </form>
        <button
          type="submit"
          form="profile-links-form"
          disabled={pending}
          className="bg-accent-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-accent-400 disabled:opacity-60 shadow-card"
        >
          {pending ? "Saving..." : "Continue →"}
        </button>
      </div>
    </div>
  );
}
