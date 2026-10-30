"use client";

import type { NotificationRow } from "@/lib/notifications";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";

import { completeNotification } from "../notification-actions";

/**
 * One outstanding job, at full width.
 *
 * Two different promises, and which one a row makes depends on whether the app
 * can see the work happen:
 *
 *   - With progress, it says so, and says the row will close itself. Ticking it
 *     off is still offered - a student who wrote to two of five people and is
 *     done with that firm is allowed to say so - but it is the second option,
 *     because the first one costs them nothing.
 *   - Without, only they can answer, so the tick is the whole control.
 */
export default function NotificationTask({
  id,
  title,
  body,
  href,
  progress,
  kind,
  focused = false,
}: {
  id: string;
  title: string;
  body: string;
  href: string;
  progress: { done: number; total: number } | null;
  /** Every kind the table holds, so a new kind never has to be added here by hand. */
  kind: NotificationRow["kind"];
  /** The row the bell was clicked on: highlighted, and scrolled to. */
  focused?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  // Removed from the list the instant it is ticked. The server revalidates the
  // layout behind it, which is slower than a click deserves to feel.
  const [gone, setGone] = useState(false);
  if (gone) return null;

  const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <li
      ref={rowRef}
      // Arriving from the bell marks which job was clicked. scroll-mt clears
      // the sticky top bar. Literal hex for the same reason as the progress
      // bar below: this panel is light in both themes.
      aria-current={focused ? "true" : undefined}
      className={`flex scroll-mt-24 flex-col gap-3 px-4 py-4 transition-colors sm:flex-row sm:items-center ${
        focused ? "bg-[#e9eef6]" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <Link href={href} className="block text-sm font-medium text-brand-900 hover:underline">
          {title}
        </Link>
        <p className="mt-0.5 text-xs text-warmgray-500">{body}</p>

        {/* A firm is several people, so it gets a bar. A follow-up or a prep
            round is one piece of work - a bar that is either empty or gone
            says nothing - so it gets the promise alone. */}
        {progress && kind !== "outreach" && (
          <p className="mt-1 text-[11px] text-warmgray-500">
            {kind === "follow_up"
              ? "Closes itself once you send it, or mark that they replied"
              : kind === "thank_you"
                ? "Closes itself once you send them a thank-you"
                : "Closes itself once you play a round"}
          </p>
        )}
        {progress && kind === "outreach" && (
          <div className="mt-2 flex items-center gap-2">
            {/* Same thin bar the contacts table uses for a match score, so the
                two read as one system.

                inline-block, not the default inline: a plain <span> ignores
                width and height outright, which rendered the track at its
                content size and left the fill floating mid-row.

                Literal hex, because this sits on a panel that is a light
                surface in BOTH themes while --color-accent-500 resolves to
                white in the dark one - the fill would have vanished. */}
            <span className="inline-block h-1 w-28 overflow-hidden rounded-full bg-[#0b1526]/12">
              <span
                className="block h-full rounded-full bg-[#1b2f4d]"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="text-[11px] text-warmgray-500">
              {progress.done} of {progress.total} emailed
              {progress.done < progress.total && " · finishing the rest closes this"}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Link
          href={href}
          className="rounded-md bg-[#24447a] px-3 py-1.5 text-xs font-medium text-[#ffffff] hover:bg-[#1c3560]"
        >
          Go do it
        </Link>
        <button
          type="button"
          disabled={pending}
          aria-label={`Mark "${title}" as done`}
          onClick={() =>
            startTransition(async () => {
              setGone(true);
              await completeNotification(id);
            })
          }
          className="rounded-md px-3 py-1.5 text-xs text-warmgray-500 hover:text-brand-900 hover:underline disabled:opacity-50"
        >
          Mark as done
        </button>
      </div>
    </li>
  );
}
