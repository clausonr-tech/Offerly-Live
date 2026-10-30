// The thank-you prompt for CHATS and CALLS, adversarially, end to end.
//
// Second round, after thank-you-lifecycle.test.ts. That file walks the happy
// paths; this one hunts for the places the three surfaces - the daily banner,
// the to-do row and the job under the bell - can disagree with each other or
// with what the student actually did:
//
//   - a week of hourly page loads, on the student's clock, across DST;
//   - every way it ends (tick, send, expiry, deletion, a move, a failed Google
//     read and its recovery) and taking a send back;
//   - "Outside of your matched contacts" filled from a `thank=` key: real,
//     forged, finished, and somebody else's;
//   - the tracked-firm lookup, contacts that share an address or have none,
//     a contact deleted after the send, many owed at once, and the other
//     prompt kinds competing for the one banner.
//
// Real queries over an in-memory PGlite migrated from drizzle/*.sql. Server
// actions that need a signed-in student (markPromptFlashSeen,
// completeThankYouPrompt, markDraftSent/setDraftSent, completeTask, the
// outreach page's `thank` lookup) are replayed step for step with the same lib
// calls. Google entries are seeded straight into the per-student cache.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed, fetch throws.

// Production (Vercel) runs in UTC.
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
  flashesShown,
  notifications,
  todoDismissals,
  userTopFirms,
  users,
} from "@/db/schema";
import {
  closeNotificationByKey,
  getNotifications,
  markNotificationDone,
  markNotificationsRead,
  upsertNotification,
} from "@/lib/notifications";
import { getPendingFlash, markFlashShown, thankYouNotification } from "@/lib/prompt-flash";
import type { ChatEvent, ThankYouPrompt } from "@/lib/thank-you";
import { getThankYouPrompts, reconcileThankYouJobs, reopenOwedThankYouJobs } from "@/lib/thank-you-db";
import { localDateString, zonedTime } from "@/lib/time-zone";
import { getAllTasks } from "@/lib/today-tasks";
import { getEverything, getTodayList, loadNextBatch, recordCompleted } from "@/lib/today-list";

delete process.env.DATABASE_URL;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TZ = "America/New_York";

const et = (y: number, m: number, d: number, h: number, min = 0) => zonedTime(y, m, d, h, min, TZ);
/** Monday 21 September 2026, New York wall clock. */
const mon = (h: number, min = 0) => et(2026, 9, 21, h, min);
/** The same week, by weekday offset from Monday. */
const day = (offset: number, h: number, min = 0) => et(2026, 9, 21 + offset, h, min);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const localDate = (d: Date) => localDateString(d, TZ);

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

// ------------------------------------------------------------------ fixtures

type User = typeof users.$inferSelect;
let seq = 0;

async function mkUser(): Promise<User> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({ email: `general-${seq}-${Date.now()}@example.edu`, passwordHash: "x", name: `Alex Rivera ${seq}` })
    .returning();
  return u;
}

async function mkContact(
  userId: string,
  name = "Dana Reed",
  email: string | null = null,
  over: Partial<typeof contacts.$inferInsert> = {},
): Promise<string> {
  const [c] = await h.db
    .insert(contacts)
    .values({ userId, name, email, relationshipStatus: "in_conversation", ...over })
    .returning({ id: contacts.id });
  return c.id;
}

/** A coffee chat 2pm-2:30pm Monday unless told otherwise: due 4:30pm. */
async function mkEvent(userId: string, over: Partial<typeof events.$inferInsert> = {}): Promise<string> {
  const [e] = await h.db
    .insert(events)
    .values({ userId, type: "coffee_chat", title: "Coffee chat", eventDate: mon(14), endDate: mon(14, 30), ...over })
    .returning({ id: events.id });
  return e.id;
}

async function track(userId: string, name: string) {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `firm-${seq}-${Date.now()}`,
      name,
      headquarters: "New York, NY",
      keyOffices: "New York",
      website: "example.com",
      description: "A firm.",
    })
    .returning({ id: firms.id });
  await h.db.insert(userTopFirms).values({ userId, firmId: f.id });
}

const offerlyKey = (id: string) => `thank_you:offerly:${id}`;
const googleKey = (id: string) => `thank_you:google:${id}`;

// ---- Google, through the cache thank-you-db reads

type GoogleRead = { at: number; events: ChatEvent[]; ok?: boolean };
function googleCache(): Map<string, GoogleRead> {
  const g = globalThis as { __thankYouGoogleCache?: Map<string, GoogleRead> };
  g.__thankYouGoogleCache ??= new Map();
  return g.__thankYouGoogleCache;
}
const seeded = new Map<string, { events: ChatEvent[]; ok: boolean }>();
function seedGoogle(userId: string, evs: ChatEvent[], ok = true) {
  seeded.set(userId, { events: evs, ok });
}
function failGoogle(userId: string, evs: ChatEvent[] = []) {
  seeded.set(userId, { events: evs, ok: false });
}
function prime(userId: string, now: Date) {
  const s = seeded.get(userId);
  if (s) googleCache().set(userId, { at: now.getTime(), events: s.events, ...(s.ok ? {} : { ok: false }) });
}
function gEvent(over: Partial<ChatEvent> & { id: string }): ChatEvent {
  const { id, ...rest } = over;
  return {
    sourceKey: `google:${id}`,
    title: "Coffee chat",
    startsAt: mon(14),
    endsAt: mon(14, 30),
    allDay: false,
    notes: null,
    videoCall: false,
    attendeeEmails: [],
    declined: false,
    recurring: false,
    eventType: "default",
    ...rest,
  };
}
/** A Google entry with exactly these people on the invitation. */
function invite(id: string, people: { email: string; name: string | null }[], over: Partial<ChatEvent> = {}) {
  return gEvent({ id, attendees: people, attendeeEmails: people.map((p) => p.email.toLowerCase()), ...over });
}

// ---- what the student sees, at a moment

async function owed(u: User, now: Date): Promise<ThankYouPrompt[]> {
  prime(u.id, now);
  return getThankYouPrompts(u.id, now);
}
const owedKeys = async (u: User, now: Date) => (await owed(u, now)).map((t) => t.key);

async function banner(u: User, now: Date) {
  prime(u.id, now);
  return getPendingFlash(u, now);
}

/** markPromptFlashSeen, step for step. */
async function seeBanner(u: User, now: Date) {
  const pending = await banner(u, now);
  if (!pending) return null;
  for (const n of pending.notifications) await upsertNotification({ userId: u.id, ...n, now });
  await markFlashShown(u.id, pending.flashKey);
  return pending;
}

/** Every banner one page load after another at this moment, until silence. */
async function drain(u: User, now: Date) {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const p = await seeBanner(u, now);
    if (!p) break;
    out.push(p);
  }
  return out;
}

/** completeThankYouPrompt, step for step. */
async function tick(u: User, key: string, now: Date): Promise<boolean> {
  const t = (await owed(u, now)).find((p) => p.key === key);
  if (!t) return false;
  await upsertNotification({ userId: u.id, ...thankYouNotification(t), now });
  await closeNotificationByKey(u.id, t.key, "manual", now);
  return true;
}

async function mkDraft(userId: string, contactId: string | null, kind: "thank_you" | "cold_outreach" | "follow_up" | "custom" = "thank_you", templateId = "thank_you_chat") {
  const [d] = await h.db
    .insert(emailDrafts)
    .values({ userId, contactId, kind, templateId, subject: "Thank you", body: "Thanks for your time." })
    .returning({ id: emailDrafts.id });
  return d.id;
}

/** markDraftSent's thank-you half. */
async function sendDraft(u: User, draftId: string, now: Date) {
  const draft = await h.db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, draftId) });
  assert.ok(draft);
  await h.db.update(emailDrafts).set({ sentAt: draft.sentAt ?? now, updatedAt: now }).where(eq(emailDrafts.id, draftId));
  if (draft.kind === "thank_you") {
    prime(u.id, now);
    await reconcileThankYouJobs(u.id, now);
  }
}

async function sendThanks(u: User, contactId: string, at: Date) {
  const d = await mkDraft(u.id, contactId);
  await sendDraft(u, d, at);
  return d;
}

/** setDraftSent(draftId, false), step for step. */
async function unsend(u: User, draftId: string, now: Date) {
  const draft = await h.db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, draftId) });
  assert.ok(draft);
  await h.db.update(emailDrafts).set({ sentAt: null, updatedAt: now }).where(eq(emailDrafts.id, draftId));
  if (draft.kind === "thank_you") {
    prime(u.id, now);
    await reopenOwedThankYouJobs(u.id, now);
  }
}

/** The outside form's send: resolveRecipient("outside") saves the person as a
 *  contact (reusing one with that address), the draft hangs off it, then the
 *  send runs as markDraftSent does. */
async function sendOutside(u: User, who: { name: string; firm: string; email: string }, at: Date) {
  const email = who.email.toLowerCase();
  const mine = await h.db.query.contacts.findMany({ where: eq(contacts.userId, u.id) });
  const existing = mine.find((c) => c.email?.toLowerCase() === email);
  const contactId =
    existing?.id ??
    (
      await h.db
        .insert(contacts)
        .values({ userId: u.id, name: who.name, firm: who.firm, email })
        .returning({ id: contacts.id })
    )[0].id;
  const d = await sendThanks(u, contactId, at);
  return { contactId, draftId: d };
}

/** The outreach page's `thank` lookup, step for step: the owed prompt with
 *  that key, and only when its next note is to someone not saved. */
async function outsideFor(u: User, thankKey: string | undefined, now: Date) {
  if (!thankKey) return undefined;
  const p = (await owed(u, now)).find((t) => t.key === thankKey) ?? null;
  return p && !p.next.contactId ? { name: p.next.name, email: p.next.email, firm: p.next.firm } : undefined;
}

/** What the page receives as `searchParams.thank` from a prompt's link. */
function thankParam(href: string): string | undefined {
  return new URL(href, "https://offerly.test").searchParams.get("thank") ?? undefined;
}

