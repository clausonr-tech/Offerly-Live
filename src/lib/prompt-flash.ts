import "server-only";
import { eq } from "drizzle-orm";
import { format } from "date-fns";
import { getDb } from "@/db/client";
import { flashesShown } from "@/db/schema";
import {
  applyNotificationKey,
  dayFlashKey,
  dayKey,
  flashDueToday,
  flashPrefix,
  getOpeningToday,
  getOutreachNudges,
} from "@/lib/application-outreach";
import {
  getInterviewPrepNudges,
  prepHref,
  type InterviewPrepNudge,
} from "@/lib/interview-prep";
import { outreachNotificationKey, type NotificationRow } from "@/lib/notifications";
import {
  followUpHref,
  followUpNotificationKey,
  FOLLOW_UP_EXPIRES_DAYS,
  followUpSubjectKey,
  ordinal,
  repeatRound,
} from "@/lib/outreach-ladder";
import { getDueLadderFollowUps, type DueFollowUp } from "@/lib/outreach-ladder-db";
import {
  THANK_YOU_LOOKBACK_DAYS,
  daysOwed,
  thankYouFlashKey,
  thankYouProgress,
  thankYouSubjectKey,
  thankYouTitle,
  type ThankYouPrompt,
} from "@/lib/thank-you";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { DEFAULT_TIME_ZONE, localDateString, localParts, parseTimeZone, zonedTime } from "@/lib/time-zone";
import { getThankYouPrompts } from "@/lib/thank-you-db";
import { dueLabel, reminderDetail, reminderNotificationKey } from "@/lib/application-reminders";
import { getApplicationReminders } from "@/lib/application-reminders-db";
import {
  generatedDetail,
  generatedFlashKey,
  generatedNotificationKey,
  generatedTitle,
  getUnreachedGenerated,
  peopleLine,
} from "@/lib/generated-reminders";
import type { LabelTone } from "@/lib/label-colors";

// The one bubble that drops across the top of the page, whichever prompt it is.
//
// Three kinds feed it - write to people before an application opens, follow up
// on a cold email that has gone a week unanswered, and practise before an
// interview - and they are deliberately not three bars. A student gets ONE
// interruption at a time, the most urgent one, and the others wait their turn
// behind it.
//
// Everything here is built from the same three parts: a key that identifies
// this firing (so it happens once), what the bubble says, and the notification
// it files under the bell, which is the durable half of the same event.

/** The key a prep prompt is recorded against: this interview, at this mark. */
export function interviewFlashKey(eventId: string, interval: number | "refresh", startsAt?: Date): string {
  // The date is part of it: an interview moved to another day is a new
  // countdown, and its 7-day mark must speak again for the new date.
  if (startsAt) return `interview:${eventId}:${startsAt.toISOString().slice(0, 16)}:${interval}`;
  return `interview:${eventId}:${interval}`;
}

/** The job a prep prompt belongs to. One per interview, whatever the mark -
 *  the 3-day prompt is the same job as the 7-day one, and bumps its row. */
export function interviewNotificationKey(eventId: string): string {
  return `interview:${eventId}`;
}

export type PendingFlash = {
  /** Identifies this firing. Recorded when the bubble mounts. */
  flashKey: string;
  /** The small uppercase chip: how long there is. */
  chip: string;
  /** Bold half of the sentence - a firm, or what the calendar called it. */
  subject: string;
  /** The rest of the sentence, after the em dash. Kept short: with the
   *  subject it has to read in full in two lines beside the chip at 1280px,
   *  and nothing in the bubble truncates it. */
  detail: string;
  href: string;
  /** What the button says. Different work, different verb. */
  cta: string;
  /** A second button that finishes the job from the bubble - "That's
   *  everyone" once some interviewers are thanked, "I applied" on a deadline
   *  reminder. The key it closes, and which kind of job it is. */
  doneKey?: string;
  doneLabel?: string;
  doneAction?: "thank_you" | "applied";
  /** Its colour, where its notification's kind would name the wrong one:
   *  the opening-day "Apply" is filed as outreach but is an application. */
  tone?: LabelTone;
  /** How urgent, in days. Only used to pick which one speaks first. */
  daysUntil: number;
  /** The moment it is about, to break a tie in days - two interviews the
   *  same day speak in the order they happen. */
  at?: Date;
  /**
   * Filed under the bell when this is shown - one job each. Usually one; the
   * follow-up bubble speaks for everyone due at once, and each of them is
   * still their own job to finish.
   */
  notifications: FlashNotification[];
};

