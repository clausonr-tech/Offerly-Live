import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firms, notifications, users, userTopFirms } from "@/db/schema";
import type { FirmProgramCategory } from "@/lib/firm-metadata";
import {
  eventNotificationKey,
  postingNotificationKey,
  shouldNotifyOfEvent,
  shouldNotifyOfPosting,
  type MatchedStudent,
} from "@/lib/firm-delivery-rules";
import { eventKindLabel, type FirmEventKind } from "@/lib/firm-posting-rules";
import { safeNotificationHref } from "@/lib/notifications";

// Tells matched students when a firm posts. The rules for who counts are in
// lib/firm-delivery-rules.ts; this file reads the matches and writes the
// notifications, one bell row per student per post.

async function matchedStudents(firmId: string): Promise<MatchedStudent[]> {
  const db = await getDb();
  return db
    .select({
      userId: users.id,
      gradYear: users.gradYear,
      schoolId: users.schoolId,
      claimedSchoolId: users.claimedSchoolId,
      isDemo: users.isDemo,
    })
    .from(userTopFirms)
    .innerJoin(users, eq(users.id, userTopFirms.userId))
    .where(and(eq(userTopFirms.firmId, firmId), eq(users.accountType, "student")));
}

async function firmFor(firmId: string) {
  const db = await getDb();
  return db.query.firms.findFirst({ where: eq(firms.id, firmId), columns: { name: true, slug: true } });
}

type Row = typeof notifications.$inferInsert;

/**
 * One row per student, and never a second: the dedupe key is the post, so
 * editing a posting later does not notify anyone again. Returns the students
 * told THIS time - the ones whose row is new - so the caller can email exactly
 * them (lib/firm-post-emails) and nobody twice.
 */
async function insertAll(rows: Row[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const db = await getDb();
  const told: string[] = [];
  // Chunked: a large firm can be on thousands of lists, and one statement
  // with that many parameters would hit Postgres' parameter limit.
  for (let i = 0; i < rows.length; i += 500) {
    const inserted = await db
      .insert(notifications)
      // The same link rule as every other job (safeNotificationHref).
      .values(rows.slice(i, i + 500).map((r) => ({ ...r, href: safeNotificationHref(r.href) })))
      .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
      .returning();
    for (const r of inserted) told.push(r.userId);
  }
  return told;
}

export async function notifyMatchedStudentsOfPosting(p: {
  postingId: string;
  firmId: string;
  roleTitle: string;
  categories: FirmProgramCategory[];
  eligibleGradYears: number[];
  deadlineDate: Date | null;
  isDemo: boolean;
}): Promise<string[]> {
  const firm = await firmFor(p.firmId);
  if (!firm) return [];
  const students = (await matchedStudents(p.firmId)).filter((s) => shouldNotifyOfPosting(s, p));
  const now = new Date();
  const due = p.deadlineDate
    ? ` · apply by ${p.deadlineDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "";
  const category = p.categories[0];
  return insertAll(
    students.map((s) => ({
      userId: s.userId,
      kind: "firm_posting" as const,
      dedupeKey: postingNotificationKey(p.postingId),
      title: `${firm.name} posted a new internship`,
      body: `${p.roleTitle}${due}`,
      // The industry's internships list, where the posting sits with its Apply button.
      href: category ? `/discovery/${category}/internships` : `/discovery/firm/${firm.slug}`,
      subjectKey: null,
      expiresAt: p.deadlineDate,
      createdAt: now,
      bumpedAt: now,
    })),
  );
}

export async function notifyMatchedStudentsOfEvent(e: {
  eventId: string;
  firmId: string;
  title: string;
  kind: FirmEventKind;
  kindLabel?: string | null;
  startsAt: Date;
  schoolIds: string[];
  isDemo: boolean;
}): Promise<string[]> {
  const firm = await firmFor(e.firmId);
  if (!firm) return [];
  const students = (await matchedStudents(e.firmId)).filter((s) => shouldNotifyOfEvent(s, e));
  const now = new Date();
  const when = e.startsAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return insertAll(
    students.map((s) => ({
      userId: s.userId,
      kind: "firm_event" as const,
      dedupeKey: eventNotificationKey(e.eventId),
      title: `${firm.name}: ${eventKindLabel(e.kind, e.kindLabel).toLowerCase()}${e.schoolIds.length ? " at your school" : ""}`,
      body: `${e.title} · ${when}`,
      href: `/discovery/firm/${firm.slug}`,
      subjectKey: null,
      // The moment passes when the event starts.
      expiresAt: e.startsAt,
      createdAt: now,
      bumpedAt: now,
    })),
  );
}

/**
 * An event students were already told about moved. Their existing note is
 * rewritten and put back at the top, unread - one row that says what is true
 * now, rather than a second row beside a stale one. Students who dismissed it
 * are told again: a changed time is worth knowing even about an event they
 * had put aside. Returns how many notes were revised.
 */
export async function reviseEventNotes(e: {
  eventId: string;
  firmId: string;
  title: string;
  kind: FirmEventKind;
  kindLabel?: string | null;
  startsAt: Date;
  location: string | null;
  change: "time" | "place" | "time and place";
}): Promise<number> {
  const firm = await firmFor(e.firmId);
  if (!firm) return 0;
  const db = await getDb();
  const now = new Date();
  const when = e.startsAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const revised = await db
    .update(notifications)
    .set({
      title: `${firm.name}: ${eventKindLabel(e.kind, e.kindLabel).toLowerCase()} ${e.change === "place" ? "has a new place" : "has moved"}`,
      body: `${e.title} · now ${when}${e.location ? ` · ${e.location}` : ""}`,
      expiresAt: e.startsAt,
      bumpedAt: now,
      readAt: null,
      doneAt: null,
      doneSource: null,
    })
    .where(eq(notifications.dedupeKey, eventNotificationKey(e.eventId)))
    .returning();
  return revised.length;
}

/** A posting's deadline moved: its notes now leave the bell at the new deadline, without re-alerting anyone. */
export async function revisePostingNoteExpiry(postingId: string, deadlineDate: Date | null): Promise<void> {
  const db = await getDb();
  await db
    .update(notifications)
    .set({ expiresAt: deadlineDate })
    .where(and(eq(notifications.dedupeKey, postingNotificationKey(postingId)), isNull(notifications.doneAt)));
}