async function todo(u: User, now: Date) {
  prime(u.id, now);
  return (await getAllTasks(u, now)).filter((t) => t.kind === "thank_you");
}

/** completeTask on the to-do list, step for step. */
async function todoTick(u: User, taskId: string, now: Date): Promise<boolean> {
  prime(u.id, now);
  const task = (await getAllTasks(u, now)).find((t) => t.id === taskId);
  if (!task) return false;
  if (task.doneKey) await tick(u, task.doneKey, now);
  await recordCompleted(u.id, [task], "manual", now);
  await h.db.insert(todoDismissals).values({ userId: u.id, taskId: task.id }).onConflictDoNothing();
  return true;
}

async function jobRows(userId: string) {
  return h.db.query.notifications.findMany({
    where: and(eq(notifications.userId, userId), eq(notifications.kind, "thank_you")),
  });
}
async function jobRow(userId: string, key: string) {
  return h.db.query.notifications.findFirst({
    where: and(eq(notifications.userId, userId), eq(notifications.dedupeKey, key)),
  });
}
async function bell(u: User, now: Date) {
  prime(u.id, now);
  return (await getNotifications(u.id, now)).open.filter((n) => n.kind === "thank_you");
}

const isThanks = (flashKey: string) => flashKey.startsWith("thank_you:");

/** Hourly page loads: every banner the student saw, keyed by local date. */
async function hourly(
  u: User,
  from: Date,
  hours: number,
  onHour?: (now: Date, i: number) => Promise<void>,
  stepHours = 1,
) {
  const seen: { now: Date; key: string; chip: string; date: string }[] = [];
  for (let i = 0; i < hours; i += stepHours) {
    const now = plus(from, i * HOUR);
    if (onHour) await onHour(now, i);
    for (const p of await drain(u, now)) {
      if (isThanks(p.flashKey)) seen.push({ now, key: p.flashKey, chip: p.chip, date: localDate(now) });
    }
  }
  return seen;
}
function perDate(seen: { date: string }[]) {
  const m = new Map<string, number>();
  for (const s of seen) m.set(s.date, (m.get(s.date) ?? 0) + 1);
  return m;
}
const dates = (from: string, n: number) => {
  const [y, mo, d] = from.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, mo - 1, d + i)).toISOString().slice(0, 10));
};

// ======================================================= a week of page loads

describe("a week of hourly page loads", () => {
  test("an Offerly chat with Dana: exactly one banner per New York day, first at 5pm Monday", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    const seen = await hourly(u, mon(15), 7 * 24);
    assert.equal(seen[0].now.getTime(), mon(17).getTime(), "not before it is due");
    assert.deepEqual([...perDate(seen).keys()], dates("2026-09-21", 8));
    assert.ok([...perDate(seen).values()].every((n) => n === 1));
    assert.ok(seen.every((s) => s.key === `${offerlyKey(e)}:${s.date}`));
  });

  test("the chip counts the days on the student's calendar, one step a day", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    const seen = await hourly(u, mon(15), 7 * 24);
    assert.deepEqual(seen.map((s) => s.chip), [
      "thank-you",
      "thank-you · yesterday",
      "thank-you · 2 days",
      "thank-you · 3 days",
      "thank-you · 4 days",
      "thank-you · 5 days",
      "thank-you · 6 days",
      "thank-you · 7 days",
    ]);
  });

  test("each day's banner is shown just after local midnight, not UTC midnight", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    const seen = await hourly(u, mon(15), 4 * 24);
    // After Monday, every banner lands on the first load of the New York day.
    for (const s of seen.slice(1)) {
      assert.equal(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: TZ }).format(s.now), "00");
    }
  });

  test("a week of banners is ONE bell row, open, titled for Dana, bumped by the last banner", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    const seen = await hourly(u, mon(15), 7 * 24);
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedupeKey, offerlyKey(e));
    assert.equal(rows[0].doneAt, null);
    assert.equal(rows[0].title, "Thank Dana Reed");
    assert.equal(rows[0].bumpedAt.getTime(), seen[seen.length - 1].now.getTime());
  });

  test("a Google chat with a saved contact: one banner a day, one bell row", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [invite("g-week", [{ email: "dana@evercore.com", name: "Dana Reed" }])]);
    const seen = await hourly(u, mon(15), 7 * 24);
    assert.deepEqual([...perDate(seen).values()], Array(8).fill(1));
    assert.ok(seen.every((s) => s.key.startsWith(googleKey("g-week"))));
    assert.equal((await jobRows(u.id)).length, 1);
  });

  test("with nobody linked: one banner a day that names the entry, and one 'Send a thank-you' row", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee chat at Blue Bottle" });
    const seen = await hourly(u, mon(15), 3 * 24);
    // Monday 3pm plus 72 hours reaches Thursday 2pm: four local days.
    assert.deepEqual([...perDate(seen).values()], [1, 1, 1, 1]);
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Send a thank-you");
  });

  test("two chats owed: two banners a day (one each) and two bell rows", async () => {
    const u = await mkUser();
    const a = await mkEvent(u.id, { title: "Coffee chat A", eventDate: mon(9), endDate: mon(9, 30) });
    const b = await mkEvent(u.id, { title: "Coffee chat B" });
    const seen = await hourly(u, mon(18), 5 * 24);
    for (const [, n] of perDate(seen)) assert.equal(n, 2);
    assert.deepEqual((await jobRows(u.id)).map((r) => r.dedupeKey).sort(), [offerlyKey(a), offerlyKey(b)].sort());
  });

  test("the to-do row is there at every load from due for a week, with the same doneKey", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    for (let i = 0; i < 7 * 24; i += 6) {
      const now = plus(mon(16), i * HOUR);
      const rows = await todo(u, now);
      if (now.getTime() < mon(16, 30).getTime()) assert.equal(rows.length, 0);
      else {
        assert.equal(rows.length, 1, `at ${now.toISOString()}`);
        assert.equal(rows[0].doneKey, offerlyKey(e));
        assert.equal(rows[0].id, `thanks-${offerlyKey(e)}`);
      }
    }
  });

  test("ticked on Wednesday at noon: banners Mon-Wed, none after, the row stays closed by hand", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    const seen = await hourly(u, mon(15), 7 * 24, async (now) => {
      if (now.getTime() === day(2, 12).getTime()) assert.equal(await tick(u, offerlyKey(e), now), true);
      if (now.getHours() % 6 === 0) await bell(u, now);
    });
    assert.deepEqual([...perDate(seen).keys()], ["2026-09-21", "2026-09-22", "2026-09-23"]);
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "manual");
    assert.equal(row?.doneAt?.getTime(), day(2, 12).getTime());
    assert.equal((await todo(u, day(6, 12))).length, 0);
  });

  test("sent on Tuesday at 10am: banners Mon and Tue, then nothing; the row closed as answered", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    const seen = await hourly(u, mon(15), 7 * 24, async (now) => {
      if (now.getTime() === day(1, 10).getTime()) await sendThanks(u, c, now);
    });
    assert.deepEqual([...perDate(seen).keys()], ["2026-09-21", "2026-09-22"]);
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "auto");
    assert.equal(row?.doneAt?.getTime(), day(1, 10).getTime());
  });

  test("sent Thursday, taken back Friday 10am: Friday's banner comes at 10am, the row reopens, still one row", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    let draft = "";
    const seen = await hourly(u, mon(15), 7 * 24, async (now) => {
      if (now.getTime() === day(3, 10).getTime()) draft = await sendThanks(u, c, now);
      if (now.getTime() === day(4, 10).getTime()) await unsend(u, draft, now);
    });
    assert.deepEqual([...perDate(seen).keys()], dates("2026-09-21", 8));
    assert.ok([...perDate(seen).values()].every((n) => n === 1));
    assert.equal(seen.find((s) => s.date === "2026-09-25")?.now.getTime(), day(4, 10).getTime());
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].doneAt, null);
    assert.equal(rows[0].dedupeKey, offerlyKey(e));
  });

  test("a fortnight and more: banners on fifteen local days, then the bell row expires", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    const seen = await hourly(
      u,
      mon(15),
      17 * 24,
      async (now, i) => {
        if (i % 12 === 0) await bell(u, now);
      },
      3,
    );
    assert.deepEqual([...perDate(seen).keys()], dates("2026-09-21", 15));
    await bell(u, et(2026, 10, 8, 9));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "expired");
    assert.equal((await todo(u, et(2026, 10, 8, 9))).length, 0);
  });

  test("deleted on Wednesday: banners Mon-Wed, the row closes as answered at the next bell read", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    const seen = await hourly(u, mon(15), 5 * 24, async (now) => {
      if (now.getTime() === day(2, 12).getTime()) {
        await h.db.delete(events).where(eq(events.id, e));
        assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null, "still open until something reads the bell");
        await bell(u, now);
      }
    });
    assert.deepEqual([...perDate(seen).keys()], ["2026-09-21", "2026-09-22", "2026-09-23"]);
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "auto");
    assert.equal(row?.doneAt?.getTime(), day(2, 12).getTime());
  });

  test("moved to Friday on Tuesday: quiet Wed-Thu, Friday's banner says 'thank-you' again and reopens the one row", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    const seen = await hourly(u, mon(15), 6 * 24, async (now) => {
      if (now.getTime() === day(1, 12).getTime()) {
        await h.db.update(events).set({ eventDate: day(4, 14), endDate: day(4, 14, 30) }).where(eq(events.id, e));
        await bell(u, now);
      }
    });
    assert.deepEqual([...perDate(seen).keys()], ["2026-09-21", "2026-09-22", "2026-09-25", "2026-09-26", "2026-09-27"]);
    const fri = seen.find((s) => s.date === "2026-09-25");
    assert.equal(fri?.chip, "thank-you");
    assert.equal(fri?.now.getTime(), day(4, 17).getTime());
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].doneAt, null);
    assert.match(rows[0].body, /25 Sep/);
  });

  test("Google read fails Tue-Wed: no banner those days, the row stays open, Thursday it speaks again", async () => {
    const u = await mkUser();
    const ev = invite("g-flaky", [{ email: "dana@evercore.com", name: "Dana Reed" }]);
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [ev]);
    const seen = await hourly(u, mon(15), 4 * 24, async (now, i) => {
      if (now.getTime() === day(1, 0).getTime()) failGoogle(u.id);
      if (now.getTime() === day(3, 0).getTime()) seedGoogle(u.id, [ev]);
      if (i % 3 === 0 && now.getTime() >= mon(17).getTime()) {
        const open = await bell(u, now);
        assert.equal(open.length, 1, `open at ${now.toISOString()}`);
      }
    });
    assert.deepEqual([...perDate(seen).keys()], ["2026-09-21", "2026-09-24", "2026-09-25"]);
    assert.equal((await jobRows(u.id)).length, 1);
  });

  test("Google read fails, then recovers without the entry: closed as answered on the first good read, not before", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-gone", [{ email: "x@y.com", name: "Pat Lee" }])]);
    await seeBanner(u, mon(17));
    failGoogle(u.id);
    await bell(u, mon(20));
    await bell(u, day(1, 9));
    assert.equal((await jobRow(u.id, googleKey("g-gone")))?.doneAt, null);
    seedGoogle(u.id, []);
    await bell(u, day(1, 10));
    const row = await jobRow(u.id, googleKey("g-gone"));
    assert.equal(row?.doneSource, "auto");
    assert.equal(row?.doneAt?.getTime(), day(1, 10).getTime());
  });

  test("across the clocks going back (1 Nov 2026): a week of hourly loads, one banner per local day", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { eventDate: et(2026, 10, 29, 14), endDate: et(2026, 10, 29, 14, 30) });
    const seen = await hourly(u, et(2026, 10, 29, 15), 7 * 24 + 1);
    assert.deepEqual([...perDate(seen).keys()], dates("2026-10-29", 8));
    assert.ok([...perDate(seen).values()].every((n) => n === 1));
  });

  test("across the clocks going forward (14 Mar 2027): one banner per local day", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { eventDate: et(2027, 3, 11, 14), endDate: et(2027, 3, 11, 14, 30) });
    const seen = await hourly(u, et(2027, 3, 11, 15), 7 * 24);
    assert.deepEqual([...perDate(seen).keys()], dates("2027-03-11", 8));
    assert.ok([...perDate(seen).values()].every((n) => n === 1));
  });

  test("a chat at 11pm: due 1:30am, and that is already the next local day's banner", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { eventDate: mon(23), endDate: mon(23, 30) });
    const seen = await hourly(u, mon(22), 2 * 24);
    assert.equal(seen[0].date, "2026-09-22");
    assert.equal(seen[0].now.getTime(), day(1, 2).getTime());
    assert.equal(seen[0].chip, "thank-you");
    assert.deepEqual([...perDate(seen).keys()], ["2026-09-22", "2026-09-23"]);
  });

  test("hourly bell reads for three days change nothing: one row, open, bumped only by the banners", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    let lastBanner = mon(17);
    for (let i = 0; i < 72; i++) {
      const now = plus(mon(17), i * HOUR);
      const p = await seeBanner(u, now);
      if (p) lastBanner = now;
      const open = await bell(u, now);
      assert.equal(open.length, 1);
    }
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.bumpedAt.getTime(), lastBanner.getTime());
    assert.equal(row?.doneAt, null);
  });
});

