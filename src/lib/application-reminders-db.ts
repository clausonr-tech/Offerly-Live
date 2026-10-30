import "server-only";
import { and, eq, gte, inArray, like, or } from "drizzle-orm";

import { getDb } from "@/db/client";
import { applications, events, firms, flashesShown, internshipPostings, todoDismissals } from "@/db/schema";
import {
  openApplications,
  reminderNotificationKey,
  selectReminders,
  type OpenApplication,
  type ApplicationReminder,
  type ReminderCandidate,
} from "@/lib/application-reminders";
import { retractOffer } from "@/lib/activity";
import { trackedFirmNames } from "@/lib/tracked-firms";
import { applyNotificationKey } from "@/lib/application-outreach";
import { firmResolver } from "@/lib/firm-name";
import { sameRole } from "@/lib/role-name";
import { internshipYearFor } from "@/lib/internship-year";
import { findSameApplication } from "@/lib/application-identity";
import { closeNotificationByKey } from "@/lib/notifications";
import { localDateString, parseTimeZone, zonedTime } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { getUpcomingApplications } from "@/lib/upcoming-applications";

// The queries behind the deadline reminders. The rules are in
// application-reminders.ts.

type ReminderUser = Parameters<typeof getUpcomingApplications>[0];

/** Statuses that mean "applied, or past applying" - never reminded. */
const APPLIED = new Set(["submitted", "interviewing", "offer", "rejected"]);
/** Statuses that are still to do. */
const TO_DO = new Set(["not_started", "in_progress"]);

/**
 * Every open application this student has not applied to.
 *
 * Two sources, as agreed: open real postings at the firms on their list that
 * fit what they said they want (the Upcoming panel's own admission, uncapped),
 * and anything on their applications tracker still marked to do. A tracker
 * entry and a posting that are the same role are one application, and a role
 * the tracker says they applied to is never reminded. A tracker entry no
 * posting speaks for is reminded only when a deadline for it is on their
 * Schedule - there is nothing else to count down to.
 */
export async function getReminderCandidates(user: ReminderUser, now: Date = new Date()): Promise<ReminderCandidate[]> {
  const db = await getDb();
  const [windows, tracker, timeZone] = await Promise.all([
    // Every row, not merged by group: two roles at one firm are two
    // applications. The same role posted twice is merged below, by role.
    getUpcomingApplications(user, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false),
    db.query.applications.findMany({
      where: eq(applications.userId, user.id),
      columns: { id: true, firm: true, role: true, status: true, applicationUrl: true },
    }),
    getStudentTimeZone(),
  ]);

  const today = localDateString(now, parseTimeZone(timeZone));
  const opensToday = (w: (typeof windows.current)[number]) =>
    w.kind === "opens" && !!w.date && w.date.toISOString().slice(0, 10) === today;
  const open = windows.current.filter((w) => (w.kind === "due" && w.date) || w.rolling || opensToday(w));
  const resolve = firmResolver(await trackedFirmNames(user.id));
  // Same firm (any name it goes by) and same role (any word order,
  // abbreviation, or a year or city left off one side) is the same
  // application - never two reminders, never two tracker rows.
  const same = (x: { firm: string; role: string }, y: { firm: string; role: string }) =>
    resolve(x.firm) === resolve(y.firm) && sameRole(x.role, y.role);

  const applied = tracker.filter((a) => APPLIED.has(a.status));
  const toDo = tracker.filter((a) => TO_DO.has(a.status));

  const out: ReminderCandidate[] = [];
  const spokenFor: { firm: string; role: string }[] = [];
  // Soonest first, so a role posted twice is reminded about its sooner date.
  const bySoonest = [...open].sort(
    (a, b) => (a.date?.getTime() ?? Number.POSITIVE_INFINITY) - (b.date?.getTime() ?? Number.POSITIVE_INFINITY),
  );
  for (const w of bySoonest) {
    const k = { firm: w.firmName, role: w.roleTitle };
    if (spokenFor.some((p) => same(p, k))) continue;
    spokenFor.push(k);
    if (applied.some((a) => same(a, k))) continue;
    out.push({
      key: `posting:${w.id}`,
      firmName: w.firmName,
      role: w.roleTitle,
      applyUrl: w.applyUrl,
      deadline: w.kind === "due" ? w.date : null,
      deadlineTime: w.deadlineTime ?? null,
      rolling: !!w.rolling,
      opensToday: opensToday(w),
      applicationId: toDo.find((a) => same(a, k))?.id ?? null,
    });
  }

  // Tracker entries no open posting speaks for: their deadline on the Schedule
  // - unless the posting behind the entry has been taken down or closed. A
  // withdrawn role is not one to apply to, whatever the Schedule still says.
  const gone = await withdrawnRoles(user);
  const orphans = toDo
    .filter((a) => !spokenFor.some((p) => same(p, a)))
    .filter((a) => !gone.some((p) => same(p, a)));
  if (orphans.length) {
    const zone = parseTimeZone(timeZone);
    const today = localDateString(now, zone);
    const [y, m, d] = today.split("-").map(Number);
    const deadlines = await db.query.events.findMany({
      where: and(
        eq(events.userId, user.id),
        eq(events.type, "deadline"),
        eq(events.completed, false),
        inArray(
          events.applicationId,
          orphans.map((a) => a.id),
        ),
        gte(events.eventDate, zonedTime(y, m, d, 0, 0, zone)),
      ),
      columns: { applicationId: true, eventDate: true },
    });
    for (const a of orphans) {
      const next = deadlines
        .filter((e) => e.applicationId === a.id)
        .sort((p, q) => p.eventDate.getTime() - q.eventDate.getTime())[0];
      if (!next) continue;
      out.push({
        key: `application:${a.id}`,
        firmName: a.firm,
        role: a.role,
        applyUrl: a.applicationUrl,
        // The Schedule holds an instant; the deadline is the day it falls on
        // for the student, stored the way posting deadlines are.
        deadline: new Date(`${localDateString(next.eventDate, zone)}T00:00:00Z`),
        deadlineTime: null,
        rolling: false,
        applicationId: a.id,
      });
    }
  }
  return out;
}

