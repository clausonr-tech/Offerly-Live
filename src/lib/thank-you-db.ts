import "server-only";
import { and, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contacts, emailDrafts, events, firms, notifications, userTopFirms, users } from "@/db/schema";
import { listCalendarEvents } from "@/lib/google-calendar";
import { getEmailConnections, getValidAccessToken } from "@/lib/google-connection";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import {
  INTERVIEW_THANK_TEMPLATES,
  THANK_YOU_LOOKBACK_DAYS,
  selectThankYous,
  type ChatEvent,
  type ThankYouPrompt,
} from "@/lib/thank-you";

// The queries behind the thank-you prompt. The rules are in thank-you.ts.

const DAY = 86_400_000;

/**
 * Google Calendar entries, cached per student for a few minutes.
 *
 * The prompts run in the layout on every page, and a Google read is several
 * round trips (the calendar list, then each calendar). A chat that ended two
 * hours ago does not need second-by-second freshness, so one read serves the
 * next ten minutes of page loads. Kept on globalThis so a dev-server reload
 * does not throw it away. A failed read is cached as empty for the same time,
 * so a revoked connection is not retried on every page.
 */
const GOOGLE_TTL_MS = 10 * 60_000;
type GoogleRead = {
  at: number;
  events: ChatEvent[];
  /** False when any read failed: the list may be missing entries, so nothing
   *  about Google entries may be concluded from their absence. */
  ok?: boolean;
};
const cache: Map<string, GoogleRead> = ((globalThis as { __thankYouGoogleCache?: Map<string, GoogleRead> })
  .__thankYouGoogleCache ??= new Map());

async function googleChats(userId: string, now: Date): Promise<{ events: ChatEvent[]; ok: boolean }> {
  const hit = cache.get(userId);
  if (hit && now.getTime() - hit.at < GOOGLE_TTL_MS) return { events: hit.events, ok: hit.ok !== false };

  const out: ChatEvent[] = [];
  let ok = true;
  try {
    const connections = await getEmailConnections(userId);
    const from = new Date(now.getTime() - (THANK_YOU_LOOKBACK_DAYS + 1) * DAY);
    for (const connection of connections) {
      try {
        const token = await getValidAccessToken(connection);
        const items = await listCalendarEvents(token, from, now);
        for (const e of items) {
          out.push({
            sourceKey: `google:${e.id}`,
            title: e.title,
            startsAt: new Date(e.start),
            endsAt: e.end ? new Date(e.end) : null,
            allDay: e.allDay,
            notes: e.notes,
            videoCall: e.videoCall,
            attendeeEmails: e.attendeeEmails,
            attendees: e.attendees,
            declined: e.declined,
            recurring: e.recurring,
            eventType: e.eventType,
          });
        }
      } catch (err) {
        // One unusable connection must not silence the prompt for the others.
        ok = false;
        console.error("[thank-you] Google Calendar read failed for", connection.email, err);
      }
    }
  } catch (err) {
    ok = false;
    console.error("[thank-you] could not list Google connections", err);
  }
  cache.set(userId, { at: now.getTime(), events: out, ok });
  return { events: out, ok };
}

/** Every thank-you this student owes right now, oldest first. */
export async function getThankYouPrompts(
  userId: string,
  now: Date = new Date(),
): Promise<ThankYouPrompt[]> {
  return selectThankYous(await loadThankYouInput(userId, now));
}

type ThankYouInput = Parameters<typeof selectThankYous>[0] & { googleOk: boolean };

