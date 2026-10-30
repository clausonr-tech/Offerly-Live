import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, events, firmRecruitingEvents, firms, internshipPostings, notifications, practiceSessions, users } from "@/db/schema";
import { parseFirmNotificationKey } from "@/lib/firm-delivery-rules";
import { firmResolver, normalizeFirmName } from "@/lib/firm-name";
import { externalHref } from "@/lib/safe-url";
import { parseFollowUpSubject } from "@/lib/outreach-ladder";
import { ladderProgressBySubject } from "@/lib/outreach-ladder-db";
import { reconcileThankYouJobs } from "@/lib/thank-you-db";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { parseTimeZone, zonedTime } from "@/lib/time-zone";
import { applyNotificationKey, dayKey, getOpeningToday, getOutreachNudges } from "@/lib/application-outreach";
import { trackedFirmNames } from "@/lib/tracked-firms";
import { reminderNotificationKey } from "@/lib/application-reminders";
import { getApplicationReminders } from "@/lib/application-reminders-db";
import { generatedDetail, generatedNotificationKey, generatedTitle, getUnreachedGenerated } from "@/lib/generated-reminders";

// The list behind the bell: everything the app has told this student to do,
// and whether they have done it.
//
// It is a to-do list, not a feed. Three rules follow from that and they are the
// whole design:
//
//   1. A prompt that fires twice is ONE job. The second firing moves the row to
//      the top rather than adding a second row saying the same thing.
//   2. A row closes when the WORK is finished, not when the student has looked
//      at it. Reading and doing are different, so they are different columns.
//   3. The app closes rows itself where it can see the work happen. Somebody
//      who emails everyone at a firm has done the thing the notification asked
//      for, and making them tick it off as well is asking them to tell us
//      something we already know.

export type NotificationRow = typeof notifications.$inferSelect;

/** One row as the bell and the full page render it. */
export type NotificationItem = {
  id: string;
  kind: NotificationRow["kind"];
  title: string;
  body: string;
  href: string;
  bumpedAt: Date;
  read: boolean;
  /**
   * How far through this job the student is, for the ones the app can watch.
   *
   * Null when there is nothing to count - which is also how a row says "this
   * one only closes when you say so". The full page reads it to decide whether
   * to promise that the job will close itself.
   */
  progress: { done: number; total: number } | null;
  /**
   * The firm a firm's own post is about - an internship or event it put on
   * the portal - so the bell can show its logo. Null for every other kind:
   * those name a firm only as words, and a logo matched on a name could be
   * somebody else's.
   */
  firm: { name: string; domain: string } | null;
  /**
   * A second line the bell shows under the title. Only the "you found them,
   * now write to them" job has one: the people at the firm still to email,
   * since its title names the firm and the names are what get the work done.
   */
  subline: string | null;
};

export type NotificationList = {
  /** Outstanding, newest firing first. Finished work is not listed anywhere:
   *  this is a to-do list, and a done row is not a to-do. */
  open: NotificationItem[];
  /** What the badge shows: outstanding jobs, not unread ones. */
  openCount: number;
  /** Outstanding AND never looked at. Drives the dot, not the number. */
  unreadCount: number;
};

/** Work left against one watched subject, and how much there was to start. */
export type SubjectProgress = { remaining: number; total: number };

/** The dedupe key for one firm's outreach prompt about one opening. */
export function outreachNotificationKey(firmKey: string, opensOn: string): string {
  return `outreach:${firmKey}:${opensOn}`;
}

/**
 * Record that something was shown to this student, or move it back to the top.
 *
 * Insert-or-bump on (userId, dedupeKey). A repeat firing also REOPENS a row
 * that had been closed: prompts only fire when the work is live, so if this one
 * has come round again the job is outstanding again, whatever was ticked last
 * time. The copy is refreshed too - "5 contacts" may be "3 contacts" now.
 */
