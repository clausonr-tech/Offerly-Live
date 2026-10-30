// Where the recruiting prompts MEET: four students walked day by day through
// every workflow at once, against a real (in-memory) Postgres.
//
//   1. outreach before an opening   (lib/application-outreach.ts)
//   2. sending                      (markDraftSent / setDraftSent -> recordOutreachSend)
//   3. the follow-up ladder         (lib/outreach-ladder*.ts)
//   4. the chat thank-you           (lib/thank-you*.ts)
//   5. interview prep + refresher,
//      and the interview thank-you  (lib/interview-prep.ts, lib/thank-you.ts)
//   6. one banner at a time, the to-do list five at a time, and the bell
//                                   (prompt-flash, today-list, notifications)
//
// Every checkpoint is a PAGE LOAD at a realistic hour: the banner queue is
// drained the way the layout does it (each bubble files its bell job and is
// recorded as shown, then router.refresh() brings the next), then the
// dashboard's to-do list is read, then the bell. Server actions that need a
// signed-in user are replayed with the same lib calls, step for step.
//
// The clock is faked (global Date) so code that reads `new Date()` - the
// upcoming-applications query, the server actions - agrees with the moment
// being simulated, and the student's time zone is set through the same `tz`
// cookie the app reads, inside a Next request-like async context.
//
// Tests state CORRECT behaviour. A failing test here is a finding.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed, fetch throws, and
// the database is an in-memory PGlite migrated from drizzle/*.sql.

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import "./helpers/no-network";
import { and, eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import {
  contacts,
  emailDrafts,
  events,
  firms,
  internshipPostings,
  notifications,
  outreachSends,
  practiceSessions,
  todoBatches,
  todoDismissals,
  userTopFirms,
  users,
} from "@/db/schema";
import { zonedTime } from "@/lib/time-zone";
import type { ChatEvent } from "@/lib/thank-you";
import type { PendingFlash } from "@/lib/prompt-flash";
import type { NotificationList } from "@/lib/notifications";
import type { TodayList } from "@/lib/today-list";
import type { TodayTask } from "@/lib/today-tasks";

delete process.env.DATABASE_URL;

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const DAY = 86_400_000;

// ------------------------------------------------------------------ the clock

const RealDate = Date;
let fakeNow: number | null = null;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(fakeNow ?? RealDate.now());
    else super(...(args as [number]));
  }
  static now() {
    return fakeNow ?? RealDate.now();
  }
  static [Symbol.hasInstance](x: unknown) {
    return x instanceof RealDate;
  }
}
(globalThis as { Date: DateConstructor }).Date = ClockDate as unknown as DateConstructor;
function clock(at: Date) {
  fakeNow = at.getTime();
}

/** Day 0 is Monday 5 October 2026. `day` may run past the month. */
const at = (day: number, h: number, min = 0, tz = NY) => zonedTime(2026, 10, 5 + day, h, min, tz);
/** The student's calendar date for an instant, "YYYY-MM-DD". */
function localDay(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

// ------------------------------------------------------------------ the app, loaded lazily
//
// Next's request storage needs AsyncLocalStorage on globalThis BEFORE any
// next/* module is evaluated, and imports are hoisted - so everything that
// reaches next/headers is imported inside before().

type Libs = typeof import("@/lib/prompt-flash") &
  typeof import("@/lib/notifications") &
  typeof import("@/lib/today-list") &
  typeof import("@/lib/today-tasks") &
  typeof import("@/lib/outreach-ladder-db") &
  typeof import("@/lib/thank-you-db") &
  typeof import("@/lib/draft-recipient") &
  typeof import("@/lib/time-zone-server");
let L: Libs;
type Storage = { run: <R>(store: never, fn: () => R) => R };
let workStorage: Storage;
let workUnitStorage: Storage;

/** Run as a request whose `tz` cookie says `tz` - what getStudentTimeZone reads. */
function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const jar = { get: (name: string) => (name === "tz" ? { name, value: tz } : undefined) };
  return workStorage.run({ route: "/journey" } as never, () =>
    workUnitStorage.run({ type: "private-cache", phase: "render", cookies: jar } as never, fn),
  );
}

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
  L = {
    ...(await import("@/lib/prompt-flash")),
    ...(await import("@/lib/notifications")),
    ...(await import("@/lib/today-list")),
    ...(await import("@/lib/today-tasks")),
    ...(await import("@/lib/outreach-ladder-db")),
    ...(await import("@/lib/thank-you-db")),
    ...(await import("@/lib/draft-recipient")),
    ...(await import("@/lib/time-zone-server")),
  } as Libs;
  workStorage = (await import("next/dist/server/app-render/work-async-storage.external")).workAsyncStorage as unknown as Storage;
  workUnitStorage = (await import("next/dist/server/app-render/work-unit-async-storage.external"))
    .workUnitAsyncStorage as unknown as Storage;
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  fakeNow = null;
  await h.close();
});

// ------------------------------------------------------------------ students

type User = typeof users.$inferSelect;
type Shown = { key: string; kind: string; subject: string; chip: string; day: string; at: Date };
type Student = {
  u: User;
  tz: string;
  /** Google Calendar entries (the invitation side). Listed once they have begun. */
  google: ChatEvent[];
  /** Every banner this student has ever been shown, in order. */
  shown: Shown[];
};

let seq = 0;

async function mkStudent(tag: string): Promise<Student> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `${tag}-${seq}@example.edu`,
      passwordHash: "x",
      name: `Student ${tag}`,
      gradYear: 2028,
      targetInternshipYear: 2027,
      preferredCategories: ["investment_banking"],
      nicheInterests: [],
    })
    .returning();
  return { u, tz: NY, google: [], shown: [] };
}

/** A firm on the student's list, with a real posting that opens at `opensAt`. */
async function trackFirm(s: Student, name: string, opensAt: Date | null) {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${seq}`,
      name,
      headquarters: "New York, NY",
      keyOffices: "New York",
      website: "example.com",
      description: "A firm.",
    })
    .returning({ id: firms.id });
  await h.db.insert(userTopFirms).values({ userId: s.u.id, firmId: f.id });
  let postingId: string | null = null;
  if (opensAt) {
    const [p] = await h.db
      .insert(internshipPostings)
      .values({
        firmId: f.id,
        categories: ["investment_banking"],
        roleTitle: "2027 Investment Banking Summer Analyst",
        location: "New York, NY",
        programYear: 2027,
        eligibleGradYears: [2028],
        opensAt,
        descriptionFull: "Ten-week summer analyst programme in investment banking.",
        sourceUrl: "https://example.com/careers",
        applicationUrl: `https://example.com/apply/${seq}`,
        isActive: true,
      })
      .returning({ id: internshipPostings.id });
    postingId = p.id;
  }
  return { firmId: f.id, postingId };
}

async function mkContact(
  s: Student,
  name: string,
  firm: string | null,
  email: string | null,
  over: Partial<typeof contacts.$inferInsert> = {},
): Promise<string> {
  const [c] = await h.db
    .insert(contacts)
    .values({ userId: s.u.id, name, firm, email, createdAt: at(-40, 9), updatedAt: at(-40, 9), ...over })
    .returning({ id: contacts.id });
  return c.id;
}

async function mkEvent(s: Student, over: Partial<typeof events.$inferInsert> & { title: string; eventDate: Date }) {
  const [e] = await h.db
    .insert(events)
    .values({ userId: s.u.id, type: "meeting", ...over })
    .returning({ id: events.id });
  return e.id;
}

// ---- Google: the cache thank-you-db reads, primed at every simulated moment

type Cache = Map<string, { at: number; events: ChatEvent[]; ok?: boolean }>;
function prime(s: Student, now: Date) {
  const g = globalThis as { __thankYouGoogleCache?: Cache };
  g.__thankYouGoogleCache ??= new Map();
  g.__thankYouGoogleCache.set(s.u.id, {
    at: now.getTime(),
    events: s.google.filter((e) => e.startsAt.getTime() <= now.getTime()),
    ok: true,
  });
}

function invite(id: string, title: string, start: Date, end: Date, people: { email: string; name: string }[]): ChatEvent {
  return {
    sourceKey: `google:${id}`,
    title,
    startsAt: start,
    endsAt: end,
    allDay: false,
    notes: null,
    videoCall: true,
    attendeeEmails: people.map((p) => p.email),
    attendees: people,
    declined: false,
    recurring: false,
    eventType: "default",
  };
}

/** Everything a server action or page does, at `now`, as this student. */
function act<T>(s: Student, now: Date, fn: () => Promise<T>): Promise<T> {
  clock(now);
  prime(s, now);
  return inZone(s.tz, fn);
}

// ------------------------------------------------------------------ a page load

type Visit = {
  now: Date;
  /** Every bubble this load dropped, one after another, in order. */
  banners: PendingFlash[];
  today: TodayList;
  /** The whole live list (the /todo page's "open"). */
  all: TodayTask[];
  bell: NotificationList;
};

const kindOf = (p: PendingFlash) => p.notifications[0]?.kind ?? "?";

/**
 * One page load: drain the bubble queue (markPromptFlashSeen, step for step,
 * then the refresh that brings the next), then the dashboard's to-do list,
 * then the bell.
 */
async function visit(s: Student, now: Date): Promise<Visit> {
  return act(s, now, async () => {
    const banners: PendingFlash[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await L.getPendingFlash(s.u, now);
      if (!p) break;
      for (const n of p.notifications) await L.upsertNotification({ userId: s.u.id, ...n, now });
      await L.markFlashShown(s.u.id, p.flashKey);
      banners.push(p);
      s.shown.push({ key: p.flashKey, kind: kindOf(p), subject: p.subject, chip: p.chip, day: localDay(now, s.tz), at: now });
    }
    const today = await L.getTodayList(s.u, now);
    const all = await L.getAllTasks(s.u, now);
    const bell = await L.getNotifications(s.u.id, now);
    return { now, banners, today, all, bell };
  });
}

const titles = (v: Visit) => v.bell.open.map((i) => i.title).sort();
const bannersOf = (v: Visit, kind: string) => v.banners.filter((b) => kindOf(b) === kind);
const task = (v: Visit, id: string) => v.all.find((t) => t.id === id);
const item = (v: Visit, id: string) => v.today.items.find((t) => t.id === id);
const bellItem = (v: Visit, title: string) => v.bell.open.find((i) => i.title === title);

