"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { applications, contacts, events } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";
import { parseWallClock } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { eventSchema } from "@/lib/validation";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  eventTypeWantsMeet,
  updateCalendarEvent,
} from "@/lib/google-calendar";
import { pushEventToGoogle } from "@/lib/google-event-sync";
import {
  getCalendarWriteTarget,
  getPrimaryEmailConnection,
  getValidAccessToken,
} from "@/lib/google-connection";
import type { ParsedScheduleEvent } from "@/lib/schedule-import";
import { guessEventType } from "@/lib/event-type-guess";

export type ActionState = { error?: string } | undefined;

/**
 * The form's start and end as instants. datetime-local posts a wall-clock
 * string with no offset ("2026-09-22T19:00"), and it means the student's
 * clock, not the server's - which on Vercel is UTC, so `new Date()` on it
 * filed a 7pm interview in New York at 3pm.
 */
async function eventTimes(
  eventDate: string,
  endDate: string | undefined,
): Promise<{ eventDate: Date; endDate: Date | null } | { error: string }> {
  const timeZone = await getStudentTimeZone();
  const start = parseWallClock(eventDate, timeZone);
  if (!start) return { error: "Enter a valid date and time." };
  if (!endDate) return { eventDate: start, endDate: null };
  const end = parseWallClock(endDate, timeZone);
  if (!end) return { error: "Enter a valid end date and time." };
  return { eventDate: start, endDate: end };
}

function parseEventForm(formData: FormData) {
  return eventSchema.safeParse({
    type: formData.get("type"),
    title: formData.get("title"),
    notes: formData.get("notes") ?? "",
    eventDate: formData.get("eventDate"),
    endDate: formData.get("endDate") ?? "",
    contactId: formData.get("contactId") ?? "",
    applicationId: formData.get("applicationId") ?? "",
  });
}

/**
 * The contact and application an event may be linked to, confirmed to be the
 * caller's own.
 *
 * Both ids arrive from the form as arbitrary strings, were written straight to
 * the row, and the Schedule page then joins them on id alone - so another
 * student's contact id read back their contact's name, and their application
 * id read back its firm and role. The event's own owner was checked; what it
 * pointed AT was not. A reference that is not the caller's is dropped rather
 * than refused: the id is not something they typed, so there is nothing for
 * them to correct, and the event itself is still what they asked for.
 *
 * Sibling paths such as syncContactLinks already bind ids to userId this way.
 */
async function ownedLinks(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  input: { contactId?: string | null; applicationId?: string | null },
): Promise<{ contactId: string | null; applicationId: string | null }> {
  const contactId = input.contactId || null;
  const applicationId = input.applicationId || null;

  const mine = await Promise.all([
    contactId
      ? db.query.contacts.findFirst({
          where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
          columns: { id: true },
        })
      : Promise.resolve(undefined),
    applicationId
      ? db.query.applications.findFirst({
          where: and(eq(applications.id, applicationId), eq(applications.userId, userId)),
          columns: { id: true },
        })
      : Promise.resolve(undefined),
  ]);

  return { contactId: mine[0]?.id ?? null, applicationId: mine[1]?.id ?? null };
}

export async function createEvent(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = parseEventForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const blocked = blockedLanguageError([["Title", formData.get("title")], ["Notes", formData.get("notes")]]);
  if (blocked) return { error: blocked };
  const times = await eventTimes(parsed.data.eventDate, parsed.data.endDate);
  if ("error" in times) return times;

  const userId = await getCurrentUserId();
  const db = await getDb();
  const links = await ownedLinks(db, userId, parsed.data);

  await db
    .insert(events)
    .values({
      userId,
      type: parsed.data.type,
      // Anything but the default "meeting" is a choice the student made, and
      // the interview detector never overrules it.
      typeSource: parsed.data.type === "meeting" ? null : "student",
      title: parsed.data.title,
      notes: parsed.data.notes || null,
      eventDate: times.eventDate,
      endDate: times.endDate,
      contactId: links.contactId,
      applicationId: links.applicationId,
      googleSyncStatus: "none",
    });

  // Nothing is pushed to Google here, deliberately.
  //
  // This used to write every new event straight into the student's Google
  // calendar the moment a connection existed. Reading someone's calendar and
  // writing to it are not the same permission in any sense that matters to the
  // person whose calendar it is: one shows them their own week inside Offerly,
  // the other puts our rows in front of everyone they share a calendar with.
  // Export is now something they ask for - see exportScheduleToGoogle.
  revalidatePath("/schedule");
}