// ======================================================= how it ends

describe("how it ends", () => {
  test("ticked from the bell panel itself (by row id): banner, to-do and prompt all stop", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    const row = await jobRow(u.id, offerlyKey(e));
    await markNotificationDone(u.id, row!.id, mon(18));
    assert.deepEqual(await owedKeys(u, day(1, 9)), []);
    assert.equal(await banner(u, day(1, 9)), null);
    assert.equal((await todo(u, day(1, 9))).length, 0);
  });

  test("a row closed by the app ('auto') is not a tick: still owed, and the next banner reopens it", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await closeNotificationByKey(u.id, offerlyKey(e), "auto", mon(18));
    assert.deepEqual(await owedKeys(u, mon(19)), [offerlyKey(e)]);
    await seeBanner(u, day(1, 9));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
  });

  test("a row closed as 'expired' is not a tick either", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await h.db.update(notifications).set({ doneAt: mon(18), doneSource: "expired" }).where(eq(notifications.dedupeKey, offerlyKey(e)));
    assert.deepEqual(await owedKeys(u, mon(19)), [offerlyKey(e)]);
  });

  test("closing by key with no row filed yet does nothing: it stays owed (the tick must file first)", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await closeNotificationByKey(u.id, offerlyKey(e), "manual", mon(18));
    assert.equal((await jobRows(u.id)).length, 0);
    assert.deepEqual(await owedKeys(u, mon(19)), [offerlyKey(e)]);
  });

  test("tick, then a send: the row stays ticked by hand at the tick's time", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await tick(u, offerlyKey(e), mon(18));
    await sendThanks(u, c, mon(19));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "manual");
    assert.equal(row?.doneAt?.getTime(), mon(18).getTime());
  });

  test("send, then a tick: the tick finds nothing owed and the row stays answered", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(18));
    assert.equal(await tick(u, offerlyKey(e), mon(19)), false);
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "auto");
  });

  test("a thank-you sent at the very minute the chat began counts", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await sendThanks(u, c, mon(14));
    assert.deepEqual(await owedKeys(u, mon(17)), []);
  });

  test("a thank-you sent a minute before the chat began does not", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await sendThanks(u, c, plus(mon(14), -MIN));
    assert.deepEqual(await owedKeys(u, mon(17)), [offerlyKey(e)]);
  });

  for (const kind of ["cold_outreach", "follow_up", "custom"] as const) {
    test(`a sent ${kind} email to Dana is not a thank-you: the job stays open`, async () => {
      const u = await mkUser();
      const c = await mkContact(u.id);
      const e = await mkEvent(u.id, { contactId: c });
      await seeBanner(u, mon(17));
      const d = await mkDraft(u.id, c, kind, "thank_you_chat");
      await sendDraft(u, d, mon(18));
      await reconcileThankYouJobs(u.id, mon(18));
      assert.deepEqual(await owedKeys(u, mon(19)), [offerlyKey(e)]);
      assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
    });
  }

  test("a thank-you to Sam closes nothing about the chat with Dana", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed");
    const sam = await mkContact(u.id, "Sam Ito");
    const e = await mkEvent(u.id, { contactId: dana });
    await seeBanner(u, mon(17));
    await sendThanks(u, sam, mon(18));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
  });

  test("the send path alone (no bell read) closes a fortnight-old row as expired, not answered", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, et(2026, 10, 7, 9));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "expired");
  });

  test("an entry deleted after the fortnight closes as expired", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await h.db.delete(events).where(eq(events.id, e));
    await bell(u, et(2026, 10, 7, 9));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "expired");
  });

  test("an entry re-filed as personal is no longer owed and its row closes", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await h.db.update(events).set({ type: "personal" }).where(eq(events.id, e));
    assert.deepEqual(await owedKeys(u, mon(18)), []);
    await bell(u, mon(18));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "auto");
  });

  test("an entry re-filed as a deadline is no longer owed", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "deadline", title: "Coffee chat" });
    assert.deepEqual(await owedKeys(u, mon(18)), []);
  });

  test("moved earlier on the same day: same key, same row, new body date on the next banner", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await h.db.update(events).set({ eventDate: plus(mon(10), -DAY), endDate: plus(mon(10, 30), -DAY) }).where(eq(events.id, e));
    assert.deepEqual(await owedKeys(u, mon(18)), [offerlyKey(e)]);
    await seeBanner(u, day(1, 9));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /20 Sep/);
  });

  test("moved on the calendar: the refreshed row's expiry follows the new due time", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await h.db.update(events).set({ eventDate: day(1, 14), endDate: day(1, 14, 30) }).where(eq(events.id, e));
    await seeBanner(u, day(2, 9));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.expiresAt?.getTime(), day(1, 16, 30).getTime() + 14 * DAY);
  });

  test("relinked to Sam after Dana was thanked: owed again, and the next banner retitles the one row", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed");
    const sam = await mkContact(u.id, "Sam Ito");
    const e = await mkEvent(u.id, { contactId: dana });
    await seeBanner(u, mon(17));
    await sendThanks(u, dana, mon(18));
    await h.db.update(events).set({ contactId: sam }).where(eq(events.id, e));
    await seeBanner(u, day(1, 9));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].doneAt, null);
    assert.equal(rows[0].title, "Thank Sam Ito");
    assert.equal(rows[0].subjectKey, `thanks:${sam}`);
  });

  test("a failed Google read leaves the Google row open while the same send closes the Offerly one", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    const e = await mkEvent(u.id, { contactId: dana });
    seedGoogle(u.id, [invite("g-other", [{ email: "pat@lazard.com", name: "Pat Lee" }], { startsAt: mon(10), endsAt: mon(10, 30) })]);
    await drain(u, mon(17));
    failGoogle(u.id);
    await sendThanks(u, dana, mon(18));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "auto");
    assert.equal((await jobRow(u.id, googleKey("g-other")))?.doneAt, null);
  });

  test("a failed Google read does not keep a fortnight-old Google row open: the bell expires it", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-old", [{ email: "pat@lazard.com", name: "Pat Lee" }])]);
    await seeBanner(u, mon(17));
    failGoogle(u.id);
    const open = await bell(u, et(2026, 10, 7, 9));
    assert.equal(open.length, 0);
    assert.equal((await jobRow(u.id, googleKey("g-old")))?.doneSource, "expired");
  });

  test("answered during an outage: closed on the first good read after it", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    const ev = invite("g-out", [{ email: "dana@evercore.com", name: "Dana Reed" }]);
    seedGoogle(u.id, [ev]);
    await seeBanner(u, mon(17));
    failGoogle(u.id);
    await sendThanks(u, dana, mon(18));
    assert.equal((await jobRow(u.id, googleKey("g-out")))?.doneAt, null, "left alone while the read is failing");
    seedGoogle(u.id, [ev]);
    await bell(u, mon(19));
    assert.equal((await jobRow(u.id, googleKey("g-out")))?.doneSource, "auto");
  });

  test("a failed read that still returned the entry is trusted for it: the send closes it at once", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    const ev = invite("g-partial", [{ email: "dana@evercore.com", name: "Dana Reed" }]);
    seedGoogle(u.id, [ev]);
    await seeBanner(u, mon(17));
    failGoogle(u.id, [ev]);
    await sendThanks(u, dana, mon(18));
    // Not owed any more; the rule leaves Google rows alone on a failed read,
    // so it closes on the next good one.
    assert.deepEqual(await owedKeys(u, mon(18, 5)), []);
    seedGoogle(u.id, [ev]);
    await bell(u, mon(19));
    assert.equal((await jobRow(u.id, googleKey("g-partial")))?.doneSource, "auto");
  });

  test("a cache entry with no ok flag is a good read: an absent Google entry's row closes", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-noflag", [{ email: "pat@lazard.com", name: "Pat Lee" }])]);
    await seeBanner(u, mon(17));
    googleCache().set(u.id, { at: mon(18).getTime(), events: [] });
    seeded.delete(u.id);
    await getNotifications(u.id, mon(18));
    assert.equal((await jobRow(u.id, googleKey("g-noflag")))?.doneSource, "auto");
  });

  test("during a failed read the Google prompt drops out of the banner and the to-do list, but not the bell", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-quiet", [{ email: "pat@lazard.com", name: "Pat Lee" }])]);
    await seeBanner(u, mon(17));
    failGoogle(u.id);
    assert.equal(await banner(u, day(1, 9)), null);
    assert.equal((await todo(u, day(1, 9))).length, 0);
    assert.equal((await bell(u, day(1, 9))).length, 1);
  });
});

