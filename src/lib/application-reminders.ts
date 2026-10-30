// "Your Evercore application closes in 3 days, and you haven't applied."
//
// An open application a student has not applied to gets a banner and a job
// under the bell at 14, 7, 3 and 1 days before its deadline and on the day
// itself, and a standing row on the to-do list from two weeks out. One with a
// rolling deadline - open, reviewed as applications arrive - has no date to
// count down to and every reason to go early, so it speaks once a week while
// it stays open. All of it stops the moment they say they applied, the
// posting closes, or the deadline passes.
//
// Pure: which applications qualify, which reminder is due, and what it says,
// all on the student's own clock. The queries are in application-reminders-db.ts.

import { DEFAULT_TIME_ZONE, localDateString, parseTimeZone } from "@/lib/time-zone";

/** Days before the deadline a banner speaks, and the day itself. */
export const REMINDER_MARKS = [14, 7, 3, 1, 0] as const;

/** How far out the standing to-do row appears. */
export const REMINDER_TODO_DAYS = 14;

/** A rolling-deadline banner comes back this often while it is open. */
export const ROLLING_EVERY_DAYS = 7;

const DAY = 86_400_000;

/** One open application, however it reached the list. */
export type ReminderCandidate = {
  /** Stable per application: "posting:<id>" or "application:<id>". */
  key: string;
  firmName: string;
  role: string;
  /** Where to apply, when we know. */
  applyUrl: string | null;
  /** The deadline as a calendar date (midnight UTC), or null when rolling. */
  deadline: Date | null;
  /** The firm's own words for the cut-off time, e.g. "11:55 PM EST". */
  deadlineTime?: string | null;
  rolling: boolean;
  /** Opens today: open to apply to, with no reminder of its own - its day
   *  has the opening-day prompt - but listed wherever "applied yet?" is asked. */
  opensToday?: boolean;
  /** Their tracker entry for it, when they have one. */
  applicationId: string | null;
};

export type ApplicationReminder = ReminderCandidate & {
  /** Whole calendar days to the deadline on the student's clock; null when rolling. */
  daysLeft: number | null;
  /** The banner due now, if one is: its key, or null for no banner today. */
  flashKey: string | null;
  /** Whether it belongs on the to-do list today. */
  onTodo: boolean;
};

/** The day a date falls on, for a date stored as midnight UTC. */
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Whole calendar days between two "YYYY-MM-DD" days. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/**
 * The mark a reminder is in: the nearest of 14, 7, 3, 1 and 0 at or above the
 * days left. A student who first opens the app 5 days out gets the 7-day
 * reminder then - late, but never skipped - and the 3-day one after it.
 */
export function reminderMark(daysLeft: number): (typeof REMINDER_MARKS)[number] | null {
  if (daysLeft < 0 || daysLeft > REMINDER_MARKS[0]) return null;
  return [...REMINDER_MARKS].reverse().find((m) => m >= daysLeft) ?? null;
}

/** The job under the bell for one application, and what "I applied" closes. */
export function reminderNotificationKey(key: string): string {
  return `deadline:${key}`;
}

/** The to-do row's id for one application. */
export function reminderTaskId(key: string): string {
  return `deadline-${key}`;
}

/**
 * The reminders due now.
 *
 * `lastRollingShown` is the calendar day each rolling application's banner
 * last spoke on the student's clock, so the weekly rhythm counts from when it
 * last fired, not from a fixed grid.
 */
