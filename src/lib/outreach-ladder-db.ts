import "server-only";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contacts, outreachSends } from "@/db/schema";
import { localDateString } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import {
  FOLLOW_UP_EXPIRES_DAYS,
  MAX_EMAILS,
  daysOverdue,
  ladderState,
  type LadderState,
} from "@/lib/outreach-ladder";

// The queries behind the ladder. The rules are in outreach-ladder.ts.

/**
 * The day `instant` falls on for this student - what a date column like
 * lastContactDate means. Not the UTC day: at 9pm in New York that is already
 * tomorrow, so an email sent that evening was dated the next day.
 */
async function studentDay(instant: Date): Promise<string> {
  return localDateString(instant, await getStudentTimeZone());
}

/** Relationship states where the person has written back, or been given up
 *  on - neither is owed a follow-up. */
const NOT_ON_LADDER = ["in_conversation", "ongoing", "cold"] as const;

/** Every contact's ladder for one student, keyed by contact id. */
export async function getLadders(
  userId: string,
  now: Date = new Date(),
): Promise<Map<string, LadderState>> {
  const db = await getDb();
  const timeZone = await getStudentTimeZone();
  const [people, sends] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: { id: true, relationshipStatus: true, lastContactDate: true, updatedAt: true },
    }),
    db.query.outreachSends.findMany({
      where: eq(outreachSends.userId, userId),
      columns: { contactId: true, step: true, sentAt: true, source: true },
    }),
  ]);

  const byContact = new Map<string, typeof sends>();
  for (const s of sends) byContact.set(s.contactId, [...(byContact.get(s.contactId) ?? []), s]);

  return new Map(
    people.map((p) => [p.id, ladderState(p, byContact.get(p.id) ?? [], now, timeZone)]),
  );
}

export type DueFollowUp = {
  contactId: string;
  name: string;
  firm: string | null;
  /** The rung the next email is: 2 or 3. */
  step: number;
  /** When the last email went, which is what "no reply since" means. */
  lastSentAt: Date;
  dueAt: Date;
  daysOverdue: number;
};

/**
 * Everyone owed a follow-up right now, longest-waiting first.
 *
 * Only people who have been written to, have not replied, and whose last email
 * is a week old. Everything that prompts about the ladder starts here.
 */
export async function getDueLadderFollowUps(
  userId: string,
  now: Date = new Date(),
): Promise<DueFollowUp[]> {
  const db = await getDb();
  const timeZone = await getStudentTimeZone();
  // Everyone who has not replied or been given up on. Not only "reached_out":
  // a contact edited back to "not contacted" who still has emails on record is
  // on the ladder by those emails (see ladderState), and every view has to
  // agree on that.
  const people = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), notInArray(contacts.relationshipStatus, [...NOT_ON_LADDER])),
    columns: {
      id: true,
      name: true,
      firm: true,
      relationshipStatus: true,
      lastContactDate: true,
      updatedAt: true,
    },
  });
  if (people.length === 0) return [];

  const sends = await db.query.outreachSends.findMany({
    where: and(
      eq(outreachSends.userId, userId),
      inArray(
        outreachSends.contactId,
        people.map((p) => p.id),
      ),
    ),
    columns: { contactId: true, step: true, sentAt: true, source: true },
  });

  const due: DueFollowUp[] = [];
  for (const p of people) {
    const state = ladderState(p, sends.filter((s) => s.contactId === p.id), now, timeZone);
    if (state.stage !== "due" || !state.nextStep || !state.dueAt) continue;
    // A month past due, it has lapsed - see FOLLOW_UP_EXPIRES_DAYS.
    if (now.getTime() - state.dueAt.getTime() >= FOLLOW_UP_EXPIRES_DAYS * 86_400_000) continue;
    due.push({
      contactId: p.id,
      name: p.name,
      firm: p.firm,
      step: state.nextStep,
      lastSentAt: state.sends[state.sends.length - 1].sentAt,
      dueAt: state.dueAt,
      daysOverdue: daysOverdue(state.dueAt, now),
    });
  }
  return due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.name.localeCompare(b.name));
}