/** Everything selectThankYous reads, for one student. */
async function loadThankYouInput(userId: string, now: Date): Promise<ThankYouInput> {
  const db = await getDb();
  const from = new Date(now.getTime() - (THANK_YOU_LOOKBACK_DAYS + 1) * DAY);

  const [own, people, closed, sent, google, timeZone, tracked, me, connections, autoClosed] = await Promise.all([
    db.query.events.findMany({
      where: and(eq(events.userId, userId), gte(events.eventDate, from), lte(events.eventDate, now)),
      columns: {
        id: true,
        title: true,
        type: true,
        typeSource: true,
        contactId: true,
        eventDate: true,
        endDate: true,
        googleEventId: true,
        notes: true,
      },
    }),
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: { id: true, name: true, email: true },
    }),
    db.query.notifications.findMany({
      where: and(
        eq(notifications.userId, userId),
        eq(notifications.kind, "thank_you"),
        isNotNull(notifications.doneAt),
        // Only what the student ticked off. A job the app closed - answered
        // by a send, expired, its entry deleted - is re-derived every time,
        // so unticking "I sent this" or moving the entry brings it back.
        eq(notifications.doneSource, "manual"),
      ),
      columns: { dedupeKey: true },
    }),
    db.query.emailDrafts.findMany({
      where: and(
        eq(emailDrafts.userId, userId),
        eq(emailDrafts.kind, "thank_you"),
        isNotNull(emailDrafts.sentAt),
        gte(emailDrafts.sentAt, from),
      ),
      columns: { contactId: true, sentAt: true, templateId: true },
      // Where it went: a note to an address on the invitation ticks that
      // interviewer off.
      with: { contact: { columns: { email: true } } },
    }),
    googleChats(userId, now),
    getStudentTimeZone(),
    // The firms they track, to fill in the firm on a note to someone new.
    db
      .select({ name: firms.name, aliases: firms.aliases })
      .from(userTopFirms)
      .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
      .where(eq(userTopFirms.userId, userId)),
    // The student's own addresses: an invitation sent to their school address
    // and shown on their Gmail calendar lists them as a guest.
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { email: true, schoolEmail: true } }),
    getEmailConnections(userId).catch(() => []),
    // Jobs the app closed itself, for when Google cannot be read (below).
    db.query.notifications.findMany({
      where: and(
        eq(notifications.userId, userId),
        eq(notifications.kind, "thank_you"),
        eq(notifications.doneSource, "auto"),
      ),
      columns: { dedupeKey: true },
    }),
  ]);
  const mine = new Set(
    [me?.email, me?.schoolEmail, ...connections.map((c) => c.email)]
      .filter((e): e is string => !!e)
      .map((e) => e.trim().toLowerCase()),
  );

  // An Offerly event that is synced to Google comes back from Google too.
  // Offerly's copy wins: it carries the type and the linked contact.
  const synced = new Set(own.map((e) => e.googleEventId).filter((id): id is string => !!id));
  const googleEvents = google.events.map((e) => ({
    ...e,
    attendeeEmails: e.attendeeEmails?.filter((a) => !mine.has(a)),
    attendees: e.attendees?.filter((a) => !mine.has(a.email)),
  }));

  return {
    events: [
      ...own.map(
        (e): ChatEvent => ({
          sourceKey: `offerly:${e.id}`,
          title: e.title,
          type: e.type,
          typeSource: e.typeSource,
          contactId: e.contactId,
          startsAt: e.eventDate,
          endsAt: e.endDate,
          notes: e.notes,
        }),
      ),
      ...googleEvents.filter((e) => !synced.has(e.sourceKey.slice("google:".length))),
    ],
    contacts: people,
    // Only what the student closed - except while Google cannot be read: then
    // an interview that took its interviewers from the invitation has lost
    // them, and would come back as unfinished. What the app already closed
    // stays closed until Google answers again.
    done: new Set([...closed, ...(google.ok ? [] : autoClosed)].map((c) => c.dedupeKey)),
    // Every sent thank-you, including one whose contact has since been
    // deleted: it still went, and still answers the chat it was for (by time,
    // see selectThankYous), rather than the prompt coming back.
    thanked: sent.flatMap((d) =>
      d.sentAt
        ? [
            {
              contactId: d.contactId ?? "",
              at: d.sentAt,
              interview: !!d.templateId && INTERVIEW_THANK_TEMPLATES.has(d.templateId),
              email: d.contact?.email ?? null,
            },
          ]
        : [],
    ),
    firms: tracked.map((f) => ({ name: f.name, aliases: f.aliases ?? [] })),
    now,
    timeZone,
    googleOk: google.ok,
  };
}

/**
 * Bring the bell's thank-you jobs into line with what is owed now.
 *
 * The bubble and the to-do row are derived fresh on every page, so they stop
 * the moment the work is done. The bell keeps a row, so something has to close
 * it - and a thank-you stops being owed in more ways than one: a thank-you
 * sent (to that person, or an interview note after the interview), the entry
 * deleted or moved, two weeks passing. So rather than closing it from each of
 * those places, this asks the one question that covers them all: is this job
 * still owed? If not, it closes - as expired when its moment has passed.
 *
 * Google entries are left alone when the Google read failed: their absence
 * from the list then says nothing. They close on the next good read.
 *
 * Runs whenever the bell is read and after every send. A job closed here
 * reopens by itself if the thank-you becomes owed again - the next bubble
 * files it again - because only a tick is remembered as done.
 */
export async function reconcileThankYouJobs(userId: string, now: Date = new Date()) {
  const db = await getDb();
  const open = await db.query.notifications.findMany({
    where: and(
      eq(notifications.userId, userId),
      eq(notifications.kind, "thank_you"),
      isNull(notifications.doneAt),
    ),
    columns: { id: true, dedupeKey: true, expiresAt: true },
  });
  if (open.length === 0) return;

  const input = await loadThankYouInput(userId, now);
  const owed = new Set(selectThankYous(input).map((t) => t.key));
  const stale = open.filter(
    (row) => !owed.has(row.dedupeKey) && (input.googleOk || !row.dedupeKey.startsWith("thank_you:google:")),
  );
  if (stale.length === 0) return;

  const expired = stale.filter((r) => r.expiresAt && r.expiresAt.getTime() <= now.getTime()).map((r) => r.id);
  const answered = stale.filter((r) => !expired.includes(r.id)).map((r) => r.id);
  await Promise.all([
    answered.length
      ? db
          .update(notifications)
          .set({ doneAt: now, doneSource: "auto" })
          .where(and(eq(notifications.userId, userId), inArray(notifications.id, answered), isNull(notifications.doneAt)))
      : Promise.resolve(),
    expired.length
      ? db
          .update(notifications)
          .set({ doneAt: now, doneSource: "expired" })
          .where(and(eq(notifications.userId, userId), inArray(notifications.id, expired), isNull(notifications.doneAt)))
      : Promise.resolve(),
  ]);
}

/**
 * A thank-you was taken back ("I sent this" unticked): reopen the jobs the app
 * had closed for it that are owed again. Only rows the app closed - one the
 * student ticked off stays done - and bumped to the top, unread, as a prompt
 * that fires again would be.
 */
export async function reopenOwedThankYouJobs(userId: string, now: Date = new Date()) {
  const owed = (await getThankYouPrompts(userId, now)).map((t) => t.key);
  if (owed.length === 0) return;
  const db = await getDb();
  await db
    .update(notifications)
    .set({ doneAt: null, doneSource: null, bumpedAt: now, readAt: null })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.kind, "thank_you"),
        inArray(notifications.dedupeKey, owed),
        eq(notifications.doneSource, "auto"),
      ),
    );
}
