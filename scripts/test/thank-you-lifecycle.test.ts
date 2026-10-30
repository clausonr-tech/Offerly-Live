// The thank-you prompt's whole life, end to end, against a real schema.
//
// A chat, a call or an interview ends; two hours later a thank-you is owed.
// While it is owed the banner drops once a day on the student's own calendar,
// a row sits on the to-do list, and ONE job sits under the bell. It ends when
// the student ticks it, sends a thank-you, or it is a fortnight late.
//
// Everything here goes through the real queries (getThankYouPrompts,
// getPendingFlash, getAllTasks, getNotifications, reconcileThankYouJobs) over
// an in-memory PGlite migrated from drizzle/*.sql. The two server actions that
// need a signed-in user (markPromptFlashSeen, completeThankYouPrompt) and the
// send (markDraftSent) are replayed step for step with the same lib calls.
//
// Google entries are seeded straight into the per-student cache that
// thank-you-db reads, so no network is touched. The cache lives ten minutes, so
// every read below re-primes it at the moment being simulated.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed, fetch throws.

// Production (Vercel) runs in UTC. Pin it, so anything that reads the server's
// own clock instead of the student's behaves here as it does there.
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
  flashesShown,
  notifications,
  outreachSends,
  users,
} from "@/db/schema";
import {
  closeNotificationByKey,
  getNotifications,
  markNotificationsRead,
  upsertNotification,
} from "@/lib/notifications";
import { getPendingFlash, markFlashShown, thankYouNotification } from "@/lib/prompt-flash";
import type { ChatEvent, ThankYouPrompt } from "@/lib/thank-you";
import {
  reconcileThankYouJobs,
  getThankYouPrompts,
} from "@/lib/thank-you-db";
import { zonedTime } from "@/lib/time-zone";
import { getAllTasks } from "@/lib/today-tasks";

delete process.env.DATABASE_URL;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TZ = "America/New_York";

/** An instant by the New York wall clock. */
const et = (y: number, m: number, d: number, h: number, min = 0) => zonedTime(y, m, d, h, min, TZ);
/** Monday 21 September 2026, by the New York wall clock. */
const mon = (h: number, min = 0) => et(2026, 9, 21, h, min);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

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
    .values({ email: `lifecycle-${seq}-${Date.now()}@example.edu`, passwordHash: "x", name: `Alex Rivera ${seq}` })
    .returning();
  return u;
}

/** A contact the student is already talking to - on no outreach list and no
 *  cold-email ladder, so the only prompt they can cause is a thank-you. */
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

/** A coffee chat 2pm-2:30pm on Monday unless told otherwise: due 4:30pm. */
async function mkEvent(userId: string, over: Partial<typeof events.$inferInsert> = {}): Promise<string> {
  const [e] = await h.db
    .insert(events)
    .values({
      userId,
      type: "coffee_chat",
      title: "Coffee chat",
      eventDate: mon(14),
      endDate: mon(14, 30),
      ...over,
    })
    .returning({ id: events.id });
  return e.id;
}

const offerlyKey = (eventId: string) => `thank_you:offerly:${eventId}`;
const googleKey = (id: string) => `thank_you:google:${id}`;

// ---- Google, through the cache thank-you-db reads

type Cache = Map<string, { at: number; events: ChatEvent[] }>;
function googleCache(): Cache {
  const g = globalThis as { __thankYouGoogleCache?: Cache };
  g.__thankYouGoogleCache ??= new Map();
  return g.__thankYouGoogleCache;
}
const seeded = new Map<string, ChatEvent[]>();
function seedGoogle(userId: string, evs: ChatEvent[]) {
  seeded.set(userId, evs);
}
/** The cache lives ten minutes: re-prime it at the moment being simulated. */
function prime(userId: string, now: Date) {
  const evs = seeded.get(userId);
  if (evs) googleCache().set(userId, { at: now.getTime(), events: evs });
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

// ---- what the student sees, at a moment

async function owed(u: User, now: Date): Promise<ThankYouPrompt[]> {
  prime(u.id, now);
  return getThankYouPrompts(u.id, now);
}

async function banner(u: User, now: Date) {
  prime(u.id, now);
  return getPendingFlash(u, now);
}

/** markPromptFlashSeen, step for step: file the job(s), then record the bubble. */
async function seeBanner(u: User, now: Date) {
  const pending = await banner(u, now);
  if (!pending) return null;
  for (const n of pending.notifications) await upsertNotification({ userId: u.id, ...n, now });
  await markFlashShown(u.id, pending.flashKey);
  return pending;
}

/** completeThankYouPrompt, step for step. */
async function tick(u: User, key: string, now: Date): Promise<boolean> {
  const t = (await owed(u, now)).find((p) => p.key === key);
  if (!t) return false;
  await upsertNotification({ userId: u.id, ...thankYouNotification(t), now });
  await closeNotificationByKey(u.id, t.key, "manual", now);
  return true;
}

/** A thank-you draft, written but not yet sent. */
async function mkDraft(userId: string, contactId: string | null, templateId = "thank_you_chat", kind: "thank_you" | "cold_outreach" = "thank_you") {
  const [d] = await h.db
    .insert(emailDrafts)
    .values({ userId, contactId, kind, templateId, subject: "Thank you", body: "Thanks for your time." })
    .returning({ id: emailDrafts.id });
  return d.id;
}

/** markDraftSent's thank-you half, step for step: sentAt is kept from the
 *  first send, then every job the send answered closes. */
async function sendDraft(u: User, draftId: string, now: Date) {
  const draft = await h.db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, draftId) });
  assert.ok(draft);
  await h.db
    .update(emailDrafts)
    .set({ sentAt: draft.sentAt ?? now, updatedAt: now })
    .where(eq(emailDrafts.id, draftId));
  if (draft.kind === "thank_you") {
    prime(u.id, now);
    await reconcileThankYouJobs(u.id, now);
  }
}

/** Write and send a thank-you in one go. */
async function sendThanks(u: User, contactId: string, at: Date, templateId = "thank_you_chat") {
  const d = await mkDraft(u.id, contactId, templateId);
  await sendDraft(u, d, at);
  return d;
}

/** An interview thank-you to someone saved as a contact that evening. */
async function sendInterviewThanks(u: User, at: Date, templateId = "thank_you_interview", name = "New Interviewer") {
  const c = await mkContact(u.id, `${name} ${++seq}`);
  return sendThanks(u, c, at, templateId);
}

async function todo(u: User, now: Date) {
  prime(u.id, now);
  return (await getAllTasks(u, now)).filter((t) => t.kind === "thank_you");
}

async function jobRows(userId: string) {
  return h.db.query.notifications.findMany({
    where: and(eq(notifications.userId, userId), eq(notifications.kind, "thank_you")),
  });
}

async function openJobs(userId: string, now: Date) {
  return (await getNotifications(userId, now)).open.filter((n) => n.kind === "thank_you");
}

async function jobRow(userId: string, key: string) {
  return h.db.query.notifications.findFirst({
    where: and(eq(notifications.userId, userId), eq(notifications.dedupeKey, key)),
  });
}

/** One page load a day: the banner is shown and recorded. */
async function dayOfBanners(u: User, now: Date) {
  const shown = [];
  for (let i = 0; i < 10; i++) {
    const p = await seeBanner(u, now);
    if (!p) break;
    shown.push(p);
  }
  return shown;
}

// ============================================================ the daily banner