export type RecordedSend = { sendId: string; step: number; contactName: string };

/**
 * Record one cold email to one contact, on the next rung of their ladder.
 *
 * Idempotent per draft: copying the same draft twice is one email, so a second
 * copy returns the row the first one wrote rather than climbing a rung. Returns
 * null when there is no rung left (three sent, or they replied) or the contact
 * is not theirs.
 *
 * Also moves the contact to "reached out" if they were untouched - the same
 * thing the networking table's old checkbox did, and what the outreach prompt
 * reads to decide who is left to write to at a firm.
 */
export async function recordOutreachSend(input: {
  userId: string;
  contactId: string;
  draftId?: string | null;
  source: "copy" | "manual";
  now?: Date;
}): Promise<RecordedSend | null> {
  const db = await getDb();
  const now = input.now ?? new Date();

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, input.contactId), eq(contacts.userId, input.userId)),
    columns: { id: true, name: true, relationshipStatus: true, lastContactDate: true, updatedAt: true },
  });
  if (!contact) return null;

  const existing = await db.query.outreachSends.findMany({
    where: eq(outreachSends.contactId, contact.id),
    columns: { id: true, step: true, sentAt: true, source: true, draftId: true },
  });

  if (input.draftId) {
    const same = existing.find((s) => s.draftId === input.draftId);
    if (same) return { sendId: same.id, step: same.step, contactName: contact.name };
  }

  const state = ladderState(contact, existing, now, await getStudentTimeZone());
  // No rung for someone who replied (the conversation is past cold email) or
  // who has had all three.
  const step = state.nextStep;
  if (!step || step > MAX_EMAILS) return null;

  // A contact ticked "reached out" before the ladder existed carries an
  // implied first email. Writing it down now, before rung 2, keeps it on the
  // table once there is a real row beside it.
  const legacy = state.sends.find((s) => s.source === "legacy");
  if (legacy) {
    await db
      .insert(outreachSends)
      .values({
        userId: input.userId,
        contactId: contact.id,
        step: legacy.step,
        sentAt: legacy.sentAt,
        source: "manual",
      })
      .onConflictDoNothing();
  }

  const [row] = await db
    .insert(outreachSends)
    .values({
      userId: input.userId,
      contactId: contact.id,
      step,
      sentAt: now,
      draftId: input.draftId ?? null,
      source: input.source,
    })
    .onConflictDoNothing()
    .returning();

  // Lost a race with a double-click: the other request wrote this rung.
  const sendId =
    row?.id ??
    (
      await db.query.outreachSends.findFirst({
        where: and(eq(outreachSends.contactId, contact.id), eq(outreachSends.step, step)),
        columns: { id: true },
      })
    )?.id;
  if (!sendId) return null;

  await db
    .update(contacts)
    .set({
      relationshipStatus:
        contact.relationshipStatus === "not_contacted" ? "reached_out" : contact.relationshipStatus,
      lastContactDate: await studentDay(now),
      updatedAt: now,
    })
    .where(and(eq(contacts.id, contact.id), eq(contacts.userId, input.userId)));

  return { sendId, step, contactName: contact.name };
}

/**
 * Take back the most recent email on a contact's ladder - the undo after a
 * copy that was not really a send, or a "Mark sent" clicked by mistake.
 *
 * Only the top rung: removing email 1 from under email 2 would leave a ladder
 * that says a follow-up went to someone never written to. A contact left with
 * no emails goes back to "not contacted".
 */
