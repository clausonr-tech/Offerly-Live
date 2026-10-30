"use client";

import { useActionState } from "react";
import { updatePhone, type PhoneState } from "./actions";

/**
 * The student's phone number, saved on its own.
 *
 * Separate from the main profile form so it sits with the school email - the
 * two lines of contact info that go under every drafted email - and so saving
 * it doesn't mean saving (and being redirected away from) the whole profile.
 */
export default function PhoneField({ defaultPhone }: { defaultPhone: string | null }) {
  const [state, action, pending] = useActionState<PhoneState, FormData>(updatePhone, undefined);

  return (
    <form action={action} className="rounded-md border border-brand-100 bg-brand-50/50 p-3">
      <label htmlFor="profile-phone" className="mb-1 block text-sm font-medium text-brand-900">
        Phone number <span className="font-normal text-warmgray-500">(optional)</span>
      </label>
      <div className="flex gap-2">
        <input
          id="profile-phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          defaultValue={defaultPhone ?? ""}
          placeholder="(555) 123-4567"
          className="w-full rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-500 disabled:opacity-60 shadow-card"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-warmgray-500">
        Goes in the signature of the emails you draft, and is where text reminders go.
      </p>
      {state?.saved && <p className="mt-1 text-xs text-success-700">Saved.</p>}
      {state?.error && <p className="mt-1 text-xs text-error-600">{state.error}</p>}
    </form>
  );
}