describe("the daily banner", () => {
  test("nothing before the two hours are up", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.equal(await banner(u, mon(16, 29)), null);
  });

  test("due exactly two hours after it ends: the banner drops", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    const p = await banner(u, mon(16, 30));
    assert.ok(p);
    assert.equal(p.flashKey, `${offerlyKey(e)}:2026-09-21`);
  });

  test("day one: chip, subject, detail, button, link", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    const p = await banner(u, mon(17));
    assert.ok(p);
    assert.equal(p.chip, "thank-you");
    assert.equal(p.subject, "Dana Reed");
    assert.equal(p.detail, "send a thank-you while the chat is fresh");
    assert.equal(p.cta, "Write it");
    assert.equal(p.href, `/outreach?contact=${c}&occasion=thanks&box=thanks.chat`);
    assert.equal(p.daysUntil, 0);
  });

  test("with nobody linked the banner names the entry and asks to thank the person", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { title: "Coffee w/ Evercore analyst" });
    const p = await banner(u, mon(17));
    assert.ok(p);
    assert.equal(p.subject, "Coffee w/ Evercore analyst");
    assert.equal(p.detail, "thank the person you spoke with");
    // Nobody saved: the outside form, looked up from the prompt's key.
    assert.equal(p.href, `/outreach?occasion=thanks&box=thanks.chat&thank=${encodeURIComponent(offerlyKey(e))}`);
  });

  test("an interview's banner thanks the interviewers", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    const p = await banner(u, mon(13));
    assert.ok(p);
    assert.equal(p.detail, "thank your interviewers while it is fresh");
    assert.equal(p.href, `/outreach?occasion=thanks&box=thanks.interview&thank=${encodeURIComponent(offerlyKey(e))}`);
  });

  test("a very long title is cut to fit the bubble", async () => {
    const u = await mkUser();
    const title = "Coffee chat about the restructuring group and how the analyst class is staffed";
    await mkEvent(u.id, { title });
    const p = await banner(u, mon(17));
    assert.ok(p);
    assert.equal(p.subject.length, 48);
    assert.ok(p.subject.endsWith("…"));
  });

  test("shown once: the same day it is silent", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.ok(await seeBanner(u, mon(17)));
    assert.equal(await banner(u, mon(17, 1)), null);
    assert.equal(await banner(u, mon(23, 59)), null);
  });

  test("the next local day it drops again with a new key and says yesterday", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    const p = await banner(u, et(2026, 9, 22, 9));
    assert.ok(p);
    assert.equal(p.flashKey, `${offerlyKey(e)}:2026-09-22`);
    assert.equal(p.chip, "thank-you · yesterday");
    assert.equal(p.detail, "still owed a thank-you, a short note still counts");
  });

  test("day three says 2 days, and an interview's late copy names the interviewers", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "interview", title: "Evercore first round", eventDate: mon(10), endDate: mon(11) });
    const p = await banner(u, et(2026, 9, 23, 9));
    assert.ok(p);
    assert.equal(p.chip, "thank-you · 2 days");
    assert.equal(p.detail, "your interviewers are still owed a thank-you");
  });

  test("five days: exactly one banner a day, five different keys", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    const days = [mon(17), et(2026, 9, 22, 10), et(2026, 9, 23, 10), et(2026, 9, 24, 10), et(2026, 9, 25, 10)];
    const keys: string[] = [];
    for (const d of days) {
      const shown = await dayOfBanners(u, d);
      assert.equal(shown.length, 1, `one banner on ${d.toISOString()}`);
      keys.push(shown[0].flashKey);
      // A second, third, fourth page load the same day: nothing.
      assert.equal(await banner(u, plus(d, 3 * HOUR)), null);
    }
    assert.equal(new Set(keys).size, 5);
    const recorded = await h.db.query.flashesShown.findMany({ where: eq(flashesShown.userId, u.id) });
    assert.equal(recorded.length, 5);
  });

  test("after the tick it never drops again", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await seeBanner(u, et(2026, 9, 22, 10));
    assert.ok(await tick(u, offerlyKey(e), et(2026, 9, 23, 8)));
    for (const d of [et(2026, 9, 23, 10), et(2026, 9, 24, 10), et(2026, 9, 25, 10)]) {
      assert.equal(await banner(u, d), null);
    }
  });

  test("a tick before the banner ever dropped silences it too", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    assert.ok(await tick(u, offerlyKey(e), mon(16, 45)));
    assert.equal(await banner(u, mon(17)), null);
    assert.equal(await banner(u, et(2026, 9, 22, 10)), null);
  });

  test("after a send it never drops again", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(21));
    for (const d of [et(2026, 9, 22, 10), et(2026, 9, 23, 10), et(2026, 9, 24, 10)]) {
      assert.equal(await banner(u, d), null);
    }
  });

  test("a thank-you sent the same afternoon, before it was due, means no banner at all", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await sendThanks(u, c, mon(15));
    assert.equal(await banner(u, mon(17)), null);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("New York midnight: 11:30pm and 12:30am are different days", async () => {
    const u = await mkUser();
    // Ends 9pm, due 11pm.
    const e = await mkEvent(u.id, { eventDate: mon(20, 30), endDate: mon(21) });
    const late = await seeBanner(u, mon(23, 30));
    assert.ok(late);
    assert.equal(late.flashKey, `${offerlyKey(e)}:2026-09-21`);
    assert.equal(await banner(u, mon(23, 59)), null);
    const early = await banner(u, et(2026, 9, 22, 0, 30));
    assert.ok(early);
    assert.equal(early.flashKey, `${offerlyKey(e)}:2026-09-22`);
  });

  test("the day is New York's, not UTC's: 9pm ET on Monday is still Monday", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { eventDate: mon(17), endDate: mon(18) });
    // 9pm EDT is 1am UTC on Tuesday.
    const p = await seeBanner(u, mon(21));
    assert.ok(p);
    assert.equal(p.flashKey, `${offerlyKey(e)}:2026-09-21`);
    // ...so 11pm the same evening (3am UTC) is still silent.
    assert.equal(await banner(u, mon(23)), null);
    assert.equal(p.chip, "thank-you");
  });

  test("across the clocks going back (1 Nov 2026) it is still once a day", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { eventDate: et(2026, 10, 31, 14), endDate: et(2026, 10, 31, 14, 30) });
    const d1 = await seeBanner(u, et(2026, 10, 31, 17));
    const d2 = await seeBanner(u, et(2026, 11, 1, 12));
    assert.equal(await banner(u, et(2026, 11, 1, 23, 30)), null);
    const d3 = await seeBanner(u, et(2026, 11, 2, 0, 15));
    assert.deepEqual(
      [d1?.flashKey, d2?.flashKey, d3?.flashKey],
      [`${offerlyKey(e)}:2026-10-31`, `${offerlyKey(e)}:2026-11-01`, `${offerlyKey(e)}:2026-11-02`],
    );
    assert.deepEqual([d1?.chip, d2?.chip, d3?.chip], ["thank-you", "thank-you · yesterday", "thank-you · 2 days"]);
  });

  test("still drops thirteen days late", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.ok(await banner(u, plus(mon(16, 30), 13 * DAY)));
  });

  test("still owed at exactly fourteen days, gone a moment later", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.equal((await owed(u, plus(mon(16, 30), 14 * DAY))).length, 1);
    assert.equal((await owed(u, plus(mon(16, 30), 14 * DAY + 1))).length, 0);
    assert.equal(await banner(u, plus(mon(16, 30), 14 * DAY + MIN)), null);
  });

  test("markFlashShown twice is one record", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    const p = await banner(u, mon(17));
    assert.ok(p);
    await markFlashShown(u.id, p.flashKey);
    await markFlashShown(u.id, p.flashKey);
    const rows = await h.db.query.flashesShown.findMany({ where: eq(flashesShown.userId, u.id) });
    assert.equal(rows.length, 1);
  });

  test("two owed: the older speaks first, the other next, then silence", async () => {
    const u = await mkUser();
    const older = await mkEvent(u.id, { title: "Coffee chat one", eventDate: mon(9), endDate: mon(9, 30) });
    const newer = await mkEvent(u.id, { title: "Coffee chat two", eventDate: mon(13), endDate: mon(13, 30) });
    const shown = await dayOfBanners(u, mon(17));
    assert.deepEqual(
      shown.map((s) => s.flashKey),
      [`${offerlyKey(older)}:2026-09-21`, `${offerlyKey(newer)}:2026-09-21`],
    );
    assert.equal(await banner(u, mon(18)), null);
  });

  test("a new chat falling due later the same day still gets its banner", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee chat one", eventDate: mon(9), endDate: mon(9, 30) });
    await seeBanner(u, mon(12));
    assert.equal(await banner(u, mon(13)), null);
    const later = await mkEvent(u.id, { title: "Coffee chat two", eventDate: mon(15), endDate: mon(15, 30) });
    const p = await banner(u, mon(17, 45));
    assert.ok(p);
    assert.equal(p.flashKey, `${offerlyKey(later)}:2026-09-21`);
  });

  test("a chat still underway is not thanked for", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { eventDate: mon(14), endDate: mon(18) });
    assert.equal(await banner(u, mon(17)), null);
  });

  test("a chat with no end is taken as thirty minutes", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { endDate: null });
    assert.equal(await banner(u, mon(16, 29)), null);
    assert.ok(await banner(u, mon(16, 30)));
  });

  test("an interview with no end is taken as an hour", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "interview", title: "Lazard interview", eventDate: mon(10), endDate: null });
    assert.equal(await banner(u, mon(12, 59)), null);
    assert.ok(await banner(u, mon(13)));
  });
});

