import "server-only";
import { randomUUID } from "crypto";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firmRecruitingEvents, firms, internshipPostings, notifications, schools } from "@/db/schema";
import { canManageFirmRow, isActiveFirmAccount, type FirmAccount } from "@/lib/firm-account";
import {
  notifyMatchedStudentsOfEvent,
  notifyMatchedStudentsOfPosting,
  reviseEventNotes,
  revisePostingNoteExpiry,
} from "@/lib/firm-delivery";
import { eventChange, eventNotificationKey, postingNotificationKey } from "@/lib/firm-delivery-rules";
import { composeDescription, type EventInput, type PostingInput } from "@/lib/firm-posting-rules";

// Writing what a firm posts. Every function here takes the signed-in account
// and checks it owns the row (lib/firm-account canManageFirmRow) before it
// reads or writes anything, so one firm can never touch another's posts.
// The language check happens in the server actions that call these, before
// anything reaches this file.

type PortalUser = FirmAccount & { isDemo: boolean };

/**
 * Whether what this account posts is a demo post. The FIRM decides, not only
 * the account: anything posted for a demo firm must stay with demo accounts,
 * whoever pressed post.
 */
async function postsAreDemo(user: PortalUser): Promise<boolean> {
  if (user.isDemo) return true;
  const db = await getDb();
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, user.orgFirmId!), columns: { isDemo: true } });
  return !!firm?.isDemo;
}

/**
 * When a firm closes a post, the notes students were sent about it close too:
 * a bell row pointing at a role that is no longer listed is a dead end.
 * "expired" rather than "manual" - the student did not finish anything.
 */
export async function closeStudentNotes(dedupeKey: string): Promise<void> {
  const db = await getDb();
  await db
    .update(notifications)
    .set({ doneAt: new Date(), doneSource: "expired" })
    .where(and(eq(notifications.dedupeKey, dedupeKey), isNull(notifications.doneAt)));
}

/** Postgres' unique_violation, whichever driver raised it. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

const TAKEN_DOWN = "Offerly removed this post. Email the Offerly team if you think that was a mistake.";

/**
 * `notified` is the students told about this post by THIS save - new posts,
 * and edits that made more students eligible - so the caller can email them
 * (lib/firm-post-emails) after the response.
 */
export type SaveResult = { ok: true; id: string; notified?: string[] } | { ok: false; error: string };

export async function getPortalFirm(user: PortalUser) {
  if (!user.orgFirmId) return null;
  const db = await getDb();
  return (await db.query.firms.findFirst({ where: eq(firms.id, user.orgFirmId) })) ?? null;
}

// ---------- internships ----------

export async function listFirmPostings(user: PortalUser) {
  if (!isActiveFirmAccount(user)) return [];
  const db = await getDb();
  return db
    .select()
    .from(internshipPostings)
    .where(and(eq(internshipPostings.firmId, user.orgFirmId!), eq(internshipPostings.origin, "firm")))
    .orderBy(desc(internshipPostings.isActive), desc(internshipPostings.updatedAt));
}

export async function getFirmPosting(user: PortalUser, id: string) {
  const db = await getDb();
  const row = await db.query.internshipPostings.findFirst({ where: eq(internshipPostings.id, id) });
  if (!row || row.origin !== "firm" || !canManageFirmRow(user, row.firmId)) return null;
  return row;
}

/**
 * Creates a posting, or updates one the firm already owns.
 *
 * A (firm, role title, summer) can only exist once - the table's unique index
 * says so. When the crawler already filed that exact role from the careers
 * site, the firm's own version takes the row over: the firm is the better
 * source for its own posting, and savePosting leaves "firm" rows alone from
 * then on.
 */
