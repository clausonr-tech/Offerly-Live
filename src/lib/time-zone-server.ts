import "server-only";
import { cookies } from "next/headers";

import { getSessionUser } from "@/lib/auth";
import { TZ_COOKIE, calendarDaysBetween, parseChosenTimeZone, parseTimeZone, resolveTimeZone } from "@/lib/time-zone";

/**
 * The signed-in student's time zone: the one they picked on their profile
 * (users.time_zone), or else the one their browser reported.
 *
 * The pick comes from the session lookup, which is cached for the request and
 * already loads the whole user row, so reading it costs no query. Outside a
 * request - a script, a test, a job - there is no cookie jar or session, and
 * the default zone is the honest answer rather than a crash.
 */
export async function getStudentTimeZone(): Promise<string> {
  return (await getTimeZoneSetting()).zone;
}

/** What the profile's time zone picker shows: the zone in use, the student's
 *  pick (null for Automatic) and what their browser reported (null before it
 *  has said). */
export async function getTimeZoneSetting(): Promise<{ zone: string; chosen: string | null; detected: string | null }> {
  try {
    const [jar, user] = await Promise.all([cookies(), getSessionUser()]);
    const rawDetected = jar.get(TZ_COOKIE)?.value;
    return {
      zone: resolveTimeZone(user?.timeZone, rawDetected),
      chosen: parseChosenTimeZone(user?.timeZone),
      detected: rawDetected ? parseTimeZone(rawDetected) : null,
    };
  } catch {
    return { zone: parseTimeZone(undefined), chosen: null, detected: null };
  }
}

/**
 * Counts calendar days on the signed-in student's clock: `daysUntil(date, now)`
 * is 0 today, 1 tomorrow, -1 yesterday.
 *
 * Not the server's clock. That is UTC, which has already started tomorrow for
 * the last hours of every US evening, so a 7pm entry in New York seen at 10pm
 * would read "1d ago".
 */
export async function getStudentDayCounter(): Promise<(date: Date, now: Date) => number> {
  const timeZone = await getStudentTimeZone();
  return (date, now) => calendarDaysBetween(now, date, timeZone);
}