// ------------------------------------------------------------------ the student's actions

/** A draft, written but not yet sent. */
async function writeDraft(
  s: Student,
  contactId: string | null,
  kind: "cold_outreach" | "follow_up" | "thank_you",
  templateId: string | null,
  subject = "Hello",
): Promise<string> {
  const [d] = await h.db
    .insert(emailDrafts)
    .values({ userId: s.u.id, contactId, kind, templateId, subject, body: "A short note." })
    .returning({ id: emailDrafts.id });
  return d.id;
}

/** markDraftSent (a copy out of the composer), step for step. */
async function markSent(s: Student, draftId: string, now: Date) {
  await act(s, now, async () => {
    const draft = await h.db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, draftId) });
    assert.ok(draft);
    await h.db
      .update(emailDrafts)
      .set({ sentAt: draft.sentAt ?? now, updatedAt: now })
      .where(eq(emailDrafts.id, draftId));
    // Someone thanked has been spoken to (markDraftSent moves a "not contacted"
    // contact to "in conversation").
    if (draft.kind === "thank_you" && draft.contactId) {
      await h.db
        .update(contacts)
        .set({ relationshipStatus: "in_conversation", updatedAt: now })
        .where(and(eq(contacts.id, draft.contactId), eq(contacts.relationshipStatus, "not_contacted")));
    }
    if (draft.kind === "thank_you") await L.reconcileThankYouJobs(s.u.id, now);
    if (draft.contactId && (draft.kind === "cold_outreach" || draft.kind === "follow_up")) {
      await L.recordOutreachSend({ userId: s.u.id, contactId: draft.contactId, draftId, source: "copy", now });
    }
  });
}

/** Write and copy a cold email (or a follow-up) to one contact. */
async function email(s: Student, contactId: string, now: Date, kind: "cold_outreach" | "follow_up" = "cold_outreach") {
  const d = await writeDraft(s, contactId, kind, kind === "follow_up" ? "follow_up" : "cold_outreach");
  await markSent(s, d, now);
  return d;
}

/** setDraftSent(false), step for step. */
async function unsend(s: Student, draftId: string, now: Date) {
  await act(s, now, async () => {
    const draft = await h.db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, draftId) });
    assert.ok(draft);
    await h.db.update(emailDrafts).set({ sentAt: null, updatedAt: now }).where(eq(emailDrafts.id, draftId));
    if (draft.kind === "thank_you") await L.reopenOwedThankYouJobs(s.u.id, now);
    const rung = await h.db.query.outreachSends.findFirst({
      where: and(eq(outreachSends.draftId, draftId), eq(outreachSends.userId, s.u.id)),
    });
    if (rung) await L.undoOutreachSend(s.u.id, rung.id);
  });
}

async function thank(s: Student, contactId: string, now: Date, templateId = "thank_you_chat") {
  const d = await writeDraft(s, contactId, "thank_you", templateId, "Thank you");
  await markSent(s, d, now);
  return d;
}

/**
 * Follow a thank-you prompt's own link: to the saved contact, or through
 * "Outside of your matched contacts" prefilled from /outreach?thank=<key>,
 * saved by resolveRecipient as generateDraft does. Returns the contact.
 */
async function thankNext(s: Student, key: string, now: Date, template: string, typed?: { name: string; email: string }) {
  const t = await act(s, now, async () => (await L.getThankYouPrompts(s.u.id, now)).find((p) => p.key === key));
  assert.ok(t, `${key} should be owed at ${now.toISOString()}`);
  let contactId = t.next.contactId;
  if (!contactId) {
    const fd = new FormData();
    fd.set("outsideName", t.next.name ?? typed?.name ?? "");
    fd.set("outsideFirm", t.next.firm ?? "Goldman Sachs");
    fd.set("outsideEmail", t.next.email ?? typed?.email ?? "");
    const r = await act(s, now, () => L.resolveRecipient(s.u.id, "outside", fd));
    assert.ok(!("error" in r), "error" in r ? String(r.error) : "");
    contactId = r.contact.id;
  }
  await thank(s, contactId, now, template);
  return contactId;
}

async function reply(s: Student, contactId: string, now: Date) {
  await act(s, now, () => L.setContactReplied(s.u.id, contactId, true));
}

async function practise(s: Student, now: Date, category = "investment_banking") {
  await h.db.insert(practiceSessions).values({
    userId: s.u.id,
    mode: "technical",
    difficulty: "mixed",
    categories: [category],
    score: 8,
    maxScore: 10,
    questionsAnswered: 10,
    createdAt: now,
  });
}

/** completeTask (the to-do "Done"), step for step. False when not offered. */
async function tick(s: Student, taskId: string, now: Date): Promise<boolean> {
  return act(s, now, async () => {
    const t = (await L.getAllTasks(s.u, now)).find((x) => x.id === taskId);
    if (!t) return false;
    const ladder = /^ladder-([0-9a-f-]{36})-\d$/.exec(t.id);
    if (ladder) {
      await L.recordOutreachSend({ userId: s.u.id, contactId: ladder[1], source: "manual", now });
    } else if (t.id.startsWith("event-")) {
      await h.db.update(events).set({ completed: true }).where(eq(events.id, t.id.slice("event-".length)));
    } else if (t.id.startsWith("draft-")) {
      await h.db.update(emailDrafts).set({ sentAt: now }).where(eq(emailDrafts.id, t.id.slice("draft-".length)));
    } else if (t.doneKey) {
      await thatsEveryoneInner(s, t.doneKey, now);
    }
    await L.recordCompleted(s.u.id, [t], "manual", now);
    await h.db.insert(todoDismissals).values({ userId: s.u.id, taskId: t.id }).onConflictDoNothing();
    return true;
  });
}

async function thatsEveryoneInner(s: Student, key: string, now: Date): Promise<boolean> {
  const owed = (await L.getThankYouPrompts(s.u.id, now)).find((t) => t.key === key);
  if (!owed) return false;
  await L.upsertNotification({ userId: s.u.id, ...L.thankYouNotification(owed, await L.getStudentTimeZone()), now });
  await L.closeNotificationByKey(s.u.id, owed.key, "manual", now);
  return true;
}

/** completeThankYouPrompt - "That's everyone" on the banner - step for step. */
function thatsEveryone(s: Student, key: string, now: Date) {
  return act(s, now, () => thatsEveryoneInner(s, key, now));
}

function loadNext(s: Student, now: Date) {
  return act(s, now, () => L.loadNextBatch(s.u, now));
}

async function deleteContact(s: Student, id: string) {
  await h.db.delete(contacts).where(and(eq(contacts.id, id), eq(contacts.userId, s.u.id)));
}

const offerlyKey = (eventId: string) => `thank_you:offerly:${eventId}`;
const ladderId = (contactId: string, step: number) => `ladder-${contactId}-${step}`;

// ======================================================================
// A: the whole season, done properly
// ======================================================================
//
// Tracks Goldman Sachs (opens day 30, 9am) and Evercore (opens day 25, 9am),
// five people to write to. Emails them over two weeks, follows up on the
// ladder, Dev at Evercore replies, coffee with Dev, a thank-you, then a
// Goldman superday (day 28, 2pm) with three interviewers on the invitation:
// prep, refresher, the interview, two thanked, "That's everyone".

