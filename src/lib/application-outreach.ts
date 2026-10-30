import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, todoDismissals } from "@/db/schema";
import { trackedFirmNames } from "@/lib/tracked-firms";
import { firmResolver, normalizeFirmName } from "@/lib/firm-name";
import { repeatRound } from "@/lib/outreach-ladder";
import { DEFAULT_TIME_ZONE, localDateString, parseTimeZone } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import {
  getUpcomingApplications,
  type UpcomingApplication,
} from "@/lib/upcoming-applications";

// "Your application at this firm opens soon, and you know people there you have
// never written to."
//
// The one moment in recruiting where a cold email is unambiguously worth
// sending is the few weeks before an application opens: a reply that arrives
// after the resume has gone in cannot change anything, and a first email sent
// the night before the deadline reads exactly like what it is. So everything
// here counts down to the OPENING date, never the deadline.
//
// Two surfaces, doing two different jobs:
//
//   - The FLASH. A bubble across the top of the page, from about a month out,
//     for a few seconds, every other day while there is still someone at that
//     firm to write to. Once was too easy to miss: a student who glanced past
//     it a month out heard nothing more until the to-do list.
//   - The TO-DO ROW. One of the five things on Opportunities, from two weeks
//     out until the application opens. It does not interrupt, so it can stand
//     there for as long as the work is outstanding.
//
// A student who never opens the app during the flash window loses nothing: the
// to-do row catches them, and it is not gated on the flash having been seen.
//
// Everything here is a suggestion. Nothing is drafted, addressed or sent on the
// student's behalf.

/**
 * How far out the flash is worth showing.
 *
 * A month, because the flash's job is to arrive BEFORE the work appears on the
 * to-do list - "this is coming, you have people to write to" - while there is
 * still room for a first email, a follow-up a week later, and a second one
 * after that, all before the application opens.
 */
export const FLASH_WINDOW_DAYS = 30;

/**
 * How far out the standing to-do row is worth showing.
 *
 * Two weeks: the point at which "soon" becomes "this fortnight", and still room
 * for a first email and one follow-up before the opening. Before that the
 * repeating flash carries it.
 */
export const TODO_WINDOW_DAYS = 14;

/** A date as the calendar day it falls on in UTC, which is how the flash rows
 *  store it - the comparison is "is this the same opening", never "how long
 *  ago", so a stable day string is both sufficient and unambiguous. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Identifies one firing of a flash: one firm's one opening, in one two-day
 * stretch of the window. The stretch is what makes it repeat - a new one starts
 * every other day, and each gets its own key.
 */
export function flashKey(firmKey: string, opensOn: Date | string, round: number): string {
  return `${firmKey}|${typeof opensOn === "string" ? opensOn : dayKey(opensOn)}|r${round}`;
}

/** Which two-day stretch of the flash window this opening is in. */
export function flashRound(daysUntilOpen: number): number {
  return repeatRound(FLASH_WINDOW_DAYS - daysUntilOpen);
}

/** "firm|opening" - every firing of one opening's flash starts with this. */
export function flashPrefix(firmKey: string, opensOn: Date | string): string {
  return `${firmKey}|${typeof opensOn === "string" ? opensOn : dayKey(opensOn)}|`;
}

/** One firing, keyed by the student's calendar day it fired on. */
export function dayFlashKey(firmKey: string, opensOn: Date | string, today: string): string {
  return `${flashPrefix(firmKey, opensOn)}d${today}`;
}

/**
 * Whether an opening's flash is due today: never shown, or last shown two or
 * more calendar days ago on the student's clock.
 *
 * Counted from when it last fired, not from a fixed grid 30 days out: a firm
 * that first appears 29 days out fires that day and again two days later,
 * never two days running.
 */