/**
 * A job's link as it is stored: a path in the app, or an outside page (an
 * application on a firm's own board). Anything else - a bare word, a mailto,
 * a javascript: URL from a crawled field - becomes the notifications page, so
 * nothing the bell renders as "Go do it" can be anything but a page.
 *
 * The outside branch goes through `externalHref`, the same policy every other
 * read boundary uses, rather than through a scheme-shaped regular expression of
 * its own. It used to accept any `https://...` with no spaces in it, and a
 * notification's href is rendered in six places - the bell, the notifications
 * page, the task rows, the dashboard, the prompt flash - all of them as
 * `href={item.href}`, which the link sweep accepts on the NAME rather than on
 * any guard. So the regex was the only thing standing between a crawled apply
 * URL and a live link with no userinfo, bare-IP, private-suffix or odd-port
 * check anywhere. Nothing writes an absolute href today; the permission is
 * deliberate and documented, so it is the permission that had to be made safe
 * rather than the six readers.
 */
export function safeNotificationHref(href: string | null | undefined): string {
  // externalHref covers both branches itself: a leading slash goes through its
  // in-app path rule (which is what refuses "//evil.example", a backslash and a
  // tab), and anything else through the public-URL rule.
  return externalHref(href) ?? "/notifications";
}

export async function upsertNotification(input: {
  userId: string;
  kind: NotificationRow["kind"];
  dedupeKey: string;
  subjectKey?: string | null;
  title: string;
  body: string;
  href: string;
  expiresAt?: Date | null;
  now?: Date;
}) {
  const db = await getDb();
  const now = input.now ?? new Date();
  await db
    .insert(notifications)
    .values({
      userId: input.userId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      subjectKey: input.subjectKey ?? null,
      title: input.title,
      body: input.body,
      href: safeNotificationHref(input.href),
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      bumpedAt: now,
    })
    .onConflictDoUpdate({
      target: [notifications.userId, notifications.dedupeKey],
      set: {
        bumpedAt: now,
        title: input.title,
        body: input.body,
        href: safeNotificationHref(input.href),
        subjectKey: input.subjectKey ?? null,
        expiresAt: input.expiresAt ?? null,
        // Fired again, so it is outstanding again, and unread again - the
        // student has not seen THIS one.
        doneAt: null,
        doneSource: null,
        readAt: null,
      },
    });
}

/**
 * Which open rows the app can close on the student's behalf, and why.
 *
 * Pure, because this is the rule that decides whether someone's to-do list
 * empties itself correctly, and it should be testable without a database.
 *
 * `remainingBySubject` is how much work is left against each watched subject -
 * for outreach, people at that firm still not written to. Zero means finished.
 * A subject missing from the map means "we could not tell", which is never
 * grounds for closing anything.
 */
export function autoCloseable(
  rows: Pick<NotificationRow, "id" | "subjectKey" | "expiresAt" | "doneAt">[],
  remainingBySubject: ReadonlyMap<string, number>,
  now: Date,
): { id: string; source: "auto" | "expired" }[] {
  const out: { id: string; source: "auto" | "expired" }[] = [];
  for (const row of rows) {
    if (row.doneAt) continue;
    // Finished beats expired: someone who did the work in the last hour before
    // the deadline did it, and the row should say so.
    const remaining = row.subjectKey ? remainingBySubject.get(row.subjectKey) : undefined;
    if (remaining === 0) {
      out.push({ id: row.id, source: "auto" });
      continue;
    }
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
      out.push({ id: row.id, source: "expired" });
    }
  }
  return out;
}

/** The outstanding rows, newest firing first, with their progress attached. */
export function toNotificationList(
  rows: NotificationRow[],
  progressBySubject: ReadonlyMap<string, SubjectProgress> = new Map(),
): NotificationList {
  const open = rows
    .filter((r) => !r.doneAt)
    .map((r): NotificationItem => {
      const p = r.subjectKey ? progressBySubject.get(r.subjectKey) : undefined;
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        href: r.href,
        bumpedAt: r.bumpedAt,
        read: r.readAt != null,
        // A total of zero is not progress, it is an empty contact list, and
        // "0 of 0 emailed" says nothing worth reading.
        progress: p && p.total > 0 ? { done: p.total - p.remaining, total: p.total } : null,
        firm: null,
        subline: r.kind === "outreach" && r.dedupeKey.startsWith("generated:") && r.body ? r.body : null,
      };
    })
    .sort((a, b) => b.bumpedAt.getTime() - a.bumpedAt.getTime());

  return {
    open,
    openCount: open.length,
    unreadCount: open.filter((i) => !i.read).length,
  };
}

