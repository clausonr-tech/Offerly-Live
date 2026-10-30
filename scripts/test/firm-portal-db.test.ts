// The firm portal against a REAL database: posting, who is notified, the
// crawler leaving a firm's own posting alone, one firm never touching
// another's rows, demo isolation, campus-event visibility and the analytics
// that are shown while student-data sharing is off.
//
// In-memory PGlite migrated by replaying drizzle/*.sql, including 0014.
// NOTHING HERE TOUCHES PRODUCTION: no DATABASE_URL is read and no network.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import "./helpers/no-network";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { readFileSync } from "node:fs";
import { applyMigrations, createTestDb, migrationFiles, type TestDatabase } from "./helpers/test-db";
import { firmNotifications, firms, internshipPostings, notifications, schools, users, userTopFirms } from "@/db/schema";
import { pinUtcClock } from "@/db/utc-clock";
import { getFirmAnalytics } from "@/lib/firm-analytics";
import { recordEngagement } from "@/lib/firm-engagement";
import { listFirmNotifications, markFirmNotificationsSeen, refreshFirmInsights } from "@/lib/firm-insights";
import { saveFirmEvent, saveFirmPosting, setFirmPostingOpen } from "@/lib/firm-posting";
import type { EventInput, PostingInput } from "@/lib/firm-posting-rules";
import { getRelevantPostings, savePosting } from "@/lib/internship-postings";
import { listFirmRecruitingEvents } from "@/lib/recruiting-events-feed";

delete process.env.DATABASE_URL;

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

let seq = 0;
const uniq = () => `${++seq}-${Date.now()}`;

async function mkFirm(isDemo = false) {
  const [f] = await h.db
    .insert(firms)
    .values({ slug: `firm-${uniq()}`, name: `Firm ${seq}`, headquarters: "NY", keyOffices: "NY", website: `f${seq}.com`, description: "x", isDemo })
    .returning();
  return f;
}

async function mkSchool(name: string) {
  const [s] = await h.db.insert(schools).values({ name, emailDomain: `${name.toLowerCase()}-${uniq()}.edu` }).returning();
  return s;
}

async function mkOwner(firmId: string, isDemo = false) {
  const [u] = await h.db
    .insert(users)
    .values({ email: `owner-${uniq()}@example.com`, passwordHash: "x", accountType: "firm", orgFirmId: firmId, orgApproved: true, firmRole: "owner", isDemo })
    .returning();
  return u;
}

async function mkStudent(over: Partial<typeof users.$inferInsert> = {}, matchFirmId?: string) {
  const [u] = await h.db.insert(users).values({ email: `s-${uniq()}@example.edu`, passwordHash: "x", ...over }).returning();
  if (matchFirmId) await h.db.insert(userTopFirms).values({ userId: u.id, firmId: matchFirmId });
  return u;
}

const posting = (over: Partial<PostingInput> = {}): PostingInput => ({
  roleTitle: `Summer Analyst ${uniq()}`,
  categories: ["investment_banking"],
  programYear: 2027,
  eligibleGradYears: [2028],
  location: "New York",
  deadlineStatus: "rolling",
  deadlineDate: null,
  opensAt: null,
  applicationUrl: "https://example.com/apply",
  recruiterName: null,
  recruiterTitle: null,
  recruiterEmail: null,
  description: "Ten weeks on a live deal team, with modeling training in the first week.",
  requirements: null,
  extraFields: [{ label: "Seats", value: "12" }],
  ...over,
});

const event = (schoolIds: string[]): EventInput => ({
  kind: "info_session",
  title: `Info session ${uniq()}`,
  schoolIds,
  startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  endsAt: null,
  registrationDeadline: null,
  format: "in_person",
  location: "Campus",
  rsvpUrl: "https://example.com/rsvp",
  description: "Meet the team.",
});

async function notifiedUsers(key: string): Promise<string[]> {
  const rows = await h.db.select({ userId: notifications.userId }).from(notifications).where(eq(notifications.dedupeKey, key));
  return rows.map((r) => r.userId).sort();
}