// ============================================================ the bell

describe("the job under the bell", () => {
  test("five days of banners are ONE row, still open, bumped to the last day", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    const days = [mon(17), et(2026, 9, 22, 10), et(2026, 9, 23, 10), et(2026, 9, 24, 10), et(2026, 9, 25, 10)];
    for (const d of days) await dayOfBanners(u, d);
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedupeKey, offerlyKey(e));
    assert.equal(rows[0].doneAt, null);
    assert.equal(rows[0].createdAt.getTime(), days[0].getTime());
    assert.equal(rows[0].bumpedAt.getTime(), days[4].getTime());
    assert.equal((await openJobs(u.id, et(2026, 9, 25, 11))).length, 1);
  });

  test("the row reads as the bell should say it", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c, title: "Coffee chat with Dana" });
    await seeBanner(u, mon(17));
    const [row] = await jobRows(u.id);
    assert.equal(row.title, "Thank Dana Reed");
    assert.equal(row.subjectKey, `thanks:${c}`);
    assert.equal(row.body, "After “Coffee chat with Dana” · 21 Sep");
    assert.equal(row.href, `/outreach?contact=${c}&occasion=thanks&box=thanks.chat`);
    // Expires when the two weeks a thank-you is prompted for run out.
    const [t] = await owed(u, mon(17));
    assert.equal(row.expiresAt?.getTime(), t.dueAt.getTime() + 14 * 86_400_000);
  });

  test("an interview's job is 'Thank your interviewers', with no person to watch", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    await seeBanner(u, mon(13));
    const [row] = await jobRows(u.id);
    assert.equal(row.title, "Thank your interviewers");
    assert.equal(row.subjectKey, null);
  });

  test("a read row comes back unread when the next day's banner bumps it", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await markNotificationsRead(u.id, mon(18));
    assert.ok((await jobRow(u.id, offerlyKey(e)))?.readAt);
    await seeBanner(u, et(2026, 9, 22, 10));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.readAt, null);
  });

  test("reading the bell does not close a contact's thank-you job", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    // getNotifications runs the auto-close pass; a "thanks:" subject must not
    // be read as a firm with nobody left to email.
    assert.equal((await openJobs(u.id, mon(18))).length, 1);
    assert.equal((await openJobs(u.id, et(2026, 9, 24, 10))).length, 1);
  });

  test("the tick closes it by hand", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await tick(u, offerlyKey(e), mon(20));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "manual");
    assert.equal(row?.doneAt?.getTime(), mon(20).getTime());
    assert.deepEqual(await openJobs(u.id, mon(21)), []);
  });

  test("a tick with no banner yet files the job and closes it: one closed row", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await tick(u, offerlyKey(e), mon(17));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].doneSource, "manual");
  });

  test("ticked, then five more days: still one closed row", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await tick(u, offerlyKey(e), mon(18));
    for (let d = 22; d <= 26; d++) await dayOfBanners(u, et(2026, 9, d, 10));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].doneAt);
  });

  test("a thank-you sent to the contact closes the chat's job", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(20));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "auto");
    assert.deepEqual(await openJobs(u.id, mon(21)), []);
  });

  test("an interview thank-you to a brand-new contact closes the interview's job", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    await seeBanner(u, mon(13));
    await sendInterviewThanks(u, mon(19));
    // An Offerly interview lists nobody: a note moves it to "anyone else?",
    // it never closes it by itself.
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
    const [t] = await owed(u, mon(20));
    assert.equal(t?.key, offerlyKey(e));
    assert.equal(t?.notesSent, 1);
    const next = await banner(u, et(2026, 9, 22, 9));
    assert.equal(next?.detail, "1 note sent · anyone else to thank?");
    assert.equal(next?.cta, "Write the next");
    assert.equal(next?.doneKey, offerlyKey(e));
    // "That's everyone" closes it.
    assert.ok(await tick(u, offerlyKey(e), et(2026, 9, 22, 9)));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "manual");
    assert.deepEqual(await owed(u, et(2026, 9, 22, 10)), []);
  });

  for (const template of ["thank_you_superday", "thank_you_phone_screen"]) {
    test(`a ${template} send closes the interview too`, async () => {
      const u = await mkUser();
      const e = await mkEvent(u.id, { type: "interview", title: "Evercore Superday", eventDate: mon(9), endDate: mon(15) });
      await seeBanner(u, mon(18));
      await sendInterviewThanks(u, mon(20), template);
      // Counted as a note for the interview (no list, so still owed)...
      assert.equal((await owed(u, mon(20, 30)))[0]?.notesSent, 1);
      assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
      // ...and "That's everyone" closes it.
      assert.ok(await tick(u, offerlyKey(e), mon(21)));
      assert.ok((await jobRow(u.id, offerlyKey(e)))?.doneAt);
    });
  }

  test("a chat thank-you to a stranger does not close an interview", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    await seeBanner(u, mon(13));
    await sendInterviewThanks(u, mon(19), "thank_you_chat");
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
  });

  test("an info-session thank-you does not close an interview", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    await seeBanner(u, mon(13));
    await sendInterviewThanks(u, mon(19), "thank_you_event");
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
    assert.equal((await owed(u, mon(20))).length, 1);
  });

  test("the coffee chat's job (no contact) stays open after an interview thank-you", async () => {
    const u = await mkUser();
    const interview = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    const chat = await mkEvent(u.id, { title: "Coffee with an analyst", eventDate: mon(8), endDate: mon(8, 30) });
    await dayOfBanners(u, mon(13));
    await sendInterviewThanks(u, mon(19));
    const open = await openJobs(u.id, mon(20));
    assert.deepEqual(open.map((o) => o.title).sort(), ["Send a thank-you", "Thank your interviewers"]);
    const now = await owed(u, mon(20));
    assert.deepEqual(now.map((t) => t.key), [offerlyKey(chat), offerlyKey(interview)]);
    assert.equal(now.find((t) => t.key === offerlyKey(interview))?.notesSent, 1);
    // "That's everyone" on the interview leaves the chat's job alone.
    await tick(u, offerlyKey(interview), mon(20));
    assert.deepEqual((await openJobs(u.id, mon(20, 5))).map((o) => o.title), ["Send a thank-you"]);
    assert.deepEqual((await owed(u, mon(20, 5))).map((t) => t.key), [offerlyKey(chat)]);
  });

  test("the coffee chat's job with Dana stays open after an interview thank-you to someone else", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id);
    await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    const chat = await mkEvent(u.id, { contactId: dana, eventDate: mon(8), endDate: mon(8, 30) });
    await dayOfBanners(u, mon(13));
    await sendInterviewThanks(u, mon(19));
    assert.equal((await jobRow(u.id, offerlyKey(chat)))?.doneAt, null);
  });

  test("two chats with Dana, one thank-you after both: both jobs close", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id);
    const first = await mkEvent(u.id, { contactId: dana, eventDate: mon(9), endDate: mon(9, 30) });
    const second = await mkEvent(u.id, { contactId: dana, eventDate: et(2026, 9, 23, 9), endDate: et(2026, 9, 23, 9, 30) });
    await dayOfBanners(u, mon(17));
    await dayOfBanners(u, et(2026, 9, 23, 17));
    assert.equal((await openJobs(u.id, et(2026, 9, 23, 18))).length, 2);
    await sendThanks(u, dana, et(2026, 9, 24, 9));
    assert.ok((await jobRow(u.id, offerlyKey(first)))?.doneAt);
    assert.ok((await jobRow(u.id, offerlyKey(second)))?.doneAt);
    assert.deepEqual(await owed(u, et(2026, 9, 24, 10)), []);
  });

  test("a thank-you to Dana between two chats answers only the first", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id);
    const first = await mkEvent(u.id, { contactId: dana, eventDate: mon(9), endDate: mon(9, 30) });
    const second = await mkEvent(u.id, { contactId: dana, eventDate: et(2026, 9, 23, 9), endDate: et(2026, 9, 23, 9, 30) });
    await dayOfBanners(u, mon(17));
    await sendThanks(u, dana, et(2026, 9, 22, 9));
    assert.ok((await jobRow(u.id, offerlyKey(first)))?.doneAt);
    assert.deepEqual((await owed(u, et(2026, 9, 23, 17))).map((t) => t.key), [offerlyKey(second)]);
  });

  test("a thank-you to Dana from last month does not answer today's chat", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id);
    await h.db.insert(emailDrafts).values({
      userId: u.id, contactId: dana, kind: "thank_you", templateId: "thank_you_chat",
      subject: "Thanks", body: "Thanks", sentAt: plus(mon(9), -20 * DAY),
    });
    await mkEvent(u.id, { contactId: dana });
    assert.equal((await owed(u, mon(17))).length, 1);
  });

  test("a thank-you to Sam closes Sam's chat and leaves Dana's", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed");
    const sam = await mkContact(u.id, "Sam Ito");
    const danaChat = await mkEvent(u.id, { contactId: dana, eventDate: mon(9), endDate: mon(9, 30) });
    const samChat = await mkEvent(u.id, { contactId: sam, eventDate: mon(11), endDate: mon(11, 30) });
    await dayOfBanners(u, mon(17));
    await sendThanks(u, sam, mon(19));
    assert.equal((await jobRow(u.id, offerlyKey(danaChat)))?.doneAt, null);
    assert.ok((await jobRow(u.id, offerlyKey(samChat)))?.doneAt);
  });

  test("an interview thank-you on Wednesday answers Wednesday's round, not Monday's", async () => {
    const u = await mkUser();
    const monday = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    const wednesday = await mkEvent(u.id, { type: "interview", title: "Evercore first round", eventDate: et(2026, 9, 23, 10), endDate: et(2026, 9, 23, 11) });
    await dayOfBanners(u, mon(13));
    await dayOfBanners(u, et(2026, 9, 23, 13));
    await sendInterviewThanks(u, et(2026, 9, 23, 19));
    const now = await owed(u, et(2026, 9, 23, 20));
    assert.equal(now.find((t) => t.key === offerlyKey(monday))?.notesSent, 0, "Monday's round is not credited");
    assert.equal(now.find((t) => t.key === offerlyKey(wednesday))?.notesSent, 1, "Wednesday's is");
    assert.equal((await jobRow(u.id, offerlyKey(monday)))?.doneAt, null);
  });

  test("an interview thank-you sent before Tuesday's round does not answer it", async () => {
    const u = await mkUser();
    const monday = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    const tuesday = await mkEvent(u.id, { type: "interview", title: "Evercore first round", eventDate: et(2026, 9, 22, 10), endDate: et(2026, 9, 22, 11) });
    await dayOfBanners(u, mon(13));
    await sendInterviewThanks(u, mon(19));
    const now = await owed(u, et(2026, 9, 22, 14));
    assert.deepEqual(now.map((t) => t.key), [offerlyKey(monday), offerlyKey(tuesday)]);
    assert.equal(now.find((t) => t.key === offerlyKey(monday))?.notesSent, 1, "Monday's round has its note");
    assert.equal(now.find((t) => t.key === offerlyKey(tuesday))?.notesSent, 0, "Tuesday's has none");
  });

  test("two interviews the same day, two interview thank-yous that evening: both jobs close", async () => {
    // Goldman at 10am, Evercore at 2pm. That evening the student writes to
    // both sets of interviewers. Each send is an interview thank-you sent after
    // each round began, so both are answered.
    const u = await mkUser();
    const goldman = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    const evercore = await mkEvent(u.id, { type: "interview", title: "Evercore first round", eventDate: mon(14), endDate: mon(15) });
    await dayOfBanners(u, mon(17, 30));
    await sendInterviewThanks(u, mon(19), "thank_you_interview", "Goldman Interviewer");
    await sendInterviewThanks(u, mon(19, 10), "thank_you_interview", "Evercore Interviewer");
    // Neither lists anyone, so each is in "anyone else?" with that evening's
    // notes credited (both began the same day).
    const now = await owed(u, mon(20));
    assert.equal(now.find((t) => t.key === offerlyKey(goldman))?.notesSent, 2);
    assert.equal(now.find((t) => t.key === offerlyKey(evercore))?.notesSent, 2);
    // "That's everyone" on each closes both jobs.
    await tick(u, offerlyKey(goldman), mon(20));
    await tick(u, offerlyKey(evercore), mon(20));
    assert.ok((await jobRow(u.id, offerlyKey(evercore)))?.doneAt, "Evercore's job closed");
    assert.ok((await jobRow(u.id, offerlyKey(goldman)))?.doneAt, "Goldman's job closed");
    assert.deepEqual(await owed(u, mon(20, 5)), []);
  });

  test("a superday booked as four back-to-back entries: one evening of notes closes all four", async () => {
    const u = await mkUser();
    const keys: string[] = [];
    for (let i = 0; i < 4; i++) {
      keys.push(offerlyKey(await mkEvent(u.id, {
        type: "interview", title: `Evercore Superday interview ${i + 1}`,
        eventDate: mon(9 + i), endDate: mon(9 + i, 45),
      })));
    }
    await dayOfBanners(u, mon(15));
    assert.equal((await openJobs(u.id, mon(15, 30))).length, 4);
    await sendInterviewThanks(u, mon(19), "thank_you_superday");
    // The evening's note is credited to all four...
    const now = await owed(u, mon(20));
    assert.deepEqual(now.map((t) => t.notesSent), [1, 1, 1, 1]);
    // ...and "That's everyone" on each closes them.
    for (const k of keys) await tick(u, k, mon(20));
    assert.deepEqual(await openJobs(u.id, mon(20, 5)), []);
    assert.deepEqual(await owed(u, mon(20, 5)), []);
  });

  test("an interview late Monday night is not answered by Tuesday evening's note for Tuesday's round", async () => {
    const u = await mkUser();
    const monday = await mkEvent(u.id, { type: "interview", title: "Nomura interview (Tokyo)", eventDate: mon(22), endDate: mon(23) });
    await mkEvent(u.id, { type: "interview", title: "Evercore first round", eventDate: et(2026, 9, 22, 10), endDate: et(2026, 9, 22, 11) });
    await dayOfBanners(u, et(2026, 9, 22, 13));
    await sendInterviewThanks(u, et(2026, 9, 22, 19));
    const now = await owed(u, et(2026, 9, 22, 20));
    assert.equal(now.find((t) => t.key === offerlyKey(monday))?.notesSent, 0, "Monday night's round has no note");
    assert.equal(now.filter((t) => t.notesSent === 1).length, 1, "only Tuesday's round has the note");
  });

  test("a Google interview whose read failed at send time still has its job closed", async () => {
    // markDraftSent's reconcileThankYouJobs re-reads Google. If that read
    // fails (it is cached as empty for ten minutes), the interview is not in
    // the list, nothing is closed - but the prompt, next time Google answers,
    // sees the send and drops the thank-you. The bell's job must not be left
    // open with nothing that will ever close it.
    const u = await mkUser();
    // The interviewer is on the invite, and the note goes to that address, so
    // it answers the whole list.
    const interview = gEvent({
      id: "int-flaky", title: "Morgan Stanley Interview", startsAt: mon(10), endsAt: mon(11),
      attendeeEmails: ["jo.park@ms.com"], attendees: [{ email: "jo.park@ms.com", name: "Jo Park" }],
    });
    seedGoogle(u.id, [interview]);
    await seeBanner(u, mon(13));
    seedGoogle(u.id, []);
    await sendThanks(u, await mkContact(u.id, "Jo Park", "jo.park@ms.com"), mon(19), "thank_you_interview");
    seedGoogle(u.id, [interview]);
    assert.deepEqual(await owed(u, mon(20)), [], "the prompt sees the send");
    assert.deepEqual(await openJobs(u.id, mon(20)), [], "...and so should the bell");
  });

  test("an old thank-you draft copied again does not close a newer chat's job", async () => {
    // Tuesday's thank-you to Dana answered Monday's chat. On Thursday the
    // student opens that old draft and copies it again (markDraftSent keeps
    // the first sentAt - it is the same email, not a new one). Wednesday's chat
    // with Dana was never thanked, so its job must stay open.
    const u = await mkUser();
    const dana = await mkContact(u.id);
    await mkEvent(u.id, { contactId: dana, eventDate: mon(9), endDate: mon(9, 30) });
    const wednesday = await mkEvent(u.id, { contactId: dana, eventDate: et(2026, 9, 23, 9), endDate: et(2026, 9, 23, 9, 30) });
    await dayOfBanners(u, mon(17));
    const draft = await sendThanks(u, dana, et(2026, 9, 22, 9));
    await dayOfBanners(u, et(2026, 9, 23, 17));
    assert.equal((await jobRow(u.id, offerlyKey(wednesday)))?.doneAt, null);
    await sendDraft(u, draft, et(2026, 9, 24, 9));
    assert.equal((await jobRow(u.id, offerlyKey(wednesday)))?.doneAt, null, "Wednesday's job still open");
    assert.deepEqual((await owed(u, et(2026, 9, 24, 10))).map((t) => t.key), [offerlyKey(wednesday)]);
  });

  test("a fortnight late: the banner and the to-do row are gone, and so is the bell's job", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    const late = plus(mon(16, 30), 15 * DAY);
    assert.deepEqual(await owed(u, late), []);
    assert.deepEqual(await todo(u, late), []);
    assert.equal(await banner(u, late), null);
    // Nothing will ever prompt it again, so a row that stays open can only be
    // closed by hand - forever on the badge for a thank-you no one will send.
    assert.deepEqual(
      (await openJobs(u.id, late)).map((o) => o.title),
      [],
      `job ${offerlyKey(e)} still open on the bell after the prompt was dropped`,
    );
  });

  test("an entry deleted from the schedule takes its open job with it", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await seeBanner(u, mon(17));
    await h.db.delete(events).where(eq(events.id, e));
    assert.deepEqual(await owed(u, mon(18)), []);
    assert.deepEqual(await openJobs(u.id, mon(18)), []);
  });

  test("a thank-you draft ticked 'done' on the to-do list closes the bell's job", async () => {
    // completeTask's draft branch: sets sentAt on the draft and nothing else.
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    const d = await mkDraft(u.id, c);
    await h.db.update(emailDrafts).set({ sentAt: mon(19) }).where(eq(emailDrafts.id, d));
    assert.deepEqual(await owed(u, mon(20)), [], "the prompt sees the send");
    assert.deepEqual(await openJobs(u.id, mon(20)), [], "...and so should the bell");
  });

  test("taking back a mistaken 'I sent this' makes the thank-you owed again", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    const d = await sendThanks(u, c, mon(18));
    assert.deepEqual(await owed(u, mon(18, 5)), []);
    // setDraftSent(false): sentAt back to null, nothing else.
    await h.db.update(emailDrafts).set({ sentAt: null }).where(eq(emailDrafts.id, d));
    assert.deepEqual((await owed(u, mon(18, 10))).map((t) => t.key), [offerlyKey(e)]);
  });
});

