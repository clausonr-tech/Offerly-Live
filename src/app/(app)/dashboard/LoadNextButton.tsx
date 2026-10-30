"use client";

import { useTransition } from "react";

import { loadNextTasks } from "./todo-actions";

/** "Load the next 5" - the server writes the batch and the list redraws. */
export default function LoadNextButton({ count }: { count: number }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => loadNextTasks())}
      className="rounded-full bg-[#0b1526] px-4 py-1.5 text-xs font-medium text-[#ffffff] transition-colors hover:bg-[#1b2f4d] disabled:opacity-60"
    >
      {pending ? "Loading..." : `Load the next ${count}`}
    </button>
  );
}