describe("A: a whole season, done properly", () => {
  let s: Student;
  const c = {} as Record<"ava" | "ben" | "cara" | "dev" | "eli", string>;
  let chat = "";
  let superday = "";
  let v: Visit;

  before(async () => {
    s = await mkStudent("a");
    await trackFirm(s, "Goldman Sachs", at(30, 9));
    await trackFirm(s, "Evercore", at(25, 9));
    c.ava = await mkContact(s, "Ava Lin", "Goldman Sachs", "ava.lin@gs.com");
    c.ben = await mkContact(s, "Ben Cho", "Goldman Sachs", "ben.cho@gs.com");
    c.cara = await mkContact(s, "Cara Diaz", "Goldman Sachs", "cara.diaz@gs.com");
    c.dev = await mkContact(s, "Dev Shah", "Evercore", "dev.shah@evercore.com");
    c.eli = await mkContact(s, "Eli Moss", "Evercore", "eli.moss@evercore.com");
  });

  test("day 0, 10am: Evercore (25 days) speaks first, then Goldman (30 days)", async () => {
    v = await visit(s, at(0, 10));
    assert.deepEqual(v.banners.map((b) => b.subject), ["Evercore", "Goldman Sachs"]);
    assert.equal(v.banners[0].chip, "opens in 25 days");
    assert.equal(v.banners[0].detail, "2 contacts you haven't emailed");
    assert.equal(v.banners[1].chip, "opens in 30 days");
    assert.equal(v.banners[1].detail, "3 contacts you haven't emailed");
  });

  test("day 0: the bell holds one job per firm, both unread", async () => {
    assert.deepEqual(titles(v), ["Email Evercore", "Email Goldman Sachs"]);
    assert.equal(v.bell.openCount, 2);
    assert.equal(v.bell.unreadCount, 2);
  });

  test("day 0: nothing on the to-do list yet - both openings are more than two weeks out", async () => {
    assert.deepEqual(v.today.items, []);
    assert.deepEqual(v.all, []);
  });

  test("day 0: a second page load the same hour drops nothing", async () => {
    const again = await visit(s, at(0, 10, 20));
    assert.equal(again.banners.length, 0);
    assert.equal(again.bell.openCount, 2);
  });

  test("day 1: Evercore does not speak again the day after it first spoke (every OTHER day)", async () => {
    v = await visit(s, at(1, 10));
    assert.deepEqual(v.banners.map((b) => b.subject), []);
    assert.equal(v.bell.openCount, 2);
  });

  test("day 2: two days on, both firms speak again; after emailing Ava the bell counts 1 of 3", async () => {
    v = await visit(s, at(2, 10));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip]), [
      ["Evercore", "opens in 23 days"],
      ["Goldman Sachs", "opens in 28 days"],
    ]);
    await email(s, c.ava, at(2, 10, 30));
    v = await visit(s, at(2, 11));
    assert.equal(v.banners.length, 0);
    assert.deepEqual(bellItem(v, "Email Goldman Sachs")?.progress, { done: 1, total: 3 });
    assert.equal(v.bell.openCount, 2);
  });

  test("day 3: silence (both spoke yesterday); Dev is emailed", async () => {
    v = await visit(s, at(3, 10));
    assert.equal(v.banners.length, 0);
    await email(s, c.dev, at(3, 10, 30));
  });

  test("day 4: both speak, counting only who is left (Ava and Dev are not asked for again)", async () => {
    v = await visit(s, at(4, 10));
    assert.deepEqual(v.banners.map((b) => `${b.subject}: ${b.detail}`), [
      "Evercore: 1 contact you haven't emailed",
      "Goldman Sachs: 2 contacts you haven't emailed",
    ]);
    assert.deepEqual(bellItem(v, "Email Evercore")?.progress, { done: 1, total: 2 });
    await email(s, c.ben, at(4, 10, 30));
  });

  test("day 5: last Evercore contact emailed - the Evercore job closes itself", async () => {
    v = await visit(s, at(5, 10));
    assert.equal(v.banners.length, 0);
    await email(s, c.eli, at(5, 10, 30));
    v = await visit(s, at(5, 11));
    assert.deepEqual(titles(v), ["Email Goldman Sachs"]);
    assert.equal(v.banners.length, 0);
  });

  test("day 6: Goldman asks about Cara alone", async () => {
    v = await visit(s, at(6, 10));
    assert.deepEqual(v.banners.map((b) => `${b.subject}: ${b.detail}`), ["Goldman Sachs: 1 contact you haven't emailed"]);
  });

  test("day 7: silence - nobody is due a follow-up, Goldman already spoke this stretch", async () => {
    v = await visit(s, at(7, 10));
    assert.equal(v.banners.length, 0);
    assert.deepEqual(titles(v), ["Email Goldman Sachs"]);
    assert.deepEqual(v.all, []);
  });

  test("day 9: Ava's 2nd email is due - the follow-up outranks Goldman's opening", async () => {
    v = await visit(s, at(9, 11));
    assert.deepEqual(v.banners.map((b) => kindOf(b)), ["follow_up", "outreach"]);
    const f = v.banners[0];
    assert.equal(f.subject, "Ava Lin");
    assert.equal(f.chip, "2nd email due");
    assert.equal(f.cta, "Write it");
    assert.equal(f.href, `/outreach?contact=${c.ava}&occasion=follow_up&box=follow.first`);
  });

  test("day 9: bell has Ava's follow-up and Goldman; to-do has Ava's row", async () => {
    assert.deepEqual(titles(v), ["Email Goldman Sachs", "Follow up with Ava Lin"]);
    assert.deepEqual(v.today.items.map((i) => i.title), ["Follow up with Ava Lin"]);
    assert.equal(task(v, ladderId(c.ava, 2))?.detail, "Goldman Sachs · 2nd email · no reply in 7 days");
  });

  test("day 9: after the follow-up is copied, Ava's row is crossed out and her job closes", async () => {
    await email(s, c.ava, at(9, 11, 30), "follow_up");
    v = await visit(s, at(9, 12));
    assert.equal(v.banners.length, 0);
    assert.deepEqual(titles(v), ["Email Goldman Sachs"]);
    assert.deepEqual(v.today.items.map((i) => [i.title, i.done]), [["Follow up with Ava Lin", true]]);
    assert.equal(v.today.finished, true);
  });

  test("day 10: Dev is due - his banner alone (Goldman spoke yesterday)", async () => {
    v = await visit(s, at(10, 11));
    assert.deepEqual(v.banners.map((b) => `${kindOf(b)}:${b.subject}`), ["follow_up:Dev Shah"]);
    assert.deepEqual(titles(v), ["Email Goldman Sachs", "Follow up with Dev Shah"]);
  });

  test("day 11: Ben comes due beside Dev - ONE banner for both (newly due speaks the same day), a job each", async () => {
    v = await visit(s, at(11, 11));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip, b.cta]), [
      ["2 people", "follow-ups due", "See who"],
      ["Goldman Sachs", "opens in 19 days", "See who"],
    ]);
    assert.deepEqual(titles(v), ["Email Goldman Sachs", "Follow up with Ben Cho", "Follow up with Dev Shah"]);
  });

  test("day 11: to-do orders the longer-waiting follow-up (Dev) above Ben", async () => {
    assert.deepEqual(v.today.items.map((i) => i.title), ["Follow up with Dev Shah", "Follow up with Ben Cho"]);
  });

  test("day 11: Dev replies, Ben is followed up - both jobs close, nothing re-drops", async () => {
    await reply(s, c.dev, at(11, 12));
    await email(s, c.ben, at(11, 12, 30), "follow_up");
    chat = await mkEvent(s, {
      type: "coffee_chat",
      title: "Coffee chat with Dev Shah",
      contactId: c.dev,
      eventDate: at(14, 14),
      endDate: at(14, 14, 30),
    });
    v = await visit(s, at(11, 13));
    assert.equal(v.banners.length, 0);
    assert.deepEqual(titles(v), ["Email Goldman Sachs"]);
    assert.ok(v.today.items.every((i) => i.done), "both rows crossed out");
    assert.equal(v.all.filter((t) => t.kind === "follow_up").length, 0, "no follow-up left for anyone");
  });

  test("day 11: 'Load the next 5' brings the coffee chat, three days out", async () => {
    assert.equal(v.today.waiting, 1);
    assert.equal(await loadNext(s, at(11, 13, 5)), true);
    v = await visit(s, at(11, 13, 10));
    assert.deepEqual(v.today.items.map((i) => [i.title, i.detail, i.done]), [
      ["Coffee chat with Dev Shah", "Scheduled in 3 days", false],
    ]);
  });

  test("day 12: Eli's follow-up; Eli is followed up", async () => {
    v = await visit(s, at(12, 11));
    assert.deepEqual(v.banners.map((b) => `${kindOf(b)}:${b.subject}`), ["follow_up:Eli Moss"]);
    await email(s, c.eli, at(12, 11, 30), "follow_up");
    v = await visit(s, at(12, 12));
    assert.deepEqual(titles(v), ["Email Goldman Sachs"]);
  });

  test("day 13: Goldman asks about Cara; Cara emailed - Goldman's job closes, the bell is empty", async () => {
    v = await visit(s, at(13, 10));
    assert.deepEqual(v.banners.map((b) => `${b.subject}: ${b.detail}`), ["Goldman Sachs: 1 contact you haven't emailed"]);
    await email(s, c.cara, at(13, 10, 30));
    v = await visit(s, at(13, 11));
    assert.equal(v.bell.openCount, 0);
    assert.equal(v.banners.length, 0);
  });

  test("day 14, 10am: the coffee chat is the day's one task", async () => {
    v = await visit(s, at(14, 10));
    assert.equal(v.banners.length, 0);
    assert.deepEqual(v.today.items.map((i) => [i.title, i.detail]), [["Coffee chat with Dev Shah", "Scheduled today"]]);
  });

  test("day 14, 5pm: the chat is over - its row is crossed out, the thank-you banner drops", async () => {
    v = await visit(s, at(14, 17));
    assert.equal(v.banners.length, 1);
    const b = v.banners[0];
    assert.equal(kindOf(b), "thank_you");
    assert.equal(b.subject, "Dev Shah");
    assert.equal(b.chip, "thank-you");
    assert.equal(b.detail, "send a thank-you while the chat is fresh");
    assert.equal(b.href, `/outreach?contact=${c.dev}&occasion=thanks&box=thanks.chat`);
    assert.deepEqual(v.today.items.map((i) => [i.title, i.done]), [["Coffee chat with Dev Shah", true]]);
  });

  test("day 14, 5pm: ONE bell job for the thank-you, and a to-do row for it waiting", async () => {
    assert.deepEqual(titles(v), ["Thank Dev Shah"]);
    assert.ok(task(v, `thanks-${offerlyKey(chat)}`));
    assert.equal(v.today.waiting, 1);
  });

  test("day 14, 6pm: thank-you sent - bell, banner and to-do all go quiet", async () => {
    await thank(s, c.dev, at(14, 18));
    v = await visit(s, at(14, 18, 30));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.equal(task(v, `thanks-${offerlyKey(chat)}`), undefined);
  });

  test("day 15: no thank-you banner the morning after it was sent", async () => {
    v = await visit(s, at(15, 9));
    assert.equal(bannersOf(v, "thank_you").length, 0);
  });

  test("day 16: Ava's 3rd (final) email is due, opening the final-rung box", async () => {
    v = await visit(s, at(16, 12));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip]), [["Ava Lin", "3rd email due"]]);
    assert.equal(v.banners[0]?.href, `/outreach?contact=${c.ava}&occasion=follow_up&box=follow.final`);
    await email(s, c.ava, at(16, 12, 30), "follow_up");
  });

  test("day 16: after the third email Ava is never prompted again", async () => {
    v = await visit(s, at(16, 13));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    const later = await visit(s, at(17, 13));
    assert.equal(later.all.filter((t) => t.id.startsWith(`ladder-${c.ava}`)).length, 0);
  });

  test("day 18: Ben's 3rd email", async () => {
    v = await visit(s, at(18, 13));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip]), [["Ben Cho", "3rd email due"]]);
    await email(s, c.ben, at(18, 13, 30), "follow_up");
  });

  test("day 19: Eli's 3rd email", async () => {
    v = await visit(s, at(19, 12));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip]), [["Eli Moss", "3rd email due"]]);
    await email(s, c.eli, at(19, 12, 30), "follow_up");
  });

  test("day 20: Cara's 2nd email; the superday lands on the calendar, 8 days out - no prep yet", async () => {
    v = await visit(s, at(20, 11));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip]), [["Cara Diaz", "2nd email due"]]);
    await email(s, c.cara, at(20, 11, 30), "follow_up");
    superday = await mkEvent(s, { type: "meeting", title: "Goldman Sachs Superday", eventDate: at(28, 14), endDate: at(28, 15) });
    s.google.push(
      invite("a-superday", "Goldman Sachs Superday", at(28, 14), at(28, 15), [
        { email: "jo.park@gs.com", name: "Jo Park" },
        { email: "sam.ito@gs.com", name: "Sam Ito" },
        { email: "lee.chen@gs.com", name: "Lee Chen" },
      ]),
    );
    v = await visit(s, at(20, 12));
    assert.equal(v.banners.length, 0);
    assert.equal(v.all.filter((t) => t.kind === "interview").length, 0);
  });

  test("day 21, 3:30pm: seven days out - the prep banner, one bell job", async () => {
    v = await visit(s, at(21, 15, 30));
    assert.equal(v.banners.length, 1);
    const b = v.banners[0];
    assert.equal(kindOf(b), "interview_prep");
    assert.equal(b.subject, "Your Goldman Sachs interview");
    assert.equal(b.chip, "interview in 7 days");
    assert.equal(b.cta, "Practise");
    // The practice page itself, no sector chosen: the student picks the desk.
    assert.equal(b.href, "/learn");
    assert.deepEqual(titles(v), ["Prep for Goldman Sachs"]);
  });

  test("day 21: the entry the detector recognised is now filed as an interview", async () => {
    const row = await h.db.query.events.findFirst({ where: eq(events.id, superday) });
    assert.equal(row?.type, "interview");
  });

  test("day 21: to-do puts practising above the calendar row for the same interview", async () => {
    assert.deepEqual(v.today.items.map((i) => i.title), ["Practise for Goldman Sachs", "Goldman Sachs Superday"]);
    assert.equal(item(v, `interview-${superday}-prep`)?.detail, "Technicals · interview in 7 days");
  });

  test("day 22: no second prep banner the next day", async () => {
    v = await visit(s, at(22, 10));
    assert.equal(bannersOf(v, "interview_prep").length, 0);
  });

  test("day 24: Dev, who had coffee with A ten days ago and was thanked, is NOT 'due a catch-up, 21 days since you last spoke'", async () => {
    v = await visit(s, at(24, 10));
    const catchUp = v.all.find((t) => t.id.startsWith(`follow-${c.dev}`));
    assert.equal(catchUp, undefined, `unexpected catch-up row: ${catchUp?.title} · ${catchUp?.detail}`);
  });

  test("day 25, 3:30pm: three days out - the 3-day banner bumps the same bell job", async () => {
    v = await visit(s, at(25, 15, 30));
    // Goldman opens today too: its "apply" banner speaks first, then prep.
    assert.deepEqual(v.banners.map((b) => [kindOf(b), b.chip]), [
      ["outreach", "opens today"],
      ["interview_prep", "interview in 3 days"],
    ]);
    assert.deepEqual(
      v.bell.open.filter((i) => i.kind === "interview_prep").map((i) => i.title),
      ["Prep for Goldman Sachs"],
    );
  });

  test("day 25: a practice round closes the prep job and quiets the prompt", async () => {
    await practise(s, at(25, 16));
    v = await visit(s, at(25, 16, 30));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.open.filter((i) => i.kind === "interview_prep").length, 0);
    assert.equal(v.all.filter((t) => t.kind === "interview").length, 0);
  });

  test("day 27 (clocks went back): the 1-day mark is quiet after practice; only Cara's 3rd email speaks", async () => {
    v = await visit(s, at(27, 15, 30));
    assert.deepEqual(v.banners.map((b) => [kindOf(b), b.subject, b.chip]), [["follow_up", "Cara Diaz", "3rd email due"]]);
    await email(s, c.cara, at(27, 16), "follow_up");
  });

  test("day 28, 8:30am: the morning-of refresher - top of the to-do list, its job back on the bell", async () => {
    v = await visit(s, at(28, 8, 30));
    assert.deepEqual(v.banners.map((b) => [kindOf(b), b.chip, b.detail, b.cta]), [
      ["interview_prep", "interview today", "a quick refresher round", "Refresh"],
    ]);
    const prep = v.bell.open.filter((i) => i.kind === "interview_prep");
    assert.deepEqual(prep.map((i) => i.title), ["Refresh for Goldman Sachs"]);
    assert.equal(v.today.items[0]?.title, "Refresher for Goldman Sachs");
    assert.equal(v.today.items[1]?.title, "Goldman Sachs Superday");
  });

  test("day 28: a refresher round played - prep is finished everywhere", async () => {
    await practise(s, at(28, 9));
    v = await visit(s, at(28, 9, 30));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.open.filter((i) => i.kind === "interview_prep").length, 0);
    assert.equal(v.all.filter((t) => t.kind === "interview").length, 0);
    assert.equal(item(v, `interview-${superday}-refresh`)?.done, true);
  });

  test("day 28, 5:30pm: the interview thank-you - addressed to the first interviewer on the invitation", async () => {
    v = await visit(s, at(28, 17, 30));
    const b = bannersOf(v, "thank_you");
    assert.equal(b.length, 1);
    assert.equal(b[0].subject, "Goldman Sachs Superday");
    assert.equal(b[0].detail, "thank your interviewers while it is fresh");
    assert.equal(
      b[0].href,
      `/outreach?occasion=thanks&box=thanks.superday&thank=${encodeURIComponent(offerlyKey(superday))}`,
    );
    assert.deepEqual(titles(v), ["Thank your interviewers"]);
  });

  test("day 28, 7pm: Jo and Sam thanked - '2 of 3 thanked' on the to-do row, the job still open", async () => {
    await thankNext(s, offerlyKey(superday), at(28, 18), "thank_you_superday");
    await thankNext(s, offerlyKey(superday), at(28, 18, 30), "thank_you_superday");
    v = await visit(s, at(28, 19));
    const row = task(v, `thanks-${offerlyKey(superday)}`);
    assert.ok(row);
    assert.match(row.detail, /2 of 3 thanked/);
    assert.equal(v.bell.open.filter((i) => i.kind === "thank_you").length, 1);
  });

  test("day 28, 7pm: the interviewers A just thanked are NOT 'Goldman contacts you haven't emailed'", async () => {
    const outreach = bannersOf(v, "outreach");
    assert.deepEqual(outreach.map((b) => `${b.subject}: ${b.detail}`), []);
    assert.equal(v.all.find((t) => t.kind === "outreach")?.title, undefined);
    assert.deepEqual(titles(v), ["Thank your interviewers"]);
  });

  test("day 29, 9am: 'yesterday · 2 of 3 thanked · anyone else to thank?' with That's everyone", async () => {
    v = await visit(s, at(29, 9));
    const b = bannersOf(v, "thank_you");
    assert.equal(b.length, 1);
    assert.equal(b[0].chip, "thank-you · yesterday");
    assert.equal(b[0].detail, "2 of 3 thanked · anyone else to thank?");
    assert.equal(b[0].cta, "Write the next");
    assert.equal(b[0].doneLabel, "That's everyone");
    assert.equal(b[0].doneKey, offerlyKey(superday));
  });

  test("day 29: 'That's everyone' closes it - no banner, no bell job, no to-do row", async () => {
    assert.equal(await thatsEveryone(s, offerlyKey(superday), at(29, 9, 1)), true);
    v = await visit(s, at(29, 9, 30));
    assert.equal(bannersOf(v, "thank_you").length, 0);
    assert.equal(v.bell.open.filter((i) => i.kind === "thank_you").length, 0);
    assert.equal(task(v, `thanks-${offerlyKey(superday)}`), undefined);
  });

  test("day 30, evening: no thank-you banner comes back the next day", async () => {
    v = await visit(s, at(30, 18));
    assert.equal(bannersOf(v, "thank_you").length, 0);
  });

  test("day 31: both openings have passed - nothing about outreach anywhere", async () => {
    v = await visit(s, at(31, 10));
    assert.equal(bannersOf(v, "outreach").length, 0);
    assert.equal(v.bell.open.filter((i) => i.kind === "outreach").length, 0);
    assert.equal(v.all.filter((t) => t.kind === "outreach").length, 0);
  });

  test("day 31: every ladder is over - no follow-up banner, job or row", async () => {
    assert.equal(bannersOf(v, "follow_up").length, 0);
    assert.equal(v.bell.open.filter((i) => i.kind === "follow_up").length, 0);
    assert.equal(v.all.filter((t) => t.id.startsWith("ladder-")).length, 0);
  });

  test("day 40: nothing A finished comes back", async () => {
    v = await visit(s, at(40, 10));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.deepEqual(
      v.all.filter((t) => !t.id.startsWith("follow-")).map((t) => t.title),
      [],
    );
  });

  test("across the season: no banner key was ever shown twice", async () => {
    const keys = s.shown.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  test("across the season: never two banners about the same thing on one calendar day", async () => {
    const seen = new Map<string, number>();
    for (const x of s.shown) {
      const k = `${x.day}|${x.kind}|${x.subject}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    assert.deepEqual([...seen].filter(([, n]) => n > 1), []);
  });
});

// ======================================================================
// B: does nothing, ever
// ======================================================================
//
// Goldman opens day 20, Evercore day 12 (9am). One person at Evercore and two
// at Goldman never written to. Fay (Lazard, untracked) was emailed two days
// before the journey and never followed up. Coffee with Gus on day 6 (3pm),
// never thanked. "Evercore first round" on day 16 at 9am, never prepared for,
// never thanked. B opens the app at 8am and 9pm every day for six weeks and
// never clicks anything.

describe("B: does nothing, opening the app morning and night", () => {
  let s: Student;
  let gusChat = "";
  let interview = "";
  const visits = new Map<string, Visit>();
  const V = (day: number, hour: 8 | 21) => {
    const x = visits.get(`${day}@${hour}`);
    assert.ok(x, `no visit on day ${day} at ${hour}`);
    return x;
  };

  before(async () => {
    s = await mkStudent("b");
    await trackFirm(s, "Goldman Sachs", at(20, 9));
    await trackFirm(s, "Evercore", at(12, 9));
    await mkContact(s, "Gia Russo", "Goldman Sachs", "gia@gs.com");
    await mkContact(s, "Hugo Park", "Goldman Sachs", "hugo@gs.com");
    await mkContact(s, "Ines Cruz", "Evercore", "ines@evercore.com");
    const fay = await mkContact(s, "Fay Wong", "Lazard", "fay@lazard.com", {
      relationshipStatus: "reached_out",
      lastContactDate: "2026-10-03",
    });
    await h.db.insert(outreachSends).values({ userId: s.u.id, contactId: fay, step: 1, sentAt: at(-2, 10), source: "copy" });
    const gus = await mkContact(s, "Gus Hale", "Moelis", "gus@moelis.com", {
      relationshipStatus: "ongoing",
      lastContactDate: "2026-10-04",
    });
    gusChat = await mkEvent(s, { type: "coffee_chat", title: "Coffee with Gus Hale", contactId: gus, eventDate: at(6, 15), endDate: at(6, 15, 30) });
    interview = await mkEvent(s, { type: "interview", title: "Evercore first round", eventDate: at(16, 9), endDate: at(16, 10) });
  });

  test("walks days 0-40 at 8am and 9pm without an error", async () => {
    for (let d = 0; d <= 40; d++) {
      for (const hour of [8, 21] as const) visits.set(`${d}@${hour}`, await visit(s, at(d, hour)));
    }
    assert.equal(visits.size, 82);
  });

  test("never the same banner key twice", () => {
    const keys = s.shown.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  test("each prompt drops at most ONE banner per calendar day, however often the app is opened", () => {
    const perDay = new Map<string, string[]>();
    for (const x of s.shown) {
      const k = `${x.day}|${x.kind}|${x.subject}`;
      perDay.set(k, [...(perDay.get(k) ?? []), x.key]);
    }
    const doubles = [...perDay].filter(([, keys]) => keys.length > 1).map(([k, keys]) => `${k}: ${keys.join(" + ")}`);
    assert.deepEqual(doubles, []);
  });

  test("the outreach banner never speaks on two consecutive days for the same firm", () => {
    const days = (firm: string) =>
      [...new Set(s.shown.filter((x) => x.kind === "outreach" && x.subject === firm).map((x) => x.day))].sort();
    const problems: string[] = [];
    for (const firm of ["Evercore", "Goldman Sachs"]) {
      const d = days(firm);
      for (let i = 1; i < d.length; i++) {
        const gap = (Date.parse(d[i]) - Date.parse(d[i - 1])) / DAY;
        if (gap < 2) problems.push(`${firm}: ${d[i - 1]} and ${d[i]}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test("day 0, 8am: both openings speak, soonest first", () => {
    assert.deepEqual(V(0, 8).banners.map((b) => [b.subject, b.chip]), [
      ["Evercore", "opens in 12 days"],
      ["Goldman Sachs", "opens in 20 days"],
    ]);
  });

  test("day 0, 8am: the to-do list is the chat six days out and Evercore (inside two weeks)", () => {
    assert.deepEqual(V(0, 8).today.items.map((i) => [i.title, i.detail]), [
      ["Coffee with Gus Hale", "Scheduled in 6 days"],
      ["Email Evercore", "1 contact left to email · opens in 12 days"],
    ]);
  });

  test("day 0, 9pm: the bell is exactly the two outreach jobs", () => {
    assert.deepEqual(titles(V(0, 21)), ["Email Evercore", "Email Goldman Sachs"]);
    assert.equal(V(0, 21).bell.openCount, 2);
  });

  test("day 5, 9pm: the calendar row says the chat is TOMORROW on the student's clock", () => {
    assert.equal(task(V(5, 21), `event-${gusChat}`)?.detail, "Scheduled tomorrow");
  });

  test("day 5, 9pm: Fay's follow-up comes due and speaks", () => {
    const f = bannersOf(V(5, 21), "follow_up");
    assert.deepEqual(f.map((b) => [b.subject, b.chip]), [["Fay Wong", "2nd email due"]]);
    assert.deepEqual(titles(V(5, 21)), ["Email Evercore", "Email Goldman Sachs", "Follow up with Fay Wong"]);
  });

  test("day 6, 9pm: the thank-you for Gus drops and files one job", () => {
    const t = bannersOf(V(6, 21), "thank_you");
    assert.deepEqual(t.map((b) => [b.subject, b.chip, b.detail]), [
      ["Gus Hale", "thank-you", "send a thank-you while the chat is fresh"],
    ]);
    assert.deepEqual(titles(V(6, 21)), ["Email Evercore", "Email Goldman Sachs", "Follow up with Fay Wong", "Thank Gus Hale"]);
  });

  test("day 7, 8am: the thank-you comes back once, as 'yesterday'", () => {
    const t = bannersOf(V(7, 8), "thank_you");
    assert.deepEqual(t.map((b) => [b.chip, b.detail]), [["thank-you · yesterday", "still owed a thank-you, a short note still counts"]]);
    assert.equal(bannersOf(V(7, 21), "thank_you").length, 0, "not again that evening");
  });

  test("the Gus thank-you speaks every day from day 6 to day 20, and never after", () => {
    const days = [...new Set(s.shown.filter((x) => x.kind === "thank_you" && x.subject === "Gus Hale").map((x) => x.day))];
    const expected = Array.from({ length: 15 }, (_, i) => localDay(at(6 + i, 12), NY));
    assert.deepEqual(days, expected);
  });

  test("day 9, 8am: the to-do's five, in order", () => {
    assert.deepEqual(V(9, 8).today.items.map((i) => i.title), [
      "Thank Gus Hale",
      "Email Evercore",
      "Follow up with Fay Wong",
      "Email Goldman Sachs",
      "Evercore first round",
    ]);
  });

  test("day 9, 9pm: seven days out - the prep banner, a fifth bell job", () => {
    const p = bannersOf(V(9, 21), "interview_prep");
    assert.deepEqual(p.map((b) => [b.subject, b.chip]), [["Your Evercore interview", "interview in 7 days"]]);
    assert.deepEqual(titles(V(9, 21)), [
      "Email Evercore",
      "Email Goldman Sachs",
      "Follow up with Fay Wong",
      "Prep for Evercore",
      "Thank Gus Hale",
    ]);
  });

  test("day 10, 8am: the five, and one waiting behind them", () => {
    assert.deepEqual(V(10, 8).today.items.map((i) => i.title), [
      "Thank Gus Hale",
      "Email Evercore",
      "Follow up with Fay Wong",
      "Practise for Evercore",
      "Email Goldman Sachs",
    ]);
    assert.equal(V(10, 8).today.waiting, 1);
    assert.equal(V(10, 8).today.total, 6);
  });

  test("day 12, 9pm: Evercore opened this morning - its job has expired off the bell", () => {
    // ...and on the day it opens, one "apply" job in its place until midnight.
    assert.deepEqual(titles(V(12, 21)), ["Apply to Evercore", "Email Goldman Sachs", "Follow up with Fay Wong", "Prep for Evercore", "Thank Gus Hale"]);
    assert.equal(V(12, 21).all.find((t) => t.title === "Email Evercore"), undefined);
  });

  test("no Evercore outreach banner after its opening", () => {
    const late = s.shown.filter((x) => x.kind === "outreach" && x.subject === "Evercore" && x.at.getTime() >= at(12, 9).getTime());
    assert.deepEqual(late, []);
  });

  test("day 13, 9pm: three days out - the 3-day banner, still one prep job", () => {
    assert.deepEqual(bannersOf(V(13, 21), "interview_prep").map((b) => b.chip), ["interview in 3 days"]);
    assert.equal(V(13, 21).bell.open.filter((i) => i.kind === "interview_prep").length, 1);
  });

  test("day 15, 8am: the five, practising first", () => {
    assert.deepEqual(V(15, 8).today.items.map((i) => i.title), [
      "Practise for Evercore",
      "Thank Gus Hale",
      "Follow up with Fay Wong",
      "Email Goldman Sachs",
      "Evercore first round",
    ]);
  });

  test("day 15, 9pm: the evening-before refresher for a 9am interview", () => {
    assert.deepEqual(bannersOf(V(15, 21), "interview_prep").map((b) => [b.chip, b.detail, b.cta]), [
      ["interview tomorrow", "a quick refresher round", "Refresh"],
    ]);
    assert.deepEqual(V(15, 21).bell.open.filter((i) => i.kind === "interview_prep").map((i) => i.title), ["Refresh for Evercore"]);
  });

  test("day 15, 9pm: B never practised, so 'Practise for Evercore' is NOT crossed out as done on the to-do list", () => {
    // The prep row turned into the refresher in place: never crossed out as
    // done, and the refresher in its slot.
    const prep = item(V(15, 21), `interview-${interview}-prep`);
    const refresh = item(V(15, 21), `interview-${interview}-refresh`);
    assert.ok(!prep || !prep.done, "prep is shown crossed out as done");
    assert.ok(refresh && !refresh.done, "the refresher that replaced it is not in the list");
  });

  test("day 16, 8am: the refresher tops the five", () => {
    assert.deepEqual(V(16, 8).today.items.map((i) => i.title), [
      "Refresher for Evercore",
      "Thank Gus Hale",
      "Follow up with Fay Wong",
      "Email Goldman Sachs",
      "Evercore first round",
    ]);
  });

  test("no prep banner after the interview began", () => {
    const late = s.shown.filter((x) => x.kind === "interview_prep" && x.at.getTime() >= at(16, 9).getTime());
    assert.deepEqual(late, []);
  });

  test("day 16, 9pm: prep expired; the interview thank-you took its place", () => {
    assert.deepEqual(bannersOf(V(16, 21), "thank_you").map((b) => [b.subject, b.detail]), [
      ["Evercore first round", "thank your interviewers while it is fresh"],
    ]);
    assert.deepEqual(titles(V(16, 21)), ["Email Goldman Sachs", "Follow up with Fay Wong", "Thank Gus Hale", "Thank your interviewers"]);
  });

  test("day 20, 8am: Gus's thank-you speaks one last time - fourteen days on", () => {
    assert.deepEqual(
      bannersOf(V(20, 8), "thank_you").filter((b) => b.subject === "Gus Hale").map((b) => b.chip),
      ["thank-you · 14 days"],
    );
  });

  test("day 20, 9pm: Goldman opened and Gus's fortnight is up - both jobs expired", () => {
    assert.deepEqual(titles(V(20, 21)), ["Apply to Goldman Sachs", "Follow up with Fay Wong", "Thank your interviewers"]);
    const rows = V(20, 21).all;
    assert.equal(rows.find((t) => t.kind === "thank_you" && t.title === "Thank Gus Hale"), undefined);
    assert.equal(rows.find((t) => t.kind === "outreach"), undefined);
  });

  test("expired jobs are closed as expired, not as done", async () => {
    const rows = await h.db.query.notifications.findMany({ where: eq(notifications.userId, s.u.id) });
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    assert.equal(byTitle.get("Email Evercore")?.doneSource, "expired");
    assert.equal(byTitle.get("Email Goldman Sachs")?.doneSource, "expired");
    assert.equal(byTitle.get("Thank Gus Hale")?.doneSource, "expired");
    assert.equal(byTitle.get("Refresh for Evercore")?.doneSource, "expired");
  });

  test("the interview thank-you speaks every day from day 16 to day 30, and never after", () => {
    const days = [
      ...new Set(s.shown.filter((x) => x.kind === "thank_you" && x.subject === "Evercore first round").map((x) => x.day)),
    ];
    const expected = Array.from({ length: 15 }, (_, i) => localDay(at(16 + i, 12), NY));
    assert.deepEqual(days, expected);
  });

  test("day 30, 9pm: only Fay's follow-up remains on the bell", () => {
    assert.deepEqual(titles(V(30, 21)), ["Follow up with Fay Wong"]);
  });

  test("days 31-40: nothing that has passed ever reappears", () => {
    // Fay's follow-up, due on day 5, is the only thing left - and it lapses a
    // month after it fell due (FOLLOW_UP_EXPIRES_DAYS).
    const late = s.shown.filter((x) => x.at.getTime() > at(30, 21).getTime());
    for (const x of late) assert.equal(`${x.kind}:${x.subject}`, "follow_up:Fay Wong");
    for (let d = 31; d <= 34; d++) {
      assert.deepEqual(V(d, 21).all.map((t) => t.title), ["Follow up with Fay Wong"], `day ${d}`);
    }
    for (let d = 36; d <= 40; d++) {
      assert.deepEqual(V(d, 21).all.map((t) => t.title), [], `day ${d}`);
      assert.equal(V(d, 21).bell.openCount, 0, `day ${d}`);
    }
  });

  test("the bell count is always exactly its open list, and never counts a finished row", async () => {
    for (const [k, x] of visits) {
      assert.equal(x.bell.openCount, x.bell.open.length, k);
      assert.equal(x.bell.unreadCount, x.bell.open.filter((i) => !i.read).length, k);
    }
    const rows = await h.db.query.notifications.findMany({ where: eq(notifications.userId, s.u.id) });
    assert.equal(rows.filter((r) => !r.doneAt).length, V(40, 21).bell.openCount);
  });

  test("the bell never held two open jobs with the same title", () => {
    for (const [k, x] of visits) {
      const t = x.bell.open.map((i) => i.title);
      assert.equal(new Set(t).size, t.length, k);
    }
  });

  test("the follow-up banner comes back every other day while Fay is owed one", () => {
    const days = [...new Set(s.shown.filter((x) => x.kind === "follow_up").map((x) => x.day))].sort();
    const gaps = days.slice(1).map((d, i) => (Date.parse(d) - Date.parse(days[i])) / DAY);
    assert.deepEqual([...new Set(gaps)], [2]);
  });

  test("the bell only ever held the jobs B was actually prompted about", async () => {
    const rows = await h.db.query.notifications.findMany({ where: eq(notifications.userId, s.u.id) });
    assert.deepEqual(rows.map((r) => r.title).sort(), [
      "Apply to Evercore",
      "Apply to Goldman Sachs",
      "Email Evercore",
      "Email Goldman Sachs",
      "Follow up with Fay Wong",
      "Refresh for Evercore",
      "Thank Gus Hale",
      "Thank your interviewers",
    ]);
  });
});

// ======================================================================
// C: does everything the day it is asked
// ======================================================================

describe("C: does everything the same day it is asked", () => {
  let s: Student;
  const names = ["Hal Ames", "Ivy Bell", "Jon Cole", "Kay Dunn", "Leo Ford", "Mia Gray"];
  const ids: string[] = [];
  let interview = "";
  let v: Visit;

  before(async () => {
    s = await mkStudent("c");
    await trackFirm(s, "Goldman Sachs", at(18, 9));
    for (const n of names) ids.push(await mkContact(s, n, "Goldman Sachs", `${n.split(" ")[0].toLowerCase()}@gs.com`));
  });

  test("day 0: one banner for Goldman, six people", async () => {
    v = await visit(s, at(0, 10));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip, b.detail]), [
      ["Goldman Sachs", "opens in 18 days", "6 contacts you haven't emailed"],
    ]);
    assert.deepEqual(titles(v), ["Email Goldman Sachs"]);
  });

  test("day 0: all six emailed - the bell closes itself", async () => {
    for (let i = 0; i < ids.length; i++) await email(s, ids[i], at(0, 10, 30 + i));
    v = await visit(s, at(0, 11));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
  });

  test("day 0: nothing left anywhere", () => {
    assert.deepEqual(v.all, []);
  });

  test("days 1-6: silence", async () => {
    for (let d = 1; d <= 6; d++) {
      const x = await visit(s, at(d, 10));
      assert.equal(x.banners.length, 0, `day ${d}`);
      assert.equal(x.bell.openCount, 0, `day ${d}`);
      assert.deepEqual(x.all, [], `day ${d}`);
    }
  });

  test("day 7: all six due - one banner, six jobs", async () => {
    v = await visit(s, at(7, 11));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip, b.cta, b.href]), [
      ["6 people", "follow-ups due", "See who", "/contacts"],
    ]);
    assert.equal(v.bell.openCount, 6);
    assert.ok(v.bell.open.every((i) => i.kind === "follow_up"));
  });

  test("day 7: the to-do shows five follow-ups, alphabetical at equal urgency, one waiting", () => {
    assert.deepEqual(v.today.items.map((i) => i.title), names.slice(0, 5).map((n) => `Follow up with ${n}`));
    assert.equal(v.today.waiting, 1);
  });

  test("day 7: five sent - those five jobs close, five rows crossed out", async () => {
    for (let i = 0; i < 5; i++) await email(s, ids[i], at(7, 11, 10 + i), "follow_up");
    v = await visit(s, at(7, 11, 20));
    assert.deepEqual(titles(v), ["Follow up with Mia Gray"]);
    assert.ok(v.today.items.every((i) => i.done));
    assert.equal(v.today.finished, true);
  });

  test("day 7: Mia, already in this morning's '6 people' banner, is not announced again the same day", () => {
    assert.deepEqual(bannersOf(v, "follow_up").map((b) => b.subject), []);
  });

  test("day 7: 'Load the next 5' brings Mia", async () => {
    assert.equal(await loadNext(s, at(7, 11, 22)), true);
    v = await visit(s, at(7, 11, 23));
    assert.deepEqual(v.today.items.map((i) => [i.title, i.done]), [["Follow up with Mia Gray", false]]);
  });

  test("day 7: Mia sent - nothing left; 'Load the next 5' has nothing to load", async () => {
    await email(s, ids[5], at(7, 11, 25), "follow_up");
    v = await visit(s, at(7, 11, 30));
    assert.equal(v.bell.openCount, 0);
    assert.deepEqual(v.all, []);
    assert.deepEqual(v.today.items.map((i) => i.done), [true]);
    assert.equal(await loadNext(s, at(7, 11, 31)), false);
  });

  test("day 7: the done history holds all six, each once", async () => {
    const history = await act(s, at(7, 11, 32), () => L.getCompletedHistory(s.u.id, at(7, 11, 32)));
    const done = history.flatMap((d) => d.items.map((i) => i.id));
    assert.equal(done.length, 6);
    assert.equal(new Set(done).size, 6);
  });

  test("day 8: Hal replies - his ladder ends; a coffee chat goes on the calendar", async () => {
    await reply(s, ids[0], at(8, 10));
    await mkEvent(s, { type: "coffee_chat", title: "Coffee chat with Hal Ames", contactId: ids[0], eventDate: at(10, 13), endDate: at(10, 13, 30) });
    v = await visit(s, at(8, 10, 30));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.deepEqual(v.all.map((t) => [t.title, t.detail]), [["Coffee chat with Hal Ames", "Scheduled in 2 days"]]);
  });

  test("day 10, 4pm: the thank-you banner for Hal, and his to-do row", async () => {
    v = await visit(s, at(10, 16));
    assert.deepEqual(v.banners.map((b) => [kindOf(b), b.subject]), [["thank_you", "Hal Ames"]]);
    assert.deepEqual(v.today.items.map((i) => i.title), ["Thank Hal Ames"]);
  });

  test("day 10: thank-you sent - nothing lingers", async () => {
    await thank(s, ids[0], at(10, 16, 5));
    v = await visit(s, at(10, 16, 10));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.deepEqual(v.all, []);
    assert.deepEqual(v.today.items.map((i) => [i.title, i.done]), [["Thank Hal Ames", true]]);
  });

  test("day 11: no thank-you banner the morning after", async () => {
    v = await visit(s, at(11, 9));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
  });

  test("day 14: five 3rd emails due - one banner; Hal (replied) is not among them", async () => {
    v = await visit(s, at(14, 11, 40));
    assert.deepEqual(v.banners.map((b) => [b.subject, b.chip]), [["5 people", "follow-ups due"]]);
    assert.equal(v.bell.openCount, 5);
    assert.ok(!v.bell.open.some((i) => i.title === "Follow up with Hal Ames"));
  });

  test("day 14: all five sent - the ladder is over for everyone", async () => {
    for (let i = 1; i < 6; i++) await email(s, ids[i], at(14, 11, 44 + i), "follow_up");
    v = await visit(s, at(14, 11, 55));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.deepEqual(v.all, []);
    const ladders = await act(s, at(14, 12), () => L.getLadders(s.u.id, at(14, 12)));
    for (const id of ids.slice(1)) assert.equal(ladders.get(id)?.stage, "finished");
  });

  test("day 15: an interview a week out - the prep banner", async () => {
    interview = await mkEvent(s, { type: "interview", title: "Goldman Sachs first round", eventDate: at(22, 15), endDate: at(22, 16) });
    s.google.push(
      invite("c-first-round", "Goldman Sachs first round", at(22, 15), at(22, 16), [
        { email: "kim.ray@gs.com", name: "Kim Ray" },
        { email: "lou.tan@gs.com", name: "Lou Tan" },
      ]),
    );
    v = await visit(s, at(15, 15, 30));
    assert.deepEqual(v.banners.map((b) => [kindOf(b), b.chip]), [["interview_prep", "interview in 7 days"]]);
    assert.deepEqual(titles(v), ["Prep for Goldman Sachs"]);
  });

  test("day 15: practised straight away - prep gone from the bell and the to-do", async () => {
    await practise(s, at(15, 15, 40));
    v = await visit(s, at(15, 15, 50));
    assert.equal(v.bell.openCount, 0);
    assert.equal(v.all.filter((t) => t.kind === "interview").length, 0);
  });

  test("days 16-21: the 3-day and 1-day marks stay quiet", async () => {
    for (let d = 16; d <= 21; d++) {
      const x = await visit(s, at(d, 16));
      // Goldman's opening day falls in here: its "apply" prompt is not prep.
      const notApply = x.banners.filter((b) => !(kindOf(b) === "outreach" && b.chip === "opens today"));
      assert.equal(notApply.length, 0, `day ${d}`);
      assert.equal(x.bell.open.filter((i) => !i.title.startsWith("Apply to")).length, 0, `day ${d}`);
      assert.equal(x.all.filter((t) => t.kind === "interview").length, 0, `day ${d}`);
    }
  });

  test("day 22, 8:30am: the refresher still comes, the morning of", async () => {
    v = await visit(s, at(22, 8, 30));
    assert.deepEqual(v.banners.map((b) => [kindOf(b), b.chip, b.cta]), [["interview_prep", "interview today", "Refresh"]]);
    assert.equal(v.today.items[0]?.title, "Refresher for Goldman Sachs");
  });

  test("day 22: refresher played - gone from all three", async () => {
    await practise(s, at(22, 8, 40));
    v = await visit(s, at(22, 8, 50));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.equal(v.all.filter((t) => t.kind === "interview").length, 0);
  });

  test("day 22, 6:05pm: the interview thank-you names Kim first", async () => {
    v = await visit(s, at(22, 18, 5));
    assert.deepEqual(v.banners.map((b) => [kindOf(b), b.subject]), [["thank_you", "Goldman Sachs first round"]]);
    const t = await act(s, at(22, 18, 5), async () => (await L.getThankYouPrompts(s.u.id, at(22, 18, 5)))[0]);
    assert.equal(t?.next.name, "Kim Ray");
    assert.equal(t?.next.email, "kim.ray@gs.com");
    assert.deepEqual(titles(v), ["Thank your interviewers"]);
  });

  test("day 22: both interviewers thanked - it closes itself, nothing lingers", async () => {
    await thankNext(s, offerlyKey(interview), at(22, 18, 10), "thank_you_interview");
    await thankNext(s, offerlyKey(interview), at(22, 18, 20), "thank_you_interview");
    v = await visit(s, at(22, 18, 30));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.equal(v.all.filter((t) => t.kind === "thank_you").length, 0);
  });

  test("day 23: nothing at all", async () => {
    v = await visit(s, at(23, 10));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
  });

  test("day 25: Hal, met for coffee and thanked 15 days ago, is not 'due a catch-up'", async () => {
    v = await visit(s, at(25, 10));
    const catchUp = v.all.find((t) => t.id.startsWith(`follow-${ids[0]}`));
    assert.equal(catchUp, undefined, `unexpected: ${catchUp?.title} · ${catchUp?.detail}`);
  });

  test("day 25: no other work reappears", () => {
    assert.deepEqual(v.all.filter((t) => !t.id.startsWith("follow-")), []);
    assert.equal(v.banners.length, 0);
  });

  test("day 40: silence - banner, bell, and nothing but a legitimate catch-up", async () => {
    v = await visit(s, at(40, 10));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.deepEqual(v.all.filter((t) => !t.id.startsWith(`follow-${ids[0]}`)).map((t) => t.title), []);
  });

  test("every job C was ever given is closed as done (auto or manual), none expired", async () => {
    const rows = await h.db.query.notifications.findMany({ where: eq(notifications.userId, s.u.id) });
    assert.ok(rows.length > 0);
    // Applying happens on the firm's own site, which the app cannot see: the
    // opening day's "apply" job runs out at midnight unless ticked off.
    assert.deepEqual(
      rows
        .filter((r) => !r.title.startsWith("Apply to"))
        .filter((r) => r.doneSource === "expired" || !r.doneAt)
        .map((r) => r.title),
      [],
    );
  });

  test("never two banners about the same thing on one day", () => {
    const seen = new Map<string, number>();
    for (const x of s.shown) seen.set(`${x.day}|${x.kind}|${x.subject}`, (seen.get(`${x.day}|${x.kind}|${x.subject}`) ?? 0) + 1);
    assert.deepEqual([...seen].filter(([, n]) => n > 1), []);
  });

  test("the only follow-up banners were the two batches it was actually owed", () => {
    const followUps = s.shown.filter((x) => x.kind === "follow_up");
    assert.deepEqual(followUps.map((x) => x.subject), ["6 people", "5 people"]);
  });
});