// ============================================================ the to-do list

describe("the to-do row", () => {
  test("present once due, with the contact's name, doneKey and link", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c, title: "Coffee chat" });
    const [row, ...rest] = await todo(u, mon(17));
    assert.equal(rest.length, 0);
    assert.equal(row.id, `thanks-${offerlyKey(e)}`);
    assert.equal(row.title, "Thank Dana Reed");
    assert.equal(row.doneKey, offerlyKey(e));
    assert.equal(row.href, `/outreach?contact=${c}&occasion=thanks&box=thanks.chat`);
  });

  test("not there before it is due", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.deepEqual(await todo(u, mon(16)), []);
  });

  test("'Send a thank-you' when nobody is linked", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee w/ Moelis analyst" });
    const [row] = await todo(u, mon(17));
    assert.equal(row.title, "Send a thank-you");
  });

  test("'Thank your interviewers' for an interview", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    const [row] = await todo(u, mon(13));
    assert.equal(row.title, "Thank your interviewers");
    assert.equal(row.href, `/outreach?occasion=thanks&box=thanks.interview&thank=${encodeURIComponent(offerlyKey(e))}`);
  });

  test("an interview linked to a contact names them, and opens the interview thank-you", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", contactId: c, eventDate: mon(10), endDate: mon(11) });
    const [row] = await todo(u, mon(13));
    assert.equal(row.title, "Thank Dana Reed");
    assert.equal(row.href, `/outreach?contact=${c}&occasion=thanks&box=thanks.interview`);
  });

  test("present every day of five, whether or not the banner dropped", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    for (const d of [mon(17), et(2026, 9, 22, 10), et(2026, 9, 23, 10), et(2026, 9, 24, 10), et(2026, 9, 25, 10)]) {
      await dayOfBanners(u, d);
      const rows = await todo(u, plus(d, HOUR));
      assert.deepEqual(rows.map((r) => r.doneKey), [offerlyKey(e)], d.toISOString());
    }
  });

  test("climbs from 80 at due to a cap of 90", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.equal((await todo(u, mon(16, 30)))[0].score, 80);
    assert.equal((await todo(u, mon(21, 30)))[0].score, 85);
    assert.equal((await todo(u, et(2026, 9, 23, 10)))[0].score, 90);
  });

  test("gone after the tick", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await tick(u, offerlyKey(e), mon(17));
    assert.deepEqual(await todo(u, mon(18)), []);
    assert.deepEqual(await todo(u, et(2026, 9, 24, 10)), []);
  });

  test("gone after a send", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await sendThanks(u, c, mon(18));
    assert.deepEqual(await todo(u, mon(19)), []);
  });

  test("gone after an interview thank-you, for the interview only", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    await mkEvent(u.id, { title: "Coffee w/ Moelis analyst", eventDate: mon(8), endDate: mon(8, 30) });
    await sendInterviewThanks(u, mon(19));
    // The note moves the interview's row to "1 note sent"; the chat's is untouched.
    const rows = await todo(u, mon(20));
    assert.deepEqual(rows.map((r) => r.title).sort(), ["Send a thank-you", "Thank your interviewers"]);
    assert.ok(rows.find((r) => r.doneKey === offerlyKey(e))?.detail.endsWith("1 note sent"));
    // "That's everyone" takes the interview's row, and only it.
    await tick(u, offerlyKey(e), mon(20));
    assert.deepEqual((await todo(u, mon(20, 5))).map((r) => r.title), ["Send a thank-you"]);
  });

  test("there at thirteen days late, gone at fifteen", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.equal((await todo(u, plus(mon(16, 30), 13 * DAY))).length, 1);
    assert.equal((await todo(u, plus(mon(16, 30), 15 * DAY))).length, 0);
  });

  test("the row stays even after the Schedule entry itself is marked done", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await h.db.update(events).set({ completed: true }).where(eq(events.id, e));
    assert.equal((await todo(u, mon(17))).length, 1);
  });

  test("the row's detail says when on the student's calendar: an evening chat is 'today'", async () => {
    // 7pm ET Monday is 11pm UTC Monday; 10pm ET Monday is 2am UTC Tuesday.
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee chat", eventDate: mon(19), endDate: mon(19, 30) });
    const [row] = await todo(u, mon(22));
    assert.equal(row.detail, "Coffee chat · today");
  });

  test("the bell's row dates the chat by the student's calendar", async () => {
    // 8:30pm ET on Monday 21 Sep is 12:30am UTC on Tuesday 22 Sep.
    const u = await mkUser();
    await mkEvent(u.id, { title: "Coffee chat", eventDate: mon(20, 30), endDate: mon(21) });
    await seeBanner(u, mon(23, 30));
    const [row] = await jobRows(u.id);
    assert.equal(row.body, "After “Coffee chat” · 21 Sep");
  });
});

