"use client";

import { useOptimistic, useTransition } from "react";
import { toggleFollow } from "./actions";

export default function FollowButton({
  kind,
  id,
  following,
}: {
  kind: "user" | "club" | "firm";
  id: string;
  following: boolean;
}) {
  const [pending, startTransition] = useTransition();
  // Optimistic, because a follow is a low-stakes toggle and waiting on a
  // round trip before the label flips makes the button feel broken.
  const [optimistic, setOptimistic] = useOptimistic(following);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          setOptimistic(!optimistic);
          await toggleFollow({ kind, id, following: optimistic });
        })
      }
      className={`rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-60 ${
        optimistic
          ? "border-brand-200 text-warmgray-500 hover:border-red-200 hover:text-red-600"
          : "border-accent-400 bg-brand-50 text-brand-900 hover:opacity-80"
      }`}
    >
      {optimistic ? "Following" : "Follow"}
    </button>
  );
}