export function flashDueToday(lastShownDay: string | null | undefined, today: string): boolean {
  if (!lastShownDay) return true;
  const gap = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastShownDay}T00:00:00Z`)) / 86_400_000;
  return gap >= REPEAT_EVERY_DAYS;
}

/** How often the flash comes back while the work is still there. */
export const REPEAT_EVERY_DAYS = 2;

export type NudgeContact = {
  id: string;
  name: string;
  role: string | null;
};

export type OutreachNudge = {
  /** Normalised firm name. The key a flash is recorded against. */
  firmKey: string;
  /** The firm as the posting names it, which is what the student reads. */
  firmName: string;
  /**
   * The firm as the STUDENT has it written on their own contacts, and the text
   * the links filter their contact table by.
   *
   * Not the same string as `firmName`, and the difference matters: the table
   * filters on a plain substring of what they typed, so sending it the
   * posting's "The Goldman Sachs Group, Inc." would match none of their
   * "Goldman Sachs" rows and land them on an empty table. The shortest spelling
   * among their own contacts at this firm is the one most likely to be
   * contained in all of them.
   */
  contactFirmQuery: string;
  firmSlug: string;
  firmWebsite: string;
  /** Which intake this opening belongs to, e.g. "Summer 2028". */
  cycleLabel: string;
  opensOn: Date;
  daysUntilOpen: number;
  /** People at this firm the student has not written to yet, never empty. */
  contacts: NudgeContact[];
};

/** Just enough of an upcoming application for the selection below. */
type NudgeApplication = Pick<
  UpcomingApplication,
  "firmName" | "firmSlug" | "firmWebsite" | "cycleLabel" | "date" | "kind" | "provenance"
> &
  Partial<Pick<UpcomingApplication, "applyUrl">>;

/** Just enough of a contact row. */
type NudgeContactRow = {
  id: string;
  name: string;
  firm: string | null;
  role: string | null;
  /** Only used to rank: someone whose address we hold can be written to
   *  tonight, someone whose address is still being chased cannot. */
  email: string | null;
  relationshipStatus: string;
};

/**
 * An application that can carry a countdown.
 *
 * "opens" only - a row counting down to a deadline is a different instruction,
 * and an undated row has nothing to count. Estimates are excluded for the
 * reason upcoming-applications.ts refuses to render them with a countdown: an
 * "opens in 14 days" derived from when this firm's last cycle happened to be
 * seen live is indistinguishable on screen from a date the firm published, and
 * a student who writes to three people because of a guess has been misled by
 * us, not by the firm.
 */
function countableOpening(app: NudgeApplication): boolean {
  return (
    app.kind === "opens" &&
    app.date != null &&
    (app.provenance === "posting" || app.provenance === "signal")
  );
}

/** A contact plus the one fact that decides where they sit in the row. */
type Ranked = NudgeContact & { hasEmail: boolean };

/** Permissive on shape, like the contacts directory: the question is "is there
 *  an address here at all", not "is this address valid". */
function isUsableEmail(email: string | null): boolean {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * The order the names are offered in, and who is dropped.
 *
 * Two things a student's contact list actually contains, both visible in any
 * real account: the same person imported twice, and people with no address yet.
 * A prompt that counts one person twice is wrong about the only number it
 * states. So duplicates collapse - by name within the firm, keeping whichever
 * copy carries an address - and people we can write to come first. Ties break
 * on name, so the order is stable between renders.
 */
function rankContacts(people: Ranked[]): Ranked[] {
  const byName = new Map<string, Ranked>();
  for (const person of people) {
    const key = person.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (!existing || (!existing.hasEmail && person.hasEmail)) byName.set(key, person);
  }
  return [...byName.values()].sort(
    (a, b) => Number(b.hasEmail) - Number(a.hasEmail) || a.name.localeCompare(b.name),
  );
}

/**
 * Every firm worth prompting about, soonest opening first.
 *
 * Pure, and separated from the queries below so the rules that decide whether a
 * student is interrupted can be tested without a database. Both surfaces are
 * cut from this one list - see todoNudges and flashNudges.
 */
export function selectOutreachNudges({
  applications,
  contactRows,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  resolveFirm = normalizeFirmName,
}: {
  applications: NudgeApplication[];
  contactRows: NudgeContactRow[];
  now?: Date;
  /** Free-text firm name to one key per firm - the firms' own aliases and
   *  DBA names included (see firmResolver). */
  resolveFirm?: (raw: string) => string;
  /** The student's own clock: "opens tomorrow" is about their calendar. */
  timeZone?: string;
}): OutreachNudge[] {
  // Contacts first, by firm. A firm with nobody to write to produces no prompt
  // at all: "you have an application coming up and know nobody there" is a real
  // problem, but it is a sourcing problem, and answering it here would put a
  // banner in front of a student whose only available action is to go and find
  // strangers.
  const byFirm = new Map<string, Ranked[]>();
  const labelByFirm = new Map<string, string>();
  // The same person saved twice is one person: if either copy has been
  // written to, they have been. Keyed by firm and name, the way rankContacts
  // merges them below.
  const reached = new Set<string>();
  for (const row of contactRows) {
    if (!row.firm?.trim() || row.relationshipStatus === "not_contacted") continue;
    reached.add(`${resolveFirm(row.firm)}|${row.name.trim().toLowerCase()}`);
  }
  for (const row of contactRows) {
    if (!row.firm?.trim()) continue;
    // Anything past not_contacted means this person has already been
    // approached, which is the whole point of the prompt. The same reading the
    // networking table's "Reached out" column uses.
    if (row.relationshipStatus !== "not_contacted") continue;
    const key = resolveFirm(row.firm);
    if (!key) continue;
    if (reached.has(`${key}|${row.name.trim().toLowerCase()}`)) continue;

    const label = row.firm.trim();
    const shortest = labelByFirm.get(key);
    if (!shortest || label.length < shortest.length) labelByFirm.set(key, label);

    const list = byFirm.get(key) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      role: row.role,
      hasEmail: isUsableEmail(row.email),
    });
    byFirm.set(key, list);
  }
  if (byFirm.size === 0) return [];

  for (const [key, people] of byFirm) {
    byFirm.set(key, rankContacts(people));
  }

  // One prompt per firm, not per posting and not per person. Two postings at
  // the same bank in the same month are one piece of news to a student, and
  // five contacts there are one job: email that firm.
  const soonest = new Map<string, OutreachNudge>();

  for (const app of applications) {
    if (!countableOpening(app)) continue;
    const opensOn = app.date!;
    if (Number.isNaN(opensOn.getTime())) continue;

    // Whole calendar days on the student's clock. An opening is a date (stored
    // at midnight UTC), not an instant: counting it as one made it vanish at
    // 8pm the evening before for a student in New York, and read a day short
    // all evening.
    const today = localDateString(now, parseTimeZone(timeZone));
    const days = Math.round(
      (Date.parse(`${dayKey(opensOn)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );
    // The day it opens is not "opens today" for this prompt - it is open, and
    // writing ahead of it is over.
    if (days < 1 || days > FLASH_WINDOW_DAYS) continue;

    const key = resolveFirm(app.firmName);
    const people = byFirm.get(key);
    if (!people || people.length === 0) continue;

    const existing = soonest.get(key);
    if (existing && existing.opensOn.getTime() <= opensOn.getTime()) continue;

    soonest.set(key, {
      firmKey: key,
      firmName: app.firmName,
      contactFirmQuery: labelByFirm.get(key) ?? app.firmName,
      firmSlug: app.firmSlug,
      firmWebsite: app.firmWebsite,
      cycleLabel: app.cycleLabel,
      opensOn,
      daysUntilOpen: days,
      // hasEmail has done its job in the ranking; it is not something a prompt
      // should be saying out loud about a person.
      contacts: people.map(({ id, name, role }) => ({ id, name, role })),
    });
  }

  // Soonest first; a firm name only to keep the order stable when two open on
  // the same day.
  return [...soonest.values()].sort(
    (a, b) => a.daysUntilOpen - b.daysUntilOpen || a.firmName.localeCompare(b.firmName),
  );
}

