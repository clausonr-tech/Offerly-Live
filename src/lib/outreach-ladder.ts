// The cold-email ladder: a first email, then a follow-up a week later if
// nobody replied, then one more a week after that - three emails to one
// person, and then stop.
//
// It stops early the moment the student says the person replied. That is the
// only reason to stop early: a follow-up is not pestering until it is the
// fourth email, and most replies to cold outreach arrive after the second.
//
// Everything a student sees about one contact's outreach - the status line in
// the networking table, the bubble, the to-do row, the job under the bell - is
// cut from ladderState() below, so they cannot disagree about whether a
// follow-up is due.
//
// Pure: the rules that decide whether a student is prompted are testable
// without a database. The queries live in outreach-ladder-db.ts.

import { DEFAULT_TIME_ZONE, parseLocalDay } from "@/lib/time-zone";

/** Days of silence after an email before the next one is due. */
export const FOLLOW_UP_AFTER_DAYS = 7;

/** The first email and two follow-ups. A fourth is pestering. */
export const MAX_EMAILS = 3;

/**
 * How long a follow-up is prompted for once it falls due. After a month with
 * no second email, the moment for it has passed: the banner, the to-do row and
 * the bell job all stop, rather than coming back every other day for ever.
 */
export const FOLLOW_UP_EXPIRES_DAYS = 30;

/**
 * How often a prompt repeats while its work is outstanding - both the ladder's
 * follow-ups and the outreach-before-an-opening bubble. Every other day: often
 * enough that a week does not slip by, rarely enough that it is not every page.
 */
export const REPEAT_EVERY_DAYS = 2;

const DAY = 86_400_000;

type LadderSend = {
  step: number;
  sentAt: Date;
  /** "legacy" is a contact ticked "Reached out" before the ladder existed. */
  source: "copy" | "manual" | "legacy";
};

type LadderStage =
  /** Never written to. */
  | "not_contacted"
  /** Written to, next email not due yet. */
  | "waiting"
  /** Written to, a week has passed, no reply: time for the next email. */
  | "due"
  /** They wrote back. Nothing more is prompted. */
  | "replied"
  /** Three emails, no reply. The ladder is over. */
  | "finished";

export type LadderState = {
  stage: LadderStage;
  /** Oldest first, one per rung. Empty only when not contacted. */
  sends: LadderSend[];
  /** The rung the next email would be, while there is one to send. */
  nextStep: number | null;
  /** When the next email becomes due. Set for "waiting" and "due". */
  dueAt: Date | null;
};

/** What the ladder needs to know about a contact. */
export type LadderContact = {
  relationshipStatus: string;
  /** "YYYY-MM-DD" or a Date - the date column comes back as a string. */
  lastContactDate: string | Date | null;
  /** When the row last changed, for a legacy "reached out" with no date. */
  updatedAt?: Date | null;
};

/** Relationship states that mean the person has written back. */
const REPLIED = new Set(["in_conversation", "ongoing"]);

/**
 * Where one contact stands.
 *
 * A contact marked "reached out" before this table existed has no rows in it.
 * They are read as having had email 1 on their last-contact date, so a student
 * who ticked twenty rows last month is prompted to follow up on them rather
 * than being told they never wrote to anyone.
 */
export function ladderState(
  contact: LadderContact,
  recorded: { step: number; sentAt: Date; source: string }[],
  now: Date = new Date(),
  /** The student's clock, for a "reached out" date typed without a time. */
  timeZone: string = DEFAULT_TIME_ZONE,
): LadderState {
  let sends: LadderSend[] = recorded
    .filter((s) => s.step >= 1 && s.step <= MAX_EMAILS)
    .map((s): LadderSend => ({
      step: s.step,
      sentAt: s.sentAt,
      source: s.source === "manual" ? "manual" : "copy",
    }))
    .sort((a, b) => a.step - b.step);

  if (sends.length === 0 && contact.relationshipStatus !== "not_contacted") {
    const when = parseLocalDay(contact.lastContactDate, timeZone) ?? contact.updatedAt ?? null;
    if (when) sends = [{ step: 1, sentAt: when, source: "legacy" }];
  }

  if (REPLIED.has(contact.relationshipStatus)) {
    return { stage: "replied", sends, nextStep: null, dueAt: null };
  }
  if (sends.length === 0) {
    return { stage: "not_contacted", sends, nextStep: 1, dueAt: null };
  }

  const last = sends[sends.length - 1];
  // "cold" is the student saying they have given up on this person, which
  // ends the ladder as surely as a third email does.
  if (last.step >= MAX_EMAILS || contact.relationshipStatus === "cold") {
    return { stage: "finished", sends, nextStep: null, dueAt: null };
  }

  const dueAt = new Date(last.sentAt.getTime() + FOLLOW_UP_AFTER_DAYS * DAY);
  return {
    stage: now.getTime() >= dueAt.getTime() ? "due" : "waiting",
    sends,
    nextStep: last.step + 1,
    dueAt,
  };
}

/** "1st", "2nd", "3rd" - which cold email this is, as the table says it. */
export function ordinal(step: number): string {
  return step === 1 ? "1st" : step === 2 ? "2nd" : step === 3 ? "3rd" : `${step}th`;
}

/**
 * Which two-day stretch `days` falls in, counting from the moment the work
 * became live. A prompt is keyed by this, so it fires once per stretch: on the
 * day it becomes due, again two days later, and so on while it is outstanding.
 */
export function repeatRound(days: number): number {
  return Math.floor(Math.max(0, days) / REPEAT_EVERY_DAYS);
}

/** Whole days since a follow-up became due, never negative. */
export function daysOverdue(dueAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / DAY));
}

/**
 * Where "write the next email" goes: the drafter, already addressed to this
 * person, with "Follow up" chosen and the right rung ticked.
 */
export function followUpHref(contactId: string, step: number): string {
  const box = step >= MAX_EMAILS ? "follow.final" : "follow.first";
  return `/outreach?contact=${contactId}&occasion=follow_up&box=${box}`;
}

/** The job under the bell for one rung of one person's ladder. */
export function followUpNotificationKey(contactId: string, step: number): string {
  return `follow_up:${contactId}:${step}`;
}

/** What the bell's completion check watches: this person, this rung. */
export function followUpSubjectKey(contactId: string, step: number): string {
  return `ladder:${contactId}:${step}`;
}

/** The reverse of followUpSubjectKey, or null for any other subject. */
export function parseFollowUpSubject(key: string): { contactId: string; step: number } | null {
  const m = /^ladder:([0-9a-f-]{36}):(\d)$/.exec(key);
  return m ? { contactId: m[1], step: Number(m[2]) } : null;
}
