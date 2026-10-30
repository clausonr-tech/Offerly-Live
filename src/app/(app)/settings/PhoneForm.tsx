"use client";

import Link from "next/link";
import { useActionState } from "react";
import { sendTestSms, type SmsState } from "./actions";

/**
 * The SMS test. The number itself lives on the profile, alongside the school
 * email, since both also go in the signature of drafted emails.
 */
export default function PhoneForm({
  defaultPhone,
  twilioConfigured,
}: {
  defaultPhone: string | null;
  twilioConfigured: boolean;
}) {
  const [smsState, smsAction, smsPending] = useActionState<SmsState, FormData>(
    sendTestSms,
    undefined,
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-brand-900">
        {defaultPhone ? (
          <>
            Texts go to <span className="font-medium">{defaultPhone}</span>.{" "}
          </>
        ) : (
          "No phone number yet. "
        )}
        <Link href="/profile" className="text-warmgray-500 underline hover:text-brand-900">
          {defaultPhone ? "Change it on your profile" : "Add one on your profile"}
        </Link>
      </p>

      <form action={smsAction}>
        <button
          type="submit"
          disabled={smsPending || !twilioConfigured}
          className="rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40 shadow-card"
        >
          {smsPending ? "Sending..." : "Send test SMS"}
        </button>
      </form>
      {!twilioConfigured && (
        <p className="text-xs text-warmgray-500">
          Text reminders haven&apos;t been set up on this deployment yet.
        </p>
      )}
      {smsState?.success && <p className="text-xs text-success-700">Test SMS sent.</p>}
      {smsState?.error && <p className="text-xs text-error-600">{smsState.error}</p>}
    </div>
  );
}
