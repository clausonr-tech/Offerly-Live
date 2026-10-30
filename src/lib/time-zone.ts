/**
 * The student's time zone, and local wall-clock arithmetic in it.
 *
 * Every timestamp in the database is an instant in UTC, which is right for
 * storing and comparing, and useless for "is this interview in the morning?".
 * That question is about the student's clock, and the server's clock is UTC.
 * The browser knows the answer, so it reports it in a cookie (the TimeZone
 * component in the app layout writes it) and the prompts that care read it.
 *
 * Its own leaf module with no imports, like lib/sidebar-rail.ts, because both a
 * client component and server code need it, and a constant exported from a
 * "use client" module arrives `undefined` on the server.
 */

export const TZ_COOKIE = "tz";

/** Most students are on US East time, and a guess is better than UTC. */
export const DEFAULT_TIME_ZONE = "America/New_York";

/** A year. Lax: it should still apply when the app is opened from a link. */
export function timeZoneCookieString(timeZone: string): string {
  return `${TZ_COOKIE}=${encodeURIComponent(timeZone)}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * The zone to use: the student's own pick (users.time_zone) first, then what
 * their browser reported, then the default. The pick is kept apart from
 * TZ_COOKIE, which the browser rewrites whenever its own zone changes: a
 * student recruiting on New York time from a laptop set to London should not
 * be put back on London the next time the app opens. Both are checked.
 */
export function resolveTimeZone(choice: string | undefined | null, detected: string | undefined | null): string {
  const picked = parseChosenTimeZone(choice);
  return picked ?? parseTimeZone(detected);
}

/** The student's pick, or null when there is none (Automatic) or it is
 *  junk. Not parseTimeZone: that turns junk into the default, which would
 *  then outrank the zone the browser reported. */
export function parseChosenTimeZone(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return isTimeZone(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** True for a zone name the runtime recognises. Strict, unlike parseTimeZone:
 *  a pick that is not a real zone is an error to report, not a default. */
export function isTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Offered first in the picker: where most students are, then the rest of the
 *  places a finance recruit tends to be. The full list follows them. */
export const COMMON_TIME_ZONES: { zone: string; label: string }[] = [
  { zone: "America/New_York", label: "Eastern (New York)" },
  { zone: "America/Chicago", label: "Central (Chicago)" },
  { zone: "America/Denver", label: "Mountain (Denver)" },
  { zone: "America/Phoenix", label: "Arizona (Phoenix)" },
  { zone: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { zone: "America/Anchorage", label: "Alaska (Anchorage)" },
  { zone: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
  { zone: "Europe/London", label: "London" },
  { zone: "Asia/Hong_Kong", label: "Hong Kong" },
];

/** Every zone the runtime knows, for the rest of the picker. Empty on a
 *  runtime too old to list them, where the common ones still work. */
export function allTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

/** An IANA zone the runtime recognises, or the default for anything else - a
 *  cookie is user-controlled text and goes into Intl, which throws on junk. */
export function parseTimeZone(value: string | undefined | null): string {
  if (!value) return DEFAULT_TIME_ZONE;
  try {
    // Inside the try: a malformed escape ("%", "%E0%A4%A") makes
    // decodeURIComponent itself throw, and that is junk like any other.
    const decoded = decodeURIComponent(value);
    new Intl.DateTimeFormat("en-US", { timeZone: decoded });
    return decoded;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** The calendar day `instant` falls on in `timeZone`, as "YYYY-MM-DD" - the
 *  shape of a date column. */
export function localDateString(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

/** What the wall clock reads in `timeZone` at `instant`. Month is 1-12. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/**
 * The instant at which the wall clock in `timeZone` reads this date and time.
 *
 * Found by guessing the UTC instant with the same digits, seeing how far the
 * zone's clock is from it, and correcting - twice, so a guess that lands on
 * the other side of a daylight-saving change still comes out right. The day
 * may overflow (day 0 is the last of the month before), as with Date.UTC.
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += target - shown;
  }
  return new Date(guess);
}

/**
 * The instant a wall-clock string typed into `<input type="datetime-local">`
 * means, read in the student's zone: "2026-09-22T19:00" in New York is
 * 23:00Z. `new Date()` on the same string reads it in the server's zone,
 * which on Vercel is UTC, and filed 7pm as 3pm. Seconds are accepted and
 * dropped. Null for anything that is not a real date and time.
 */
export function parseWallClock(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  // Date.UTC rolls over quietly (Feb 30 is Mar 2); a typed date should not.
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return zonedTime(year, month, day, hour, minute, timeZone);
}

/** `instant` as "YYYY-MM-DDTHH:mm" on the wall clock in `timeZone` - what a
 *  datetime-local input wants, and what parseWallClock reads back. */
export function wallClockInputValue(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * A Date whose *local* fields (getHours, getDate, toLocaleTimeString with no
 * zone) read what the wall clock in `timeZone` reads at `instant`.
 *
 * For code written against the browser's own clock - the schedule calendar is
 * day columns and hour rows built from local fields - so it can be put on the
 * student's chosen clock by converting instants on the way in, rather than
 * rewriting every date operation. Only for placing and labelling: its
 * getTime() is not `instant` unless the two zones agree.
 */
export function wallClockDate(instant: Date, timeZone: string): Date {
  const p = localParts(instant, timeZone);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, instant.getSeconds());
}

/** Calendar days from `now` to `then` on the student's own clock: 0 today, 1
 *  tomorrow, -1 yesterday. */
export function calendarDaysBetween(now: Date, then: Date, timeZone: string): number {
  const a = localParts(now, timeZone);
  const b = localParts(then, timeZone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** Midnight at the start of the student's day - the day `now` falls on in
 *  `timeZone`, not on the server's clock, which is UTC and has usually
 *  started tomorrow by the time a New York evening is under way. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const p = localParts(now, timeZone);
  return zonedTime(p.year, p.month, p.day, 0, 0, timeZone);
}

/**
 * A bare `date` column ("YYYY-MM-DD", as drizzle hands it back) as midnight
 * on the student's clock, not the server's. `new Date("2026-08-29")` parses
 * as UTC midnight, which west of UTC is the previous evening - off by one
 * day for every student in the US, and on a UTC server a follow-up typed as
 * "1 Oct" fell due four hours early in New York.
 */
export function parseLocalDay(
  value: string | Date | null | undefined,
  timeZone: string,
): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const parsed = zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, parseTimeZone(timeZone));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