/**
 * Roles whose postings are no longer open - taken down, or closed by the firm
 * - in the student's own cycle (last year's closed posting says nothing about
 * this year's). Matched to tracker entries in code, by firm and role, so a
 * firm spelled another way is still the same firm.
 */
async function withdrawnRoles(user: ReminderUser): Promise<{ firm: string; role: string }[]> {
  const cycle = internshipYearFor(user);
  // No cycle known: nothing can be said to have closed in it.
  if (cycle === null) return [];
  const db = await getDb();
  return db
    .select({ firm: firms.name, role: internshipPostings.roleTitle })
    .from(internshipPostings)
    .innerJoin(firms, eq(firms.id, internshipPostings.firmId))
    .where(
      and(
        or(eq(internshipPostings.isActive, false), eq(internshipPostings.deadlineStatus, "closed")),
        eq(internshipPostings.programYear, cycle),
      ),
    );
}

/** The reminders due now, for the banner, the to-do list and the bell. */
export async function getApplicationReminders(
  user: ReminderUser,
  now: Date = new Date(),
): Promise<ApplicationReminder[]> {
  const db = await getDb();
  const [candidates, shown, timeZone] = await Promise.all([
    getReminderCandidates(user, now),
    db.query.flashesShown.findMany({
      where: and(eq(flashesShown.userId, user.id), like(flashesShown.flashKey, "deadline:%:rolling:%")),
      columns: { flashKey: true },
    }),
    getStudentTimeZone(),
  ]);
  if (candidates.length === 0) return [];

  // When each rolling application's banner last spoke.
  const lastRollingShown = new Map<string, string>();
  for (const row of shown) {
    const m = /^deadline:(.+):rolling:(\d{4}-\d{2}-\d{2})$/.exec(row.flashKey);
    if (!m) continue;
    const prev = lastRollingShown.get(m[1]);
    if (!prev || m[2] > prev) lastRollingShown.set(m[1], m[2]);
  }
  return selectReminders({ candidates, now, timeZone, lastRollingShown });
}

/** The "Applied yet?" list: every open application not yet marked applied. */
export async function getOpenApplications(user: ReminderUser, now: Date = new Date()): Promise<OpenApplication[]> {
  const [candidates, timeZone] = await Promise.all([getReminderCandidates(user, now), getStudentTimeZone()]);
  return openApplications(candidates, now, timeZone);
}

