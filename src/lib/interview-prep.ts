import "server-only";
import { and, asc, eq, gte, isNull, lte, ne, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { events, firms, practiceSessions, todoDismissals, userTopFirms } from "@/db/schema";
import { CONVERSATION_OVER_INTERVIEW, interviewEvidence, looksLikeInterview } from "@/lib/interview-prep-words";
import { normalizeFirmName } from "@/lib/network-coverage";
import { DEFAULT_TIME_ZONE, calendarDaysBetween, localParts, zonedTime } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";

// "You have an interview in three days and you have not practised."
//
// The third of the three prompts, and the one with the hardest edge: an
// interview does not move, and the work that helps - technicals for the desk
// you are sitting in front of - is the work nobody does until it is too late.
//
// The calendar entry is the trigger. It arrives as a title someone else wrote
// ("Evercore | Superday - Round 2"), so what is read out of that string is
// whether it is an interview at all and, for the wording, which firm it is
// with. Not which desk: the prompt opens the practice page with no sector
// chosen, and the student picks (see PREP_HREF).
//
// Two phases, and practice ends each one:
//
//   - PREP. At 7, 3 and 1 days out, until the student plays a round - any
//     round. Once they have, the countdown goes quiet - they did the thing.
//   - REFRESHER. Shortly before the interview, whatever they did earlier: the
//     morning of it, or the evening before when the interview is itself in the
//     morning. Practice a week ago is not practice this morning. It goes quiet
//     once they play a round after it fires.

/** Days before an interview at which the student is prompted, widest first. */
export const PREP_INTERVALS = [7, 3, 1] as const;

export type PrepInterval = (typeof PREP_INTERVALS)[number];

/** Before this local hour an interview is "in the morning", and its refresher
 *  comes the evening before instead of on the day. */
export const MORNING_ENDS_HOUR = 12;
/** The evening-before refresher, local time. */
export const NIGHT_BEFORE_HOUR = 18;
/** The morning-of refresher, local time. */
export const MORNING_OF_HOUR = 8;

const DAY = 86_400_000;

/**
 * When the last-minute refresher prompt starts, on the student's own clock:
 * 8am on the day of an afternoon or evening interview, 6pm the evening before
 * one that starts before noon - a 9am superday is prepared for the night
 * before, not at 8am on the train.
 */
export function refresherAt(startsAt: Date, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const p = localParts(startsAt, timeZone);
  return p.hour < MORNING_ENDS_HOUR
    ? zonedTime(p.year, p.month, p.day - 1, NIGHT_BEFORE_HOUR, 0, timeZone)
    : zonedTime(p.year, p.month, p.day, MORNING_OF_HOUR, 0, timeZone);
}

/** The widest interval is also the window: outside it there is no prompt. */
const WINDOW_DAYS = PREP_INTERVALS[0];

// What counts as an interview lives in its own module, so code that cannot
// import this server-only one (the thank-you rules, tests) can ask too.
export { looksLikeInterview };

/**
 * The interval a countdown of `days` is inside, or null when it is too far out.
 *
 * The tightest threshold the day has reached, so a student who opens the app on
 * day 5 gets the 7-day prompt rather than nothing. Same rule as the outreach
 * prompts - see application-outreach.ts.
 */
export function prepIntervalFor(days: number): PrepInterval | null {
  if (days < 0 || days > WINDOW_DAYS) return null;
  let current: PrepInterval | null = null;
  for (const threshold of PREP_INTERVALS) {
    if (days <= threshold) current = threshold;
  }
  return current;
}

export type InterviewPrepNudge = {
  eventId: string;
  /** The calendar entry's own title, as the student wrote or received it. */
  title: string;
  /** The firm the title named, when it named one of theirs. Only for the
   *  wording of the prompt ("Practise for Evercore") - it no longer picks a
   *  question bank. */
  firmName: string | null;
  startsAt: Date;
  daysUntil: number;
  /** Which countdown mark this is. For a refresher, the tightest one. */
  interval: PrepInterval;
  /** "prep" at 7/3/1 days out, "refresh" in the last hours. */
  phase: "prep" | "refresh";
  /** "today", "tomorrow", "in 3 days" - by the student's calendar, not by
   *  24-hour blocks, so a 9am interview seen at 8pm the night before is
   *  "tomorrow" and one at 2pm seen at 9am is "today". */
  dayLabel: string;
};

// Lives in lib/time-zone now, where the to-do list counts days with it too.
export { calendarDaysBetween };

function dayLabelFor(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** One practice round, of any sector or mode: when it was played. */
export type PracticeRound = { at: Date };

type PrepEvent = {
  id: string;
  title: string;
  notes: string | null;
  type: string;
  /** "student" when the student chose the type themselves - see events. */
  typeSource?: string | null;
  eventDate: Date;
  completed: boolean;
};

/** Firms this student tracks, by normalised name and alias. */
export type TrackedFirms = ReadonlyMap<string, { name: string }>;

/**
 * Which interviews to prompt about, given everything already loaded.
 *
 * Pure, and separated from the queries below so the rules can be tested without
 * a database - including the one that decides whether somebody is interrupted
 * about a meeting that was never an interview.
 */
/**
 * Whether an entry is an interview to prepare for. Typed by hand beats guessed
 * from the title, both ways: filed as an interview, it is one whatever it is
 * called; filed as a coffee chat, an info session, a deadline or something
 * personal - or re-filed by the student as anything else - it is not. Only the
 * catch-all "meeting" (and an untyped entry) is read from its words, and a
 * title that says it is a coffee chat is one, whatever it mentions.
 */
export function isPrepInterview(row: Pick<PrepEvent, "type" | "typeSource" | "title" | "notes">): boolean {
  if (row.type === "interview") return true;
  if (row.type && NOT_INTERVIEW_TYPES.has(row.type)) return false;
  if (row.typeSource === "student") return false;
  if (CONVERSATION_OVER_INTERVIEW.test(row.title)) return false;
  return looksLikeInterview(row.title, row.notes);
}

/** Types a student chose that say "this is not an interview". */
const NOT_INTERVIEW_TYPES = new Set(["coffee_chat", "info_session", "deadline", "personal"]);

export function selectInterviewPrep({
  events: rows,
  trackedFirms = new Map(),
  practice = [],
  timeZone = DEFAULT_TIME_ZONE,
  now = new Date(),
}: {
  events: PrepEvent[];
  trackedFirms?: TrackedFirms;
  /** Their recent practice rounds, which is what quiets a prompt. */
  practice?: PracticeRound[];
  /** Their own clock, for "is this interview in the morning". */
  timeZone?: string;
  now?: Date;
}): InterviewPrepNudge[] {
  // Any round counts, whatever sector or mode. The prompt no longer guesses
  // which desk an interview is for - a calendar title is too thin to read that
  // from, and a wrong guess had students drilling the wrong questions - so the
  // student picks the sector on the practice page, and playing is the job.
  const practisedSince = (since: Date) => practice.some((r) => r.at.getTime() >= since.getTime());

  const out: InterviewPrepNudge[] = [];

  for (const row of rows) {
    // Something already ticked off is not still ahead of them.
    if (row.completed) continue;
    if (!isPrepInterview(row)) continue;

    const startsAt = row.eventDate;
    if (startsAt.getTime() < now.getTime()) continue;
    const days = Math.ceil((startsAt.getTime() - now.getTime()) / DAY);
    const interval = prepIntervalFor(days);
    if (interval === null) continue;

    const firm = firmInTitle(row.title, trackedFirms);

    // Last hours: the refresher, quiet only if they have practised since it
    // started. Before that: the countdown, quiet once they have practised at
    // all inside the week.
    const refreshFrom = refresherAt(startsAt, timeZone);
    const phase = now.getTime() >= refreshFrom.getTime() ? "refresh" : "prep";
    const since = phase === "refresh" ? refreshFrom : new Date(startsAt.getTime() - WINDOW_DAYS * DAY);
    if (practisedSince(since)) continue;

    out.push({
      eventId: row.id,
      title: row.title,
      firmName: firm?.name ?? null,
      startsAt,
      daysUntil: days,
      interval,
      phase,
      dayLabel: dayLabelFor(calendarDaysBetween(now, startsAt, timeZone)),
    });
  }

  return out.sort(
    // Soonest first by the clock, not by whole days: two interviews in the
    // same 24 hours are both "1 day" away, and the one at 11am comes first.
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.title.localeCompare(b.title),
  );
}

/**
 * The firm a calendar title names, if it names one this student tracks.
 *
 * Matched against their own firm list rather than the whole directory: a
 * student's own firms are both the likely answer and a short list.
 *
 * Every run of words in the title is normalised and looked up, rather than the
 * title as a whole, because the normaliser's abbreviations only fire on a whole
 * string: "BAML superday - NYC" normalises to "baml superday nyc", which is not
 * "bank of america" and never will be, while its first word alone is. Longest
 * run wins, so "Bank of America Merrill Lynch" is not resolved as "Bank of
 * America" when the student tracks both.
 */
function firmInTitle(title: string, trackedFirms: TrackedFirms): { name: string } | null {
  const words = normalizeFirmName(title).split(" ").filter(Boolean);
  if (words.length === 0) return null;

  let best: { words: number; firm: { name: string } } | null = null;
  // Five words is longer than any firm name in the directory, and the loop is
  // over a calendar title, not a document.
  const maxRun = Math.min(5, words.length);
  for (let size = maxRun; size >= 1; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      // A short name (MS, GS, DB) only in capitals, as a firm is written.
      if (size === 1 && words[start].length <= 3 && !new RegExp(`\\b${words[start].toUpperCase()}\\b(?!\\s*\\d)`).test(title)) continue;
      const key = normalizeFirmName(words.slice(start, start + size).join(" "));
      const firm = key ? trackedFirms.get(key) : undefined;
      if (firm && (!best || size > best.words)) best = { words: size, firm };
    }
    if (best) break;
  }
  return best?.firm ?? null;
}

type PrepUser = { id: string };

/**
 * Where a prompt sends them: the practice page itself, with no sector chosen.
 *
 * It used to open the question bank for the firm's sector, read out of the
 * calendar title, or the student's own sector, or banking. A guess the student
 * never sees is a guess they cannot correct, and the cost of a wrong one is an
 * evening spent practising the wrong desk. The student knows which interview
 * it is; they pick.
 */
export const PREP_HREF = "/learn";

export function prepHref(): string {
  return PREP_HREF;
}

/**
 * The interviews this student should be preparing for.
 *
 * Also writes the type back onto anything the detector recognised, so the
 * Schedule stops calling a superday a meeting. That is the only write, it is
 * idempotent, and it never overwrites a type the student chose themselves.
 */
export async function getInterviewPrepNudges(
  user: PrepUser,
  now: Date = new Date(),
): Promise<InterviewPrepNudge[]> {
  const db = await getDb();

  const to = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
  const rows = await db.query.events.findMany({
    where: and(
      eq(events.userId, user.id),
      eq(events.completed, false),
      gte(events.eventDate, now),
      lte(events.eventDate, to),
    ),
    columns: { id: true, title: true, notes: true, type: true, typeSource: true, eventDate: true, completed: true },
    orderBy: [asc(events.eventDate)],
  });
  if (rows.length === 0) return [];

  const [firmsByName, rounds, timeZone] = await Promise.all([
    trackedFirms(user.id),
    // Only rounds inside the window can quiet a prompt, so only those are read.
    db.query.practiceSessions.findMany({
      where: and(
        eq(practiceSessions.userId, user.id),
        gte(practiceSessions.createdAt, new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY)),
      ),
      columns: { createdAt: true },
    }),
    getStudentTimeZone(),
  ]);

  const selected = selectInterviewPrep({
    events: rows,
    trackedFirms: firmsByName,
    practice: rounds.map((r) => ({ at: r.createdAt })),
    timeZone,
    now,
  });
  // A prep row the student ticked off on the to-do list is their call: its
  // banner stops too, for that phase (the refresher still comes).
  const ticked = new Set(
    (
      await db.query.todoDismissals.findMany({
        where: eq(todoDismissals.userId, user.id),
        columns: { taskId: true },
      })
    ).map((d) => d.taskId),
  );
  const nudges = selected.filter((n) => !ticked.has(`interview-${n.eventId}-${n.phase}`));

  // Auto-tagging, as agreed: an entry the detector recognised is filed as an
  // interview from now on. Only for rows still carrying another type, so a
  // student who re-filed one as a meeting is not overruled on every page load.
  // Recorded as the detector's doing, when, and from which words - so a wrong
  // guess can be traced, and so the student's own re-filing is never undone.
  // Every entry recognised as one, prompted or not: a superday the student
  // has already practised for is still an interview on their Schedule.
  const untagged = rows.filter((r) => r.type !== "interview" && r.typeSource !== "student" && isPrepInterview(r));
  if (untagged.length > 0) {
    await Promise.all(
      untagged.map((r) =>
        db
          .update(events)
          .set({
            type: "interview",
            typeSource: "detected",
            typeDetectedAt: now,
            typeDetectedFrom: interviewEvidence(r.title, r.notes),
          })
          .where(
            and(
              eq(events.id, r.id),
              eq(events.userId, user.id),
              ne(events.type, "interview"),
              or(isNull(events.typeSource), ne(events.typeSource, "student")),
            ),
          ),
      ),
    );
  }

  return nudges;
}

/** The student's tracked firms, keyed for title matching by name and alias. */
async function trackedFirms(userId: string): Promise<TrackedFirms> {
  const db = await getDb();
  const rows = await db
    .select({ name: firms.name, aliases: firms.aliases })
    .from(userTopFirms)
    .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
    .where(eq(userTopFirms.userId, userId));

  const out = new Map<string, { name: string }>();
  for (const row of rows) {
    const firm = { name: row.name };
    // Its name and every alias it goes by: "Superday - CVP" is Centerview.
    for (const label of [row.name, ...(row.aliases ?? [])]) {
      const key = normalizeFirmName(label);
      if (key && !out.has(key)) out.set(key, firm);
    }
  }
  return out;
}
