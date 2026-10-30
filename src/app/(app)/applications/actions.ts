"use server";

import { blockedInForm, blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applicationContacts, applications, contacts } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { applicationSchema } from "@/lib/validation";
import { recordOffer, retractOffer } from "@/lib/activity";
import { localDateString } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { findSameApplication } from "@/lib/application-identity";

export type ActionState = { error?: string } | undefined;

const APPLICATION_LABELS: Record<string, string> = {
  firm: "Firm",
  role: "Role",
  compensation: "Compensation",
  notes: "Notes",
};

function readApplicationForm(formData: FormData) {
  return applicationSchema.safeParse({
    firm: formData.get("firm"),
    role: formData.get("role"),
    status: formData.get("status"),
    category: formData.get("category") ?? "",
    compensation: formData.get("compensation") ?? "",
    applicationUrl: formData.get("applicationUrl") ?? "",
    notes: formData.get("notes") ?? "",
    appliedDate: formData.get("appliedDate") ?? "",
  });
}

async function syncContactLinks(
  applicationId: string,
  userId: string,
  formData: FormData,
) {
  const db = await getDb();
  const requestedIds = formData.getAll("contactIds").map(String);

  // only keep ids that are actually this user's contacts
  const ownedContacts =
    requestedIds.length > 0
      ? await db.query.contacts.findMany({
          where: eq(contacts.userId, userId),
        })
      : [];
  const ownedIds = new Set(ownedContacts.map((c) => c.id));
  const validIds = requestedIds.filter((id) => ownedIds.has(id));

  await db
    .delete(applicationContacts)
    .where(eq(applicationContacts.applicationId, applicationId));

  if (validIds.length > 0) {
    await db
      .insert(applicationContacts)
      .values(validIds.map((contactId) => ({ applicationId, contactId })));
  }
}

export async function createApplication(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = readApplicationForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const blocked = blockedInForm(formData, APPLICATION_LABELS, ["status", "category", "applicationUrl", "appliedDate", "contactIds"]);
  if (blocked) return { error: blocked };

  const userId = await getCurrentUserId();
  const db = await getDb();
  // Already on the tracker under another spelling: open that one rather than
  // start a second record of the same application.
  const same = await findSameApplication(userId, parsed.data.firm, parsed.data.role);
  if (same) redirect(`/applications/${same.id}`);
  const [created] = await db
    .insert(applications)
    .values({
      userId,
      firm: parsed.data.firm,
      role: parsed.data.role,
      status: parsed.data.status,
      category: parsed.data.category || null,
      compensation: parsed.data.compensation ? Number(parsed.data.compensation) : null,
      applicationUrl: parsed.data.applicationUrl || null,
      notes: parsed.data.notes || null,
      appliedDate: parsed.data.appliedDate || null,
    })
    .returning();

  await syncContactLinks(created.id, userId, formData);
  // An application can be entered as an offer outright - somebody logging a
  // result they already have - so the create path posts too, not just the edit.
  if (parsed.data.status === "offer") {
    await recordOffer(userId, created.id, parsed.data.firm, parsed.data.role);
  }

  revalidatePath("/applications");
  revalidatePath("/dashboard");
  redirect(`/applications/${created.id}`);
}

export async function updateApplication(
  applicationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = readApplicationForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const blocked = blockedInForm(formData, APPLICATION_LABELS, ["status", "category", "applicationUrl", "appliedDate", "contactIds"]);
  if (blocked) return { error: blocked };

  const userId = await getCurrentUserId();
  const db = await getDb();
  const updated = await db
    .update(applications)
    .set({
      firm: parsed.data.firm,
      role: parsed.data.role,
      status: parsed.data.status,
      category: parsed.data.category || null,
      compensation: parsed.data.compensation ? Number(parsed.data.compensation) : null,
      applicationUrl: parsed.data.applicationUrl || null,
      notes: parsed.data.notes || null,
      appliedDate: parsed.data.appliedDate || null,
      updatedAt: new Date(),
    })
    .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)))
    .returning();
  // Not the caller's application: nothing else below may touch it either -
  // the offer note and the contact links are keyed on this id alone.
  if (updated.length === 0) return { error: "That application no longer exists." };

  // Keyed on the application id, so an offer edited, toggled to rejected and
  // back, or simply re-saved, announces itself exactly once.
  //
  // And taken back down when the status leaves "offer". Announcing was the
  // only half that was wired up: a student who picked "offer" by mistake, or
  // whose offer fell through and who moved the row to "rejected", left the
  // announcement standing with no way to reach it from the tracker. The
  // dedupe key is the application id either way, so retracting leaves the
  // path free to announce again if the status comes back - which is what makes
  // a correction a correction rather than a one-way door.
  if (parsed.data.status === "offer") {
    await recordOffer(userId, applicationId, parsed.data.firm, parsed.data.role);
  } else {
    await retractOffer(userId, applicationId);
  }

  await syncContactLinks(applicationId, userId, formData);

  revalidatePath("/applications");
  revalidatePath(`/applications/${applicationId}`);
  revalidatePath("/dashboard");
  redirect(`/applications/${applicationId}`);
}

export async function deleteApplication(applicationId: string) {
  const userId = await getCurrentUserId();
  const db = await getDb();
  // Before the row goes, so does anything it published. The application is the
  // only thing that ever pointed at that feed row - nothing else deletes it,
  // and once the application is gone the student has no surface left that
  // mentions it - so deleting the tracker row while leaving "Got an offer at
  // Evercore" in the feed is the one case where the announcement outlives
  // every trace of what made it. Scoped to this student and this application
  // id (lib/activity retractOffer), so it cannot reach anyone else's row.
  await retractOffer(userId, applicationId);
  await db
    .delete(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));

  revalidatePath("/applications");
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

