"use client";

import { useSyncExternalStore } from "react";

/**
 * A deadline shown in the viewer's own timezone.
 *
 * Converted in the browser and only after hydration, deliberately. The server
 * has no idea where the student is - it renders in whatever zone the machine
 * happens to be set to, which is how "Nov 15" came to be displayed as "Nov 14"
 * in the first place. Formatting during SSR with a guessed zone would also
 * hand React two different strings to reconcile.
 *
 * So the first paint is the firm's own words - the stored calendar date and
 * the stated time text - and the swap to local happens once the browser can
 * tell us its zone. Both states are correct and neither is blank, so nothing
 * flashes into existence or shifts the row's height.
 *
 * useSyncExternalStore rather than the usual useState+useEffect pair: it is
 * built for exactly this, reading a value the server cannot know. It gives
 * React an explicit server snapshot to hydrate against, and the formatting
 * then happens during render rather than in an effect that sets state and
 * forces a second pass.
 *
 * The DATE is converted along with the time, never just the time. They are one
 * moment: 11:55 PM EST on the 15th is 4:55 AM on the 16th in London, and
 * showing that student "Nov 15" beside "4:55 AM GMT" would be a worse error
 * than the one this replaced - it would look right.
 */
const subscribe = () => () => {};

export default function LocalDeadline({
  /** ISO instant, when the stated zone could be resolved. Null otherwise. */
  exactAt,
  /** The firm's calendar date, already formatted in UTC. Always present. */
  fallbackDate,
  /** The firm's stated time of day, e.g. "11:55 PM EST". May be null. */
  fallbackTime,
}: {
  exactAt: string | null;
  fallbackDate: string;
  fallbackTime: string | null;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const instant = exactAt ? new Date(exactAt) : null;
  const local =
    hydrated && instant && !Number.isNaN(instant.getTime())
      ? {
          date: instant.toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          }),
          // timeZoneName so the row still says which zone it is talking about.
          // A bare "8:55 PM" invites a student to wonder whose 8:55 it is,
          // which is the doubt the conversion was meant to remove.
          time: instant.toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }),
        }
      : null;

  return (
    <>
      <span className="block text-[11px] text-warmgray-500">
        {local ? local.date : fallbackDate}
      </span>
      {local ? (
        <span className="block text-[11px] text-warmgray-500">{local.time}</span>
      ) : fallbackTime ? (
        <span className="block text-[11px] text-warmgray-500">{fallbackTime}</span>
      ) : null}
    </>
  );
}