// ============================================================ Google entries

describe("Google Calendar entries", () => {
  test("a Zoom titled only with the two names, Dana invited by email: thank Dana", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana.reed@evercore.com");
    seedGoogle(u.id, [gEvent({ id: "zoom-1", title: "Alex Rivera and Dana Reed", videoCall: true, attendeeEmails: ["dana.reed@evercore.com"] })]);
    const [t, ...rest] = await owed(u, mon(17));
    assert.equal(rest.length, 0);
    assert.equal(t.key, googleKey("zoom-1"));
    assert.equal(t.occasion, "chat");
    assert.equal(t.contact?.id, dana);
    const [row] = await todo(u, mon(17));
    assert.equal(row.title, "Thank Dana Reed");
  });

  test("the invite matches a contact whose saved email has capitals and spaces", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "  Dana.Reed@Evercore.com ");
    seedGoogle(u.id, [gEvent({ id: "zoom-2", title: "Quick sync", attendeeEmails: ["dana.reed@evercore.com"] })]);
    const [t] = await owed(u, mon(17));
    assert.equal(t?.contact?.id, dana);
  });

  test("an untitled-looking entry with a contact on the invite is still a chat", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [gEvent({ id: "inv-3", title: "Kai / Dana", attendeeEmails: ["dana@evercore.com"] })]);
    assert.equal((await owed(u, mon(17))).length, 1);
  });

  test("a Google chat gets the daily banner and one bell job, and the send closes it", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [gEvent({ id: "zoom-4", title: "Alex Rivera and Dana Reed", videoCall: true, attendeeEmails: ["dana@evercore.com"] })]);
    for (const d of [mon(17), et(2026, 9, 22, 10), et(2026, 9, 23, 10)]) {
      assert.equal((await dayOfBanners(u, d)).length, 1);
    }
    assert.equal((await jobRows(u.id)).length, 1);
    await sendThanks(u, dana, et(2026, 9, 23, 12));
    assert.equal((await jobRow(u.id, googleKey("zoom-4")))?.doneSource, "auto");
    assert.equal(await banner(u, et(2026, 9, 24, 10)), null);
  });

  test("a Google chat ticked off is gone", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [gEvent({ id: "zoom-5", title: "Coffee chat", attendeeEmails: ["dana@evercore.com"] })]);
    assert.ok(await tick(u, googleKey("zoom-5"), mon(17)));
    assert.deepEqual(await owed(u, mon(18)), []);
    assert.equal(await banner(u, et(2026, 9, 22, 10)), null);
  });

  test("a declined invitation is never thanked for", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [gEvent({ id: "dec-1", title: "Coffee chat with Dana Reed", declined: true, attendeeEmails: ["dana@evercore.com"] })]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("a declined interview is never thanked for", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "dec-2", title: "Goldman Sachs Interview", declined: true, startsAt: mon(10), endsAt: mon(11) })]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("a recurring weekly 1:1 is not a thank-you every week", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    seedGoogle(u.id, [gEvent({ id: "weekly_20260921", title: "Weekly 1:1 with Dana Reed", recurring: true, videoCall: true, attendeeEmails: ["dana@evercore.com"] })]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("an out-of-office block is not a chat, whatever it says", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [
      gEvent({ id: "ooo-1", title: "Out of office - coffee chat day", eventType: "outOfOffice" }),
      gEvent({ id: "focus-1", title: "Coffee chat prep block", eventType: "focusTime" }),
      gEvent({ id: "wl-1", title: "Office", eventType: "workingLocation" }),
    ]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("a recorded HireVue on Google is never thanked for", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "hv-1", title: "HireVue - JPMorgan Interview", startsAt: mon(10), endsAt: mon(10, 30) })]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("an online test on Google is never thanked for", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "oa-1", title: "Citi online assessment", startsAt: mon(10), endsAt: mon(11) })]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("a timed Google interview is 'Thank your interviewers'", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "int-1", title: "Goldman Sachs Interview", startsAt: mon(10), endsAt: mon(11) })]);
    const [row] = await todo(u, mon(13));
    assert.equal(row?.title, "Thank your interviewers");
  });

  test("an all-day Google superday is due at 6pm that day, New York time", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "sd-1", title: "Evercore Superday", allDay: true, startsAt: new Date("2026-09-21"), endsAt: new Date("2026-09-22") })]);
    assert.deepEqual(await owed(u, mon(17, 59)), []);
    const [t] = await owed(u, mon(18));
    assert.equal(t?.occasion, "interview");
    assert.equal(t?.href, `/outreach?occasion=thanks&box=thanks.superday&thank=${encodeURIComponent(googleKey("sd-1"))}`);
  });

  test("an all-day chat is not a chat", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "ad-1", title: "Coffee chat", allDay: true, startsAt: new Date("2026-09-21"), endsAt: new Date("2026-09-22") })]);
    assert.deepEqual(await owed(u, et(2026, 9, 22, 10)), []);
  });

  test("an Offerly event synced to Google appears once, and Offerly's copy wins", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    const e = await mkEvent(u.id, { contactId: dana, title: "Coffee chat", googleEventId: "sync-1" });
    seedGoogle(u.id, [gEvent({ id: "sync-1", title: "Coffee chat", attendeeEmails: ["dana@evercore.com"] })]);
    const all = await owed(u, mon(17));
    assert.deepEqual(all.map((t) => t.key), [offerlyKey(e)]);
    assert.equal((await todo(u, mon(17))).length, 1);
    assert.equal((await dayOfBanners(u, mon(17))).length, 1);
    assert.equal((await jobRows(u.id)).length, 1);
  });

  test("an Offerly personal entry synced to Google is not thanked for from either side", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "personal", title: "Coffee chat with mum", googleEventId: "sync-2" });
    seedGoogle(u.id, [gEvent({ id: "sync-2", title: "Coffee chat with mum", videoCall: true, attendeeEmails: ["mum@example.com"] })]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("Dana's own Google invite and the student's Offerly entry for the same coffee are one thank-you", async () => {
    // The student logs the chat in Offerly (pushed to their Offerly calendar
    // under a new id) AND accepts Dana's invitation (a different id). Same
    // person, same slot: one conversation, one thank-you.
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@evercore.com");
    await mkEvent(u.id, { contactId: dana, title: "Coffee chat - Dana Reed", googleEventId: "offerly-cal-7" });
    seedGoogle(u.id, [gEvent({ id: "dana-invite-7", title: "Kai <> Dana coffee", attendeeEmails: ["dana@evercore.com"] })]);
    const all = await owed(u, mon(17));
    assert.equal(all.length, 1, `one prompt, got ${all.map((t) => t.key).join(", ")}`);
    assert.equal((await todo(u, mon(17))).length, 1);
  });

  test("a booking-tool title with only two names, someone not yet saved on the Zoom, is still a call", async () => {
    // Calendly's default title for a one-on-one is "<Invitee> and <Host>".
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "cal-1", title: "Alex Rivera and Dana Reed", videoCall: true, attendeeEmails: ["dana@evercore.com"] })]);
    const [t] = await owed(u, mon(17));
    assert.equal(t?.occasion, "chat");
  });

  test("Calendly's 'between' title with someone on the call is a chat", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "cal-2", title: "30 Minute Meeting between Alex Rivera and Dana Reed", videoCall: true, attendeeEmails: ["dana@evercore.com"] })]);
    const [t] = await owed(u, mon(17));
    assert.equal(t?.title, "30 Minute Meeting between Alex Rivera and Dana Reed");
    assert.equal(t?.contact, null);
  });

  test("a team Zoom is not a thank-you", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "team-1", title: "Investment club team zoom", videoCall: true, attendeeEmails: ["a@x.edu", "b@x.edu"] })]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("'Lunch' alone with nobody is nothing, 'Lunch with Dana Reed' is a chat", async () => {
    const u = await mkUser();
    await mkContact(u.id, "Dana Reed");
    seedGoogle(u.id, [
      gEvent({ id: "l-1", title: "Lunch", startsAt: mon(12), endsAt: mon(13) }),
      gEvent({ id: "l-2", title: "Lunch with Dana Reed", startsAt: mon(12), endsAt: mon(13) }),
    ]);
    assert.deepEqual((await owed(u, mon(17))).map((t) => t.key), [googleKey("l-2")]);
  });

  test("a Google entry older than the lookback is ignored", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [gEvent({ id: "old-1", title: "Coffee chat", startsAt: plus(mon(14), -16 * DAY), endsAt: plus(mon(14, 30), -16 * DAY) })]);
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("the same Google entry listed twice (two calendars) is one prompt", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [
      gEvent({ id: "dup-1", title: "Coffee chat" }),
      gEvent({ id: "dup-1", title: "Coffee chat" }),
    ]);
    assert.equal((await owed(u, mon(17))).length, 1);
  });

  test("an interview thank-you closes a Google interview's job", async () => {
    const u = await mkUser();
    // The interviewer on the invite, thanked at that address: the list is done.
    seedGoogle(u.id, [gEvent({
      id: "int-2", title: "Morgan Stanley Interview", startsAt: mon(10), endsAt: mon(11),
      attendeeEmails: ["jo.park@ms.com"], attendees: [{ email: "jo.park@ms.com", name: "Jo Park" }],
    })]);
    await seeBanner(u, mon(13));
    await sendThanks(u, await mkContact(u.id, "Jo Park", "jo.park@ms.com"), mon(19), "thank_you_interview");
    assert.ok((await jobRow(u.id, googleKey("int-2")))?.doneAt);
    assert.deepEqual(await owed(u, mon(20)), []);
  });

  test("a student with no Google connection and no seeded cache reads cleanly", async () => {
    const u = await mkUser();
    googleCache().delete(u.id);
    assert.deepEqual(await getThankYouPrompts(u.id, mon(17)), []);
  });
});