/**
 * The student's list, with anything they have already finished closed first.
 *
 * The auto-close pass runs on read rather than on a schedule: the moment that
 * matters is the one where they open the bell, and a row that says "email
 * Evercore" next to a contact list they finished yesterday is the failure worth
 * avoiding. It writes at most one statement, and only when something changed.
 */
export async function getNotifications(
  userId: string,
  now: Date = new Date(),
): Promise<NotificationList> {
  const db = await getDb();
  const rows = await db.query.notifications.findMany({
    where: eq(notifications.userId, userId),
    orderBy: [desc(notifications.bumpedAt)],
    limit: 50,
  });
  if (rows.length === 0) return { open: [], openCount: 0, unreadCount: 0 };

  // A thank-you has more ways to end than any count here can see - a send,
  // the entry deleted, two weeks passing - so it asks its own rule, then the
  // rows are read again with whatever that closed.
  if (rows.some((r) => r.kind === "thank_you" && !r.doneAt)) {
    await reconcileThankYouJobs(userId, now);
    const fresh = await db.query.notifications.findMany({
      where: eq(notifications.userId, userId),
      orderBy: [desc(notifications.bumpedAt)],
      limit: 50,
    });
    rows.splice(0, rows.length, ...fresh);
  }

  const openRows = rows.filter((r) => !r.doneAt);
  const subjects = openRows.map((r) => r.subjectKey).filter((k): k is string => !!k);
  // Three kinds of subject, three ways of telling whether the work is done: a
  // firm (everyone there written to), a question bank (a round played), and one
  // rung of one person's follow-up ladder (that email sent, or they replied).
  const ladder = subjects
    .map((key) => ({ key, parsed: parseFollowUpSubject(key) }))
    .filter((x): x is { key: string; parsed: { contactId: string; step: number } } => !!x.parsed)
    .map(({ key, parsed }) => ({ key, ...parsed }));
  const [firmProgress, quizProgress, ladderProgress] = await Promise.all([
    outreachProgressBySubject(
      userId,
      // Anything with a prefix is not a firm. "thanks:" rows are closed by
      // their own rule (reconcileThankYouJobs), so they have no progress to count -
      // read as a firm, a contact id matches no one and would close at once.
      subjects.filter(
        (k) => !k.startsWith("quiz:") && !k.startsWith("ladder:") && !k.startsWith("thanks:"),
      ),
    ),
    quizProgressBySubject(userId, openRows),
    ladderProgressBySubject(userId, ladder),
  ]);
  const progress = new Map([...firmProgress, ...quizProgress, ...ladderProgress]);
  const remaining = new Map([...progress].map(([k, p]) => [k, p.remaining]));

  const toClose = autoCloseable(openRows, remaining, now);

  // An outreach job is about one opening at one firm. If that opening is no
  // longer coming - the posting taken down, the firm untracked, the date
  // moved - the job is not the student's to finish: it closes as expired,
  // rather than asking about a date that no longer exists until it passes.
  // A firm written to in full is left to the count above, which closes it as
  // done.
  // A "you found them, now write to them" job (lib/generated-reminders) is
  // about people, not an opening: it has no date to go stale against, and the
  // count above closes it once everyone at the firm has been written to.
  const openOutreach = openRows.filter(
    (r) => r.kind === "outreach" && !r.dedupeKey.startsWith("generated:") && !toClose.some((c) => c.id === r.id),
  );
  // An interview-prep job is about one interview on one date. Deleted, ticked
  // off, or moved to another day, the job it was is over: it closes as
  // expired, and the first banner for the new date files it again (a repeat
  // firing reopens and rewrites its row) - so the bell never counts down to a
  // date the interview is no longer on.
  const openPrep = openRows.filter(
    (r) => r.kind === "interview_prep" && r.dedupeKey.startsWith("interview:") && !toClose.some((c) => c.id === r.id),
  );
  if (openPrep.length > 0) {
    // Only real ids reach the query: a malformed key must not fail the bell.
    const ids = openPrep
      .map((r) => r.dedupeKey.slice("interview:".length))
      .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    const current = new Map(
      (
        ids.length === 0
          ? []
          : await db.query.events.findMany({
              where: and(eq(events.userId, userId), inArray(events.id, ids)),
              columns: { id: true, eventDate: true, completed: true, type: true, typeSource: true },
            })
      ).map((e) => [e.id, e]),
    );
    for (const r of openPrep) {
      const id = r.dedupeKey.slice("interview:".length);
      if (!ids.includes(id)) continue;
      const e = current.get(id);
      const moved = !!e && !!r.expiresAt && e.eventDate.getTime() !== r.expiresAt.getTime();
      // Re-filed by the student as something other than an interview: not one.
      const refiled = !!e && e.type !== "interview" && e.typeSource === "student";
      if (!e || e.completed || moved || refiled) toClose.push({ id: r.id, source: "expired" });
    }
  }

  // A deadline reminder's job lives while the application is open and not
  // applied to. Applied, closed or taken down: done (the student did it, or
  // it is no longer theirs to do). Past its deadline: expired.
  const openDeadline = openRows.filter(
    (r) => r.kind === "application_deadline" && !toClose.some((c) => c.id === r.id),
  );
  if (openDeadline.length > 0) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (user) {
      const [reminders, timeZone] = await Promise.all([getApplicationReminders(user, now), getStudentTimeZone()]);
      const zone = parseTimeZone(timeZone);
      const live = new Map(reminders.map((x) => [reminderNotificationKey(x.key), x]));
      for (const r of openDeadline) {
        const reminder = live.get(r.dedupeKey);
        if (reminder) {
          // Still open, but its deadline moved: the job names a date that is
          // no longer the deadline. It goes, and the next reminder files it
          // again with the right one.
          const d = reminder.deadline;
          const want = d ? zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate() + 1, 0, 0, zone) : null;
          if ((want?.getTime() ?? null) !== (r.expiresAt?.getTime() ?? null)) {
            toClose.push({ id: r.id, source: "expired" });
          }
          continue;
        }
        const passed = !!r.expiresAt && r.expiresAt.getTime() <= now.getTime();
        toClose.push({ id: r.id, source: passed ? "expired" : "auto" });
      }
    }
  }

  if (openOutreach.length > 0) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (user) {
      const [nudges, openingToday] = await Promise.all([
        getOutreachNudges(user, now),
        getOpeningToday(user, now),
      ]);
      const live = new Set([
        ...nudges.map((n) => outreachNotificationKey(n.firmKey, dayKey(n.opensOn))),
        // Today's "apply" jobs share the outreach kind.
        ...openingToday.map((o) => applyNotificationKey(o.firmKey, o.opensOn)),
      ]);
      for (const r of openOutreach) {
        if (!live.has(r.dedupeKey)) toClose.push({ id: r.id, source: "expired" });
      }
    }
  }
  if (toClose.length > 0) {
    const auto = toClose.filter((c) => c.source === "auto").map((c) => c.id);
    const expired = toClose.filter((c) => c.source === "expired").map((c) => c.id);
    await Promise.all([
      auto.length
        ? db
            .update(notifications)
            .set({ doneAt: now, doneSource: "auto" })
            .where(and(eq(notifications.userId, userId), inArray(notifications.id, auto)))
        : Promise.resolve(),
      expired.length
        ? db
            .update(notifications)
            .set({ doneAt: now, doneSource: "expired" })
            .where(and(eq(notifications.userId, userId), inArray(notifications.id, expired)))
        : Promise.resolve(),
    ]);
    const closedNow = new Map(toClose.map((c) => [c.id, c.source]));
    for (const row of rows) {
      const source = closedNow.get(row.id);
      if (source) {
        row.doneAt = now;
        row.doneSource = source;
      }
    }
  }

  await refreshGeneratedCopy(userId, rows, now);

  const list = toNotificationList(rows, progress);
  const firmOf = await firmsBehind(rows.filter((r) => !r.doneAt));
  for (const item of list.open) item.firm = firmOf.get(item.id) ?? null;
  return list;
}

