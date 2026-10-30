"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { events, firmRecruitingEvents, firms, studentOpeningReports } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { blockedLanguageError } from "@/lib/content-limits";
import { recordOpeningSignal } from "@/lib/opening-signals";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { pushEventToGoogle } from "@/lib/google-event-sync";
import { getCalendarWriteTarget } from "@/lib/google-connection";
import { recordEngagement } from "@/lib/firm-engagement";
import { rateLimit } from "@/lib/rate-limit";
import { eventVisibleTo } from "@/lib/firm-delivery-rules";
import { selectableCycleYears } from "./cycles";

export type ReportOpeningState = { success?: string; error?: string } | undefined;

/** The note is a sighting, not an essay, and the link is a URL. Bounded here
 *  because a server action's body is 4.4mb and both are stored and shown. */
const NOTE_MAX = 500;
const SOURCE_URL_MAX = 500;

/** Reports one student may file in a day. A student checking a dozen firms'
 *  careers pages is ordinary; hundreds is not a student reporting openings. */
const REPORT_LIMIT = 30;
const REPORT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Records that a student saw a firm's programme open.
 *
 * Two writes, and they are different in kind. The student's own report goes
 * into `student_opening_reports` verbatim and untouched - that is the raw
 * observation, one row per person. The aggregated claim then goes into
 * `opening_signals` as a single `student_report` row, rebuilt from every
 * undismissed report each time, because that table holds one live claim per
 * source per programme and must not be appended to per student.
 */
export async function reportOpening(
  _prev: ReportOpeningState,
  formData: FormData,
): Promise<ReportOpeningState> {
  // Redirects to /login on its own when there is no session, so there is no
  // logged-out branch to handle here.
  const user = await getCurrentUser();
  const db = await getDb();

  const firmId = String(formData.get("firmId") ?? "");
  const slug = String(formData.get("slug") ?? "");
  const rawCategory = String(formData.get("programCategory") ?? "");
  const cycleYear = Number(formData.get("cycleYear"));
  const note = String(formData.get("note") ?? "").trim();
  const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();

  // The note is the one free-text field here, so it carries the whole of the
  // blocked-language obligation. Everything else on this form is an id, a
  // fixed choice, a year or a URL. Checked before anything is written, and the
  // message is returned as the action's error rather than thrown - this is a
  // student-facing form, not an admin one.
  const blocked = blockedLanguageError([["Note", note]]);
  if (blocked) return { error: blocked };

  if (note.length > NOTE_MAX) {
    return { error: `Keep the note under ${NOTE_MAX} characters.` };
  }
  if (sourceUrl.length > SOURCE_URL_MAX) {
    return { error: "That link is too long." };
  }

  if (!firmId) return { error: "Something went wrong - reload the page and try again." };

  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) return { error: "That firm no longer exists." };

  if (!selectableCycleYears().includes(cycleYear)) {
    return { error: "Pick one of the listed recruiting cycles." };
  }

  // "" is the deliberate "the firm generally" option, which is what a student
  // who saw a careers-page banner rather than a specific desk's posting has.
  const programCategory =
    rawCategory && rawCategory in CATEGORY_LABELS ? (rawCategory as FirmProgramCategory) : null;

  if (sourceUrl && !/^https?:\/\/\S+$/i.test(sourceUrl)) {
    return { error: "The link should start with http:// or https://" };
  }

  const gate = await rateLimit("opening-report", user.id, REPORT_LIMIT, REPORT_WINDOW_MS);
  if (!gate.allowed) {
    return { error: "That's a lot of reports today. Try again tomorrow." };
  }

  const observedAt = new Date();

  // The "firm generally" option stores programCategory NULL, and Postgres
  // treats NULLs as distinct in a unique index - so the ON CONFLICT below
  // never matches for those, and every submission inserted ANOTHER row,
  // making one student look like as many corroborating sightings as they
  // pressed the button. Found and updated by hand instead, the same
  // workaround lib/opening-signals.ts already uses for the same reason.
  if (programCategory === null) {
    const [mine] = await db
      .select({ id: studentOpeningReports.id })
      .from(studentOpeningReports)
      .where(
        and(
          eq(studentOpeningReports.firmId, firmId),
          eq(studentOpeningReports.reportedByUserId, user.id),
          eq(studentOpeningReports.cycleYear, cycleYear),
          isNull(studentOpeningReports.programCategory),
        ),
      )
      .limit(1);
    if (mine) {
      await db
        .update(studentOpeningReports)
        .set({
          note: note || null,
          sourceUrl: sourceUrl || null,
          observedAt,
          dismissedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(studentOpeningReports.id, mine.id));
    } else {
      await db.insert(studentOpeningReports).values({
        firmId,
        reportedByUserId: user.id,
        programCategory,
        cycleYear,
        note: note || null,
        sourceUrl: sourceUrl || null,
        observedAt,
      });
    }
    await rebuildStudentSignal(firmId, cycleYear, programCategory);
    revalidatePath(`/discovery/firm/${slug}`);
    revalidatePath("/discovery");
    return { success: "Thanks - that's recorded." };
  }

  // Upsert, not insert. A student reporting the same programme twice is
  // correcting themselves - a second row would make one person look like two
  // corroborating sightings, which is exactly the inflation this table's
  // unique index exists to prevent.
  await db
    .insert(studentOpeningReports)
    .values({
      firmId,
      reportedByUserId: user.id,
      programCategory,
      cycleYear,
      note: note || null,
      sourceUrl: sourceUrl || null,
      observedAt,
    })
    .onConflictDoUpdate({
      target: [
        studentOpeningReports.firmId,
        studentOpeningReports.reportedByUserId,
        studentOpeningReports.programCategory,
        studentOpeningReports.cycleYear,
      ],
      set: {
        note: note || null,
        sourceUrl: sourceUrl || null,
        observedAt,
        // A student correcting a report they had previously had dismissed gets
        // a fresh hearing rather than staying silently excluded.
        dismissedAt: null,
        updatedAt: new Date(),
      },
    });

  await rebuildStudentSignal(firmId, cycleYear, programCategory);

  revalidatePath(`/discovery/firm/${slug}`);
  revalidatePath("/discovery");

  return { success: "Thanks - that's recorded." };
}

