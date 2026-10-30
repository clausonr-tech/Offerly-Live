"use client";

import { useActionState } from "react";
import { updateMoreAnswers, type AccountState } from "./actions";

const inputClass =
  "w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none";

/** The two answers outside the onboarding question bank, so they still have a home. */
export default function MoreAnswersForm({
  defaultValues,
}: {
  defaultValues: { targetGroup: string | null; challengeLearned: string | null };
}) {
  const [state, action, pending] = useActionState<AccountState, FormData>(updateMoreAnswers, undefined);

  return (
    <form action={action} className="space-y-4 rounded-xl border border-brand-100 p-5">
      <p className="text-sm font-semibold text-brand-900">A little more about you</p>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-warmgray-600">Other industries / keywords</span>
        <input
          name="targetGroup"
          defaultValue={defaultValues.targetGroup ?? ""}
          placeholder="e.g. impact investing, ESG, family office"
          className={inputClass}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-warmgray-600">
          What&apos;s a challenge or setback you learned the most from?
        </span>
        <textarea
          name="challengeLearned"
          rows={3}
          defaultValue={defaultValues.challengeLearned ?? ""}
          placeholder="A setback, mistake, or hard situation and what it taught you"
          className={inputClass}
        />
      </label>
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
  );
}