type FlashNotification = {
  kind: NotificationRow["kind"];
  dedupeKey: string;
  subjectKey: string | null;
  title: string;
  body: string;
  href: string;
  expiresAt: Date | null;
};

type FlashUser = Parameters<typeof getOutreachNudges>[0] &
  Parameters<typeof getInterviewPrepNudges>[0];

function daysLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** Which two-day stretch of the student's calendar the follow-up bubble is in. */
function followUpRound(now: Date, timeZone: string): number {
  const p = localParts(now, timeZone);
  return repeatRound(Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000));
}

/**
 * An opening date as "6 Oct". Openings are calendar dates stored at midnight
 * UTC, so they are read in UTC - in the server's zone a New York machine would
 * print the day before.
 */
function openingDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", timeZone: "UTC" }).formatToParts(date);
  return `${parts.find((p) => p.type === "day")?.value} ${parts.find((p) => p.type === "month")?.value}`;
}

/** What the calendar called it, shortened enough to sit in a bubble. */
function shortTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

function interviewFlash(n: InterviewPrepNudge): PendingFlash {
  const where = n.firmName ? `Your ${n.firmName} interview` : shortTitle(n.title);
  const refresh = n.phase === "refresh";
  return {
    // The refresher is its own firing: it speaks once in the last hours even
    // when the 1-day prompt already has.
    flashKey: interviewFlashKey(n.eventId, refresh ? "refresh" : n.interval, n.startsAt),
    chip: `interview ${n.dayLabel}`,
    subject: where,
    detail: refresh
      ? "a quick refresher round"
      : "run a technicals round before it",
    href: prepHref(),
    cta: refresh ? "Refresh" : "Practise",
    // The refresher is the most urgent thing there is: hours, not days.
    daysUntil: refresh ? -1 : n.daysUntil,
    at: n.startsAt,
    notifications: [{
      kind: "interview_prep",
      // Same job for both phases. The refresher bumps it back to the top, and
      // reopens it if the earlier round had closed it.
      dedupeKey: interviewNotificationKey(n.eventId),
      // What the completion check watches: a practice round, any sector,
      // played since this row last fired. Keyed per interview so two
      // interviews close on their own rounds rather than on each other's.
      subjectKey: `quiz:${n.eventId}`,
      title: n.firmName
        ? `${refresh ? "Refresh" : "Prep"} for ${n.firmName}`
        : `${refresh ? "Refresh" : "Prep"} for ${shortTitle(n.title)}`,
      // A date, not a countdown: the row keeps saying what it said, and "in 3
      // days" would be wrong by tomorrow.
      body: refresh
        ? `Quick technicals round before your interview on ${format(n.startsAt, "d MMM")}`
        : `Technicals round before ${format(n.startsAt, "d MMM")}`,
      href: prepHref(),
      // Afterwards there is nothing left to prepare for.
      expiresAt: n.startsAt,
    }],
  };
}

/** One follow-up's job under the bell. */
function followUpNotification(f: DueFollowUp): FlashNotification {
  return {
    kind: "follow_up",
    dedupeKey: followUpNotificationKey(f.contactId, f.step),
    subjectKey: followUpSubjectKey(f.contactId, f.step),
    title: `Follow up with ${f.name}`,
    body: `${ordinal(f.step)} email${f.firm ? ` · ${f.firm}` : ""} · no reply since ${format(f.lastSentAt, "d MMM")}`,
    href: followUpHref(f.contactId, f.step),
    // Open until it is sent, they reply, or a month passes with neither.
    expiresAt: new Date(f.dueAt.getTime() + FOLLOW_UP_EXPIRES_DAYS * 86_400_000),
  };
}

/**
 * One chat, call or interview a couple of hours over, with nobody thanked yet.
 *
 * Once a day, every day, until it is sent or ticked off - beside the to-do row,
 * which stays the whole time. Every day's bubble files the same bell job.
 */
