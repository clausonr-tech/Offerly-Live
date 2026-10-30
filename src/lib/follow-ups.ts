import "server-only";
import { and, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, emailDrafts, events } from "@/db/schema";
import { parseLocalDay } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { FOLLOW_UP_EXPIRES_DAYS } from "@/lib/outreach-ladder";

// Networking fails from silence, not from bad emails. A student has one good
// coffee chat, means to circle back, and then forty other things happen. This
// finds the contacts that have gone quiet long enough to be worth a nudge.

// Days of silence before a contact is due, keyed by where the relationship
// stands. The gap widens as the relationship gets more established: someone who
// hasn't replied to a first email needs chasing in a week, someone you speak to
// every couple of months does not.
//
// "not_contacted" is deliberately absent. Following up requires having made
// contact - a contact you have never emailed is a different problem, and it
// surfaces through network coverage instead.
//
// "reached_out" is absent too: someone written to who has not replied is on the
// cold-email ladder (lib/outreach-ladder.ts), which prompts the follow-up at a
// week and stops after three emails. Counting them here as well would put the
// same person on the to-do list twice.
const CADENCE_DAYS: Partial<Record<(typeof contacts.$inferSelect)["relationshipStatus"], number>> = {
  in_conversation: 21,
  ongoing: 45,
  cold: 90,
};

const MS_PER_DAY = 86_400_000;

export type DueFollowUp = {
  contactId: string;
  name: string;
  firm: string | null;
  role: string | null;
  relationshipStatus: (typeof contacts.$inferSelect)["relationshipStatus"];
  lastTouch: Date;
  // Where the last touch came from, so the UI can be honest about whether this
  // is a real logged interaction or just when the contact was created.
  lastTouchSource: "meeting" | "logged_date" | "created";
  daysSince: number;
  dueAfterDays: number;
  overdueByDays: number;
};

export async function getDueFollowUps(userId: string, now: Date = new Date()): Promise<DueFollowUp[]> {
  const timeZone = await getStudentTimeZone();
  const db = await getDb();

  const candidates = await db.query.contacts.findMany({
    where: and(
      eq(contacts.userId, userId),
      inArray(contacts.relationshipStatus, Object.keys(CADENCE_DAYS) as ("reached_out" | "in_conversation" | "ongoing" | "cold")[]),
    ),
    columns: {
      id: true,
      name: true,
      firm: true,
      role: true,
      relationshipStatus: true,
      lastContactDate: true,
      createdAt: true,
    },
  });
  if (candidates.length === 0) return [];

  // A coffee chat or meeting with them, or an email sent to them, is a
  // stronger signal of last contact than the lastContactDate field, which
  // students forget to update. Take whichever is most recent rather than
  // trusting any one alone. A meeting counts once it has happened - ticked
  // off or not: a past chat leaves the to-do list, so there is nowhere to
  // tick it - and a sent email (a thank-you, a follow-up) is contact too.
  const [meetings, sent] = await Promise.all([
    db.query.events.findMany({
      where: and(
        eq(events.userId, userId),
        or(eq(events.completed, true), lte(events.eventDate, now)),
        isNotNull(events.contactId),
        inArray(events.type, ["coffee_chat", "meeting", "interview"]),
      ),
      columns: { contactId: true, eventDate: true },
    }),
    db.query.emailDrafts.findMany({
      where: and(eq(emailDrafts.userId, userId), isNotNull(emailDrafts.sentAt), isNotNull(emailDrafts.contactId)),
      columns: { contactId: true, sentAt: true },
    }),
  ]);

  const lastMeetingByContact = new Map<string, Date>();
  const touch = (contactId: string | null, at: Date | null) => {
    if (!contactId || !at || at.getTime() > now.getTime()) return;
    const current = lastMeetingByContact.get(contactId);
    if (!current || at > current) lastMeetingByContact.set(contactId, at);
  };
  for (const m of meetings) touch(m.contactId, m.eventDate);
  for (const d of sent) touch(d.contactId, d.sentAt);

  const due: DueFollowUp[] = [];

  for (const c of candidates) {
    const dueAfterDays = CADENCE_DAYS[c.relationshipStatus];
    if (dueAfterDays === undefined) continue;

    const logged = parseLocalDay(c.lastContactDate, timeZone);
    const meeting = lastMeetingByContact.get(c.id) ?? null;

    let lastTouch: Date;
    let lastTouchSource: DueFollowUp["lastTouchSource"];
    if (meeting && (!logged || meeting > logged)) {
      lastTouch = meeting;
      lastTouchSource = "meeting";
    } else if (logged) {
      lastTouch = logged;
      lastTouchSource = "logged_date";
    } else {
      // No interaction recorded at all. Falling back to when the contact was
      // created is what keeps a student who marked someone "reached out" and
      // never logged a date from disappearing out of this list forever.
      lastTouch = c.createdAt;
      lastTouchSource = "created";
    }

    const daysSince = Math.floor((now.getTime() - lastTouch.getTime()) / MS_PER_DAY);
    if (daysSince < dueAfterDays) continue;
    // A month past due, the catch-up has lapsed too - the same rule as the
    // cold-email ladder (FOLLOW_UP_EXPIRES_DAYS).
    if (daysSince - dueAfterDays >= FOLLOW_UP_EXPIRES_DAYS) continue;

    due.push({
      contactId: c.id,
      name: c.name,
      firm: c.firm,
      role: c.role,
      relationshipStatus: c.relationshipStatus,
      lastTouch,
      lastTouchSource,
      daysSince,
      dueAfterDays,
      overdueByDays: daysSince - dueAfterDays,
    });
  }

  // Most overdue first. Ties break on name so the order is stable across loads.
  return due.sort((a, b) => b.overdueByDays - a.overdueByDays || a.name.localeCompare(b.name));
}