// ======================================================= taking a send back

describe("taking back 'I sent this'", () => {
  test("the reopened row is open, unticked, unread, and bumped to the moment it was taken back", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await markNotificationsRead(u.id, mon(17, 5));
    const d = await sendThanks(u, c, mon(18));
    await unsend(u, d, mon(19));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneAt, null);
    assert.equal(row?.doneSource, null);
    assert.equal(row?.readAt, null);
    assert.equal(row?.bumpedAt.getTime(), mon(19).getTime());
  });

  test("the to-do row comes straight back", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    const d = await sendThanks(u, c, mon(18));
    assert.equal((await todo(u, mon(18, 30))).length, 0);
    await unsend(u, d, mon(19));
    assert.equal((await todo(u, mon(19, 5))).length, 1);
  });

  test("taken back after today's banner was shown: no second banner today, one tomorrow", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    const d = await sendThanks(u, c, mon(18));
    await unsend(u, d, mon(19));
    assert.equal(await banner(u, mon(20)), null);
    assert.ok((await banner(u, day(1, 8)))?.flashKey.endsWith("2026-09-22"));
  });

  test("another thank-you to Dana still stands: nothing reopens", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(18));
    const second = await sendThanks(u, c, mon(19));
    await unsend(u, second, mon(20));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "auto");
    assert.deepEqual(await owedKeys(u, mon(20, 5)), []);
  });

  test("taking back a note sent before the chat changes nothing", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    const early = await sendThanks(u, c, mon(9));
    await seeBanner(u, mon(17));
    await unsend(u, early, mon(18));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneAt, null);
    assert.equal(row?.bumpedAt.getTime(), mon(17).getTime(), "not bumped by an unrelated take-back");
  });

  test("taken back after the fortnight: not reopened", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    const d = await sendThanks(u, c, mon(18));
    await unsend(u, d, et(2026, 10, 7, 9));
    assert.notEqual((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
    assert.equal((await bell(u, et(2026, 10, 7, 10))).length, 0);
  });

  test("a row closed because its entry was deleted is not reopened by an unrelated take-back", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const gone = await mkEvent(u.id, { title: "Coffee chat (cancelled later)", eventDate: mon(9), endDate: mon(9, 30) });
    await mkEvent(u.id, { contactId: c });
    await drain(u, mon(17));
    await h.db.delete(events).where(eq(events.id, gone));
    const d = await sendThanks(u, c, mon(18));
    await unsend(u, d, mon(19));
    assert.equal((await jobRow(u.id, offerlyKey(gone)))?.doneSource, "auto");
  });

  test("a ticked row stays ticked through a take-back", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await tick(u, offerlyKey(e), mon(17));
    const d = await sendThanks(u, c, mon(18));
    await unsend(u, d, mon(19));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "manual");
    assert.deepEqual(await owedKeys(u, mon(19, 5)), []);
  });

  test("taking it back twice is once: the second leaves the first's bump", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    const d = await sendThanks(u, c, mon(18));
    await unsend(u, d, mon(19));
    await unsend(u, d, mon(20));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.bumpedAt.getTime(), mon(19).getTime());
    assert.equal((await jobRows(u.id)).length, 1);
  });

  test("taken back, then sent again: closed again, still one row", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    const d = await sendThanks(u, c, mon(18));
    await unsend(u, d, mon(19));
    await sendDraft(u, d, mon(20));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].doneSource, "auto");
    assert.equal(rows[0].dedupeKey, offerlyKey(e));
  });

  test("one note that answered two chats with Dana, taken back: both rows reopen", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const a = await mkEvent(u.id, { contactId: c, eventDate: mon(9), endDate: mon(9, 30) });
    const b = await mkEvent(u.id, { contactId: c });
    await drain(u, mon(17));
    const d = await sendThanks(u, c, mon(18));
    assert.equal((await bell(u, mon(18, 5))).length, 0);
    await unsend(u, d, mon(19));
    assert.equal((await jobRow(u.id, offerlyKey(a)))?.doneAt, null);
    assert.equal((await jobRow(u.id, offerlyKey(b)))?.doneAt, null);
  });

  test("a Google chat's row reopens too", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [invite("g-unsend", [{ email: "dana@evercore.com", name: "Dana Reed" }])]);
    await seeBanner(u, mon(17));
    const d = await sendThanks(u, c, mon(18));
    assert.equal((await jobRow(u.id, googleKey("g-unsend")))?.doneSource, "auto");
    await unsend(u, d, mon(19));
    assert.equal((await jobRow(u.id, googleKey("g-unsend")))?.doneAt, null);
  });

  test("A taking back her note does not reopen B's row", async () => {
    const a = await mkUser();
    const b = await mkUser();
    const aDana = await mkContact(a.id);
    const bDana = await mkContact(b.id);
    await mkEvent(a.id, { contactId: aDana });
    const bChat = await mkEvent(b.id, { contactId: bDana });
    await seeBanner(a, mon(17));
    await seeBanner(b, mon(17));
    const da = await sendThanks(a, aDana, mon(18));
    await sendThanks(b, bDana, mon(18));
    await unsend(a, da, mon(19));
    assert.equal((await jobRow(b.id, offerlyKey(bChat)))?.doneSource, "auto");
  });
});

// ======================================================= "Outside of your matched contacts"