export async function saveFirmPosting(user: PortalUser, id: string | null, input: PostingInput): Promise<SaveResult> {
  if (!isActiveFirmAccount(user)) return { ok: false, error: "Your account isn't approved to post yet." };
  const firmId = user.orgFirmId!;
  const db = await getDb();
  const isDemo = await postsAreDemo(user);

  // Written on every save. Open/closed is NOT here: editing a closed posting
  // must not quietly put it back in front of students - reopening is its own
  // button (setFirmPostingOpen).
  const values = {
    firmId,
    categories: input.categories,
    roleTitle: input.roleTitle,
    location: input.location,
    programYear: input.programYear,
    eligibleGradYears: input.eligibleGradYears,
    deadlineStatus: input.deadlineStatus,
    deadlineText: input.deadlineStatus === "rolling" ? "Rolling applications" : null,
    deadlineDate: input.deadlineDate,
    opensAt: input.opensAt,
    opensText: null,
    descriptionFull: composeDescription(input.description, input.extraFields),
    requirementsFull: input.requirements,
    // "Read the full posting" links here. The firm's own application page is
    // the full posting when there is one; otherwise there is nothing further
    // to read, and an empty source hides the link.
    sourceUrl: input.applicationUrl ?? "",
    applicationUrl: input.applicationUrl,
    recruiterName: input.recruiterName,
    recruiterTitle: input.recruiterTitle,
    recruiterEmail: input.recruiterEmail,
    recruiterPhone: null,
    extraFields: input.extraFields,
    origin: "firm",
    postedByUserId: user.id,
    isDemo,
    lastCheckedAt: new Date(),
    updatedAt: new Date(),
  };
  const DUPLICATE = "You already have a posting with this title for that summer. Edit that one instead.";

  const clash = await db.query.internshipPostings.findFirst({
    where: and(
      eq(internshipPostings.firmId, firmId),
      eq(internshipPostings.roleTitle, input.roleTitle),
      eq(internshipPostings.programYear, input.programYear),
      id ? ne(internshipPostings.id, id) : undefined,
    ),
    columns: { id: true, origin: true },
  });
  if (clash?.origin === "firm") return { ok: false, error: DUPLICATE };

  let postingId: string;
  let isActive = true;
  try {
    if (id) {
      const existing = await getFirmPosting(user, id);
      if (!existing) return { ok: false, error: "That posting isn't yours to edit." };
      // Editing onto a crawled row's (role, year) would collide on the unique
      // index; the crawled copy is replaced by this one.
      if (clash) await db.delete(internshipPostings).where(eq(internshipPostings.id, clash.id));
      await db.update(internshipPostings).set(values).where(eq(internshipPostings.id, id));
      postingId = id;
      isActive = existing.isActive;
      if ((existing.deadlineDate?.getTime() ?? null) !== (input.deadlineDate?.getTime() ?? null)) {
        await revisePostingNoteExpiry(id, input.deadlineDate);
      }
    } else if (clash) {
      await db.update(internshipPostings).set({ ...values, isActive: true }).where(eq(internshipPostings.id, clash.id));
      postingId = clash.id;
    } else {
      const [row] = await db.insert(internshipPostings).values({ ...values, isActive: true }).returning();
      postingId = row.id;
    }
  } catch (err) {
    // Two saves of the same role at once: the index let one through, and the
    // other gets the same answer the check above would have given it.
    if (isUniqueViolation(err)) return { ok: false, error: DUPLICATE };
    throw err;
  }

  // New, or edited while open: tell the matched students who can apply. The
  // dedupe key is the posting, so anyone told before is never told twice -
  // on an edit this reaches only students the edit made eligible.
  let notified: string[] = [];
  if (isActive) {
    notified = await notifyMatchedStudentsOfPosting({
      postingId,
      firmId,
      roleTitle: input.roleTitle,
      categories: input.categories,
      eligibleGradYears: input.eligibleGradYears,
      deadlineDate: input.deadlineDate,
      isDemo,
    });
  }
  return { ok: true, id: postingId, notified };
}

/** Closes a posting (students stop seeing it) or reopens it. Never deletes: its analytics stay. */
export async function setFirmPostingOpen(user: PortalUser, id: string, open: boolean): Promise<SaveResult> {
  const existing = await getFirmPosting(user, id);
  if (!existing) return { ok: false, error: "That posting isn't yours to change." };
  if (open && existing.takenDownAt) return { ok: false, error: TAKEN_DOWN };
  const db = await getDb();
  await db.update(internshipPostings).set({ isActive: open, updatedAt: new Date() }).where(eq(internshipPostings.id, id));
  if (!open) await closeStudentNotes(postingNotificationKey(id));
  return { ok: true, id };
}

// ---------- events ----------

export async function listFirmEvents(user: PortalUser) {
  if (!isActiveFirmAccount(user)) return [];
  const db = await getDb();
  return db
    .select()
    .from(firmRecruitingEvents)
    .where(and(eq(firmRecruitingEvents.firmId, user.orgFirmId!), eq(firmRecruitingEvents.origin, "firm")))
    .orderBy(desc(firmRecruitingEvents.isActive), desc(firmRecruitingEvents.eventDate));
}