test("the firm portal and notification migrations are re-runnable", async () => {
  // Everything once, then these again: a second pass must be a no-op, the way
  // 0010-0013 are (the earliest migrations were never written to repeat).
  // Found by name, not number - the numbers moved when main's 0014 landed.
  const client = new PGlite();
  await pinUtcClock(client);
  await applyMigrations(client);
  for (const tag of ["_firm_portal.sql", "_firm_notifications.sql"]) {
    const sql = readFileSync(migrationFiles().find((f) => f.includes(tag))!, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement.trim());
    }
  }
  await client.close();
});

describe("posting an internship", () => {
  test("goes live, and notifies matched, eligible, real students only", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const eligible = await mkStudent({ gradYear: 2028 }, firm.id);
    const wrongYear = await mkStudent({ gradYear: 2027 }, firm.id);
    await mkStudent({ gradYear: 2028 }); // not matched
    await mkStudent({ gradYear: 2028, isDemo: true }, firm.id); // a demo account

    const r = await saveFirmPosting(owner, null, posting());
    assert.ok(r.ok);
    const row = await h.db.query.internshipPostings.findFirst({ where: eq(internshipPostings.id, r.id) });
    assert.equal(row?.origin, "firm");
    assert.equal(row?.isActive, true);
    assert.match(row!.descriptionFull, /Additional details\nSeats: 12$/);
    assert.deepEqual(await notifiedUsers(`firm_posting:${r.id}`), [eligible.id]);
    assert.ok(!(await notifiedUsers(`firm_posting:${r.id}`)).includes(wrongYear.id));

    // Editing never notifies anyone a second time.
    await saveFirmPosting(owner, r.id, posting({ roleTitle: row!.roleTitle, description: row!.descriptionFull }));
    assert.equal((await notifiedUsers(`firm_posting:${r.id}`)).length, 1);
  });

  test("is shown to students through the same query as every other posting", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const r = await saveFirmPosting(owner, null, posting());
    assert.ok(r.ok);
    const seen = await getRelevantPostings({ gradYear: 2028, preferredCategories: null, internshipYear: 2027, firmIds: [firm.id] });
    assert.deepEqual(seen.map((p) => p.id), [r.id]);

    await setFirmPostingOpen(owner, r.id, false);
    const closed = await getRelevantPostings({ gradYear: 2028, preferredCategories: null, internshipYear: 2027, firmIds: [firm.id] });
    assert.equal(closed.length, 0, "closed postings leave the list");
  });

  test("the crawler never overwrites a firm's own posting", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const input = posting();
    const r = await saveFirmPosting(owner, null, input);
    assert.ok(r.ok);
    await savePosting(firm.id, ["private_equity"], {
      roleTitle: input.roleTitle,
      location: "Somewhere else",
      programYear: input.programYear,
      eligibleGradYears: [],
      deadlineStatus: "tbd",
      deadlineText: null,
      deadlineDateIso: null,
      descriptionFull: "Crawled copy",
      sourceUrl: "https://careers.example.com/x",
      applicationUrl: null,
      recruiterName: null,
      recruiterTitle: null,
      recruiterEmail: null,
      recruiterPhone: null,
    });
    const row = await h.db.query.internshipPostings.findFirst({ where: eq(internshipPostings.id, r.id) });
    assert.equal(row?.location, "New York");
    assert.deepEqual(row?.categories, ["investment_banking"]);
  });

  test("a firm's own version takes over a crawled row for the same role", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const input = posting();
    await savePosting(firm.id, ["investment_banking"], {
      roleTitle: input.roleTitle,
      location: null,
      programYear: input.programYear,
      eligibleGradYears: [],
      deadlineStatus: "tbd",
      deadlineText: null,
      deadlineDateIso: null,
      descriptionFull: "Crawled copy",
      sourceUrl: "https://careers.example.com/x",
      applicationUrl: null,
      recruiterName: null,
      recruiterTitle: null,
      recruiterEmail: null,
      recruiterPhone: null,
    });
    const r = await saveFirmPosting(owner, null, input);
    assert.ok(r.ok);
    const rows = await h.db
      .select()
      .from(internshipPostings)
      .where(and(eq(internshipPostings.firmId, firm.id), eq(internshipPostings.roleTitle, input.roleTitle)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "firm");
  });

  test("one firm can never edit or close another firm's posting", async () => {
    const a = await mkFirm();
    const b = await mkFirm();
    const ownerA = await mkOwner(a.id);
    const ownerB = await mkOwner(b.id);
    const r = await saveFirmPosting(ownerA, null, posting());
    assert.ok(r.ok);
    assert.equal((await saveFirmPosting(ownerB, r.id, posting())).ok, false);
    assert.equal((await setFirmPostingOpen(ownerB, r.id, false)).ok, false);
    const row = await h.db.query.internshipPostings.findFirst({ where: eq(internshipPostings.id, r.id) });
    assert.equal(row?.isActive, true);
    assert.equal(row?.firmId, a.id);
  });

  test("an unapproved account cannot post", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const pending = { ...owner, orgApproved: false };
    assert.equal((await saveFirmPosting(pending, null, posting())).ok, false);
  });

  test("a demo firm's posting reaches demo accounts only", async () => {
    const firm = await mkFirm(true);
    const owner = await mkOwner(firm.id, true);
    const real = await mkStudent({ gradYear: 2028 }, firm.id);
    const demo = await mkStudent({ gradYear: 2028, isDemo: true }, firm.id);
    const r = await saveFirmPosting(owner, null, posting());
    assert.ok(r.ok);
    assert.deepEqual(await notifiedUsers(`firm_posting:${r.id}`), [demo.id]);
    assert.ok(!(await notifiedUsers(`firm_posting:${r.id}`)).includes(real.id));
    const forReal = await getRelevantPostings({ gradYear: 2028, preferredCategories: null, internshipYear: 2027, firmIds: [firm.id] });
    assert.equal(forReal.length, 0);
    const forDemo = await getRelevantPostings({ gradYear: 2028, preferredCategories: null, internshipYear: 2027, firmIds: [firm.id], includeDemo: true });
    assert.equal(forDemo.length, 1);
  });
});