// ======================================================================
// D: the edge cases
// ======================================================================
//
// New York until day 10, then Los Angeles. A draft taken back, contacts
// deleted mid-ladder, a to-do row ticked instead of the work, a posting that
// stops being real, an interview moved a few days later.

describe("D: moves coast, deletes, unsends, reschedules, and a posting disappears", () => {
  let s: Student;
  const c = {} as Record<"kai" | "lia" | "max" | "oli" | "pia" | "nia", string>;
  let msPosting = "";
  let kaiDraft = "";
  let superday = "";
  let chat = "";
  let v: Visit;

  before(async () => {
    s = await mkStudent("d");
    await trackFirm(s, "Goldman Sachs", at(20, 9));
    msPosting = (await trackFirm(s, "Morgan Stanley", at(16, 9))).postingId!;
    await trackFirm(s, "Evercore", at(12, 9));
    c.kai = await mkContact(s, "Kai Ross", "Goldman Sachs", "kai.ross@gs.com");
    c.lia = await mkContact(s, "Lia Fox", "Goldman Sachs", "lia.fox@gs.com");
    c.max = await mkContact(s, "Max Ng", "Morgan Stanley", "max.ng@ms.com");
    c.oli = await mkContact(s, "Oli Park", "Morgan Stanley", "oli.park@ms.com");
    c.pia = await mkContact(s, "Pia Lee", "Evercore", "pia.lee@evercore.com");
    c.nia = await mkContact(s, "Nia Cole", "Centerview", "nia@centerview.com", {
      relationshipStatus: "ongoing",
      lastContactDate: "2026-10-01",
    });
  });

  test("day 0: three openings, soonest first; three jobs", async () => {
    v = await visit(s, at(0, 10));
    assert.deepEqual(v.banners.map((b) => b.subject), ["Evercore", "Morgan Stanley", "Goldman Sachs"]);
    assert.deepEqual(titles(v), ["Email Evercore", "Email Goldman Sachs", "Email Morgan Stanley"]);
    assert.deepEqual(v.today.items.map((i) => i.title), ["Email Evercore"]);
  });

  test("day 0: Kai emailed; 'Email Evercore' ticked done on the to-do instead of emailing Pia", async () => {
    kaiDraft = await writeDraft(s, c.kai, "cold_outreach", "cold_outreach", "Hello Kai");
    await markSent(s, kaiDraft, at(0, 10, 30));
    const evercore = v.all.find((t) => t.title === "Email Evercore");
    assert.ok(evercore);
    assert.equal(await tick(s, evercore.id, at(0, 10, 40)), true);
    v = await visit(s, at(0, 10, 50));
    assert.deepEqual(v.today.items.map((i) => [i.title, i.done]), [["Email Evercore", true]]);
    assert.equal(v.all.find((t) => t.title === "Email Evercore"), undefined);
  });

  test("day 0: the ticked 'Email Evercore' is closed under the bell too", () => {
    assert.equal(bellItem(v, "Email Evercore"), undefined, "the to-do says done, the bell still asks");
  });

  test("day 1: Kai's email taken back ('I sent this' unticked) - he is back to 'not contacted'", async () => {
    await unsend(s, kaiDraft, at(1, 10, 5));
    const kai = await h.db.query.contacts.findFirst({ where: eq(contacts.id, c.kai) });
    assert.equal(kai?.relationshipStatus, "not_contacted");
    assert.equal(kai?.lastContactDate, null);
    const sends = await h.db.query.outreachSends.findMany({ where: eq(outreachSends.contactId, c.kai) });
    assert.equal(sends.length, 0);
  });

  test("day 1: the draft is back on the to-do as unsent; Goldman counts 0 of 2 again", async () => {
    v = await visit(s, at(1, 10, 10));
    assert.equal(task(v, `draft-${kaiDraft}`)?.title, "Send: Hello Kai");
    assert.deepEqual(bellItem(v, "Email Goldman Sachs")?.progress, { done: 0, total: 2 });
  });

  test("day 2: the ticked Evercore does not come back as a banner", async () => {
    v = await visit(s, at(2, 10));
    assert.deepEqual(bannersOf(v, "outreach").filter((b) => b.subject === "Evercore").map((b) => b.chip), []);
  });

  test("day 2: Goldman's banner counts Kai again (2 contacts); Morgan Stanley 2", () => {
    const o = bannersOf(v, "outreach").filter((b) => b.subject !== "Evercore");
    assert.deepEqual(o.map((b) => `${b.subject}: ${b.detail}`), [
      "Morgan Stanley: 2 contacts you haven't emailed",
      "Goldman Sachs: 2 contacts you haven't emailed",
    ]);
  });

  test("day 2: the same draft copied again is email 1 again; Lia emailed; Goldman's job closes", async () => {
    await markSent(s, kaiDraft, at(2, 10, 30));
    await email(s, c.lia, at(2, 10, 35));
    v = await visit(s, at(2, 10, 40));
    const sends = await h.db.query.outreachSends.findMany({ where: eq(outreachSends.contactId, c.kai) });
    assert.deepEqual(sends.map((x) => x.step), [1]);
    assert.equal(bellItem(v, "Email Goldman Sachs"), undefined);
    assert.equal(task(v, `draft-${kaiDraft}`), undefined);
  });

  test("day 3: Max (Morgan Stanley) deleted - the prompt counts one person, the to-do row too", async () => {
    await deleteContact(s, c.max);
    v = await visit(s, at(3, 10, 10));
    assert.deepEqual(bellItem(v, "Email Morgan Stanley")?.progress, { done: 0, total: 1 });
    assert.equal(v.all.find((t) => t.title === "Email Morgan Stanley")?.detail, "1 contact left to email · opens in 13 days");
  });

  test("day 5: the Morgan Stanley posting stops being real - no banner, no to-do row", async () => {
    await h.db
      .update(internshipPostings)
      .set({ deadlineText: "Summer 2027 applications are not open yet", deadlineStatus: "tbd" })
      .where(eq(internshipPostings.id, msPosting));
    v = await visit(s, at(5, 10, 10));
    assert.equal(bannersOf(v, "outreach").filter((b) => b.subject === "Morgan Stanley").length, 0);
    assert.equal(v.all.find((t) => t.title === "Email Morgan Stanley"), undefined);
  });

  test("day 5: ...and its bell job is not still asking", () => {
    assert.equal(bellItem(v, "Email Morgan Stanley"), undefined);
  });

  test("day 9: Kai and Lia due together - one banner, two jobs", async () => {
    v = await visit(s, at(9, 11));
    assert.deepEqual(bannersOf(v, "follow_up").map((b) => b.subject), ["2 people"]);
    assert.ok(bellItem(v, "Follow up with Kai Ross"));
    assert.ok(bellItem(v, "Follow up with Lia Fox"));
  });

  test("day 9: Lia deleted - her job closes, her row goes", async () => {
    await deleteContact(s, c.lia);
    v = await visit(s, at(9, 11, 40));
    assert.equal(bellItem(v, "Follow up with Lia Fox"), undefined);
    assert.equal(v.all.find((t) => t.title === "Follow up with Lia Fox"), undefined);
    assert.ok(bellItem(v, "Follow up with Kai Ross"));
  });

  test("day 9: deleting Lia does not re-announce Kai, already in this morning's banner", () => {
    assert.deepEqual(bannersOf(v, "follow_up").map((b) => b.subject), []);
  });

  test("day 9: Kai followed up - his job closes", async () => {
    await email(s, c.kai, at(9, 11, 45), "follow_up");
    v = await visit(s, at(9, 11, 50));
    assert.equal(bellItem(v, "Follow up with Kai Ross"), undefined);
    assert.equal(v.all.filter((t) => t.id.startsWith("ladder-")).length, 0);
  });

  test("day 10 (now in Los Angeles): the superday a week out - prep banner on the LA clock", async () => {
    s.tz = LA;
    superday = await mkEvent(s, { type: "meeting", title: "Goldman Sachs Superday", eventDate: at(17, 9, 0, LA), endDate: at(17, 10, 0, LA) });
    v = await visit(s, at(10, 9, 30, LA));
    assert.deepEqual(bannersOf(v, "interview_prep").map((b) => [b.subject, b.chip]), [["Your Goldman Sachs interview", "interview in 7 days"]]);
    assert.ok(bellItem(v, "Prep for Goldman Sachs"));
  });

  test("day 11: the superday moved three days later - now 9 days out, outside the prep window: no prep row", async () => {
    await h.db.update(events).set({ eventDate: at(20, 9, 0, LA), endDate: at(20, 10, 0, LA) }).where(eq(events.id, superday));
    chat = await mkEvent(s, { type: "coffee_chat", title: "Coffee with Nia Cole", contactId: c.nia, eventDate: at(11, 17, 0, LA), endDate: at(11, 17, 30, LA) });
    v = await visit(s, at(11, 10, 0, LA));
    assert.equal(task(v, `interview-${superday}-prep`), undefined);
    assert.equal(task(v, `event-${superday}`)?.detail, "Scheduled in 9 days");
  });

  test("day 11: the bell does not keep asking to prep 'before 22 Oct' for an interview now on 25 Oct", () => {
    const prep = v.bell.open.filter((i) => i.kind === "interview_prep");
    assert.deepEqual(prep.filter((i) => /22 Oct/.test(i.body)).map((i) => `${i.title} · ${i.body}`), []);
  });

  test("day 11, 9:30pm LA (00:30 in New York): the thank-you is 'today', not 'yesterday'", async () => {
    v = await visit(s, at(11, 21, 30, LA));
    const t = bannersOf(v, "thank_you");
    assert.deepEqual(t.map((b) => [b.subject, b.chip]), [["Nia Cole", "thank-you"]]);
    assert.equal(task(v, `thanks-${offerlyKey(chat)}`)?.detail, "Coffee with Nia Cole · today");
  });

  test("day 11: the bell's row dates the chat on the LA calendar (16 Oct)", () => {
    const row = bellItem(v, "Thank Nia Cole");
    assert.ok(row);
    assert.match(row.body, /16 Oct/);
  });

  test("day 11: today's to-do list is still LA's 16 October - no batch for the 17th yet", async () => {
    const rows = await h.db.query.todoBatches.findMany({ where: eq(todoBatches.userId, s.u.id) });
    assert.ok(rows.some((r) => r.day === "2026-10-16"));
    assert.ok(!rows.some((r) => r.day === "2026-10-17"));
  });

  test("day 12, 8am LA: the thank-you speaks again, as 'yesterday'", async () => {
    v = await visit(s, at(12, 8, 0, LA));
    assert.deepEqual(bannersOf(v, "thank_you").map((b) => b.chip), ["thank-you · yesterday"]);
  });

  test("day 12: ticked on the to-do ('I sent it from my phone') - banner, row and job all close", async () => {
    assert.equal(await tick(s, `thanks-${offerlyKey(chat)}`, at(12, 8, 10, LA)), true);
    v = await visit(s, at(12, 8, 20, LA));
    assert.equal(bannersOf(v, "thank_you").length, 0);
    assert.equal(bellItem(v, "Thank Nia Cole"), undefined);
    assert.equal(task(v, `thanks-${offerlyKey(chat)}`), undefined);
    const later = await visit(s, at(13, 8, 0, LA));
    assert.equal(bannersOf(later, "thank_you").length, 0);
  });

  test("day 13: seven days before the NEW date - the 7-day prep banner speaks for the moved interview", async () => {
    v = await visit(s, at(13, 9, 30, LA));
    assert.deepEqual(bannersOf(v, "interview_prep").map((b) => b.chip), ["interview in 7 days"]);
  });

  test("day 13: the to-do counts down to the new date", () => {
    assert.equal(task(v, `interview-${superday}-prep`)?.detail, "Technicals · interview in 7 days");
  });

  test("day 17: the original date has passed - the prep job is open for the moved interview (3 days out)", async () => {
    v = await visit(s, at(17, 9, 30, LA));
    assert.ok(bellItem(v, "Prep for Goldman Sachs"));
    assert.deepEqual(bannersOf(v, "interview_prep").map((b) => b.chip), ["interview in 3 days"]);
  });

  test("day 17: Kai's final email, written from LA, is dated on the LA calendar", async () => {
    assert.deepEqual(bannersOf(v, "follow_up").map((b) => [b.subject, b.chip]), [["Kai Ross", "3rd email due"]]);
    await email(s, c.kai, at(17, 9, 40, LA), "follow_up");
    const kai = await h.db.query.contacts.findFirst({ where: eq(contacts.id, c.kai) });
    assert.equal(kai?.lastContactDate, "2026-10-22");
  });

  test("day 19, 6:30pm LA: the evening-before refresher for a 9am (LA) interview", async () => {
    v = await visit(s, at(19, 18, 30, LA));
    assert.deepEqual(bannersOf(v, "interview_prep").map((b) => [b.chip, b.cta]), [["interview tomorrow", "Refresh"]]);
    assert.ok(bellItem(v, "Refresh for Goldman Sachs"));
    await practise(s, at(19, 19, 0, LA));
    const after = await visit(s, at(19, 19, 30, LA));
    assert.equal(after.bell.open.filter((i) => i.kind === "interview_prep").length, 0);
  });

  test("day 20, 12:30pm LA: the interview thank-you", async () => {
    v = await visit(s, at(20, 12, 30, LA));
    assert.deepEqual(bannersOf(v, "thank_you").map((b) => [b.subject, b.detail]), [
      ["Goldman Sachs Superday", "thank your interviewers while it is fresh"],
    ]);
    assert.deepEqual(titles(v), ["Apply to Goldman Sachs", "Thank your interviewers"]);
  });

  test("day 20: one note to someone the invitation never listed - '1 note sent', still open", async () => {
    await thankNext(s, offerlyKey(superday), at(20, 13, 0, LA), "thank_you_superday", { name: "Quinn Hart", email: "quinn.hart@gs.com" });
    v = await visit(s, at(20, 13, 30, LA));
    assert.match(task(v, `thanks-${offerlyKey(superday)}`)?.detail ?? "", /1 note sent/);
    assert.equal(bannersOf(v, "thank_you").length, 0, "already spoke today");
  });

  test("day 21, 9am LA: 'anyone else to thank?' - That's everyone closes it", async () => {
    v = await visit(s, at(21, 9, 0, LA));
    const b = bannersOf(v, "thank_you");
    assert.deepEqual(b.map((x) => [x.chip, x.detail, x.doneLabel]), [
      ["thank-you · yesterday", "1 note sent · anyone else to thank?", "That's everyone"],
    ]);
    assert.equal(await thatsEveryone(s, offerlyKey(superday), at(21, 9, 1, LA)), true);
    v = await visit(s, at(21, 9, 30, LA));
    assert.equal(v.bell.openCount, 0);
  });

  test("day 25: nothing - Morgan Stanley's old opening has passed without anything reappearing", async () => {
    v = await visit(s, at(25, 10, 0, LA));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.deepEqual(v.all, []);
  });

  test("day 25: the withdrawn firm's job closed the day it was withdrawn, not at the old opening", async () => {
    const row = await h.db.query.notifications.findFirst({
      where: and(eq(notifications.userId, s.u.id), eq(notifications.title, "Email Morgan Stanley")),
    });
    assert.ok(row?.doneAt);
    assert.ok(row.doneAt.getTime() <= at(5, 10, 10).getTime(), `closed at ${row.doneAt.toISOString()}`);
  });

  test("day 40: nothing reappears", async () => {
    v = await visit(s, at(40, 10, 0, LA));
    assert.equal(v.banners.length, 0);
    assert.equal(v.bell.openCount, 0);
    assert.deepEqual(v.all, []);
  });

  test("never the same banner key twice", () => {
    const keys = s.shown.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});