/**
 * "I applied" - from the banner, the to-do row or the "Applied yet?" list.
 *
 * Takes the key of a reminder and acts only on one this student has right
 * now. Marks their tracker entry submitted, or - for a posting they never
 * added - puts it on the tracker as submitted, so it is recorded where every
 * other application is. Then closes the job under the bell as theirs.
 *
 * Every write here only ever moves a row TO "submitted", so each one is also a
 * write that can move a row OFF "offer" - and an application that stops being
 * an offer takes its feed announcement with it, exactly as editing the status
 * on the tracker does. Leaving that to the tracker's own actions left a
 * student announcing an offer they could no longer reach from the tracker,
 * with no way to take it back down.
 */
export async function markReminderApplied(user: ReminderUser, key: string, now: Date = new Date()): Promise<boolean> {
  // Anything on the "Applied yet?" list - a superset of what is reminded.
  const reminder = (await getOpenApplications(user, now)).find((r) => r.key === key);
  if (!reminder) return false;

  const db = await getDb();
  const appliedDate = localDateString(now, parseTimeZone(await getStudentTimeZone()));
  let same: { id: string; status: string } | null = null;
  if (reminder.applicationId) {
    // Its deadline on the Schedule is done too - otherwise "Application
    // deadline in 3 days" would sit on the to-do list after they applied.
    await db
      .update(events)
      .set({ completed: true })
      .where(
        and(
          eq(events.userId, user.id),
          eq(events.applicationId, reminder.applicationId),
          eq(events.type, "deadline"),
        ),
      );
    await db
      .update(applications)
      .set({ status: "submitted", appliedDate, updatedAt: now })
      .where(
        and(
          eq(applications.id, reminder.applicationId),
          eq(applications.userId, user.id),
          inArray(applications.status, ["not_started", "in_progress"]),
        ),
      );
  } else if ((same = await findSameApplication(user.id, reminder.firmName, reminder.role))) {
    // On the tracker under another spelling: mark that one - restricted to the
    // two to-do statuses exactly as the branch above is. Without the
    // predicate this write moved ANY row it matched to "submitted", including
    // one at "offer", which is not a thing "I applied" is allowed to decide.
    const [moved] = await db
      .update(applications)
      .set({ status: "submitted", appliedDate, updatedAt: now })
      .where(
        and(
          eq(applications.id, same.id),
          eq(applications.userId, user.id),
          inArray(applications.status, ["not_started", "in_progress"]),
        ),
      )
      .returning();
    // A row that moves off "offer" takes its announcement with it, the way
    // editing the status on the tracker does. Predicated as above, nothing
    // reachable through here is at "offer", so this normally deletes nothing -
    // it is here so that the two halves of "stop being an offer" stay together
    // in every write that performs one, rather than in only some of them.
    if (moved) await retractOffer(user.id, moved.id);
  } else {
    const [row] = await db
      .insert(applications)
      .values({
        userId: user.id,
        firm: reminder.firmName,
        role: reminder.role,
        status: "submitted",
        appliedDate,
        applicationUrl: reminder.applyUrl,
      })
      .onConflictDoUpdate({
        target: [applications.userId, applications.firm, applications.role],
        set: { status: "submitted", appliedDate, updatedAt: now },
      })
      .returning();
    // This branch CAN land on an offer: the conflict is on the exact (firm,
    // role) strings while findSameApplication above matches by meaning, and
    // the two disagree for a title that carries no words of its own
    // ("Internship Program"), so an existing row at "offer" is overwritten to
    // "submitted" here. Whichever happened - a fresh row or an overwrite - the
    // row is now "submitted", so any offer it was announcing comes down with
    // it instead of outliving the status that made it.
    if (row) await retractOffer(user.id, row.id);
  }
  await closeNotificationByKey(user.id, reminderNotificationKey(key), "manual", now);
  // Applied on the day it opened: the opening-day "Apply to X" prompt is done
  // too - its to-do row off the list, its job under the bell closed.
  if (reminder.opensToday) {
    const firmKey = firmResolver(await trackedFirmNames(user.id))(reminder.firmName);
    await db
      .insert(todoDismissals)
      .values({ userId: user.id, taskId: `apply-${firmKey}-${appliedDate}` })
      .onConflictDoNothing();
    await closeNotificationByKey(user.id, applyNotificationKey(firmKey, appliedDate), "manual", now);
  }
  return true;
}