describe("posting an event", () => {
  test("a campus event notifies matched students at that school, and shows on the firm page only to them", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const penn = await mkSchool("Penn");
    const duke = await mkSchool("Duke");
    const atPenn = await mkStudent({ schoolId: penn.id }, firm.id);
    const claimedPenn = await mkStudent({ claimedSchoolId: penn.id }, firm.id);
    await mkStudent({ schoolId: duke.id }, firm.id);

    const r = await saveFirmEvent(owner, null, event([penn.id]));
    assert.ok(r.ok);
    assert.deepEqual(await notifiedUsers(`firm_event:${r.id}`), [atPenn.id, claimedPenn.id].sort());

    const pennView = await listFirmRecruitingEvents(firm.id, new Date(), { schoolId: penn.id, claimedSchoolId: null, isDemo: false });
    assert.equal(pennView.length, 1);
    assert.equal(pennView[0].eventUrl, `/api/firm-events/${r.id}/open`, "firm events link through the click log");
    const dukeView = await listFirmRecruitingEvents(firm.id, new Date(), { schoolId: duke.id, claimedSchoolId: null, isDemo: false });
    assert.equal(dukeView.length, 0);
  });

  test("an event open to any school reaches every matched student", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const a = await mkStudent({}, firm.id);
    const b = await mkStudent({}, firm.id);
    const r = await saveFirmEvent(owner, null, event([]));
    assert.ok(r.ok);
    assert.deepEqual(await notifiedUsers(`firm_event:${r.id}`), [a.id, b.id].sort());
  });
});