export async function undoOutreachSend(userId: string, sendId: string): Promise<boolean> {
  const db = await getDb();
  const send = await db.query.outreachSends.findFirst({
    where: and(eq(outreachSends.id, sendId), eq(outreachSends.userId, userId)),
    columns: { id: true, contactId: true, step: true },
  });
  if (!send) return false;

  const top = await db.query.outreachSends.findFirst({
    where: eq(outreachSends.contactId, send.contactId),
    orderBy: [desc(outreachSends.step)],
    columns: { id: true },
  });
  if (top?.id !== send.id) return false;

  await db.delete(outreachSends).where(eq(outreachSends.id, send.id));

  const left = await db.query.outreachSends.findMany({
    where: eq(outreachSends.contactId, send.contactId),
    orderBy: [desc(outreachSends.sentAt)],
    columns: { sentAt: true },
  });
  await db
    .update(contacts)
    .set(
      left.length === 0
        ? { relationshipStatus: "not_contacted", lastContactDate: null, updatedAt: new Date() }
        : { lastContactDate: await studentDay(left[0].sentAt), updatedAt: new Date() },
    )
    .where(
      and(
        eq(contacts.id, send.contactId),
        eq(contacts.userId, userId),
        // Never downgrade someone who has replied: the reply is the student's
        // own answer and outlives an email being taken back.
        inArray(contacts.relationshipStatus, ["not_contacted", "reached_out", "cold"]),
      ),
    );
  return true;
}

/**
 * Say whether this person replied. A reply ends the ladder; taking it back
 * puts them where their emails leave them.
 */
export async function setContactReplied(userId: string, contactId: string, replied: boolean) {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, lastContactDate: true },
  });
  if (!contact) return;

  let status: "in_conversation" | "reached_out" | "not_contacted" = "in_conversation";
  if (!replied) {
    // Back to "written to" if there is any sign they were: an email on record,
    // or a contact date from before the ladder recorded emails. Someone who
    // was marked as having replied was, by definition, written to - only a
    // contact with no trace of either goes back to "not contacted".
    const any = await db.query.outreachSends.findFirst({
      where: eq(outreachSends.contactId, contactId),
      columns: { id: true },
    });
    status = any || contact.lastContactDate ? "reached_out" : "not_contacted";
  }

  await db
    .update(contacts)
    .set({
      relationshipStatus: status,
      // The contact date is left alone: it is when the student last wrote,
      // which is what the ladder dates its emails from and what tells a
      // taken-back reply that this person was written to. Stamping the reply
      // day over it made every taken-back reply look like an email.
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
}

/**
 * How much of each watched follow-up is left, for the bell's auto-close: 0
 * once the rung has been sent, the person replied, or the contact is gone.
 */
export async function ladderProgressBySubject(
  userId: string,
  subjects: { key: string; contactId: string; step: number }[],
): Promise<Map<string, { remaining: number; total: number }>> {
  if (subjects.length === 0) return new Map();
  const db = await getDb();
  const ids = [...new Set(subjects.map((s) => s.contactId))];
  const [people, sends] = await Promise.all([
    db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
      columns: { id: true, relationshipStatus: true },
    }),
    db.query.outreachSends.findMany({
      where: and(eq(outreachSends.userId, userId), inArray(outreachSends.contactId, ids)),
      columns: { contactId: true, step: true },
    }),
  ]);
  const status = new Map(people.map((p) => [p.id, p.relationshipStatus]));

  const out = new Map<string, { remaining: number; total: number }>();
  for (const s of subjects) {
    const st = status.get(s.contactId);
    const own = sends.filter((x) => x.contactId === s.contactId);
    const sent = own.some((x) => x.step >= s.step);
    const over = !st || (NOT_ON_LADDER as readonly string[]).includes(st);
    // Nothing left to follow up on: the email before this rung was taken back,
    // and the contact is back to never written to. Without this the job stays
    // under the bell for good - follow-ups never expire.
    const orphaned = st === "not_contacted" && !own.some((x) => x.step === s.step - 1);
    out.set(s.key, { remaining: sent || over || orphaned ? 0 : 1, total: 1 });
  }
  return out;
}