describe("the outside prefill from a thank= key", () => {
  test("a Google chat with one unsaved invitee: the link carries the key, and the page fills name and email", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-out1", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    const [t] = await owed(u, mon(17));
    assert.equal(t.href, `/outreach?occasion=thanks&box=thanks.chat&thank=${encodeURIComponent(googleKey("g-out1"))}`);
    assert.deepEqual(await outsideFor(u, thankParam(t.href), mon(17)), { name: "Pat Lee", email: "pat.lee@lazard.com", firm: null });
  });

  test("with the firm tracked and named in the title, the firm is filled too", async () => {
    const u = await mkUser();
    await track(u.id, "Lazard");
    seedGoogle(u.id, [invite("g-out2", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }], { title: "Coffee chat - Lazard" })]);
    assert.deepEqual(await outsideFor(u, googleKey("g-out2"), mon(17)), { name: "Pat Lee", email: "pat.lee@lazard.com", firm: "Lazard" });
  });

  test("an invitee with no display name: email only, the name left for the student", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-out3", [{ email: "pat.lee@lazard.com", name: null }])]);
    assert.deepEqual(await outsideFor(u, googleKey("g-out3"), mon(17)), { name: null, email: "pat.lee@lazard.com", firm: null });
  });

  test("two people invited: nobody is guessed", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [
      invite("g-out4", [
        { email: "pat.lee@lazard.com", name: "Pat Lee" },
        { email: "sam.ito@lazard.com", name: "Sam Ito" },
      ]),
    ]);
    assert.deepEqual(await outsideFor(u, googleKey("g-out4"), mon(17)), { name: null, email: null, firm: null });
  });

  test("two people invited at a tracked firm: the firm only", async () => {
    const u = await mkUser();
    await track(u.id, "Lazard");
    seedGoogle(u.id, [
      invite(
        "g-out5",
        [
          { email: "pat.lee@lazard.com", name: "Pat Lee" },
          { email: "sam.ito@lazard.com", name: "Sam Ito" },
        ],
        { title: "Lazard coffee chat" },
      ),
    ]);
    assert.deepEqual(await outsideFor(u, googleKey("g-out5"), mon(17)), { name: null, email: null, firm: "Lazard" });
  });

  test("an Offerly entry with nobody linked: nothing about the person, never the title's name", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { title: "Coffee with Jordan Park" });
    const [t] = await owed(u, mon(17));
    assert.equal(thankParam(t.href), offerlyKey(e));
    assert.deepEqual(await outsideFor(u, offerlyKey(e), mon(17)), { name: null, email: null, firm: null });
  });

  test("an Offerly entry naming a tracked firm: the firm only", async () => {
    const u = await mkUser();
    await track(u.id, "Evercore");
    const e = await mkEvent(u.id, { title: "Coffee chat with an Evercore analyst" });
    assert.deepEqual(await outsideFor(u, offerlyKey(e), mon(17)), { name: null, email: null, firm: "Evercore" });
  });

  test("a Google invite with no attendees but the name in the title: the name is not guessed from the title", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "g-out6", title: "Coffee with Jordan Park" })]);
    assert.deepEqual(await outsideFor(u, googleKey("g-out6"), mon(17)), { name: null, email: null, firm: null });
  });

  test("a saved contact's prompt links by contact, never by key", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    const [t] = await owed(u, mon(17));
    assert.equal(t.href, `/outreach?contact=${c}&occasion=thanks&box=thanks.chat`);
    assert.equal(thankParam(t.href), undefined);
    assert.equal(await outsideFor(u, offerlyKey(e), mon(17)), undefined, "a hand-typed key of a contact's prompt fills nothing");
  });

  test("a single invitee who is a saved contact: linked by contact, no prefill", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id, "Pat Lee", "pat.lee@lazard.com");
    seedGoogle(u.id, [invite("g-out7", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    const [t] = await owed(u, mon(17));
    assert.equal(t.href, `/outreach?contact=${c}&occasion=thanks&box=thanks.chat`);
    assert.equal(await outsideFor(u, googleKey("g-out7"), mon(17)), undefined);
  });

  const forged = [
    "thank_you:offerly:00000000-0000-0000-0000-000000000000",
    "thank_you:google:made-up",
    "thank_you:",
    "",
    "offerly:abc",
    "<script>alert(1)</script>",
    "thank_you:google:g-real ",
    "THANK_YOU:GOOGLE:G-REAL",
  ];
  for (const key of forged) {
    test(`a forged key (${JSON.stringify(key)}) fills nothing`, async () => {
      const u = await mkUser();
      seedGoogle(u.id, [invite("g-real", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
      assert.equal((await owed(u, mon(17))).length, 1, "the student does owe a real one");
      assert.equal(await outsideFor(u, key, mon(17)), undefined);
    });
  }

  test("a key ticked off fills nothing", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-done1", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    await tick(u, googleKey("g-done1"), mon(17));
    assert.equal(await outsideFor(u, googleKey("g-done1"), mon(18)), undefined);
  });

  test("the outside form's own send closes it: the key then fills nothing", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-done2", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    await seeBanner(u, mon(17));
    const pre = await outsideFor(u, googleKey("g-done2"), mon(17));
    await sendOutside(u, { name: pre!.name!, firm: "Lazard", email: pre!.email! }, mon(18));
    assert.equal(await outsideFor(u, googleKey("g-done2"), mon(18, 5)), undefined);
    assert.equal((await jobRow(u.id, googleKey("g-done2")))?.doneSource, "auto");
  });

  test("a key past the fortnight fills nothing", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-done3", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    assert.equal(await outsideFor(u, googleKey("g-done3"), et(2026, 10, 6, 9)), undefined);
  });

  test("a key for a chat not yet due fills nothing", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-done4", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    assert.equal(await outsideFor(u, googleKey("g-done4"), mon(16)), undefined);
  });

  test("a key for a deleted Offerly entry fills nothing", async () => {
    const u = await mkUser();
    await track(u.id, "Evercore");
    const e = await mkEvent(u.id, { title: "Evercore coffee chat" });
    assert.ok(await outsideFor(u, offerlyKey(e), mon(17)));
    await h.db.delete(events).where(eq(events.id, e));
    assert.equal(await outsideFor(u, offerlyKey(e), mon(17)), undefined);
  });

  test("a key for a declined invitation fills nothing", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-done5", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }], { declined: true })]);
    assert.equal(await outsideFor(u, googleKey("g-done5"), mon(17)), undefined);
  });

  test("B opening A's link gets nothing of A's", async () => {
    const a = await mkUser();
    const b = await mkUser();
    seedGoogle(a.id, [invite("g-a1", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    const [t] = await owed(a, mon(17));
    assert.equal(await outsideFor(b, thankParam(t.href), mon(17)), undefined);
  });

  test("B with thank-yous of his own opening A's link still gets nothing", async () => {
    const a = await mkUser();
    const b = await mkUser();
    seedGoogle(a.id, [invite("g-a2", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    seedGoogle(b.id, [invite("g-b2", [{ email: "sam.ito@evercore.com", name: "Sam Ito" }])]);
    await mkEvent(b.id);
    // B's own Offerly chat and invite at the same time are one prompt.
    assert.equal((await owed(b, mon(17))).length, 1);
    assert.equal(await outsideFor(b, googleKey("g-a2"), mon(17)), undefined);
  });

  test("B opening A's Offerly key gets nothing, even with the same firm tracked", async () => {
    const a = await mkUser();
    const b = await mkUser();
    await track(a.id, "Evercore");
    await track(b.id, "Evercore");
    const e = await mkEvent(a.id, { title: "Evercore coffee chat" });
    assert.ok(await outsideFor(a, offerlyKey(e), mon(17)));
    assert.equal(await outsideFor(b, offerlyKey(e), mon(17)), undefined);
  });

  test("both on the same Google meeting, different invitee lists: each gets their own", async () => {
    const a = await mkUser();
    const b = await mkUser();
    seedGoogle(a.id, [invite("g-shared", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    seedGoogle(b.id, [invite("g-shared", [{ email: "sam.ito@lazard.com", name: "Sam Ito" }])]);
    assert.deepEqual(await outsideFor(a, googleKey("g-shared"), mon(17)), { name: "Pat Lee", email: "pat.lee@lazard.com", firm: null });
    assert.deepEqual(await outsideFor(b, googleKey("g-shared"), mon(17)), { name: "Sam Ito", email: "sam.ito@lazard.com", firm: null });
  });

  test("B's own saved contact at that address does not make A's prompt a contact prompt", async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mkContact(b.id, "Pat Lee", "pat.lee@lazard.com");
    seedGoogle(a.id, [invite("g-a3", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    const [t] = await owed(a, mon(17));
    assert.equal(t.next.contactId, null);
    assert.deepEqual(await outsideFor(a, googleKey("g-a3"), mon(17)), { name: "Pat Lee", email: "pat.lee@lazard.com", firm: null });
  });

  const odd = ["abc_20260921T180000Z", "a/b+c=d", "id with spaces", "%41%42", "a&thank=b", "émoji☕"];
  for (const id of odd) {
    test(`a Google id like ${JSON.stringify(id)} survives the round trip through the link`, async () => {
      const u = await mkUser();
      seedGoogle(u.id, [invite(id, [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
      const [t] = await owed(u, mon(17));
      assert.equal(thankParam(t.href), googleKey(id));
      assert.equal((await outsideFor(u, thankParam(t.href), mon(17)))?.email, "pat.lee@lazard.com");
    });
  }

  test("the banner's link and the to-do row's link are the same link", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-same", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    const flash = await banner(u, mon(17));
    const [row] = await todo(u, mon(17));
    assert.equal(flash?.href, row.href);
    assert.equal(flash?.notifications[0].href, row.href);
  });

  test("no name or address ever travels in the link", async () => {
    const u = await mkUser();
    await track(u.id, "Lazard");
    seedGoogle(u.id, [invite("g-priv", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }], { title: "Lazard coffee" })]);
    const [t] = await owed(u, mon(17));
    assert.doesNotMatch(t.href, /pat|lee|lazard\.com|Lazard/i);
  });

  test("the prefill follows the key after the student saves the person some other way", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-saved", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    assert.ok(await outsideFor(u, googleKey("g-saved"), mon(17)));
    await mkContact(u.id, "Pat Lee", "pat.lee@lazard.com");
    // Now a saved contact: the old link fills nothing, and the prompt links by contact.
    assert.equal(await outsideFor(u, googleKey("g-saved"), mon(18)), undefined);
    const [t] = await owed(u, mon(18));
    assert.match(t.href, /contact=/);
  });
});

// ======================================================= the tracked-firm lookup

describe("which tracked firm the title names", () => {
  const cases: { tracked: string[]; title: string; firm: string | null; label: string }[] = [
    { label: "plain name", tracked: ["Evercore"], title: "Coffee chat - Evercore", firm: "Evercore" },
    { label: "longest wins", tracked: ["Evercore", "Evercore ISI"], title: "Evercore ISI coffee chat", firm: "Evercore ISI" },
    { label: "longest wins whichever order they were tracked", tracked: ["Evercore ISI", "Evercore"], title: "Evercore ISI coffee chat", firm: "Evercore ISI" },
    { label: "periods dropped", tracked: ["J.P. Morgan"], title: "JP Morgan coffee chat", firm: "J.P. Morgan" },
    { label: "possessive", tracked: ["Morgan Stanley"], title: "Morgan Stanley's analyst coffee", firm: "Morgan Stanley" },
    { label: "curly possessive", tracked: ["Evercore"], title: "Evercore’s analyst coffee chat", firm: "Evercore" },
    { label: "in brackets", tracked: ["Lazard"], title: "Coffee chat (Lazard)", firm: "Lazard" },
    { label: "any case", tracked: ["Goldman Sachs"], title: "coffee chat with goldman sachs analyst", firm: "Goldman Sachs" },
    { label: "an ampersand", tracked: ["Moelis & Company"], title: "Coffee chat Moelis & Company", firm: "Moelis & Company" },
    { label: "an em dash", tracked: ["BNP Paribas"], title: "Coffee chat—BNP Paribas", firm: "BNP Paribas" },
    { label: "a near miss is not it", tracked: ["Evercore"], title: "Coffee chat - Evercorp", firm: null },
    { label: "a word inside another is not it", tracked: ["Citi"], title: "Coffee chat about Citizens Bank", firm: null },
    { label: "an untracked firm is never filled", tracked: [], title: "Coffee chat - Evercore", firm: null },
    { label: "a tracked firm not in the title", tracked: ["Lazard"], title: "Coffee chat", firm: null },
  ];
  for (const c of cases) {
    test(`${c.label}: "${c.title}" -> ${c.firm ?? "nothing"}`, async () => {
      const u = await mkUser();
      for (const f of c.tracked) await track(u.id, f);
      const e = await mkEvent(u.id, { title: c.title });
      assert.equal((await outsideFor(u, offerlyKey(e), mon(17)))?.firm, c.firm);
    });
  }

  test("a firm only somebody else tracks is never filled", async () => {
    const u = await mkUser();
    const other = await mkUser();
    await track(other.id, "Evercore");
    const e = await mkEvent(u.id, { title: "Coffee chat - Evercore" });
    assert.equal((await outsideFor(u, offerlyKey(e), mon(17)))?.firm, null);
  });

  test("untracking the firm stops it being filled", async () => {
    const u = await mkUser();
    await track(u.id, "Evercore");
    const e = await mkEvent(u.id, { title: "Coffee chat - Evercore" });
    assert.equal((await outsideFor(u, offerlyKey(e), mon(17)))?.firm, "Evercore");
    await h.db.delete(userTopFirms).where(eq(userTopFirms.userId, u.id));
    assert.equal((await outsideFor(u, offerlyKey(e), mon(17)))?.firm, null);
  });

  test("a known contact's chat carries no firm guess", async () => {
    const u = await mkUser();
    await track(u.id, "Evercore");
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c, title: "Coffee chat - Evercore" });
    const [t] = await owed(u, mon(17));
    assert.equal(t.next.firm, null);
  });
});

// ======================================================= people: shared, missing, deleted

describe("contacts sharing an address, without one, or deleted", () => {
  test("two contacts share Dana's address: the invite names the first saved, and one prompt", async () => {
    const u = await mkUser();
    const first = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    await mkContact(u.id, "Dana R.", "dana@evercore.com");
    seedGoogle(u.id, [invite("g-dup1", [{ email: "dana@evercore.com", name: "Dana Reed" }])]);
    const ts = await owed(u, mon(17));
    assert.equal(ts.length, 1);
    assert.equal(ts[0].contact?.id, first);
  });

  test("the thank-you sent to the first of them closes it", async () => {
    const u = await mkUser();
    const first = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    await mkContact(u.id, "Dana R.", "dana@evercore.com");
    seedGoogle(u.id, [invite("g-dup2", [{ email: "dana@evercore.com", name: "Dana Reed" }])]);
    await seeBanner(u, mon(17));
    await sendThanks(u, first, mon(18));
    assert.deepEqual(await owedKeys(u, mon(19)), []);
  });

  test("the thank-you sent to the other contact with the same address closes it too", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    const second = await mkContact(u.id, "Dana R.", "dana@evercore.com");
    seedGoogle(u.id, [invite("g-dup3", [{ email: "dana@evercore.com", name: "Dana Reed" }])]);
    await seeBanner(u, mon(17));
    await sendThanks(u, second, mon(18));
    // The same person at the same address was thanked.
    assert.deepEqual(await owedKeys(u, mon(19)), []);
    assert.equal((await jobRow(u.id, googleKey("g-dup3")))?.doneSource, "auto");
  });

  test("an Offerly entry linked to one Dana and her own invite resolved to the other: one thank-you, not two", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    const second = await mkContact(u.id, "Dana R.", "dana@evercore.com");
    await mkEvent(u.id, { contactId: second });
    seedGoogle(u.id, [invite("g-dup4", [{ email: "dana@evercore.com", name: "Dana Reed" }])]);
    assert.equal((await owed(u, mon(17))).length, 1);
  });

  test("an unlinked Offerly entry and Dana's invite in the same slot: one conversation, one thank-you", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    await mkEvent(u.id, { title: "Coffee chat" });
    seedGoogle(u.id, [invite("g-dup5", [{ email: "dana@evercore.com", name: "Dana Reed" }])]);
    const ts = await owed(u, mon(17));
    assert.equal(ts.length, 1, `got ${ts.map((t) => `${t.key} (${t.contact?.name ?? "nobody"})`).join(", ")}`);
  });

  test("a contact with no address, linked on the entry: named, linked by contact, closed by a send", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id, "Dana Reed", null);
    const e = await mkEvent(u.id, { contactId: c });
    const [t] = await owed(u, mon(17));
    assert.equal(t.next.contactId, c);
    assert.equal(t.next.email, null);
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(18));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "auto");
  });

  test("a contact with no address named in a Google title: found by name, the invitee's address not pinned on her", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id, "Dana Reed", null);
    seedGoogle(u.id, [invite("g-noaddr", [{ email: "dana@evercore.com", name: "Dana Reed" }], { title: "Coffee with Dana Reed" })]);
    const [t] = await owed(u, mon(17));
    assert.equal(t.contact?.id, c);
    assert.equal(t.next.email, null);
  });

  test("contacts with no address never match an invitee with no address either", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", null);
    await mkContact(u.id, "Sam Ito", "");
    seedGoogle(u.id, [invite("g-empty", [{ email: "", name: "Someone" }], { title: "Coffee chat" })]);
    const ts = await owed(u, mon(17));
    assert.ok(ts.every((t) => t.contact === null));
  });

  test("Dana deleted before any note: it carries on as 'Send a thank-you', and the next banner retitles the row", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await h.db.delete(contacts).where(eq(contacts.id, c));
    const [t] = await owed(u, mon(18));
    assert.equal(t.key, offerlyKey(e));
    assert.equal(t.contact, null);
    await seeBanner(u, day(1, 9));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.title, "Send a thank-you");
    assert.equal(row?.subjectKey, null);
    assert.equal(thankParam(row!.href), offerlyKey(e));
  });

  test("Dana thanked, then deleted from contacts: the chat is not owed again", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(18));
    await h.db.delete(contacts).where(eq(contacts.id, c));
    assert.deepEqual(await owedKeys(u, day(1, 9)), []);
  });

  test("Dana thanked, then deleted: no banner the next day, and the bell row stays closed", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(18));
    await h.db.delete(contacts).where(eq(contacts.id, c));
    assert.equal(await seeBanner(u, day(1, 9)), null);
    assert.notEqual((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
  });

  test("a Google chat thanked, then the contact deleted: not owed again", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [invite("g-del", [{ email: "dana@evercore.com", name: "Dana Reed" }])]);
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(18));
    await h.db.delete(contacts).where(eq(contacts.id, c));
    assert.deepEqual(await owedKeys(u, day(1, 9)), []);
  });

  test("the outside form's send from an unlinked Offerly chat closes it (the prompt's own 'Write it')", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { title: "Coffee chat" });
    const [t] = await owed(u, mon(17));
    await seeBanner(u, mon(17));
    assert.ok(await outsideFor(u, thankParam(t.href), mon(17)));
    await sendOutside(u, { name: "Jordan Park", firm: "Evercore", email: "jordan.park@evercore.com" }, mon(18));
    assert.deepEqual(await owedKeys(u, day(1, 9)), [], "the thank-you it asked for went out");
    assert.notEqual((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
  });

  test("the outside form's send from a Google chat with nobody on the invite closes it", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "g-noone", title: "Coffee chat ☕", videoCall: true })]);
    const [t] = await owed(u, mon(17));
    assert.equal(t.key, googleKey("g-noone"));
    await sendOutside(u, { name: "Jordan Park", firm: "Evercore", email: "jordan.park@evercore.com" }, mon(18));
    assert.deepEqual(await owedKeys(u, day(1, 9)), []);
  });

  test("the outside send to someone the title names closes it (the new contact is found by name)", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { title: "Coffee with Jordan Park" });
    await seeBanner(u, mon(17));
    await sendOutside(u, { name: "Jordan Park", firm: "Evercore", email: "jordan.park@evercore.com" }, mon(18));
    assert.deepEqual(await owedKeys(u, day(1, 9)), []);
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "auto");
  });

  test("the outside send reuses a contact already saved at that address, and closes it", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id, "P. Lee", "pat.lee@lazard.com");
    seedGoogle(u.id, [invite("g-reuse", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    const { contactId } = await sendOutside(u, { name: "Pat Lee", firm: "Lazard", email: "Pat.Lee@Lazard.com" }, mon(18));
    assert.equal(contactId, c);
    assert.deepEqual(await owedKeys(u, mon(19)), []);
  });
});