function thankYouFlash(t: ThankYouPrompt, now: Date, timeZone: string): PendingFlash {
  const interview = t.occasion === "interview";
  const late = daysOwed(t.dueAt, now, timeZone);
  const progress = thankYouProgress(t);
  return {
    // A new key each day it is owed, so the banner comes back every day until
    // the thank-you is sent or ticked off - and never twice in one day.
    flashKey: thankYouFlashKey(t.key, now, timeZone),
    chip: late === 0 ? "thank-you" : late === 1 ? "thank-you · yesterday" : `thank-you · ${late} days`,
    subject: interview ? shortTitle(t.title) : (t.contact?.name ?? shortTitle(t.title)),
    detail: progress
      ? `${progress} · anyone else to thank?`
      : late > 0
        ? interview
          ? "your interviewers are still owed a thank-you"
          : "still owed a thank-you, a short note still counts"
        : interview
          ? "thank your interviewers while it is fresh"
          : t.contact
            ? "send a thank-you while the chat is fresh"
            : "thank the person you spoke with",
    href: t.href,
    cta: progress ? "Write the next" : "Write it",
    // Once some are thanked, only the student knows whether that was everyone.
    ...(progress ? { doneKey: t.key, doneLabel: "That's everyone" } : {}),
    // Same day matters here: a thank-you is expected within a day.
    daysUntil: 0,
    at: t.dueAt,
    notifications: [thankYouNotification(t, timeZone)],
  };
}

/**
 * The bell's job for one thank-you. The bubble files it, and so does ticking
 * the to-do row when the bubble never dropped - one builder, so the two rows
 * are the same row.
 */
export function thankYouNotification(
  t: ThankYouPrompt,
  timeZone: string = DEFAULT_TIME_ZONE,
): PendingFlash["notifications"][number] {
  // The date on the student's clock, not the server's: a chat at 8.30pm in
  // New York is on the 21st, whatever the date is in UTC.
  // "21 Sep", as date-fns writes it everywhere else in the app (en-GB would
  // write "21 Sept").
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: parseTimeZone(timeZone),
  }).formatToParts(t.startsAt);
  const day = `${parts.find((p) => p.type === "day")?.value} ${parts.find((p) => p.type === "month")?.value}`;
  return {
    kind: "thank_you",
    dedupeKey: t.key,
    subjectKey: t.contact ? thankYouSubjectKey(t.contact.id) : null,
    title: thankYouTitle(t),
    body: [`After “${shortTitle(t.title)}”`, day, thankYouProgress(t)].filter(Boolean).join(" · "),
    href: t.href,
    // Stays until they send it or tick it off, or the two weeks a thank-you
    // is worth prompting for run out.
    expiresAt: new Date(t.dueAt.getTime() + THANK_YOU_LOOKBACK_DAYS * 86_400_000),
  };
}

/**
 * The follow-up bubble: everyone owed their next email, as ONE bubble.
 *
 * One per person would stack five bubbles on a student who sent five emails
 * last Monday, which is exactly the inbox-across-the-top-of-the-page this
 * component exists to avoid. It repeats every other day while anyone is still
 * due, and its key carries who is due, so somebody newly due speaks up the
 * same day rather than waiting out the stretch.
 */
function followUpFlash(due: DueFollowUp[], now: Date, timeZone: string): PendingFlash {
  const first = due[0];
  const who = due
    .map((f) => `${f.contactId.slice(0, 8)}.${f.step}`)
    .sort()
    .join(",");
  // Every other day by the student's calendar, so the rhythm is the same for
  // everyone on the list however their due dates fall - and it turns over at
  // their midnight, not the server's (8pm in New York).
  const round = followUpRound(now, timeZone);
  const single = due.length === 1;
  return {
    flashKey: `follow_up:r${round}:${who}`,
    chip: single ? `${ordinal(first.step)} email due` : "follow-ups due",
    subject: single ? first.name : `${due.length} people`,
    detail: single
      ? "no reply in a week, time to follow up"
      : "haven't replied in a week, time to follow up",
    href: single ? followUpHref(first.contactId, first.step) : "/contacts",
    cta: single ? "Write it" : "See who",
    // Overdue work is urgent work: a follow-up a week late sits level with an
    // interview a day out, and ahead of an opening a fortnight away.
    daysUntil: Math.max(0, 3 - first.daysOverdue),
    notifications: due.map(followUpNotification),
  };
}

/**
 * The next bubble to drop, or null for silence.
 *
 * Most urgent first across both kinds, skipping anything already shown. An
 * interview in three days outranks an application opening in twenty, and it
 * should: one of those is a room you are about to walk into.
 */