export async function getFirmEvent(user: PortalUser, id: string) {
  const db = await getDb();
  const row = await db.query.firmRecruitingEvents.findFirst({ where: eq(firmRecruitingEvents.id, id) });
  if (!row || row.origin !== "firm" || !canManageFirmRow(user, row.firmId)) return null;
  return row;
}

/** Resolves school ids to names, dropping any id that is not a real school. */
async function schoolNames(ids: string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  return db.select({ id: schools.id, name: schools.name }).from(schools).where(inArray(schools.id, ids));
}

export async function saveFirmEvent(user: PortalUser, id: string | null, input: EventInput): Promise<SaveResult> {
  if (!isActiveFirmAccount(user)) return { ok: false, error: "Your account isn't approved to post yet." };
  const firmId = user.orgFirmId!;
  const db = await getDb();
  const isDemo = await postsAreDemo(user);

  const picked = await schoolNames(input.schoolIds);
  if (input.schoolIds.length > 0 && picked.length === 0) return { ok: false, error: "Pick the schools from the list." };

  // As with postings, open/closed is not written on an edit.
  const values = {
    firmId,
    title: input.title,
    eventKind: input.kind,
    kindLabel: input.kindLabel,
    eventDate: input.startsAt,
    endsAt: input.endsAt,
    registrationDeadline: input.registrationDeadline,
    schoolIds: picked.map((s) => s.id),
    school: picked.length ? picked.map((s) => s.name).join(", ") : null,
    format: input.format,
    location: input.format === "virtual" ? "Virtual" : input.location,
    rsvpUrl: input.rsvpUrl,
    descriptionRaw: input.description,
    origin: "firm",
    postedByUserId: user.id,
    isDemo,
    lastConfirmedAt: new Date(),
    updatedAt: new Date(),
  };

  let eventId: string;
  let isActive = true;
  if (id) {
    const existing = await getFirmEvent(user, id);
    if (!existing) return { ok: false, error: "That event isn't yours to edit." };
    await db.update(firmRecruitingEvents).set(values).where(eq(firmRecruitingEvents.id, id));
    eventId = id;
    isActive = existing.isActive;
    // Students already told about it hear that it moved.
    const change = eventChange({ startsAt: existing.eventDate, location: existing.location }, { startsAt: input.startsAt, location: values.location });
    if (change && isActive && input.startsAt.getTime() > Date.now()) {
      await reviseEventNotes({
        eventId: id,
        firmId,
        title: input.title,
        kind: input.kind,
        kindLabel: input.kindLabel,
        startsAt: input.startsAt,
        location: values.location,
        change,
      });
    }
  } else {
    eventId = randomUUID();
    await db.insert(firmRecruitingEvents).values({
      id: eventId,
      ...values,
      isActive: true,
      // The identity column must be unique per firm; a firm event's own id is.
      // Students reach the RSVP link through /api/firm-events/[id]/open.
      eventUrl: `offerly:firm-event:${eventId}`,
    });
  }

  // New, or edited while open and still ahead: tell matched students at the
  // event's schools. Keyed by the event, so a school added on an edit reaches
  // its students and nobody hears twice.
  let notified: string[] = [];
  if (isActive && input.startsAt.getTime() > Date.now()) {
    notified = await notifyMatchedStudentsOfEvent({
      eventId,
      firmId,
      title: input.title,
      kind: input.kind,
      kindLabel: input.kindLabel,
      startsAt: input.startsAt,
      schoolIds: values.schoolIds,
      isDemo,
    });
  }
  return { ok: true, id: eventId, notified };
}

export async function setFirmEventOpen(user: PortalUser, id: string, open: boolean): Promise<SaveResult> {
  const existing = await getFirmEvent(user, id);
  if (!existing) return { ok: false, error: "That event isn't yours to change." };
  if (open && existing.takenDownAt) return { ok: false, error: TAKEN_DOWN };
  const db = await getDb();
  await db.update(firmRecruitingEvents).set({ isActive: open, updatedAt: new Date() }).where(eq(firmRecruitingEvents.id, id));
  if (!open) await closeStudentNotes(eventNotificationKey(id));
  return { ok: true, id };
}