/**
 * Rewrites each open "you found them, now write to them" job with who is left
 * at its firm now. The copy is otherwise written only when the reminder fires
 * (at three days and at seven), so the names would go stale as people were
 * emailed, and rows filed before 5 October 2026 would keep naming one person
 * instead of the firm. Writes only the rows whose words changed.
 */
async function refreshGeneratedCopy(userId: string, rows: NotificationRow[], now: Date): Promise<void> {
  const open = rows.filter((r) => !r.doneAt && r.kind === "outreach" && r.dedupeKey.startsWith("generated:"));
  if (open.length === 0) return;
  const fresh = new Map((await getUnreachedGenerated(userId, now)).map((f) => [generatedNotificationKey(f.firmKey), f]));
  const db = await getDb();
  for (const row of open) {
    const f = fresh.get(row.dedupeKey);
    if (!f) continue;
    const title = generatedTitle(f);
    const body = generatedDetail(f);
    if (title === row.title && body === row.body) continue;
    await db
      .update(notifications)
      .set({ title, body })
      .where(and(eq(notifications.userId, userId), eq(notifications.id, row.id)));
    row.title = title;
    row.body = body;
  }
}

/**
 * The firm behind each firm_posting / firm_event row, keyed by notification
 * id. One query per table, only for the ids that are there; a posting or event
 * since deleted just has no firm.
 */
