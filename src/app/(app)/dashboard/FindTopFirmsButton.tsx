"use client";

import { useActionState } from "react";
import { Sparkles } from "lucide-react";
import type { TopFirmsState } from "./actions";

export default function FindTopFirmsButton({
  action,
  label = "Find my top firms",
}: {
  action: (state: TopFirmsState, formData: FormData) => Promise<TopFirmsState>;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1.5">
      <button
        type="submit"
        disabled={pending}
        className="flex items-center gap-1.5 bg-accent-500 px-4 py-2 text-xs font-semibold text-white shadow-card transition-colors hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Sparkles size={13} />
        {pending ? "Researching firms..." : label}
      </button>
      {state?.error && <p className="text-xs text-error-600">{state.error}</p>}
    </form>
  );
}