export function selectReminders({
  candidates,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  lastRollingShown = new Map(),
}: {
  candidates: ReminderCandidate[];
  now?: Date;
  timeZone?: string;
  lastRollingShown?: ReadonlyMap<string, string>;
}): ApplicationReminder[] {
  const today = localDateString(now, parseTimeZone(timeZone));
  const seen = new Set<string>();
  const out: ApplicationReminder[] = [];

  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);

    if (c.rolling || !c.deadline) {
      if (!c.rolling) continue; // no date and not known to be open: nothing to say
      const last = lastRollingShown.get(c.key);
      const due = !last || daysBetween(last, today) >= ROLLING_EVERY_DAYS;
      out.push({
        ...c,
        daysLeft: null,
        flashKey: due ? `deadline:${c.key}:rolling:${today}` : null,
        onTodo: true,
      });
      continue;
    }

    if (Number.isNaN(c.deadline.getTime())) continue;
    const daysLeft = daysBetween(today, dayOf(c.deadline));
    if (daysLeft < 0) continue; // it has closed
    const mark = reminderMark(daysLeft);
    out.push({
      ...c,
      daysLeft,
      // Keyed by the deadline too: a deadline that moves is a new countdown.
      flashKey: mark === null ? null : `deadline:${c.key}:${dayOf(c.deadline)}:m${mark}`,
      onTodo: daysLeft <= REMINDER_TODO_DAYS,
    });
  }

  // Soonest first; rolling ones after the dated, by firm.
  return out.sort(
    (a, b) =>
      (a.daysLeft ?? Number.POSITIVE_INFINITY) - (b.daysLeft ?? Number.POSITIVE_INFINITY) ||
      a.firmName.localeCompare(b.firmName) ||
      a.role.localeCompare(b.role),
  );
}

/** "due today", "due tomorrow", "due in 5 days", or "rolling". */
export function dueLabel(r: Pick<ApplicationReminder, "daysLeft">): string {
  if (r.daysLeft === null) return "rolling";
  if (r.daysLeft === 0) return "due today";
  if (r.daysLeft === 1) return "due tomorrow";
  return `due in ${r.daysLeft} days`;
}

/** The sentence after the firm in the banner. */
export function reminderDetail(r: Pick<ApplicationReminder, "role" | "daysLeft" | "deadlineTime">): string {
  if (r.daysLeft === null) return `${r.role} · rolling, earlier is better`;
  const when = r.daysLeft === 0 && r.deadlineTime ? ` · closes ${r.deadlineTime}` : "";
  return `${r.role} · you haven't applied yet${when}`;
}

/** How urgent, for ordering against every other prompt and to-do row. */
export function reminderScore(r: Pick<ApplicationReminder, "daysLeft">): number {
  if (r.daysLeft === null) return 60;
  // 99 on the day, climbing as it nears: level with an interview tomorrow at 1
  // day out, above almost everything a fortnight away.
  return Math.max(55, 99 - r.daysLeft * 3);
}

/** One open application in the "Applied yet?" list. */
export type OpenApplication = ReminderCandidate & {
  /** "due in 5 days", "due today", "rolling", "opens today". */
  label: string;
  /** Whole days to the deadline on the student's clock, when dated. */
  daysLeft: number | null;
};

/**
 * Every open application the student has not said they applied to, soonest
 * first - the "Applied yet?" list. Deadlines already past are gone; the rest
 * are listed however far out, since saying "I applied" early is exactly what
 * spares the student the reminders later.
 */
export function openApplications(
  candidates: ReminderCandidate[],
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): OpenApplication[] {
  const today = localDateString(now, parseTimeZone(timeZone));
  const seen = new Set<string>();
  const out: OpenApplication[] = [];
  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    if (c.deadline && !Number.isNaN(c.deadline.getTime())) {
      const daysLeft = daysBetween(today, dayOf(c.deadline));
      if (daysLeft < 0) continue;
      out.push({ ...c, daysLeft, label: dueLabel({ daysLeft }) });
    } else if (c.rolling) {
      out.push({ ...c, daysLeft: null, label: "rolling" });
    } else if (c.opensToday) {
      out.push({ ...c, daysLeft: null, label: "opens today" });
    }
  }
  const rank = (a: OpenApplication) => a.daysLeft ?? (a.opensToday ? 0.5 : Number.POSITIVE_INFINITY);
  return out.sort((a, b) => rank(a) - rank(b) || a.firmName.localeCompare(b.firmName) || a.role.localeCompare(b.role));
}