// Edits are pushed to Google so the synced copy never goes stale. An event
// that isn't on Google yet (created while disconnected) is created now rather
// than patched, so connecting Google later backfills on first edit.
export async function updateEvent(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const eventId = formData.get("eventId");
  if (typeof eventId !== "string" || !eventId) return { error: "Missing event." };

  const parsed = parseEventForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const blocked = blockedLanguageError([["Title", formData.get("title")], ["Notes", formData.get("notes")]]);
  if (blocked) return { error: blocked };
  const times = await eventTimes(parsed.data.eventDate, parsed.data.endDate);
  if ("error" in times) return times;

  const userId = await getCurrentUserId();
  const db = await getDb();

  const existing = await db.query.events.findFirst({
    where: and(eq(events.id, eventId), eq(events.userId, userId)),
  });
  if (!existing) return { error: "Event not found." };
  const links = await ownedLinks(db, userId, parsed.data);

  const [row] = await db
    .update(events)
    .set({
      type: parsed.data.type,
      // Changing the type is re-filing it: a tagged interview put back as a
      // meeting stays a meeting.
      typeSource: parsed.data.type !== existing.type ? "student" : existing.typeSource,
      title: parsed.data.title,
      notes: parsed.data.notes || null,
      eventDate: times.eventDate,
      endDate: times.endDate,
      contactId: links.contactId,
      applicationId: links.applicationId,
    })
    .where(and(eq(events.id, eventId), eq(events.userId, userId)))
    .returning();

  // An event that was already exported is kept in step, so the copy on their
  // calendar never contradicts the one here. One that was never exported is
  // NOT created now - editing is not a request to publish, and the old code
  // treated it as one ("connecting Google later backfills on first edit").
  try {
    if (existing.googleEventId) {
      await updateCalendarEvent(
        (await getCalendarWriteTarget(userId))?.accessToken ?? "",
        existing.googleCalendarId ?? "primary",
        existing.googleEventId,
        {
          title: row.title,
          notes: row.notes,
          eventDate: row.eventDate,
          endDate: row.endDate,
        },
      );
    }
  } catch {
    // Best-effort: the local event is the source of truth either way.
  }

  revalidatePath("/schedule");
}

export async function toggleEventCompleted(eventId: string, completed: boolean) {
  const userId = await getCurrentUserId();
  const db = await getDb();
  await db
    .update(events)
    .set({ completed })
    .where(and(eq(events.id, eventId), eq(events.userId, userId)));

  revalidatePath("/schedule");
}

export async function deleteEvent(eventId: string) {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const event = await db.query.events.findFirst({
    where: and(eq(events.id, eventId), eq(events.userId, userId)),
    columns: { googleEventId: true, googleCalendarId: true },
  });

  if (event?.googleEventId) {
    const connection = await getPrimaryEmailConnection(userId);
    if (connection) {
      try {
        const accessToken = await getValidAccessToken(connection);
        await deleteCalendarEvent(
          accessToken,
          event.googleCalendarId ?? "primary",
          event.googleEventId,
        );
      } catch {
        // Best-effort - still remove the local record either way.
      }
    }
  }

  await db.delete(events).where(and(eq(events.id, eventId), eq(events.userId, userId)));

  revalidatePath("/schedule");
}

export async function acceptGoogleSync(eventId: string) {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const [target, event] = await Promise.all([
    getCalendarWriteTarget(userId),
    db.query.events.findFirst({ where: and(eq(events.id, eventId), eq(events.userId, userId)) }),
  ]);
  if (!target || !event) return;

  try {
    const created = await createCalendarEvent(target.accessToken, target.calendarId, {
      title: event.title,
      notes: event.notes,
      eventDate: event.eventDate,
      endDate: event.endDate,
      withMeet: eventTypeWantsMeet(event.type),
    });
    await db
      .update(events)
      .set({
        googleEventId: created.id,
        googleCalendarId: target.calendarId,
        googleMeetUrl: created.meetUrl,
        googleSyncStatus: "synced",
      })
      // Bound to the caller, like every other write to this table here. The
      // guard above already refuses an event that is not theirs, so this
      // changes nothing today - which is exactly why it belongs here: this was
      // the one write in this file whose correctness rested on a check several
      // lines away rather than on its own predicate, and the next edit to that
      // guard would have been the bug.
      .where(and(eq(events.id, eventId), eq(events.userId, userId)));
  } catch {
    // Leave it pending - the student can retry from the panel.
  }

  revalidatePath("/schedule");
}

export async function dismissGoogleSync(eventId: string) {
  const userId = await getCurrentUserId();
  const db = await getDb();
  await db
    .update(events)
    .set({ googleSyncStatus: "dismissed" })
    .where(and(eq(events.id, eventId), eq(events.userId, userId)));

  revalidatePath("/schedule");
}

type ImportState = { error?: string; imported?: number } | undefined;

/** Occurrences accepted in one file. A term of classes expanded week by week
 *  is a few hundred; this is the same ceiling the tracker import uses. */
const MAX_IMPORT_ROWS = 2000;

/** How much posted text is read at all: the caps below only apply once the
 *  JSON is parsed, so without this the only bound is the 4.4mb server-action
 *  body limit. */
const MAX_IMPORT_CHARS = 2_000_000;

/** As long as a title a student can type into the Schedule by hand
 *  (eventSchema in lib/validation.ts), and no longer. */
const MAX_TITLE_CHARS = 300;

/**
 * Events one student's schedule holds.
 *
 * Every one of them is a row the shared reminder job may pick up, and an
 * import is the only way to add them in bulk - repeatedly, until this cap. A
 * term or two of classes, deadlines and meetings is well inside it.
 */
const MAX_EVENTS = 5_000;