async function firmsBehind(rows: NotificationRow[]): Promise<Map<string, { name: string; domain: string }>> {
  const refs = rows
    .map((r) => ({ id: r.id, ref: parseFirmNotificationKey(r.dedupeKey) }))
    .filter((x): x is { id: string; ref: { kind: "posting" | "event"; id: string } } => !!x.ref);
  if (refs.length === 0) return new Map();

  const postingIds = refs.filter((x) => x.ref.kind === "posting").map((x) => x.ref.id);
  const eventIds = refs.filter((x) => x.ref.kind === "event").map((x) => x.ref.id);
  const db = await getDb();
  const firmCols = { name: firms.name, domain: firms.website };
  const [postingFirms, eventFirms] = await Promise.all([
    postingIds.length === 0
      ? []
      : db
          .select({ id: internshipPostings.id, ...firmCols })
          .from(internshipPostings)
          .innerJoin(firms, eq(firms.id, internshipPostings.firmId))
          .where(inArray(internshipPostings.id, postingIds)),
    eventIds.length === 0
      ? []
      : db
          .select({ id: firmRecruitingEvents.id, ...firmCols })
          .from(firmRecruitingEvents)
          .innerJoin(firms, eq(firms.id, firmRecruitingEvents.firmId))
          .where(inArray(firmRecruitingEvents.id, eventIds)),
  ]);
  const byPosting = new Map(postingFirms.map((f) => [f.id, { name: f.name, domain: f.domain }]));
  const byEvent = new Map(eventFirms.map((f) => [f.id, { name: f.name, domain: f.domain }]));

  const out = new Map<string, { name: string; domain: string }>();
  for (const { id, ref } of refs) {
    const firm = (ref.kind === "posting" ? byPosting : byEvent).get(ref.id);
    if (firm) out.set(id, firm);
  }
  return out;
}

/**
 * Whether the student has practised since being told to.
 *
 * The question is not "how many are left" but "have they played a round since
 * this prompt fired". Any round, in any sector: the prompt no longer picks the
 * sector, the student does. A round is the whole job, so the answer is one or
 * zero.
 *
 * Rows sharing a subject share an answer, taken from the LATEST of them. New
 * rows are keyed per interview (`quiz:<event id>`); older rows were keyed per
 * question bank (`quiz:<sector>`), and read the same way - the part after the
 * prefix no longer matters.
 */
