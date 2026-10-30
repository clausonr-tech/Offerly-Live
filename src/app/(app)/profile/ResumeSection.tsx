"use client";

import { useActionState } from "react";
import { FileText } from "lucide-react";
import { RESUME_ACCEPT, RESUME_TYPES_LABEL } from "@/lib/resume-formats";
import {
  reanalyzeResume,
  updateLinkedin,
  uploadResume,
  type AccountState,
  type ResumeState,
} from "./actions";
import { resumeLooksLikeSomeoneElses } from "@/lib/draft-lint";
import { externalHref } from "@/lib/safe-url";

const inputClass =
  "w-full rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-900 focus:border-accent-500 focus:outline-none";
const smallButton =
  "shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-500 disabled:opacity-60 shadow-card";

/**
 * LinkedIn link and the resume on file, both of which feed drafted emails.
 *
 * What was read from the resume stays in the background - it shapes the
 * emails, but it isn't shown here. The only trace on screen is the retry for a
 * read that failed, so a resume the emails know nothing about never goes
 * unnoticed.
 */
export default function ResumeSection({
  linkedinUrl,
  resume,
  readFailed,
  studentName,
}: {
  linkedinUrl: string | null;
  /** `readable`: a type the resume reader understands (everything but legacy .doc). */
  resume: { filename: string; readable: boolean } | null;
  /** A readable resume is on file but hasn't been read, so emails don't know its contents. */
  readFailed: boolean;
  /** For spotting a resume uploaded under someone else's name. */
  studentName: string;
}) {
  const [linkState, linkAction, linkPending] = useActionState<AccountState, FormData>(updateLinkedin, undefined);
  const [uploadState, uploadAction, uploadPending] = useActionState<ResumeState, FormData>(uploadResume, undefined);
  const [readState, readAction, readPending] = useActionState<ResumeState, FormData>(reanalyzeResume, undefined);
  // Read-boundary guard. The student typed this, and it is also the value that
  // goes out in their email signature and into the firm portal - so a row
  // stored before the write rule existed is one they would click themselves.
  // A refused one offers no "Open your profile"; the field still shows it, so
  // they can see what is saved and fix it. See lib/safe-url.
  const profileHref = externalHref(linkedinUrl);

  return (
    <div className="space-y-5">
      <form action={linkAction}>
        <label htmlFor="linkedin-url" className="mb-1 block text-sm font-medium text-brand-900">
          LinkedIn profile
        </label>
        <div className="flex gap-2">
          <input
            id="linkedin-url"
            name="linkedinUrl"
            type="url"
            defaultValue={linkedinUrl ?? ""}
            placeholder="https://www.linkedin.com/in/your-name"
            className={inputClass}
          />
          <button type="submit" disabled={linkPending} className={smallButton}>
            {linkPending ? "Saving..." : "Save"}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-warmgray-500">
          Goes in your email signature.{" "}
          {profileHref && (
            <a href={profileHref} target="_blank" rel="noopener noreferrer" className="text-brand-900 underline">
              Open your profile
            </a>
          )}
        </p>
        {linkState?.saved && <p className="mt-1 text-xs text-success-700">Saved.</p>}
        {linkState?.error && <p className="mt-1 text-xs text-error-600">{linkState.error}</p>}
      </form>

      <div>
        <p className="mb-1 text-sm font-medium text-brand-900">Resume</p>
        {resume ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-brand-100 px-3 py-2">
            <FileText size={16} className="shrink-0 text-warmgray-500" />
            <span className="min-w-0 flex-1 truncate text-sm text-brand-900">{resume.filename}</span>
            <a
              href="/api/resume/current"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-brand-900 underline"
            >
              View
            </a>
          </div>
        ) : null}
        {resume && resumeLooksLikeSomeoneElses(resume.filename, studentName) && (
          <p className="mt-1.5 text-xs text-error-600">
            This file looks like it&apos;s named for someone else. It&apos;s attached to your cold emails, so upload your own
            if it isn&apos;t yours.
          </p>
        )}
        {resume ? null : (
          <p className="text-sm text-warmgray-500">No resume yet.</p>
        )}

        <form action={uploadAction} className="mt-2 flex flex-wrap items-center gap-2">
          <input
            name="resume"
            type="file"
            accept={RESUME_ACCEPT}
            required
            className="min-w-0 flex-1 text-sm text-warmgray-600 file:mr-3 file:rounded-md file:border file:border-brand-300 file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:text-brand-900"
          />
          <button type="submit" disabled={uploadPending} className={smallButton}>
            {uploadPending ? "Uploading..." : resume ? "Replace resume" : "Upload resume"}
          </button>
        </form>
        <p className="mt-1.5 text-xs text-warmgray-500">
          Used to tailor every email you draft, and attached to your cold emails. {RESUME_TYPES_LABEL}.
        </p>
        {uploadState?.saved && <p className="mt-1 text-xs text-success-700">{uploadState.note ?? "Uploaded."}</p>}
        {uploadState?.error && <p className="mt-1 text-xs text-error-600">{uploadState.error}</p>}
        {resume && !resume.readable && (
          <p className="mt-1 text-xs text-error-600">
            Older .doc files can be attached but not read. Save it as .docx or PDF so your emails can use your
            experience.
          </p>
        )}

        {resume?.readable && readFailed && (
          <form action={readAction} className="mt-2 text-xs text-warmgray-500">
            Your resume couldn&apos;t be read, so your emails can&apos;t use it yet.{" "}
            <button
              type="submit"
              disabled={readPending}
              className="font-medium text-brand-900 underline disabled:opacity-60"
            >
              {readPending ? "Trying..." : "Try again"}
            </button>
            {readState?.error && <span className="ml-1 text-error-600">{readState.error}</span>}
          </form>
        )}
      </div>
    </div>
  );
}