// ============================================================ students kept apart

describe("one student's thank-yous never touch another's", () => {
  test("A's send to her Dana does not close B's job about his Dana", async () => {
    const a = await mkUser();
    const b = await mkUser();
    const aDana = await mkContact(a.id, "Dana Reed");
    const bDana = await mkContact(b.id, "Dana Reed");
    await mkEvent(a.id, { contactId: aDana });
    const bChat = await mkEvent(b.id, { contactId: bDana });
    await seeBanner(a, mon(17));
    await seeBanner(b, mon(17));
    await sendThanks(a, aDana, mon(18));
    assert.equal((await jobRow(b.id, offerlyKey(bChat)))?.doneAt, null);
    assert.equal((await owed(b, mon(19))).length, 1);
  });

  test("reconciling another student's jobs closes nothing of theirs", async () => {
    const a = await mkUser();
    const b = await mkUser();
    const bDana = await mkContact(b.id, "Dana Reed");
    const bChat = await mkEvent(b.id, { contactId: bDana });
    await seeBanner(b, mon(17));
    prime(a.id, mon(18));
    await reconcileThankYouJobs(a.id, mon(18));
    assert.equal((await jobRow(b.id, offerlyKey(bChat)))?.doneAt, null);
  });

  test("A's interview thank-you does not answer B's interview", async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mkEvent(a.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    const bInt = await mkEvent(b.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    await seeBanner(a, mon(13));
    await seeBanner(b, mon(13));
    await sendInterviewThanks(a, mon(19));
    await reconcileThankYouJobs(b.id, mon(19));
    assert.equal((await jobRow(b.id, offerlyKey(bInt)))?.doneAt, null);
    assert.equal((await owed(b, mon(20))).length, 1);
  });

  test("a tick by A with B's key does nothing to B", async () => {
    const a = await mkUser();
    const b = await mkUser();
    const bChat = await mkEvent(b.id);
    await seeBanner(b, mon(17));
    assert.equal(await tick(a, offerlyKey(bChat), mon(18)), false);
    await closeNotificationByKey(a.id, offerlyKey(bChat), "manual", mon(18));
    assert.equal((await jobRow(b.id, offerlyKey(bChat)))?.doneAt, null);
  });

  test("two students on the same Google meeting: each gets their own banner and job", async () => {
    const a = await mkUser();
    const b = await mkUser();
    const aDana = await mkContact(a.id, "Dana Reed", "dana@evercore.com");
    await mkContact(b.id, "Dana Reed", "dana@evercore.com");
    const shared = gEvent({ id: "shared-1", title: "Coffee chat", attendeeEmails: ["dana@evercore.com"] });
    seedGoogle(a.id, [shared]);
    seedGoogle(b.id, [shared]);
    const aShown = await seeBanner(a, mon(17));
    const bShown = await seeBanner(b, mon(17));
    assert.ok(aShown);
    assert.ok(bShown, "B's banner is not hidden by A's");
    assert.equal(aShown.flashKey, bShown.flashKey);
    assert.equal((await jobRows(a.id)).length, 1);
    assert.equal((await jobRows(b.id)).length, 1);
    await sendThanks(a, aDana, mon(18));
    assert.equal((await owed(b, mon(19))).length, 1);
    assert.equal((await owed(a, mon(19))).length, 0);
  });

  test("Google entries seeded for A are not B's", async () => {
    const a = await mkUser();
    const b = await mkUser();
    seedGoogle(a.id, [gEvent({ id: "a-only", title: "Coffee chat" })]);
    assert.equal((await owed(a, mon(17))).length, 1);
    assert.deepEqual(await owed(b, mon(17)), []);
  });

  test("A's flashes shown do not silence B's banner", async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mkEvent(a.id);
    await mkEvent(b.id);
    await dayOfBanners(a, mon(17));
    assert.ok(await banner(b, mon(17)));
  });
});