// ======================================================= many at once

describe("many owed at once", () => {
  async function eight(u: User) {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(await mkEvent(u.id, { title: `Coffee chat ${i + 1}`, eventDate: mon(8 + i), endDate: mon(8 + i, 30) }));
    }
    return ids;
  }

  test("eight owed: the prompts come oldest due first", async () => {
    const u = await mkUser();
    const ids = await eight(u);
    assert.deepEqual(await owedKeys(u, mon(20)), ids.map(offerlyKey));
  });

  test("eight owed: eight banners in a row that evening, oldest first, then silence", async () => {
    const u = await mkUser();
    const ids = await eight(u);
    const shown = await drain(u, mon(20));
    assert.deepEqual(shown.map((s) => s.flashKey), ids.map((id) => `${offerlyKey(id)}:2026-09-21`));
    assert.equal(await banner(u, mon(21)), null);
  });

  test("eight owed: eight bell rows, eight to-do rows", async () => {
    const u = await mkUser();
    await eight(u);
    await drain(u, mon(20));
    assert.equal((await bell(u, mon(20))).length, 8);
    assert.equal((await todo(u, mon(20))).length, 8);
  });

  test("the to-do list's first five are the five oldest thank-yous", async () => {
    const u = await mkUser();
    const ids = await eight(u);
    prime(u.id, mon(20));
    const list = await getTodayList(u, mon(20));
    assert.deepEqual(list.items.map((i) => i.id), ids.slice(0, 5).map((id) => `thanks-${offerlyKey(id)}`));
    assert.ok(list.items.every((i) => i.doneKey));
  });

  test("ticking those five from the to-do list, then 'next 5' brings the other three", async () => {
    const u = await mkUser();
    const ids = await eight(u);
    prime(u.id, mon(20));
    const list = await getTodayList(u, mon(20));
    for (const item of list.items) assert.equal(await todoTick(u, item.id, mon(20, 5)), true);
    prime(u.id, mon(20, 10));
    const after = await getTodayList(u, mon(20, 10));
    assert.ok(after.finished);
    assert.equal(await loadNextBatch(u, mon(20, 10)), true);
    prime(u.id, mon(20, 15));
    const next = await getTodayList(u, mon(20, 15));
    for (const id of ids.slice(5)) assert.ok(next.items.some((i) => i.id === `thanks-${offerlyKey(id)}`), `missing ${id}`);
  });

  test("ticking from the to-do list closes the bell's row by hand", async () => {
    const u = await mkUser();
    const ids = await eight(u);
    await drain(u, mon(20));
    await todoTick(u, `thanks-${offerlyKey(ids[0])}`, mon(20, 5));
    assert.equal((await jobRow(u.id, offerlyKey(ids[0])))?.doneSource, "manual");
    assert.equal((await bell(u, mon(20, 10))).length, 7);
  });

  test("a thank-you answered by a send is crossed out in today's five, not removed", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    prime(u.id, mon(17));
    await getTodayList(u, mon(17));
    await sendThanks(u, c, mon(18));
    prime(u.id, mon(18, 5));
    const list = await getTodayList(u, mon(18, 5));
    const item = list.items.find((i) => i.id === `thanks-${offerlyKey(e)}`);
    assert.equal(item?.done, true);
  });

  test("a thank-you falling due after today's five were drawn waits on the full list", async () => {
    const u = await mkUser();
    for (let i = 0; i < 5; i++) await mkDraft(u.id, null, "cold_outreach", "cold_email");
    prime(u.id, mon(9));
    await getTodayList(u, mon(9));
    const e = await mkEvent(u.id);
    prime(u.id, mon(17));
    const list = await getTodayList(u, mon(17));
    assert.ok(!list.items.some((i) => i.id === `thanks-${offerlyKey(e)}`));
    assert.ok(list.waiting >= 1);
    prime(u.id, mon(17));
    assert.ok((await getEverything(u, mon(17))).open.some((t) => t.id === `thanks-${offerlyKey(e)}`));
  });

  test("with unsent drafts and uncovered firms on the list, thank-yous still lead today's five", async () => {
    const u = await mkUser();
    await track(u.id, "Lazard");
    await track(u.id, "Evercore");
    for (let i = 0; i < 3; i++) await mkDraft(u.id, null, "cold_outreach", "cold_email");
    const a = await mkEvent(u.id, { title: "Coffee chat A", eventDate: mon(9), endDate: mon(9, 30) });
    const b = await mkEvent(u.id, { title: "Coffee chat B" });
    prime(u.id, mon(18));
    const list = await getTodayList(u, mon(18));
    assert.deepEqual(list.items.slice(0, 2).map((i) => i.id), [`thanks-${offerlyKey(a)}`, `thanks-${offerlyKey(b)}`]);
  });

  test("one note to Dana closes both her chats, and leaves Sam's", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed");
    const sam = await mkContact(u.id, "Sam Ito");
    await mkEvent(u.id, { contactId: dana, eventDate: mon(9), endDate: mon(9, 30) });
    await mkEvent(u.id, { contactId: dana, eventDate: mon(11), endDate: mon(11, 30) });
    const s = await mkEvent(u.id, { contactId: sam });
    await drain(u, mon(17));
    await sendThanks(u, dana, mon(18));
    assert.deepEqual(await owedKeys(u, mon(19)), [offerlyKey(s)]);
    assert.deepEqual((await bell(u, mon(19))).map((r) => r.title), ["Thank Sam Ito"]);
  });

  test("two chats due at the same minute: the banner speaks for them in name order", async () => {
    const u = await mkUser();
    const sam = await mkContact(u.id, "Sam Ito");
    const dana = await mkContact(u.id, "Dana Reed");
    const s = await mkEvent(u.id, { contactId: sam });
    const d = await mkEvent(u.id, { contactId: dana });
    const shown = await drain(u, mon(17));
    assert.deepEqual(shown.map((x) => x.subject), ["Dana Reed", "Sam Ito"]);
    assert.deepEqual(shown.map((x) => x.flashKey.split(":2026")[0]), [offerlyKey(d), offerlyKey(s)]);
  });

  test("a new chat falling due tomorrow joins tomorrow's run without repeating today's", async () => {
    const u = await mkUser();
    const a = await mkEvent(u.id);
    await drain(u, mon(17));
    const b = await mkEvent(u.id, { title: "Call with an analyst", type: "meeting", eventDate: day(1, 10), endDate: day(1, 10, 30) });
    const tue = await drain(u, day(1, 13));
    assert.deepEqual(tue.map((x) => x.flashKey), [`${offerlyKey(a)}:2026-09-22`, `${offerlyKey(b)}:2026-09-22`]);
  });
});

