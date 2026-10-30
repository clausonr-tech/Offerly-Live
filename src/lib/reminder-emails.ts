import "server-only";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { events, users } from "@/db/schema";
import { sendEmail } from "./email";

// Emails a student ahead of a deadline they have on Offerly.
//
// Deliberately conservative about what it sends. The dates on these events are
// *estimates* derived from prose recruiting guidance (see deadline-reminders),
// not deadlines a firm published, so the email has to read as a prompt to go
// and check rather than an authoritative "applications close Friday". Getting
// that wrong would be worse than sending nothing.

/** How far ahead of the event the email goes out. */
const REMINDER_LEAD_DAYS = 7;

/** Emails one run sends, across everybody. Unchanged: it is what one
 *  invocation of the job has time for. */
const SEND_LIMIT = 500;

/**
 * Events one student can take out of a single run.
 *
 * The query is global and ordered by date alone, so the window used to be
 * whatever the earliest 500 rows in the database happened to be. One student
 * with 500 events in the lead window - which a bulk import is all it takes to
 * create - filled it, and everybody else waited for the next run. Rows whose
 * send keeps failing, or whose owner has no address to send to, are left
 * unmarked on purpose so a later run retries them, which turned that wait into
 * a permanent one. A share per student keeps one person's rows from deciding
 * whose reminders a run processes; nobody has more than this many genuinely
 * different things to be reminded of in a week.
 */
const MAX_PER_USER_PER_RUN = 25;

/** Rows read before the share above is applied. Enough that the run still
 *  fills its 500 from other students when the earliest rows all belong to
 *  one. */
const CANDIDATE_LIMIT = 4000;

function formatDate(d: Date) {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function buildBody(input: { name: string | null; title: string; when: Date; notes: string | null }) {
  const greeting = input.name ? `Hi ${input.name.split(" ")[0]},` : "Hi,";
  return [
    greeting,
    "",
    `You asked Offerly to keep an eye on this one:`,
    "",
    `  ${input.title}`,
    `  ${formatDate(input.when)}`,
    "",
    "This date is our estimate from the firm's general recruiting guidance and your",
    "graduation year - it is not a deadline the firm published. Please check the firm's",
    "own careers page for the real dates before relying on it.",
    ...(input.notes ? ["", input.notes] : []),
    "",
    "- Offerly",
  ].join("\n");
}

export type ReminderRun = { sent: number; failed: number; skipped: number };

/**
 * Sends run-up emails for every event now inside the lead window that has not
 * already been emailed. Safe to call repeatedly: `reminderEmailSentAt` is the
 * idempotency guard, and it is written per event as each send succeeds rather
 * than in one batch at the end, so a mid-run crash cannot re-send what already
 * went out.
 */
export async function sendDueReminderEmails(now = new Date()): Promise<ReminderRun> {
  const db = await getDb();

  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db.query.events.findMany({
    where: and(
      eq(events.completed, false),
      isNull(events.reminderEmailSentAt),
      gte(events.eventDate, now),
      lte(events.eventDate, windowEnd),
    ),
    orderBy: [asc(events.eventDate)],
    limit: CANDIDATE_LIMIT,
  });

  // Soonest first, as before, but no more than one student's share. What this
  // leaves behind is not dropped - it is unmarked, so the next run sees it.
  const taken = new Map<string, number>();
  const due: typeof candidates = [];
  for (const event of candidates) {
    const mine = taken.get(event.userId) ?? 0;
    if (mine >= MAX_PER_USER_PER_RUN) continue;
    taken.set(event.userId, mine + 1);
    due.push(event);
    if (due.length >= SEND_LIMIT) break;
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // Every recipient in one query rather than one per event. A student with
  // twelve deadlines in the window used to cost twelve identical lookups, and
  // the loop runs up to the 500-row limit above.
  const recipients = new Map<string, { email: string | null; name: string | null }>();
  const userIds = [...new Set(due.map((e) => e.userId))];
  if (userIds.length > 0) {
    const rows = await db.query.users.findMany({
      where: inArray(users.id, userIds),
      columns: { id: true, email: true, name: true },
    });
    for (const row of rows) recipients.set(row.id, { email: row.email, name: row.name });
  }

  for (const event of due) {
    const user = recipients.get(event.userId);
    if (!user?.email) {
      skipped++;
      continue;
    }

    try {
      await sendEmail({
        to: user.email,
        subject: `Coming up: ${event.title}`,
        text: buildBody({
          name: user.name,
          title: event.title,
          when: event.eventDate,
          notes: event.notes,
        }),
      });
      await db
        .update(events)
        .set({ reminderEmailSentAt: new Date() })
        .where(eq(events.id, event.id));
      sent++;
    } catch (err) {
      // One bad address must not stop the rest of the run. Left unmarked so the
      // next run retries it.
      console.error(`reminder email failed for event ${event.id}:`, err);
      failed++;
    }
  }

  return { sent, failed, skipped };
}