/** Imports per student per hour: enough to fix a file and try again. */
const IMPORT_LIMIT = 10;
const IMPORT_WINDOW_MS = 60 * 60_000;

const importRowSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  isoDateTime: z.string().max(64),
});

export async function bulkImportScheduleEvents(
  _prevState: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const raw = formData.get("rows");
  if (typeof raw !== "string") return { error: "No rows to import." };
  if (raw.length > MAX_IMPORT_CHARS) {
    return { error: "That file is too large to import. Split it into smaller files and try again." };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { error: "Couldn't read parsed rows." };
  }
  if (!Array.isArray(parsedJson) || parsedJson.length === 0) {
    return { error: "Nothing to import." };
  }
  if (parsedJson.length > MAX_IMPORT_ROWS) {
    return {
      error: `A file can bring up to ${MAX_IMPORT_ROWS.toLocaleString()} entries at a time. Split it and try again.`,
    };
  }
  // Each row's shape and lengths checked before anything is stored. The title
  // used to be taken on trust - truthy was the whole check - so one row could
  // carry a megabyte of it. A row that does not fit is dropped, which is what
  // already happened to a row with no title or no readable time.
  const rows: ParsedScheduleEvent[] = parsedJson.flatMap((r) => {
    const row = importRowSchema.safeParse(r);
    return row.success ? [row.data] : [];
  });
  if (rows.length === 0) return { error: "Nothing to import." };

  // The check runs on the titles that are about to be stored, not on the JSON
  // text that carried them: checking the text checked the transport encoding
  // instead of the words, and a \u escape inside a word reads to a whole-word
  // matcher as no word at all until JSON.parse decodes it.
  for (const row of rows) {
    const blocked = blockedLanguageError([["The imported events", row.title]]);
    if (blocked) return { error: blocked };
  }

  const userId = await getCurrentUserId();
  const gate = await rateLimit("import:schedule", userId, IMPORT_LIMIT, IMPORT_WINDOW_MS);
  if (!gate.allowed) {
    return {
      error: `You've imported a lot of files just now. Try again in about ${retryAfterText(gate.retryAfterMs)}.`,
    };
  }
  const db = await getDb();
  // The parser hands back wall-clock strings on the student's clock (see
  // lib/schedule-import.ts), so they are read in their zone, not UTC.
  const timeZone = await getStudentTimeZone();

  // Each entry filed as what it most likely is - an interview, a coffee
  // chat, a deadline - rather than all as "personal", which silenced every
  // prompt for an imported calendar. Marked as the app's guess, with the words
  // that decided it; the student's own change is final (see typeSource).
  const importedAt = new Date();
  const values = rows
    .map((r) => {
      const eventDate = typeof r.isoDateTime === "string" ? parseWallClock(r.isoDateTime, timeZone) : null;
      if (!r.title || !eventDate) return null;
      const guess = guessEventType(r.title);
      return {
        userId,
        type: guess.type,
        typeSource: "detected",
        typeDetectedAt: importedAt,
        typeDetectedFrom: guess.evidence,
        title: r.title,
        eventDate,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  if (values.length === 0) return { error: "Nothing valid to import." };

  const [{ held }] = await db
    .select({ held: count() })
    .from(events)
    .where(eq(events.userId, userId));
  if (held + values.length > MAX_EVENTS) {
    return {
      error: `Your schedule holds up to ${MAX_EVENTS.toLocaleString()} entries, and this file would take it past that. Remove some, or import fewer rows.`,
    };
  }

  await db.insert(events).values(values);

  // Not pushed to Google, for the same reason creating one event is not.
  //
  // This used to mirror a whole imported term onto the student's calendar in
  // concurrent batches - the largest automatic write in the app, triggered by
  // uploading a file. Importing a timetable into Offerly is not a decision to
  // publish it, and "the student probably wants this" is not the student
  // asking. Export to Google picks these up whenever they do ask.

  revalidatePath("/schedule");
  return { imported: values.length };
}

export type ExportState = { error?: string; exported?: number } | undefined;

/**
 * Copies this student's schedule into their Google calendar, on request.
 *
 * The counterpart to no longer pushing automatically. Reading a calendar and
 * writing to one are different things to ask of somebody: pulling shows them
 * their own week inside Offerly, pushing puts our rows in front of everyone
 * they share that calendar with. So it happens when they press the button and
 * not before.
 *
 * Only events that have never been exported are sent, so pressing it twice
 * does not produce two of everything - the googleEventId written back is what
 * makes the second press a no-op.
 */
export async function exportScheduleToGoogle(): Promise<ExportState> {
  const userId = await getCurrentUserId();
  const target = await getCalendarWriteTarget(userId);
  if (!target) return { error: "Connect a Google account first." };

  const db = await getDb();
  const mine = await db.query.events.findMany({
    where: and(eq(events.userId, userId), isNull(events.googleEventId)),
  });

  let exported = 0;
  for (const row of mine) {
    try {
      await pushEventToGoogle(db, target, row);
      exported++;
    } catch {
      // One failure should not abandon the rest of the export.
    }
  }

  revalidatePath("/schedule");
  return { exported };
}