// One-click "add this opportunity to my pipeline" from the Top/Other
// Applications discovery rows - a lighter-weight insert than the full
// createApplication form, with sensible defaults (not_started, no comp).
export async function quickAddApplication(input: {
  firm: string;
  role: string;
  applicationUrl: string;
  category: string | null;
}): Promise<{ alreadyTracked: boolean }> {
  const blocked = blockedLanguageError([["Firm", input.firm], ["Role", input.role]]);
  if (blocked) throw new Error(blocked);
  const userId = await getCurrentUserId();
  const db = await getDb();

  // The same role however it is written - never a second row for it.
  const existing = await findSameApplication(userId, input.firm, input.role);
  if (existing) return { alreadyTracked: true };

  const inserted = await db
    .insert(applications)
    .values({
      userId,
      firm: input.firm,
      role: input.role,
      applicationUrl: input.applicationUrl || null,
      category: (input.category as (typeof applications.$inferInsert)["category"]) ?? null,
    })
    // The read above is a fast path and a nicer answer, not the guarantee.
    // Two clicks on the same Track button race it, and before
    // `applications_user_firm_role_key` existed that is how a student ended up
    // with the same role listed twice. A conflict here means somebody else won
    // the race and the row now exists, which is "already tracked" by any
    // reading the caller cares about.
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return { alreadyTracked: true };

  // Tracking something does put it on the calendar - but from the POSTING's
  // own date, rendered onto the Schedule grid on every load, not from a
  // guessed "(estimated window)" event written here. See
  // lib/deadline-reminders.ts for what used to happen and why it stopped.

  revalidatePath("/applications");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");
  revalidatePath("/discovery");
  return { alreadyTracked: false };
}

/**
 * The other half of quickAddApplication: stop tracking a posting.
 *
 * Keyed on (firm, role) rather than an application id because the callers are
 * posting cards, which know what they are but not which pipeline row they
 * produced - the same pair the pipeline itself treats as one application.
 *
 * This deletes the row. That is what "stop tracking" means, and re-tracking
 * makes a fresh one - but it does mean a row the student has since worked on
 * (status moved, notes written, applied date stamped) loses that work. So the
 * work is reported back rather than silently discarded: the caller gets
 * `hadProgress`, and can say so instead of the change looking free.
 */
export async function untrackApplication(input: {
  firm: string;
  role: string;
}): Promise<{ untracked: boolean; hadProgress: boolean }> {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const existing = await db.query.applications.findFirst({
    where: and(
      eq(applications.userId, userId),
      eq(applications.firm, input.firm),
      eq(applications.role, input.role),
    ),
  });
  if (!existing) return { untracked: false, hadProgress: false };

  const hadProgress =
    existing.status !== "not_started" ||
    !!existing.appliedDate ||
    !!existing.compensation ||
    // The marker autoTrackInternships writes is ours, not the student's, so it
    // does not count as work they would miss.
    !!(existing.notes && !existing.notes.startsWith("Auto-tracked from"));

  await db.delete(applications).where(eq(applications.id, existing.id));
  // As in deleteApplication: the row goes, so its announcement goes. Nothing
  // cascades, because an offer event finds its application through a plain text
  // dedupe key with no foreign key.
  await retractOffer(userId, existing.id);

  revalidatePath("/applications");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");
  revalidatePath("/discovery");
  return { untracked: true, hadProgress };
}

// Checking an application off the schedule to-do list.
//
// Deliberately narrow: it only ever moves an application forward out of the
// pre-submission states, and only for rows the caller owns. It is the single
// write behind the school application count, so it must not be able to inflate
// that count by being called repeatedly - re-checking a row that is already
// submitted is a no-op, and appliedDate is only stamped on the first transition.
export async function markApplicationApplied(applicationId: string) {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const existing = await db.query.applications.findFirst({
    where: and(eq(applications.id, applicationId), eq(applications.userId, userId)),
    columns: { id: true, status: true, appliedDate: true },
  });
  if (!existing) return;
  if (existing.status !== "not_started" && existing.status !== "in_progress") return;

  await db
    .update(applications)
    .set({
      status: "submitted",
      // The student's own date: a New York evening is still today, not UTC's tomorrow.
      appliedDate: existing.appliedDate ?? localDateString(new Date(), await getStudentTimeZone()),
      updatedAt: new Date(),
    })
    .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));

  revalidatePath("/schedule");
  revalidatePath("/applications");
  revalidatePath("/dashboard");
  revalidatePath("/learn");
}

// Manual add from the Schedule page, for anything not in the firm directory.
//
// Routes through the same path as the Track button rather than a second insert,
// so a hand-typed application gets the identical treatment: a dated reminder on
// the schedule and, when Google is connected, a push to that calendar - with no
// second click anywhere.
export async function addApplicationFromSchedule(formData: FormData) {
  const firm = String(formData.get("firm") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const applicationUrl = String(formData.get("applicationUrl") ?? "").trim();
  if (!firm || !role) return;
  const blocked = blockedLanguageError([["Firm", firm], ["Role", role]]);
  if (blocked) throw new Error(blocked);

  await quickAddApplication({ firm, role, applicationUrl, category: null });
  revalidatePath("/schedule");
}