async function quizProgressBySubject(
  userId: string,
  openRows: NotificationRow[],
): Promise<Map<string, SubjectProgress>> {
  const since = new Map<string, Date>();
  for (const row of openRows) {
    if (!row.subjectKey?.startsWith("quiz:")) continue;
    const current = since.get(row.subjectKey);
    if (!current || row.bumpedAt > current) since.set(row.subjectKey, row.bumpedAt);
  }
  if (since.size === 0) return new Map();

  const db = await getDb();
  const sessions = await db.query.practiceSessions.findMany({
    where: eq(practiceSessions.userId, userId),
    columns: { createdAt: true },
  });

  const out = new Map<string, SubjectProgress>();
  for (const [subject, firedAt] of since) {
    const played = sessions.some((s) => s.createdAt >= firedAt);
    // total 1, so the full page can render "0 of 1" as an honest bar.
    out.set(subject, { remaining: played ? 0 : 1, total: 1 });
  }
  return out;
}

/**
 * How far through each watched firm the student is.
 *
 * One query for every firm at once, and counted from the contacts table rather
 * than from the outreach selector, so it stays true after the opening has
 * passed and the firm has dropped out of that window - "did they do it" and "is
 * it still worth doing" are different questions.
 */
async function outreachProgressBySubject(
  userId: string,
  subjectKeys: string[],
): Promise<Map<string, SubjectProgress>> {
  const wanted = new Set(subjectKeys);
  if (wanted.size === 0) return new Map();

  const db = await getDb();
  const [rows, tracked] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: { firm: true, name: true, relationshipStatus: true },
    }),
    // Their firms' names and aliases - the same list the banner resolves
    // against, so "CVP" is counted at Centerview here too.
    trackedFirmNames(userId),
  ]);
  const resolveFirm = firmResolver(tracked);

  // People, not rows, counted the way the banner and the to-do row count them
  // (lib/application-outreach.ts): the same person saved twice is one person,
  // and written to if either copy has been - so the bell's "1 of 5 emailed"
  // never sits beside "3 contacts still to email".
  const people = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    if (!row.firm?.trim()) continue;
    const key = resolveFirm(row.firm);
    if (!wanted.has(key)) continue;
    const byName = people.get(key) ?? new Map<string, boolean>();
    const name = row.name.trim().toLowerCase();
    byName.set(name, (byName.get(name) ?? false) || row.relationshipStatus !== "not_contacted");
    people.set(key, byName);
  }

  // Every watched firm starts at zero, so a firm the student has no
  // un-contacted people at reads as finished rather than as unknown.
  const counts = new Map<string, SubjectProgress>();
  for (const key of wanted) {
    const byName = people.get(key);
    const total = byName?.size ?? 0;
    const reached = byName ? [...byName.values()].filter(Boolean).length : 0;
    counts.set(key, { remaining: total - reached, total });
  }
  return counts;
}

/** Close one job by its key rather than its id - for a job closed from
 *  somewhere that never saw the row, like the to-do list. */
export async function closeNotificationByKey(
  userId: string,
  dedupeKey: string,
  source: "manual" | "auto",
  now: Date = new Date(),
) {
  const db = await getDb();
  await db
    .update(notifications)
    .set({ doneAt: now, doneSource: source })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.dedupeKey, dedupeKey),
        isNull(notifications.doneAt),
      ),
    );
}

/** Tick one off by hand. Idempotent, and never reopens a closed row. */
export async function markNotificationDone(userId: string, id: string, now: Date = new Date()) {
  const db = await getDb();
  await db
    .update(notifications)
    .set({ doneAt: now, doneSource: "manual" })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.userId, userId),
        isNull(notifications.doneAt),
      ),
    );
}

/** Opening the panel is reading it. Marks only what is on screen now. */
export async function markNotificationsRead(userId: string, now: Date = new Date()) {
  const db = await getDb();
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.doneAt),
      ),
    );
}

/** Count alone, for the badge, without building the list. */
export async function countOpenNotifications(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.doneAt)));
  return Number(row?.n ?? 0);
}