/**
 * Rebuilds the single aggregated `student_report` claim for one programme.
 *
 * Runs over every undismissed report rather than adjusting the existing signal,
 * so a dismissal or a correction produces the same answer as a fresh count.
 * Cheap - this is an indexed read of a handful of rows.
 */
async function rebuildStudentSignal(
  firmId: string,
  cycleYear: number,
  programCategory: FirmProgramCategory | null,
) {
  const db = await getDb();

  const reports = await db
    .select()
    .from(studentOpeningReports)
    .where(
      and(
        eq(studentOpeningReports.firmId, firmId),
        eq(studentOpeningReports.cycleYear, cycleYear),
        programCategory === null
          ? isNull(studentOpeningReports.programCategory)
          : eq(studentOpeningReports.programCategory, programCategory),
        isNull(studentOpeningReports.dismissedAt),
      ),
    )
    .orderBy(desc(studentOpeningReports.observedAt));

  if (reports.length === 0) return;

  const latest = reports[0];
  const withNote = reports.find((r) => r.note);
  const count = reports.length;

  // Evidence is required by the signals table and by the rule behind it: a
  // claim that cannot quote what it was read out of is not reviewable. A
  // student's own words are quoted verbatim; when nobody wrote one, the
  // evidence says plainly that the claim rests on the sighting alone rather
  // than inventing a sentence for them.
  const headline =
    count === 1 ? "1 student reported this open" : `${count} students reported this open`;
  const evidence = withNote?.note
    ? `${headline} - "${withNote.note.slice(0, 300)}"`
    : `${headline} (no note given)`;

  await recordOpeningSignal({
    firmId,
    cycleYear,
    programCategory,
    source: "student_report",
    evidence,
    sourceUrl: reports.find((r) => r.sourceUrl)?.sourceUrl ?? null,
    // opensEnd only, never opensStart - a sighting says the programme had
    // opened BY the day it was seen and nothing about when it opened. The same
    // rule monitor-run.ts follows for `seen_live`, and the reason this table
    // stores windows rather than dates.
    opensEnd: latest.observedAt,
    // The first person to tell us keeps the credit; later reports corroborate
    // rather than replace.
    reportedByUserId: reports[reports.length - 1].reportedByUserId,
    observedAt: latest.observedAt,
  });
}

// ---------- recruiting events -> the student's own calendar ----------

export type AddEventState = { success?: string; error?: string; eventId?: string } | undefined;

/**
 * Marks an `events` row as a copy of one crawled recruiting event.
 *
 * Account-scoped by the event's own uuid, and stored in the notes the same way
 * the old Gmail inbox import stored its message id: there is no column for
 * provenance on `events`, and adding one for a single feature would put a
 * crawler concept into the student's own calendar table.
 */
function recruitingEventMarker(recruitingEventId: string) {
  return `Source: recruiting_event:${recruitingEventId}`;
}

/**
 * What a crawled event kind becomes on a student's calendar.
 *
 * `events.type` is a five-value enum about the student's own day, not a
 * taxonomy of what firms run, so the four hosted kinds that are not a coffee
 * chat all land on `info_session` - a firm talking to a room of students.
 * Widening the enum to mirror the crawler would put crawler vocabulary into a
 * table that predates it.
 */