describe("analytics", () => {
  test("while sharing is off, a real firm sees engagement with its own posts and nothing built from student profiles", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const s1 = await mkStudent({ gradYear: 2028 }, firm.id);
    const s2 = await mkStudent({ gradYear: 2028 }, firm.id);
    const r = await saveFirmPosting(owner, null, posting());
    assert.ok(r.ok);
    await recordEngagement({ firmId: firm.id, userId: s1.id, kind: "apply_click", postingId: r.id });
    await recordEngagement({ firmId: firm.id, userId: s1.id, kind: "apply_click", postingId: r.id }); // a double-click
    await recordEngagement({ firmId: firm.id, userId: s2.id, kind: "apply_click", postingId: r.id });

    const a = await getFirmAnalytics(firm.id, new Date(), { shareStudentData: false });
    assert.ok(a);
    assert.equal(a.isSample, false);
    assert.equal(a.studentDataShared, false);
    assert.equal(a.totals.applyClicks, 2, "a repeat click within ten minutes counts once");
    assert.equal(a.totals.applyClickStudents, 2);
    assert.equal(a.totals.notified, 2);
    assert.equal(a.totals.matched, 0, "locked");
    assert.deepEqual(a.schools.rows, []);
    assert.equal(a.postings[0].applyClicks, 2);
  });

  test("a demo firm's analytics are labelled sample data", async () => {
    const firm = await mkFirm(true);
    const a = await getFirmAnalytics(firm.id);
    assert.equal(a?.isSample, true);
    for (const b of [a!.schools, a!.gradYears, a!.sectors]) for (const row of b.rows) assert.ok(row.count >= 5);
  });
});

describe("the notification center", () => {
  test("writes a note when a line is crossed, never twice, and shows owner-only notes to the owner only", async () => {
    const firm = await mkFirm();
    const owner = await mkOwner(firm.id);
    const [member] = await h.db
      .insert(users)
      .values({ email: `m-${uniq()}@example.com`, passwordHash: "x", accountType: "firm", orgFirmId: firm.id, orgApproved: true, firmRole: "member" })
      .returning();
    const [waiting] = await h.db
      .insert(users)
      .values({ email: `w-${uniq()}@example.com`, name: "Jordan", passwordHash: "x", accountType: "firm", orgFirmId: firm.id, orgApproved: false, firmRole: "member" })
      .returning();
    const students = await Promise.all(Array.from({ length: 11 }, () => mkStudent({ gradYear: 2028 }, firm.id)));
    const r = await saveFirmPosting(owner, null, posting());
    assert.ok(r.ok);
    for (const s of students) await recordEngagement({ firmId: firm.id, userId: s.id, kind: "apply_click", postingId: r.id });

    const wrote = await refreshFirmInsights(firm.id, new Date(), true);
    assert.ok(wrote >= 3, `wrote ${wrote}`);
    assert.equal(await refreshFirmInsights(firm.id, new Date(), true), 0, "a second pass announces nothing new");

    const rows = await h.db.select().from(firmNotifications).where(eq(firmNotifications.firmId, firm.id));
    const keys = rows.map((x) => x.dedupeKey);
    assert.ok(keys.includes(`apply:${r.id}:10`));
    assert.ok(keys.includes(`reach:posting:${r.id}`));
    assert.ok(keys.includes(`team:${waiting.id}`));

    const ownerView = await listFirmNotifications({ ...owner, firmNotificationsSeenAt: null });
    const memberView = await listFirmNotifications({ ...member, firmNotificationsSeenAt: null });
    assert.ok(ownerView.items.some((i) => i.kind === "team"));
    assert.ok(!memberView.items.some((i) => i.kind === "team"), "members never see approval requests");
    assert.equal(memberView.unreadCount, memberView.items.length);

    await markFirmNotificationsSeen(member.id, new Date(Date.now() + 1000));
    const [fresh] = await h.db.select().from(users).where(eq(users.id, member.id));
    assert.equal((await listFirmNotifications(fresh)).unreadCount, 0);

    // Approved: the waiting note goes.
    await h.db.update(users).set({ orgApproved: true }).where(eq(users.id, waiting.id));
    await refreshFirmInsights(firm.id, new Date(), true);
    const after = await h.db.select().from(firmNotifications).where(eq(firmNotifications.firmId, firm.id));
    assert.ok(!after.some((x) => x.kind === "team"));
  });

  test("another firm's notes are never listed", async () => {
    const a = await mkFirm();
    const b = await mkFirm();
    const ownerA = await mkOwner(a.id);
    await mkOwner(b.id);
    await h.db.insert(firmNotifications).values({ firmId: b.id, dedupeKey: "x", kind: "weekly", title: "B's", body: "", href: "/firms/analytics" });
    const view = await listFirmNotifications({ ...ownerA, firmNotificationsSeenAt: null });
    assert.ok(!view.items.some((i) => i.title === "B's"));
  });
});