// ======================================================= other prompts in the one banner

describe("competing with other prompts for the banner", () => {
  test("a thank-you due today speaks before prep for tomorrow's interview", async () => {
    const u = await mkUser();
    const chat = await mkEvent(u.id);
    await mkEvent(u.id, { type: "interview", title: "Goldman Sachs Interview", eventDate: day(1, 15), endDate: day(1, 16) });
    const shown = await drain(u, mon(17));
    assert.equal(shown[0].flashKey, `${offerlyKey(chat)}:2026-09-21`);
    assert.ok(shown[1]?.flashKey.startsWith("interview:"));
  });

  test("two thank-yous and a prep prompt: both thank-yous first", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee chat A", eventDate: mon(9), endDate: mon(9, 30) });
    await mkEvent(u.id, { title: "Coffee chat B" });
    await mkEvent(u.id, { type: "interview", title: "Evercore Interview", eventDate: day(3, 15), endDate: day(3, 16) });
    const shown = await drain(u, mon(17));
    assert.deepEqual(shown.map((s) => (isThanks(s.flashKey) ? "thanks" : "other")), ["thanks", "thanks", "other"]);
  });

  test("the next morning the still-owed thank-you speaks first again", async () => {
    const u = await mkUser();
    const chat = await mkEvent(u.id);
    await mkEvent(u.id, { type: "interview", title: "Evercore Interview", eventDate: day(3, 15), endDate: day(3, 16) });
    await drain(u, mon(17));
    const first = await seeBanner(u, day(1, 9));
    assert.equal(first?.flashKey, `${offerlyKey(chat)}:2026-09-22`);
  });

  test("once ticked, the prep prompt speaks first", async () => {
    const u = await mkUser();
    const chat = await mkEvent(u.id);
    await mkEvent(u.id, { type: "interview", title: "Evercore Interview", eventDate: day(3, 15), endDate: day(3, 16) });
    await tick(u, offerlyKey(chat), mon(17));
    const first = await banner(u, mon(17, 5));
    assert.ok(first?.flashKey.startsWith("interview:"));
  });

  test("a thank-you's banner files only a thank-you row, and the prep banner only a prep row", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    await mkEvent(u.id, { type: "interview", title: "Evercore Interview", eventDate: day(3, 15), endDate: day(3, 16) });
    await drain(u, mon(17));
    const rows = await h.db.query.notifications.findMany({ where: eq(notifications.userId, u.id) });
    assert.deepEqual(rows.map((r) => r.kind).sort(), ["interview_prep", "thank_you"]);
  });

  test("the interview itself, once over, is thanked as an interview - not a second chat prompt", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "interview", title: "Evercore Interview", eventDate: mon(10), endDate: mon(11) });
    const ts = await owed(u, mon(17));
    assert.deepEqual(ts.map((t) => t.occasion), ["interview"]);
  });

  test("the thank-you banner's bell row is not closed by reading the bell alongside a prep row", async () => {
    const u = await mkUser();
    const chat = await mkEvent(u.id);
    await mkEvent(u.id, { type: "interview", title: "Evercore Interview", eventDate: day(3, 15), endDate: day(3, 16) });
    await drain(u, mon(17));
    const open = (await getNotifications(u.id, mon(18))).open;
    assert.equal(open.filter((n) => n.kind === "thank_you").length, 1);
    assert.equal((await jobRow(u.id, offerlyKey(chat)))?.doneAt, null);
  });

  test("a shown thank-you banner never shadows another student's", async () => {
    const a = await mkUser();
    const b = await mkUser();
    seedGoogle(a.id, [invite("g-both", [{ email: "pat@lazard.com", name: "Pat Lee" }])]);
    seedGoogle(b.id, [invite("g-both", [{ email: "pat@lazard.com", name: "Pat Lee" }])]);
    await seeBanner(a, mon(17));
    assert.equal((await banner(b, mon(17)))?.flashKey, `${googleKey("g-both")}:2026-09-21`);
  });
});

// ======================================================= doing it twice