/**
 * The standing reminders: one row per firm on the Opportunities to-do list.
 *
 * Two weeks rather than the flash's month, so the list only ever carries work
 * that is actually this fortnight's. Nothing filters these out once they are
 * in - they leave when the student writes to everyone, or when the application
 * opens.
 */
/** One firm whose application opens today, on the student's clock. */
export type OpeningToday = {
  firmKey: string;
  firmName: string;
  firmSlug: string;
  cycleLabel: string;
  opensOn: Date;
  /** Where to apply - the posting's own link, or the firm's page. */
  applyUrl: string;
};

/**
 * Every tracked firm whose application opens TODAY - the one day the prompt
 * is "apply", not "write to people first". Whether or not the student knows
 * anyone there: applying is the job either way. One per firm; the soonest
 * dated programme's link when a firm opens several.
 */
export function selectOpeningToday({
  applications,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  resolveFirm = normalizeFirmName,
}: {
  applications: NudgeApplication[];
  now?: Date;
  timeZone?: string;
  resolveFirm?: (raw: string) => string;
}): OpeningToday[] {
  const today = localDateString(now, parseTimeZone(timeZone));
  const byFirm = new Map<string, OpeningToday>();
  for (const app of applications) {
    if (!countableOpening(app)) continue;
    const opensOn = app.date!;
    if (Number.isNaN(opensOn.getTime()) || dayKey(opensOn) !== today) continue;
    const key = resolveFirm(app.firmName);
    if (!key || byFirm.has(key)) continue;
    byFirm.set(key, {
      firmKey: key,
      firmName: app.firmName,
      firmSlug: app.firmSlug,
      cycleLabel: app.cycleLabel,
      opensOn,
      applyUrl: app.applyUrl?.trim() || `/discovery/firm/${app.firmSlug}`,
    });
  }
  return [...byFirm.values()].sort((a, b) => a.firmName.localeCompare(b.firmName));
}