// ============================================================ ordering

describe("which banner speaks first", () => {
  test("several owed: oldest due first on the list and in the banner", async () => {
    const u = await mkUser();
    const third = await mkEvent(u.id, { title: "Coffee chat three", eventDate: mon(13), endDate: mon(13, 30) });
    const first = await mkEvent(u.id, { title: "Coffee chat one", eventDate: plus(mon(9), -DAY), endDate: plus(mon(9, 30), -DAY) });
    const second = await mkEvent(u.id, { title: "Coffee chat two", eventDate: mon(9), endDate: mon(9, 30) });
    assert.deepEqual((await owed(u, mon(17))).map((t) => t.key), [offerlyKey(first), offerlyKey(second), offerlyKey(third)]);
    const shown = await dayOfBanners(u, mon(17));
    assert.deepEqual(shown.map((s) => s.flashKey.split(":2026")[0]), [offerlyKey(first), offerlyKey(second), offerlyKey(third)]);
  });

  test("every thank-you banner is daysUntil 0, anchored at when it fell due", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    const p = await banner(u, et(2026, 9, 24, 10));
    assert.equal(p?.daysUntil, 0);
    assert.equal(p?.at?.getTime(), mon(16, 30).getTime());
  });

  test("a thank-you due today speaks before prep for an interview in three days", async () => {
    const u = await mkUser();
    const chat = await mkEvent(u.id);
    await mkEvent(u.id, { type: "interview", title: "Goldman Sachs Interview", eventDate: et(2026, 9, 24, 15), endDate: et(2026, 9, 24, 16) });
    const first = await seeBanner(u, mon(17));
    assert.equal(first?.flashKey, `${offerlyKey(chat)}:2026-09-21`);
    const second = await banner(u, mon(17, 5));
    assert.ok(second?.flashKey.startsWith("interview:"), `then the prep prompt, got ${second?.flashKey}`);
  });

  test("the last-hours refresher for tonight's interview speaks before the thank-you", async () => {
    const u = await mkUser();
    const chat = await mkEvent(u.id, { eventDate: mon(9), endDate: mon(9, 30) });
    const interview = await mkEvent(u.id, { type: "interview", title: "Evercore Interview", eventDate: mon(19), endDate: mon(20) });
    const first = await seeBanner(u, mon(17));
    assert.match(first?.flashKey ?? "", new RegExp(`^interview:${interview}:.+:refresh$`));
    const second = await banner(u, mon(17, 5));
    assert.equal(second?.flashKey, `${offerlyKey(chat)}:2026-09-21`);
  });

  test("a follow-up a day overdue waits behind the thank-you", async () => {
    const u = await mkUser();
    const chat = await mkEvent(u.id);
    const [c] = await h.db.insert(contacts).values({ userId: u.id, name: "Sam Ito", relationshipStatus: "reached_out" }).returning({ id: contacts.id });
    await h.db.insert(outreachSends).values({ userId: u.id, contactId: c.id, step: 1, sentAt: plus(mon(17), -8 * DAY), source: "copy" });
    const first = await seeBanner(u, mon(17));
    assert.equal(first?.flashKey, `${offerlyKey(chat)}:2026-09-21`);
    const second = await banner(u, mon(17, 5));
    assert.ok(second?.flashKey.startsWith("follow_up:"));
  });

  test("with a week-overdue follow-up ahead of it, the thank-you still speaks that day", async () => {
    const u = await mkUser();
    const chat = await mkEvent(u.id);
    const [c] = await h.db.insert(contacts).values({ userId: u.id, name: "Sam Ito", relationshipStatus: "reached_out" }).returning({ id: contacts.id });
    await h.db.insert(outreachSends).values({ userId: u.id, contactId: c.id, step: 1, sentAt: plus(mon(17), -14 * DAY), source: "copy" });
    const shown = await dayOfBanners(u, mon(17));
    assert.ok(shown.some((s) => s.flashKey === `${offerlyKey(chat)}:2026-09-21`));
    // ...and filing the follow-up did not add a thank-you row, or vice versa.
    assert.equal((await jobRows(u.id)).length, 1);
  });
});

