"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Mail, X } from "lucide-react";
import {
  confirmSchoolVerification,
  requestSchoolVerification,
  type VerificationActionState,
} from "./school-verification-actions";

/**
 * The school email: one field and a Verify button.
 *
 * It used to be two - a plain "School email" field that saved an address
 * unverified, and a separate verification box with its own email field and a
 * paragraph of explanation - so a student saw the same address twice. Now the
 * address is only ever set by verifying it: Verify sends a six-digit code, a
 * dialog in the middle of the screen says so and takes the code, and a
 * correct code saves the address and sets the school from its domain.
 */
export default function SchoolEmailVerify({
  verifiedEmail,
  pendingEmail,
  suggestedEmail,
  verifiedSchoolName,
  codesGoToLog = false,
}: {
  verifiedEmail: string | null;
  /** An address a code is already out for. */
  pendingEmail: string | null;
  /** The saved (unverified) school email, pre-filled so verifying it is one click. */
  suggestedEmail: string | null;
  verifiedSchoolName: string | null;
  /** Local dev with no mail provider: codes land in the server log, not an inbox. */
  codesGoToLog?: boolean;
}) {
  const [requestState, requestAction, requestPending] = useActionState<VerificationActionState, FormData>(
    requestSchoolVerification,
    undefined,
  );
  const [confirmState, confirmAction, confirmPending] = useActionState<VerificationActionState, FormData>(
    confirmSchoolVerification,
    undefined,
  );

  const [email, setEmail] = useState(pendingEmail ?? suggestedEmail ?? "");
  // The verified address "Change" was pressed on. A newly verified address is
  // a different one, so the field locks again without resetting anything.
  const [changingFrom, setChangingFrom] = useState<string | null>(null);
  // The address the dialog is about - the one the code went to.
  const [sentTo, setSentTo] = useState(pendingEmail ?? "");
  // The send whose dialog was closed. Each send is a new state object, so a
  // new code reopens the dialog and a failed send never opens it.
  const [dismissed, setDismissed] = useState<VerificationActionState>(undefined);

  const locked = Boolean(verifiedEmail) && changingFrom !== verifiedEmail;
  const dialogOpen = Boolean(requestState?.sent) && requestState !== dismissed && !locked;

  return (
    <div id="school-email">
      <label htmlFor="school-email-input" className="mb-1 block text-sm font-medium text-brand-900">
        School email
      </label>
      <form
        action={(fd) => {
          setSentTo(String(fd.get("schoolEmail") ?? "").trim().toLowerCase());
          requestAction(fd);
        }}
        className="flex gap-2"
      >
        <input
          id="school-email-input"
          name="schoolEmail"
          type="email"
          required
          value={locked ? (verifiedEmail ?? "") : email}
          onChange={(e) => setEmail(e.target.value)}
          readOnly={locked}
          placeholder="you@school.edu"
          className={`w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none ${
            locked
              ? "cursor-not-allowed border-brand-100 bg-brand-50 text-warmgray-600"
              : "border-brand-200 text-brand-900 focus:border-accent-500"
          }`}
        />
        {locked ? (
          // Where Verify was: the answer to it. Not a control - it does
          // nothing when pressed, so it is announced as a status.
          <span
            role="status"
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#2f7a3b] px-3 py-1.5 text-xs font-semibold text-[#ffffff] shadow-card"
          >
            <CheckCircle2 size={13} aria-hidden />
            Verified
          </span>
        ) : (
          <button
            type="submit"
            disabled={requestPending}
            className="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white shadow-card hover:bg-accent-500 disabled:opacity-60"
          >
            {requestPending ? "Sending..." : "Verify"}
          </button>
        )}
      </form>

      {locked ? (
        <p className="mt-1.5 text-xs text-warmgray-500">
          {verifiedSchoolName ? `${verifiedSchoolName}. ` : ""}
          <button
            type="button"
            onClick={() => {
              setChangingFrom(verifiedEmail);
              setEmail("");
            }}
            className="underline-offset-2 hover:text-brand-900 hover:underline"
          >
            Change school email
          </button>
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-warmgray-500">
          We&apos;ll email you a code. Verifying sets your school from the address.
        </p>
      )}
      {requestState?.error && <p className="mt-1.5 text-xs text-error-600">{requestState.error}</p>}

      {dialogOpen && (
        <CodeSentDialog
          email={sentTo}
          codesGoToLog={codesGoToLog}
          confirmAction={confirmAction}
          confirmPending={confirmPending}
          confirmError={confirmState?.error ?? null}
          onResend={() => {
            const fd = new FormData();
            fd.set("schoolEmail", sentTo);
            requestAction(fd);
          }}
          resendPending={requestPending}
          onClose={() => setDismissed(requestState)}
        />
      )}
    </div>
  );
}

/**
 * "A message has been sent to your email", in the middle of the screen, with
 * the box the code goes in - the dialog is where verifying finishes.
 */
function CodeSentDialog({
  email,
  codesGoToLog,
  confirmAction,
  confirmPending,
  confirmError,
  onResend,
  resendPending,
  onClose,
}: {
  email: string;
  codesGoToLog: boolean;
  confirmAction: (fd: FormData) => void;
  confirmPending: boolean;
  confirmError: string | null;
  onResend: () => void;
  resendPending: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Escape closes, and the page behind does not scroll under the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  // Opened only by a click, so this never renders on the server.
  // Into the themed root, not <body>: outside [data-app-theme] the dialog
  // renders in the wrong theme's colours.
  const target = document.querySelector("[data-app-theme]") ?? document.body;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (!panelRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-sent-heading"
        className="rounded-xl relative w-full max-w-sm border border-brand-100 bg-white p-6 text-center shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 text-warmgray-400 hover:text-brand-900"
        >
          <X size={16} />
        </button>
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-accent-50 text-accent-600">
          <Mail size={20} aria-hidden />
        </div>
        <h2 id="code-sent-heading" className="text-base font-semibold text-brand-900">
          Check your email
        </h2>
        <p className="mt-1 text-sm text-warmgray-600">
          We sent a 6-digit code to <span className="font-medium text-brand-900">{email}</span>.
        </p>

        <form action={confirmAction} className="mt-4 flex gap-2">
          <input
            autoFocus
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            placeholder="6-digit code"
            className="w-full rounded-md border border-brand-200 px-3 py-1.5 text-center text-sm tracking-widest text-brand-900 focus:border-accent-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={confirmPending}
            className="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white shadow-card hover:bg-accent-500 disabled:opacity-60"
          >
            {confirmPending ? "Verifying..." : "Verify"}
          </button>
        </form>
        {confirmError && <p className="mt-2 text-xs text-error-600">{confirmError}</p>}

        {codesGoToLog && (
          <p className="mt-3 rounded border border-brand-200 bg-brand-50 px-2 py-1.5 text-left text-xs text-brand-900">
            Email sending isn&apos;t set up on this server, so the code was written to the server log instead.
          </p>
        )}

        <button
          type="button"
          onClick={onResend}
          disabled={resendPending}
          className="mt-4 text-xs text-warmgray-500 underline-offset-2 hover:text-brand-900 hover:underline disabled:opacity-60"
        >
          {resendPending ? "Sending..." : "Send a new code"}
        </button>
      </div>
    </div>,
    target,
  );
}
