"use client";

import { useOptimistic, useTransition } from "react";

import type { PeerState } from "@/lib/peers";

import { togglePeer } from "./peer-actions";

/**
 * Add someone as a peer, beside Follow rather than instead of it.
 *
 * The two say different things. Follow is one-way and about reading someone's
 * activity; a peer is mutual and about knowing them. Showing both lets a
 * student watch a stranger's progress without claiming to know them, which is
 * the honest version of what a directory of strangers is for.
 *
 * Four labels, because a single "Add" would lie in two of the four states:
 *
 *   none       "Add +"        nothing between you yet
 *   requested  "Requested"    your half is recorded, theirs is not
 *   added_you  "Add back"     one click from you completes the pair
 *   peers      "Peers"        both halves exist
 */
export default function AddPeerButton({ userId, state }: { userId: string; state: PeerState }) {
  const [pending, startTransition] = useTransition();
  // Optimistic for the same reason Follow is: waiting on a round trip before
  // the label moves makes the button feel broken.
  const [optimistic, setOptimistic] = useOptimistic(state);

  const isPeer = optimistic === "peers";
  const label =
    optimistic === "peers"
      ? "Peers"
      : optimistic === "requested"
        ? "Requested"
        : optimistic === "added_you"
          ? "Add back"
          : "Add +";

  // Only a recorded half can be withdrawn. From "none" or "added_you" the
  // click adds; from "requested" or "peers" it removes the viewer's own row.
  const willRemove = optimistic === "requested" || optimistic === "peers";

  return (
    <button
      type="button"
      disabled={pending}
      title={
        optimistic === "added_you"
          ? "They added you - add back to become peers"
          : optimistic === "requested"
            ? "Waiting for them to add you back"
            : undefined
      }
      onClick={() =>
        startTransition(async () => {
          setOptimistic(
            willRemove
              ? optimistic === "peers"
                ? "added_you"
                : "none"
              : optimistic === "added_you"
                ? "peers"
                : "requested",
          );
          await togglePeer({ peerId: userId, peer: willRemove });
        })
      }
      className={`rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-60 ${
        isPeer
          ? "border-brand-200 text-warmgray-500 hover:border-red-200 hover:text-red-600"
          : optimistic === "requested"
            ? "border-brand-100 text-warmgray-500 hover:border-red-200 hover:text-red-600"
            : "border-accent-400 bg-brand-50 text-brand-900 hover:opacity-80"
      }`}
    >
      {label}
    </button>
  );
}