/** The dedupe key of an opening-day "apply" job under the bell. */
export function applyNotificationKey(firmKey: string, opensOn: Date | string): string {
  return `apply:${firmKey}:${typeof opensOn === "string" ? opensOn : dayKey(opensOn)}`;
}

export function todoNudges(nudges: OutreachNudge[]): OutreachNudge[] {
  return nudges.filter((n) => n.daysUntilOpen <= TODO_WINDOW_DAYS);
}

/**
 * The one flash to show now, or null.
 *
 * One at a time, most urgent first: two bars stacked across the top of a page
 * is not a heads-up, it is an inbox, and the second one is still there for the
 * next page view. Anything already flashed in this two-day stretch waits for
 * the next one.
 */
export function nextFlash(
  nudges: OutreachNudge[],
  /** "firm|opening|" to the student's calendar day it last fired. */
  lastShownDay: ReadonlyMap<string, string>,
  today: string,
): OutreachNudge | null {
  return nudges.find((n) => flashDueToday(lastShownDay.get(flashPrefix(n.firmKey, n.opensOn)), today)) ?? null;
}

type OutreachUser = Parameters<typeof getUpcomingApplications>[0] & { id: string };

/**
 * Every firm this student should be writing to, within the flash window.
 *
 * `getUpcomingApplications` is request-cached, so the to-do list and the flash
 * calling this in the same render costs one set of queries, not two - and
 * guarantees the two cannot disagree about when something opens.
 */
export async function getOutreachNudges(
  user: OutreachUser,
  now: Date = new Date(),
): Promise<OutreachNudge[]> {
  const db = await getDb();

  // Contacts first, alone, because this runs in the layout on EVERY page. The
  // upcoming-applications call is the expensive half - postings, signals,
  // tracked firms - and a student with nobody left to write to can never be
  // prompted whatever it returns. One cheap indexed query decides that.
  const contactRows = await db.query.contacts.findMany({
    // Everyone, not only the un-contacted: a person saved twice with one copy
    // already written to is not someone to prompt about.
    where: eq(contacts.userId, user.id),
    columns: {
      id: true,
      name: true,
      firm: true,
      role: true,
      email: true,
      relationshipStatus: true,
    },
  });
  if (!contactRows.some((c) => c.relationshipStatus === "not_contacted")) return [];

  // Every dated opening, not the Upcoming panel's eight: that panel is a
  // summary and rations by firm and city, and a firm past its cut would never
  // be prompted at all.
  const [windows, timeZone] = await Promise.all([
    getUpcomingApplications(user, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    getStudentTimeZone(),
  ]);
  const applications = [...windows.current, ...windows.upcoming];
  // Those firms' own names and aliases, so a contact saved at "CVP" or at a
  // firm's DBA name counts as someone there.
  const known = await trackedFirmNames(user.id);

  const nudges = selectOutreachNudges({
    // Both lists: a row is filed under "current" or "upcoming" by whether it can
    // be acted on today, which is not the same question as whether it has an
    // opening date, and countableOpening() is the only filter that matters here.
    applications,
    contactRows,
    now,
    timeZone,
    resolveFirm: firmResolver(known),
  });

  // A firm the student ticked off on the to-do list for this opening is their
  // call - no banner, no row. A new opening date is a new question.
  const ticked = new Set(
    (
      await db.query.todoDismissals.findMany({
        where: eq(todoDismissals.userId, user.id),
        columns: { taskId: true },
      })
    ).map((d) => d.taskId),
  );
  return nudges.filter((n) => !ticked.has(`outreach-${n.firmKey}-${dayKey(n.opensOn)}`));
}

/**
 * Tracked firms whose application opens today, for the "apply" prompt.
 *
 * The same openings the countdown reads (request-cached), resolved the same
 * way - but not gated on contacts: on the day it opens, applying is the job
 * whether or not the student knows anyone there.
 */
export async function getOpeningToday(user: OutreachUser, now: Date = new Date()): Promise<OpeningToday[]> {
  const db = await getDb();
  const [windows, timeZone] = await Promise.all([
    getUpcomingApplications(user, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    getStudentTimeZone(),
  ]);
  const applications = [...windows.current, ...windows.upcoming];
  if (applications.length === 0) return [];
  const known = await trackedFirmNames(user.id);
  const ticked = new Set(
    (
      await db.query.todoDismissals.findMany({
        where: eq(todoDismissals.userId, user.id),
        columns: { taskId: true },
      })
    ).map((d) => d.taskId),
  );
  return selectOpeningToday({ applications, now, timeZone, resolveFirm: firmResolver(known) }).filter(
    (o) => !ticked.has(`apply-${o.firmKey}-${dayKey(o.opensOn)}`),
  );
}

export { trackedFirmNames };
