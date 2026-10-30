"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import {
  confirmSchoolVerification,
  requestSchoolVerification,
  type VerificationActionState,
} from "@/app/(app)/profile/school-verification-actions";

/**
 * Two stages in one step: send a code, then read it back.
 *
 * Reuses the profile's actions rather than reimplementing them. They key off
 * the signed-in user and nothing about the profile page, and a second copy of
 * a security flow is a second copy to keep correct.
 */
export default function VerifySchoolStep({
  schoolName,
  schoolDomain,
  defaultEmail,
}: {
  schoolName: string;
  schoolDomain: string | null;
  defaultEmail: string | null;
}) {
  const router = useRouter();
  const [sendState, send, sending] = useActionState<VerificationActionState, FormData>(
    requestSchoolVerification,
    undefined,
  );
  const [confirmState, confirm, confirming] = useActionState<VerificationActionState, FormData>(
    confirmSchoolVerification,
    undefined,
  );
  const [sent, setSent] = useState(false);

  // The request action reports success the same way the confirm action does,
  // so the stage is tracked here rather than inferred from a shared flag.
  if (sendState?.sent && !sent) setSent(true);
  if (confirmState?.sent) router.push("/onboarding");

  const inputClass =
    "w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none";

  return (
    <div className="w-full max-w-lg">
      <p className="label-eyebrow text-xs text-accent-500">Confirm your school</p>
      <h1 className="mt-2 text-2xl font-normal text-brand-900">{schoolName}</h1>

      {!sent ? (
        <form action={send} className="mt-6 space-y-3">
          <label htmlFor="schoolEmail" className="block text-sm font-medium text-warmgray-600">
            School email
          </label>
          <input
            id="schoolEmail"
            name="schoolEmail"
            type="email"
            required
            defaultValue={defaultEmail ?? ""}
            placeholder={schoolDomain ? `you@${schoolDomain}` : "you@school.edu"}
            className={inputClass}
          />
          {sendState?.error && (
            <p role="alert" className="text-xs text-error-600">
              {sendState.error}
            </p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={sending}
              className="inline-flex h-10 items-center rounded-full bg-[#0b1526] px-5 text-sm font-medium text-[#ffffff] transition hover:opacity-90 disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send code"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/onboarding")}
              className="text-sm text-warmgray-500 underline-offset-2 hover:text-brand-900 hover:underline"
            >
              I&apos;ll do this later
            </button>
          </div>
        </form>
      ) : (
        <form action={confirm} className="mt-6 space-y-3">
          <label htmlFor="code" className="block text-sm font-medium text-warmgray-600">
            Enter the 6-digit code
          </label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            className={inputClass}
          />
          {confirmState?.error && (
            <p role="alert" className="text-xs text-error-600">
              {confirmState.error}
            </p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={confirming}
              className="inline-flex h-10 items-center rounded-full bg-[#0b1526] px-5 text-sm font-medium text-[#ffffff] transition hover:opacity-90 disabled:opacity-50"
            >
              {confirming ? "Checking…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setSent(false)}
              className="text-sm text-warmgray-500 underline-offset-2 hover:text-brand-900 hover:underline"
            >
              Use a different address
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