describe("idempotency", () => {
  test("the same banner seen from three tabs at once: one flash record, one bell row", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    const p = await banner(u, mon(17));
    await Promise.all(
      [0, 1, 2].map(async () => {
        for (const n of p!.notifications) await upsertNotification({ userId: u.id, ...n, now: mon(17) });
        await markFlashShown(u.id, p!.flashKey);
      }),
    );
    const flashes = await h.db.query.flashesShown.findMany({ where: eq(flashesShown.userId, u.id) });
    assert.equal(flashes.length, 1);
    assert.equal((await jobRows(u.id)).length, 1);
  });

  test("ticking twice, from the to-do and then the bubble, keeps the first tick's time", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await todoTick(u, `thanks-${offerlyKey(e)}`, mon(17));
    assert.equal(await tick(u, offerlyKey(e), mon(18)), false);
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt?.getTime(), mon(17).getTime());
  });

  test("to-do tick twice: the second finds nothing", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    assert.equal(await todoTick(u, `thanks-${offerlyKey(e)}`, mon(17)), true);
    assert.equal(await todoTick(u, `thanks-${offerlyKey(e)}`, mon(17, 5)), false);
  });

  test("reopenOwedThankYouJobs with nothing closed changes nothing", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    prime(u.id, mon(18));
    await reopenOwedThankYouJobs(u.id, mon(18));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.bumpedAt.getTime(), mon(17).getTime());
  });

  test("reconcile with no rows at all writes nothing", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    prime(u.id, mon(18));
    await reconcileThankYouJobs(u.id, mon(18));
    assert.equal((await jobRows(u.id)).length, 0);
  });

  test("the bell read twice returns the same list", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    await seeBanner(u, mon(17));
    const a = await bell(u, mon(18));
    const b = await bell(u, mon(18));
    assert.deepEqual(a, b);
  });

  test("the same draft copied three times is one send: the job closed once, at the first", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    const d = await mkDraft(u.id, c);
    await sendDraft(u, d, mon(18));
    await sendDraft(u, d, mon(19));
    await sendDraft(u, d, mon(20));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt?.getTime(), mon(18).getTime());
  });

  test("a new day's banner on a row the student read makes it unread again, still one row", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await markNotificationsRead(u.id, mon(18));
    await seeBanner(u, day(1, 9));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].readAt, null);
    assert.equal(rows[0].dedupeKey, offerlyKey(e));
  });
});

// ======================================================= what the rows say

describe("what each surface says", () => {
  test("the bell body is 'After “<title>” · <d MMM>' on the student's clock", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee chat", eventDate: mon(23, 30), endDate: mon(23, 59) });
    await seeBanner(u, day(1, 9));
    const [row] = await jobRows(u.id);
    assert.equal(row.body, "After “Coffee chat” · 21 Sep");
  });

  test("the bell row expires exactly fourteen days after it fell due", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.expiresAt?.getTime(), mon(16, 30).getTime() + 14 * DAY);
  });

  test("the to-do detail for an 11pm chat seen the next morning says 1d ago", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee chat", eventDate: mon(23), endDate: mon(23, 30) });
    const [row] = await todo(u, day(1, 9));
    assert.equal(row.detail, "Coffee chat · 1d ago");
  });

  test("the to-do detail for a chat at 9pm seen at 11pm (next day in UTC) says today", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee chat", eventDate: mon(19), endDate: mon(19, 30) });
    const [row] = await todo(u, mon(23));
    assert.equal(row.detail, "Coffee chat · today");
  });

  test("the to-do row's title names the contact, or asks for a thank-you", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id, "Dana Reed");
    await mkEvent(u.id, { contactId: c, eventDate: mon(9), endDate: mon(9, 30) });
    await mkEvent(u.id, { title: "Coffee chat" });
    assert.deepEqual((await todo(u, mon(17))).map((t) => t.title).sort(), ["Send a thank-you", "Thank Dana Reed"]);
  });

  test("the to-do row's score climbs by the hour and stops at 90", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.equal((await todo(u, mon(16, 30)))[0].score, 80);
    assert.equal((await todo(u, mon(19, 31)))[0].score, 83);
    assert.equal((await todo(u, day(2, 9)))[0].score, 90);
  });

  test("a chat that is over is not also on the to-do list as 'Scheduled today'", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    prime(u.id, mon(17));
    const all = await getAllTasks(u, mon(17));
    assert.ok(all.some((t) => t.id === `thanks-${offerlyKey(e)}`));
    assert.ok(!all.some((t) => t.id === `event-${e}`), "the chat itself happened; only its thank-you is left to do");
  });

  test("the bell row's title and link match the banner and the to-do row", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    const p = await seeBanner(u, mon(17));
    const [row] = await jobRows(u.id);
    const [task] = await todo(u, mon(17));
    assert.equal(row.title, task.title);
    assert.equal(row.href, p?.href);
    assert.equal(row.href, task.href);
    assert.equal(row.subjectKey, `thanks:${c}`);
  });

  test("a long title is cut in the bell body the same way as the banner", async () => {
    const u = await mkUser();
    const title = "Coffee chat with the analyst from the restructuring group about the summer programme";
    await mkEvent(u.id, { title });
    const p = await seeBanner(u, mon(17));
    const [row] = await jobRows(u.id);
    assert.equal(p?.subject, `${title.slice(0, 47)}…`);
    assert.equal(row.body, `After “${title.slice(0, 47)}…” · 21 Sep`);
  });

  test("a phone call with a contact on the invite is a chat, with the chat's words", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [invite("g-phone", [{ email: "dana@evercore.com", name: "Dana Reed" }], { title: "Phone call" })]);
    const p = await banner(u, mon(17));
    assert.equal(p?.subject, "Dana Reed");
    assert.equal(p?.detail, "send a thank-you while the chat is fresh");
    assert.equal(p?.cta, "Write it");
  });

  test("the late copy: 'still owed a thank-you, a short note still counts'", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.equal((await banner(u, day(2, 9)))?.detail, "still owed a thank-you, a short note still counts");
  });

  test("a chat ticked on the Schedule (entry marked done) is still owed a thank-you", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await h.db.update(events).set({ completed: true }).where(eq(events.id, e));
    assert.deepEqual(await owedKeys(u, mon(17)), [offerlyKey(e)]);
  });
});

// ======================================================= edges a student can reach

describe("edges a student can reach", () => {
  test("an entry whose end is before its start is read as thirty minutes: due 4:30pm", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { eventDate: mon(14), endDate: mon(13) });
    assert.equal((await owed(u, mon(16, 29))).length, 0);
    assert.equal((await owed(u, mon(16, 30))).length, 1);
  });

  test("a chat that ran long (2pm-5pm) is due at 7pm, not 4:30pm", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { eventDate: mon(14), endDate: mon(17) });
    assert.equal(await banner(u, mon(18)), null);
    assert.ok(await banner(u, mon(19)));
  });

  test("an entry fifteen days old never files a row, whatever reads it", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { eventDate: plus(mon(14), -15 * DAY), endDate: plus(mon(14, 30), -15 * DAY) });
    await drain(u, mon(17));
    await bell(u, mon(17));
    assert.equal((await jobRows(u.id)).length, 0);
  });

  test("a chat logged after the fact, days later, is owed from the moment it is saved", async () => {
    const u = await mkUser();
    assert.equal(await banner(u, day(3, 9)), null);
    const e = await mkEvent(u.id);
    const p = await seeBanner(u, day(3, 9, 5));
    assert.equal(p?.flashKey, `${offerlyKey(e)}:2026-09-24`);
    assert.equal(p?.chip, "thank-you · 3 days");
  });

  test("a Google entry that becomes declined after the banner: not owed, row closed", async () => {
    const u = await mkUser();
    const ev = invite("g-decl", [{ email: "pat@lazard.com", name: "Pat Lee" }]);
    seedGoogle(u.id, [ev]);
    await seeBanner(u, mon(17));
    seedGoogle(u.id, [{ ...ev, declined: true }]);
    await bell(u, mon(18));
    assert.equal((await jobRow(u.id, googleKey("g-decl")))?.doneSource, "auto");
  });

  test("a Google entry retitled into a class after the banner: not owed, row closed", async () => {
    const u = await mkUser();
    const ev = invite("g-class", [{ email: "pat@lazard.com", name: "Pat Lee" }], { title: "Call" });
    seedGoogle(u.id, [ev]);
    assert.equal((await owed(u, mon(17))).length, 1);
    await seeBanner(u, mon(17));
    seedGoogle(u.id, [{ ...ev, title: "ECON 101 lecture" }]);
    await bell(u, mon(18));
    assert.equal((await jobRow(u.id, googleKey("g-class")))?.doneSource, "auto");
  });

  test("an Offerly entry synced to Google, both copies present: one prompt, one row, Offerly's key", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { googleEventId: "synced-1" });
    seedGoogle(u.id, [gEvent({ id: "synced-1", title: "Coffee chat", videoCall: true })]);
    await hourly(u, mon(17), 24);
    const rows = await jobRows(u.id);
    assert.deepEqual(rows.map((r) => r.dedupeKey), [offerlyKey(e)]);
  });

  test("the contact's email typed in later: the Google invite now resolves to her and the prompt links by contact", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id, "Pat Lee", null);
    seedGoogle(u.id, [invite("g-later", [{ email: "pat.lee@lazard.com", name: "P" }], { title: "Coffee chat" })]);
    assert.equal((await owed(u, mon(17)))[0].next.contactId, null);
    await h.db.update(contacts).set({ email: "pat.lee@lazard.com" }).where(eq(contacts.id, c));
    assert.equal((await owed(u, mon(18)))[0].next.contactId, c);
  });

  test("a thank-you to a contact saved AFTER the chat (from the invite's address) still closes it", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [invite("g-newc", [{ email: "pat.lee@lazard.com", name: "Pat Lee" }])]);
    await seeBanner(u, mon(17));
    const c = await mkContact(u.id, "Pat Lee", "pat.lee@lazard.com");
    await sendThanks(u, c, mon(18));
    assert.equal((await jobRow(u.id, googleKey("g-newc")))?.doneSource, "auto");
  });

  test("the student's own tick survives the entry being moved later", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await tick(u, offerlyKey(e), mon(17));
    await h.db.update(events).set({ eventDate: day(1, 14), endDate: day(1, 14, 30) }).where(eq(events.id, e));
    assert.deepEqual(await owedKeys(u, day(1, 17)), []);
  });

  test("a follow-up (thank-you) sent a week later still counts as the thank-you", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, day(7, 9));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "auto");
  });

  test("a bell job left open for a chat whose Google copy became Offerly's (synced later) closes", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "late-sync", title: "Coffee chat", videoCall: true, attendeeEmails: ["pat@lazard.com"] })]);
    await seeBanner(u, mon(17));
    const e = await mkEvent(u.id, { googleEventId: "late-sync" });
    await drain(u, mon(18));
    await bell(u, mon(18));
    assert.equal((await jobRow(u.id, googleKey("late-sync")))?.doneSource, "auto");
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
  });
});
