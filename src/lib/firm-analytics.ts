import "server-only";
import { and, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  applications,
  contacts,
  contactSourcingRuns,
  firmEngagement,
  firmRecruitingEvents,
  firms,
  internshipPostings,
  notifications,
  schools,
  users,
  userTopFirms,
} from "@/db/schema";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import {
  APPLIED_STATUSES,
  breakdown,
  DEGREE_LABELS,
  multiBreakdown,
  STUDENT_DATA_SHARING_ENABLED,
  weeklyCounts,
  type FirmAnalytics,
} from "@/lib/firm-analytics-rules";
import { sampleFirmAnalytics } from "@/lib/firm-analytics-sample";
import { eventNotificationKey, postingNotificationKey } from "@/lib/firm-delivery-rules";
import { normalizeFirmName } from "@/lib/network-coverage";
import { sharedWithFirmsWhere } from "@/lib/firm-sharing";

// A firm's Analytics tab. Every number is a count over students; the privacy
// rules that decide what may be shown live in lib/firm-analytics-rules.ts.
//
// "Students interested in you" - the base every breakdown describes - is
// anyone who did something about this firm: matched with it, found contacts
// there, tracked one of its roles, or clicked one of its posts. Demo firms
// count demo students only, real firms real students only.

export async function getFirmAnalytics(
  firmId: string,
  now: Date = new Date(),
  /** Tests only: exercise the student-data path while the real switch stays off. */
  opts: { shareStudentData?: boolean } = {},
): Promise<FirmAnalytics | null> {
  const db = await getDb();
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) return null;

  // The firm's own posts and what students did with them. Shown to every
  // firm: it is engagement with the firm's own content.
  const [postingRows, eventRows, engagement] = await Promise.all([
    db
      .select({
        id: internshipPostings.id,
        title: internshipPostings.roleTitle,
        isActive: internshipPostings.isActive,
        origin: internshipPostings.origin,
      })
      .from(internshipPostings)
      .where(eq(internshipPostings.firmId, firmId)),
    db
      .select({
        id: firmRecruitingEvents.id,
        title: firmRecruitingEvents.title,
        date: firmRecruitingEvents.eventDate,
        isActive: firmRecruitingEvents.isActive,
      })
      .from(firmRecruitingEvents)
      .where(and(eq(firmRecruitingEvents.firmId, firmId), eq(firmRecruitingEvents.origin, "firm"))),
    db
      .select({
        userId: firmEngagement.userId,
        kind: firmEngagement.kind,
        postingId: firmEngagement.postingId,
        eventId: firmEngagement.eventId,
        createdAt: firmEngagement.createdAt,
      })
      .from(firmEngagement)
      .innerJoin(users, eq(users.id, firmEngagement.userId))
      .where(and(eq(firmEngagement.firmId, firmId), eq(users.isDemo, firm.isDemo))),
  ]);

  const keys = [
    ...postingRows.map((p) => postingNotificationKey(p.id)),
    ...eventRows.map((e) => eventNotificationKey(e.id)),
  ];
  const notifiedRows = keys.length
    ? await db
        .select({ key: notifications.dedupeKey, n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(inArray(notifications.dedupeKey, keys))
        .groupBy(notifications.dedupeKey)
    : [];
  const notifiedBy = new Map(notifiedRows.map((r) => [r.key, r.n]));

  const applyClicks = engagement.filter((e) => e.kind === "apply_click");
  const eventClicks = engagement.filter((e) => e.kind === "event_click");
  const calendarAdds = engagement.filter((e) => e.kind === "event_calendar_add");

  const postings = postingRows
    .map((p) => {
      const clicks = applyClicks.filter((c) => c.postingId === p.id);
      return {
        ...p,
        applyClicks: clicks.length,
        students: new Set(clicks.map((c) => c.userId)).size,
        notified: notifiedBy.get(postingNotificationKey(p.id)) ?? 0,
      };
    })
    // Every posting the firm wrote, plus any crawled one students acted on.
    .filter((p) => p.origin === "firm" || p.applyClicks > 0)
    .sort((a, b) => b.applyClicks - a.applyClicks || a.title.localeCompare(b.title));

  const events = eventRows
    .map((e) => ({
      ...e,
      clicks: eventClicks.filter((c) => c.eventId === e.id).length,
      calendarAdds: calendarAdds.filter((c) => c.eventId === e.id).length,
      notified: notifiedBy.get(eventNotificationKey(e.id)) ?? 0,
    }))
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));

  const ownPostTotals = {
    applyClicks: applyClicks.length,
    applyClickStudents: new Set(applyClicks.map((c) => c.userId)).size,
    eventClicks: eventClicks.length,
    calendarAdds: calendarAdds.length,
    notified: [...notifiedBy.values()].reduce((a, b) => a + b, 0),
  };
  const weekly = weeklyCounts(engagement.map((e) => e.createdAt), now);

  if (firm.isDemo) {
    return sampleFirmAnalytics({ firmName: firm.name, postings, events, ownPostTotals, weekly, now });
  }

  const locked: FirmAnalytics = {
    firmName: firm.name,
    isSample: false,
    studentDataShared: false,
    generatedAt: now,
    totals: { matched: 0, foundContacts: 0, contactsFound: 0, tracking: 0, applied: 0, interviewing: 0, offers: 0, ...ownPostTotals },
    funnel: [],
    postings,
    events,
    schools: { rows: [], total: 0, hidden: 0 },
    gradYears: { rows: [], total: 0, hidden: 0 },
    degrees: { rows: [], total: 0, hidden: 0 },
    sectors: { rows: [], total: 0, hidden: 0 },
    locations: { rows: [], total: 0, hidden: 0 },
    weekly,
  };
  if (!(opts.shareStudentData ?? STUDENT_DATA_SHARING_ENABLED)) return locked;

  // ---- built from student profiles, contacts and applications ----

  const names = [firm.name, ...(firm.aliases ?? [])];
  const wanted = new Set(names.map(normalizeFirmName).filter(Boolean));
  // Narrowed in SQL by the firm's first word, decided by the same normaliser
  // the rest of the app matches firm names with.
  const firstWord = firm.name.split(/\s+/)[0] ?? firm.name;
  const nameFilter = (col: typeof contacts.firm | typeof applications.firm) =>
    or(...names.map((n) => ilike(col, n)), ilike(col, `${firstWord}%`));

  const [matched, sourced, contactRows, applicationRows] = await Promise.all([
    db
      .select({ userId: userTopFirms.userId })
      .from(userTopFirms)
      .innerJoin(users, eq(users.id, userTopFirms.userId))
      // Opted-in students only - see the cohort below, which is the real gate.
      .where(and(eq(userTopFirms.firmId, firmId), sharedWithFirmsWhere())),
    db
      .select({ userId: contactSourcingRuns.userId, created: contactSourcingRuns.contactsCreated })
      .from(contactSourcingRuns)
      .where(and(eq(contactSourcingRuns.firmId, firmId), eq(contactSourcingRuns.status, "succeeded"), gt(contactSourcingRuns.contactsCreated, 0))),
    db
      .select({ userId: contacts.userId, firm: contacts.firm })
      .from(contacts)
      .where(nameFilter(contacts.firm)),
    db
      .select({ userId: applications.userId, firm: applications.firm, status: applications.status })
      .from(applications)
      .where(nameFilter(applications.firm)),
  ]);

  const atFirm = <T extends { firm: string | null }>(rows: T[]) => rows.filter((r) => r.firm && wanted.has(normalizeFirmName(r.firm)));
  const myContacts = atFirm(contactRows);
  const myApplications = atFirm(applicationRows);

  const contactUsers = new Set([...sourced.map((s) => s.userId), ...myContacts.map((c) => c.userId)]);
  const trackingUsers = new Set(myApplications.map((a) => a.userId));
  const appliedUsers = new Set(myApplications.filter((a) => APPLIED_STATUSES.has(a.status)).map((a) => a.userId));
  const interviewing = new Set(myApplications.filter((a) => a.status === "interviewing" || a.status === "offer").map((a) => a.userId));
  const offers = new Set(myApplications.filter((a) => a.status === "offer").map((a) => a.userId));
  const matchedUsers = new Set(matched.map((m) => m.userId));

  const cohortIds = [
    ...new Set([...matchedUsers, ...contactUsers, ...trackingUsers, ...engagement.map((e) => e.userId)]),
  ];
  const cohort = cohortIds.length
    ? await db
        .select({
          id: users.id,
          accountType: users.accountType,
          isDemo: users.isDemo,
          school: schools.name,
          gradYear: users.gradYear,
          degreeLevel: users.degreeLevel,
          preferredCategories: users.preferredCategories,
          targetLocations: users.targetLocations,
        })
        .from(users)
        .leftJoin(schools, eq(schools.id, users.schoolId))
        // THE GATE: only students who opted in to sharing with firms, under the
        // current policy (lib/firm-sharing.ts). Contacts, applications and
        // clicks were gathered by firm name above; every total, funnel step and
        // breakdown below is counted over this cohort alone, so a student who
        // did not opt in never adds to any of them.
        .where(and(inArray(users.id, cohortIds), sharedWithFirmsWhere()))
    : [];
  const students = cohort;
  const real = new Set(students.map((s) => s.id));
  const count = (s: Set<string>) => [...s].filter((id) => real.has(id)).length;
  const amongMatched = (s: Set<string>) => [...s].filter((id) => real.has(id) && matchedUsers.has(id)).length;

  const totals = {
    ...locked.totals,
    matched: count(matchedUsers),
    foundContacts: count(contactUsers),
    contactsFound:
      sourced.filter((s) => real.has(s.userId)).reduce((a, s) => a + s.created, 0) +
      myContacts.filter((c) => real.has(c.userId)).length,
    tracking: count(trackingUsers),
    applied: count(appliedUsers),
    interviewing: count(interviewing),
    offers: count(offers),
  };

  return {
    ...locked,
    studentDataShared: true,
    totals,
    // Every step counts MATCHED students only, because the chart shows each
    // as a share of them. Counting anyone who found contacts or clicked apply
    // could put a step over 100%, and describe students outside the base.
    funnel: [
      { label: "Matched with you", count: totals.matched },
      { label: "Found contacts at your firm", count: amongMatched(contactUsers) },
      { label: "Tracking one of your roles", count: amongMatched(trackingUsers) },
      { label: "Clicked apply", count: amongMatched(new Set(applyClicks.map((c) => c.userId))) },
      { label: "Applied", count: amongMatched(appliedUsers) },
    ],
    schools: breakdown(students.map((s) => s.school ?? "School not verified")),
    gradYears: breakdown(students.map((s) => (s.gradYear ? `Class of ${s.gradYear}` : null))),
    degrees: breakdown(students.map((s) => (s.degreeLevel ? (DEGREE_LABELS[s.degreeLevel] ?? s.degreeLevel) : null))),
    sectors: multiBreakdown(
      students.map((s) => (s.preferredCategories ?? []).map((c) => CATEGORY_LABELS[c as FirmProgramCategory] ?? c)),
    ),
    locations: multiBreakdown(students.map((s) => s.targetLocations ?? [])),
  };
}