// ============================================================ idempotency

describe("doing it twice is doing it once", () => {
  test("reconcileThankYouJobs twice: the close time is the first one's", async () => {
    const u = await mkUser();
    // Jo is the whole invite list, so her note closes it.
    seedGoogle(u.id, [gEvent({
      id: "int-twice", title: "Goldman Sachs first round", startsAt: mon(10), endsAt: mon(11),
      attendeeEmails: ["jo.park@gs.com"], attendees: [{ email: "jo.park@gs.com", name: "Jo Park" }],
    })]);
    await seeBanner(u, mon(13));
    await sendThanks(u, await mkContact(u.id, "Jo Park", "jo.park@gs.com"), mon(19), "thank_you_interview");
    prime(u.id, mon(20));
    await reconcileThankYouJobs(u.id, mon(20));
    const row = await jobRow(u.id, googleKey("int-twice"));
    assert.equal(row?.doneAt?.getTime(), mon(19).getTime());
  });

  test("reconcileThankYouJobs with nothing sent closes nothing", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "interview", title: "Goldman Sachs first round", eventDate: mon(10), endDate: mon(11) });
    await seeBanner(u, mon(13));
    await reconcileThankYouJobs(u.id, mon(14));
    await reconcileThankYouJobs(u.id, mon(15));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
  });

  test("reconcileThankYouJobs never reopens a ticked job", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    await tick(u, offerlyKey(e), mon(17));
    await reconcileThankYouJobs(u.id, mon(18));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "manual");
  });

  test("reconciling twice keeps the first close", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    await sendThanks(u, c, mon(18));
    prime(u.id, mon(19));
    await reconcileThankYouJobs(u.id, mon(19));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt?.getTime(), mon(18).getTime());
  });

  test("upsert twice is one row, bumped", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    const [t] = await owed(u, mon(17));
    await upsertNotification({ userId: u.id, ...thankYouNotification(t), now: mon(17) });
    await upsertNotification({ userId: u.id, ...thankYouNotification(t), now: mon(18) });
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedupeKey, offerlyKey(e));
    assert.equal(rows[0].bumpedAt.getTime(), mon(18).getTime());
    assert.equal(rows[0].createdAt.getTime(), mon(17).getTime());
  });

  test("the same banner seen twice (two tabs racing) is one flash and one job", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    const p = await banner(u, mon(17));
    assert.ok(p);
    for (let i = 0; i < 2; i++) {
      for (const n of p.notifications) await upsertNotification({ userId: u.id, ...n, now: mon(17) });
      await markFlashShown(u.id, p.flashKey);
    }
    assert.equal((await h.db.query.flashesShown.findMany({ where: eq(flashesShown.userId, u.id) })).length, 1);
    assert.equal((await jobRows(u.id)).length, 1);
  });

  test("ticking twice keeps the first tick", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    assert.equal(await tick(u, offerlyKey(e), mon(17)), true);
    assert.equal(await tick(u, offerlyKey(e), mon(18)), false);
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt?.getTime(), mon(17).getTime());
  });

  test("a made-up key ticks nothing and files nothing", async () => {
    const u = await mkUser();
    await mkEvent(u.id);
    assert.equal(await tick(u, "thank_you:offerly:00000000-0000-0000-0000-000000000000", mon(17)), false);
    assert.equal((await jobRows(u.id)).length, 0);
  });

  test("sending the same draft twice leaves one closed job", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    const e = await mkEvent(u.id, { contactId: c });
    await seeBanner(u, mon(17));
    const d = await sendThanks(u, c, mon(18));
    await sendDraft(u, d, mon(18, 5));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedupeKey, offerlyKey(e));
    assert.equal(rows[0].doneAt?.getTime(), mon(18).getTime());
  });
});

// ============================================================ what counts

describe("what is and is not thanked for", () => {
  test("an Offerly meeting with a contact is a chat", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { type: "meeting", title: "Call", contactId: c });
    assert.equal((await owed(u, mon(17)))[0]?.occasion, "chat");
  });

  for (const type of ["personal", "info_session", "deadline"] as const) {
    test(`an Offerly ${type} entry titled 'coffee chat' is not thanked for`, async () => {
      const u = await mkUser();
      await mkEvent(u.id, { type, title: "Coffee chat" });
      assert.deepEqual(await owed(u, mon(17)), []);
    });
  }

  test("an Offerly interview titled HireVue is not thanked for", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "interview", title: "HireVue - JPMorgan", eventDate: mon(10), endDate: mon(10, 30) });
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("an Offerly interview titled 'modelling test' is not thanked for", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "interview", title: "KKR modelling test", eventDate: mon(10), endDate: mon(13) });
    assert.deepEqual(await owed(u, mon(17)), []);
  });

  test("a meeting titled 'Evercore Superday' is an interview on the superday template", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "meeting", title: "Evercore Superday", eventDate: mon(9), endDate: mon(15) });
    const [t] = await owed(u, mon(17));
    assert.equal(t?.occasion, "interview");
    assert.equal(t?.href, `/outreach?occasion=thanks&box=thanks.superday&thank=${encodeURIComponent(offerlyKey(e))}`);
  });

  test("a phone screen opens the phone-screen template", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { type: "interview", title: "Jefferies HR screen", eventDate: mon(10), endDate: mon(10, 30) });
    const [t] = await owed(u, mon(17));
    assert.equal(t?.href, `/outreach?occasion=thanks&box=thanks.screen&thank=${encodeURIComponent(offerlyKey(e))}`);
  });

  test("a nine-to-five superday entry is due at 7pm", async () => {
    const u = await mkUser();
    await mkEvent(u.id, { type: "interview", title: "Evercore Superday", eventDate: mon(9), endDate: mon(17) });
    assert.deepEqual(await owed(u, mon(18, 59)), []);
    assert.equal((await owed(u, mon(19))).length, 1);
  });

  test("an entry moved into the future is no longer owed", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id);
    assert.equal((await owed(u, mon(17))).length, 1);
    await h.db.update(events).set({ eventDate: et(2026, 9, 28, 14), endDate: et(2026, 9, 28, 14, 30) }).where(eq(events.id, e));
    assert.deepEqual(await owed(u, mon(18)), []);
  });

  test("a contact linked after the fact names them from then on", async () => {
    const u = await mkUser();
    const e = await mkEvent(u.id, { title: "Coffee chat" });
    await seeBanner(u, mon(17));
    const c = await mkContact(u.id);
    await h.db.update(events).set({ contactId: c }).where(eq(events.id, e));
    const p = await seeBanner(u, et(2026, 9, 22, 10));
    assert.equal(p?.subject, "Dana Reed");
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Thank Dana Reed");
    assert.equal(rows[0].subjectKey, `thanks:${c}`);
  });

  test("a thank-you draft that is only written, never sent, answers nothing", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    await mkDraft(u.id, c);
    assert.equal((await owed(u, mon(17))).length, 1);
  });

  test("a sent cold email to Dana is not a thank-you", async () => {
    const u = await mkUser();
    const c = await mkContact(u.id);
    await mkEvent(u.id, { contactId: c });
    const d = await mkDraft(u.id, c, "cold_outreach_default", "cold_outreach");
    await sendDraft(u, d, mon(16));
    assert.equal((await owed(u, mon(17))).length, 1);
  });
});