export async function getPendingFlash(
  user: FlashUser,
  now: Date = new Date(),
): Promise<PendingFlash | null> {
  const [outreach, interviews, followUps, thanks, timeZone, openingToday, reminders, unreached] = await Promise.all([
    getOutreachNudges(user, now),
    getInterviewPrepNudges(user, now),
    getDueLadderFollowUps(user.id, now),
    getThankYouPrompts(user.id, now),
    getStudentTimeZone(),
    getOpeningToday(user, now),
    getApplicationReminders(user, now),
    getUnreachedGenerated(user.id, now),
  ]);
  const zone = parseTimeZone(timeZone);
  const today = localDateString(now, zone);
  if (
    outreach.length === 0 &&
    interviews.length === 0 &&
    followUps.length === 0 &&
    thanks.length === 0 &&
    openingToday.length === 0 &&
    unreached.length === 0 &&
    !reminders.some((r) => r.flashKey)
  ) {
    return null;
  }

  const candidates: PendingFlash[] = [
    ...interviews.map(interviewFlash),
    ...thanks.map((t) => thankYouFlash(t, now, timeZone)),
    // An open application not applied to: at 14, 7, 3 and 1 days and on the
    // day; weekly when rolling. The to-do row stands in between.
    ...reminders
      .filter((r) => r.flashKey)
      .map((r) => ({
        flashKey: r.flashKey!,
        chip: dueLabel(r),
        subject: r.firmName,
        detail: reminderDetail(r),
        href: r.applyUrl ?? "/applications",
        cta: "Apply",
        doneKey: r.key,
        doneLabel: "I applied",
        doneAction: "applied" as const,
        daysUntil: r.daysLeft ?? 7,
        at: r.deadline ?? undefined,
        notifications: [
          {
            kind: "application_deadline" as const,
            dedupeKey: reminderNotificationKey(r.key),
            subjectKey: null,
            title: `Apply to ${r.firmName}`,
            body: [r.role, r.deadline ? `due ${openingDay(r.deadline)}` : "rolling"].join(" · "),
            href: r.applyUrl ?? "/applications",
            // The end of the deadline day on the student's clock; a rolling one
            // stays until they apply or it closes.
            expiresAt: r.deadline
              ? zonedTime(
                  r.deadline.getUTCFullYear(),
                  r.deadline.getUTCMonth() + 1,
                  r.deadline.getUTCDate() + 1,
                  0,
                  0,
                  zone,
                )
              : null,
          },
        ],
      })),
    // The day it opens: apply. Once, that day; the to-do row carries it.
    ...openingToday.map((o) => ({
      flashKey: applyNotificationKey(o.firmKey, o.opensOn),
      chip: "opens today",
      subject: o.firmName,
      detail: "applications are open, apply today",
      href: o.applyUrl,
      cta: "Apply",
      tone: "apply" as const,
      daysUntil: 0,
      at: o.opensOn,
      notifications: [
        {
          kind: "outreach" as const,
          dedupeKey: applyNotificationKey(o.firmKey, o.opensOn),
          subjectKey: null,
          title: `Apply to ${o.firmName}`,
          body: `${o.cycleLabel} · applications open today`,
          href: o.applyUrl,
          // Midnight at the end of the opening day, on the student's clock.
          expiresAt: zonedTime(
            o.opensOn.getUTCFullYear(),
            o.opensOn.getUTCMonth() + 1,
            o.opensOn.getUTCDate() + 1,
            0,
            0,
            zone,
          ),
        },
      ],
    })),
    ...(followUps.length > 0 ? [followUpFlash(followUps, now, zone)] : []),
    ...outreach.map((n) => ({
      // Keyed by the day it fires; whether it is due today is decided below,
      // from when this opening last fired.
      flashKey: dayFlashKey(n.firmKey, n.opensOn, today),
      chip: `opens ${daysLabel(n.daysUntilOpen)}`,
      subject: n.firmName,
      detail: `${n.contacts.length} contact${
        n.contacts.length === 1 ? "" : "s"
      } you haven't emailed`,
      href: `/contacts?q=${encodeURIComponent(n.contactFirmQuery)}`,
      cta: "See who",
      daysUntil: n.daysUntilOpen,
      at: n.opensOn,
      notifications: [{
        kind: "outreach" as const,
        dedupeKey: outreachNotificationKey(n.firmKey, dayKey(n.opensOn)),
        subjectKey: n.firmKey,
        title: `Email ${n.firmName}`,
        body: `${n.contacts.length} contact${
          n.contacts.length === 1 ? "" : "s"
        } still to email · opens ${openingDay(n.opensOn)}`,
        href: `/contacts?q=${encodeURIComponent(n.contactFirmQuery)}`,
        // Midnight on the opening day on the student's clock: it opened.
        expiresAt: zonedTime(
          n.opensOn.getUTCFullYear(),
          n.opensOn.getUTCMonth() + 1,
          n.opensOn.getUTCDate(),
          0,
          0,
          zone,
        ),
      }],
    })),
    // People found with contact search and never written to: at three days,
    // and once more at seven (lib/generated-reminders). Nothing is due on a
    // date, so it speaks after anything that is.
    ...unreached.map((f): PendingFlash => ({
      flashKey: generatedFlashKey(f),
      chip: `found ${f.days}d ago`,
      // The firm, with who is left there - the same job as the bell's.
      subject: f.firmName,
      detail: f.people.length === 1 ? `${f.people[0]}, not emailed yet` : `${peopleLine(f.people)} to email`,
      href: f.href,
      cta: "Write to them",
      daysUntil: 30,
      notifications: [
        {
          kind: "outreach",
          dedupeKey: generatedNotificationKey(f.firmKey),
          // The firm, so the bell counts who is left there and closes this
          // once everyone has been written to.
          subjectKey: f.firmKey,
          title: generatedTitle(f),
          body: generatedDetail(f),
          href: f.href,
          expiresAt: null,
        },
      ],
    })),
  ].sort(
    (a, b) =>
      a.daysUntil - b.daysUntil ||
      (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0) ||
      a.subject.localeCompare(b.subject),
  );

  const db = await getDb();
  const shown = await db.query.flashesShown.findMany({
    where: eq(flashesShown.userId, user.id),
    columns: { flashKey: true, shownAt: true },
  });
  const seen = new Set(shown.map((s) => s.flashKey));

  // When each opening's flash last fired, on the student's calendar - from the
  // day in its key, or (for keys from before that) the day it was shown.
  const lastShownDay = new Map<string, string>();
  for (const row of shown) {
    const m = /^(.+\|\d{4}-\d{2}-\d{2}\|)(?:d(\d{4}-\d{2}-\d{2})|r\d+)$/.exec(row.flashKey);
    if (!m) continue;
    const day = m[2] ?? localDateString(row.shownAt, zone);
    const prev = lastShownDay.get(m[1]);
    if (!prev || day > prev) lastShownDay.set(m[1], day);
  }
  const outreachPrefixes = new Set(outreach.map((n) => flashPrefix(n.firmKey, n.opensOn)));

  // Everyone the follow-up bubble has already named in this stretch. Sending
  // one person's follow-up changes the key (they drop off it), and without
  // this the bubble would come straight back to re-announce the rest.
  const followRound = `follow_up:r${followUpRound(now, zone)}:`;
  const named = new Set(
    shown
      .filter((row) => row.flashKey.startsWith(followRound))
      .flatMap((row) => row.flashKey.slice(followRound.length).split(",")),
  );

  return (
    candidates.find((c) => {
      if (seen.has(c.flashKey)) return false;
      if (c.flashKey.startsWith(followRound)) {
        const who = c.flashKey.slice(followRound.length).split(",");
        if (who.every((w) => named.has(w))) return false;
      }
      const prefix = /^(.+\|\d{4}-\d{2}-\d{2}\|)d\d{4}-\d{2}-\d{2}$/.exec(c.flashKey)?.[1];
      if (prefix && outreachPrefixes.has(prefix)) return flashDueToday(lastShownDay.get(prefix), today);
      return true;
    }) ?? null
  );
}

/**
 * Record that one flash has been shown.
 *
 * Written when it is SHOWN, not when it closes - the bubble closes itself, so
 * there is no other moment, and a flash that failed to record would repeat on
 * the next page load, which is the one thing it must never do. Idempotent: a
 * second render racing the first writes nothing.
 */
export async function markFlashShown(userId: string, flashKey: string) {
  const db = await getDb();
  await db.insert(flashesShown).values({ userId, flashKey }).onConflictDoNothing();
}