const EVENT_KIND_TO_CALENDAR_TYPE: Record<string, "coffee_chat" | "info_session"> = {
  coffee_chat: "coffee_chat",
  info_session: "info_session",
  networking: "info_session",
  insight_day: "info_session",
  other: "info_session",
};

/**
 * Puts one crawled recruiting event on the student's calendar.
 *
 * Takes the event's id and reads every displayed word from the row rather than
 * the form: the title and location are the firm's copy, and a form that posted
 * them back would let anyone write whatever they liked into a calendar entry
 * that then gets pushed to their Google account.
 */
export async function addRecruitingEventToCalendar(
  _prev: AddEventState,
  formData: FormData,
): Promise<AddEventState> {
  const user = await getCurrentUser();
  const db = await getDb();

  const recruitingEventId = String(formData.get("recruitingEventId") ?? "");
  const slug = String(formData.get("slug") ?? "");
  if (!recruitingEventId) {
    return { error: "Something went wrong - reload the page and try again." };
  }

  const event = await db.query.firmRecruitingEvents.findFirst({
    where: eq(firmRecruitingEvents.id, recruitingEventId),
  });
  // The same rule as the firm's page: a cancelled or taken-down event, one
  // for other schools, or the demo firm's outside the demo is not listed for
  // this student, so it cannot be saved by posting its id either.
  if (!event || event.takenDownAt || !eventVisibleTo(user, event)) {
    return { error: "That event is no longer listed." };
  }

  // An event with no published date cannot become a calendar entry, and the
  // one thing we will not do is invent a time for it. The UI does not offer
  // the button in this case; this covers a stale page.
  if (!event.eventDate) {
    return { error: "That event has no published date yet - open it on the firm's site." };
  }

  // The firm's own crawled words, about to be written into this student's
  // calendar and pushed to their Google account. Checked here for the same
  // reason `promote-approved-listings` checks before publishing a posting: the
  // text comes from a page we do not control.
  const blocked = blockedLanguageError([
    ["Title", event.title],
    ["Location", event.location],
  ]);
  if (blocked) return { error: blocked };

  const marker = recruitingEventMarker(event.id);

  // Idempotent. The button can be clicked twice, and the second click should
  // say "already on your calendar" rather than produce a duplicate that then
  // syncs to Google as a second entry.
  const existing = await db.query.events.findMany({
    where: and(eq(events.userId, user.id), eq(events.type, "info_session")),
    columns: { id: true, notes: true },
  });
  const coffeeChats = await db.query.events.findMany({
    where: and(eq(events.userId, user.id), eq(events.type, "coffee_chat")),
    columns: { id: true, notes: true },
  });
  if ([...existing, ...coffeeChats].some((e) => e.notes?.includes(marker))) {
    return { success: "Already on your calendar.", eventId: recruitingEventId };
  }

  const firm = await db.query.firms.findFirst({ where: eq(firms.id, event.firmId) });
  const title = firm ? `${firm.name} - ${event.title}` : event.title;

  const notesLines: string[] = [];
  if (event.location) notesLines.push(`Location: ${event.location}`);
  if (event.registrationDeadline) {
    notesLines.push(
      `Registration closes ${event.registrationDeadline.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })}`,
    );
  }
  // A firm-posted event's eventUrl is an internal marker; its link is the RSVP.
  const link = event.origin === "firm" ? event.rsvpUrl : event.eventUrl;
  if (link) notesLines.push(link);
  notesLines.push(marker);

  const [row] = await db
    .insert(events)
    .values({
      userId: user.id,
      type: EVENT_KIND_TO_CALENDAR_TYPE[event.eventKind] ?? "info_session",
      title,
      notes: notesLines.join("\n\n"),
      eventDate: event.eventDate,
      endDate: event.endsAt,
      googleSyncStatus: "none",
    })
    .returning();

  // Counted for the firm's analytics when the firm posted it itself.
  if (event.origin === "firm") {
    await recordEngagement({ firmId: event.firmId, userId: user.id, kind: "event_calendar_add", eventId: event.id });
  }

  // Pushed to Google on the same terms every other event is - see
  // `createEvent` in schedule/actions.ts. Best-effort: the entry exists on the
  // student's schedule either way.
  try {
    const target = await getCalendarWriteTarget(user.id);
    if (target) {
      await pushEventToGoogle(db, target, row);
    }
  } catch {
    // Best-effort - the event still exists locally either way.
  }

  revalidatePath(`/discovery/firm/${slug}`);
  revalidatePath("/schedule");

  return { success: "Added to your schedule.", eventId: recruitingEventId };
}
