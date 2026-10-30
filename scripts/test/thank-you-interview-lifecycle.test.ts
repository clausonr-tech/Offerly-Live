// The INTERVIEW thank-you, end to end, as a student lives it.
//
// An interview ends; two hours later its interviewers are owed a thank-you.
// Who they are comes from the Google invitation (bots, rooms and the student
// filtered out) plus the contact the entry names. Each note ticks one of them
// off; the prompt routes the student to the next one - a saved contact by id,
// anyone else through "Outside of your matched contacts", prefilled from the
// prompt looked up by its key. A listed interview closes itself once everyone
// is thanked. One typed into Offerly lists nobody, so after the first note it
// asks "anyone else to thank?" until the student says "That's everyone".
//
// Everything goes through the real queries over an in-memory PGlite migrated
// from drizzle/*.sql. The server actions that need a signed-in user are
// replayed step for step with the lib calls they make:
//
//   markPromptFlashSeen   -> seeBanner
//   completeThankYouPrompt ("That's everyone") -> thatsEveryone
//   completeTask (to-do tick)                  -> tickTodo
//   markDraftSent / setDraftSent(false)        -> markSent / unsend
//   the outside form (generateDraft)           -> writeOutside (resolveRecipient)
//   /outreach?thank=<key>                      -> outsidePrefill
//
// Google entries are raw API items run through parseGoogleEvent (the real bot
// and room filter) and seeded into the cache thank-you-db reads, re-primed at
// every simulated moment. NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is
// removed and fetch throws.

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
  notifications,
  todoDismissals,
  userTopFirms,
  users,
} from "@/db/schema";
import { resolveRecipient } from "@/lib/draft-recipient";
import { parseGoogleEvent } from "@/lib/google-calendar";
import { closeNotificationByKey, getNotifications, upsertNotification } from "@/lib/notifications";
import { getPendingFlash, markFlashShown, thankYouNotification } from "@/lib/prompt-flash";
import type { ChatEvent, ThankYouPrompt } from "@/lib/thank-you";
import { getThankYouPrompts, reconcileThankYouJobs, reopenOwedThankYouJobs } from "@/lib/thank-you-db";
import { zonedTime } from "@/lib/time-zone";
import { getAllTasks } from "@/lib/today-tasks";

delete process.env.DATABASE_URL;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TZ = "America/New_York";

/** An instant on the New York wall clock, September 2026. Monday is the 21st. */
const sep = (d: number, h: number, min = 0) => zonedTime(2026, 9, d, h, min, TZ);
const mon = (h: number, min = 0) => sep(21, h, min);
const tue = (h: number, min = 0) => sep(22, h, min);
const wed = (h: number, min = 0) => sep(23, h, min);
const thu = (h: number, min = 0) => sep(24, h, min);
const fri = (h: number, min = 0) => sep(25, h, min);
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
    .values({ email: `interview-${seq}-${Date.now()}@example.edu`, passwordHash: "x", name: `Alex Rivera ${seq}` })
    .returning();
  return u;
}

/** A saved contact the student already talks to (no outreach, no ladder). */
async function mkContact(userId: string, name: string, email: string | null = null): Promise<string> {
  const [c] = await h.db
    .insert(contacts)
    .values({ userId, name, email, relationshipStatus: "in_conversation" })
    .returning({ id: contacts.id });
  return c.id;
}

/** An Offerly interview, Monday 10-11am unless told otherwise: due 1pm. */
async function mkInterview(userId: string, over: Partial<typeof events.$inferInsert> = {}): Promise<string> {
  const [e] = await h.db
    .insert(events)
    .values({
      userId,
      type: "interview",
      title: "Goldman Sachs first round",
      eventDate: mon(10),
      endDate: mon(11),
      ...over,
    })
    .returning({ id: events.id });
  return e.id;
}

/** A firm on the student's list. */
async function trackFirm(userId: string, name: string, aliases: string[] = []) {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${seq}-${Date.now()}`,
      name,
      headquarters: "New York",
      keyOffices: "New York",
      website: "example.com",
      description: "A firm.",
      aliases,
    })
    .returning({ id: firms.id });
  await h.db.insert(userTopFirms).values({ userId, firmId: f.id });
  return f.id;
}

const offerlyKey = (id: string) => `thank_you:offerly:${id}`;
const googleKey = (id: string) => `thank_you:google:${id}`;

// ---- Google, as the API sends it, through the real parser and the cache

type Seed = { events: ChatEvent[]; ok: boolean };
type Cache = Map<string, { at: number; events: ChatEvent[]; ok?: boolean }>;
function googleCache(): Cache {
  const g = globalThis as { __thankYouGoogleCache?: Cache };
  g.__thankYouGoogleCache ??= new Map();
  return g.__thankYouGoogleCache;
}
const seeded = new Map<string, Seed>();
function seedGoogle(userId: string, evs: ChatEvent[], ok = true) {
  seeded.set(userId, { events: evs, ok });
}
/** A failed read: nothing listed, and flagged as not to be trusted. */
function failGoogle(userId: string) {
  seeded.set(userId, { events: [], ok: false });
}
function prime(userId: string, now: Date) {
  const s = seeded.get(userId);
  if (s) googleCache().set(userId, { at: now.getTime(), events: s.events, ok: s.ok });
}

type RawAttendee = { email: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string };

/** One Google API item, parsed exactly as thank-you-db's read maps it. */
function google(o: {
  id: string;
  title: string;
  start: Date;
  end: Date | null;
  attendees?: RawAttendee[];
  allDayDates?: [string, string];
}): ChatEvent {
  const raw = {
    id: o.id,
    summary: o.title,
    htmlLink: "https://calendar.google.com/x",
    start: o.allDayDates ? { date: o.allDayDates[0] } : { dateTime: o.start.toISOString() },
    end: o.allDayDates ? { date: o.allDayDates[1] } : o.end ? { dateTime: o.end.toISOString() } : undefined,
    attendees: [{ email: "kai.clauson@gmail.com", self: true, responseStatus: "accepted" }, ...(o.attendees ?? [])],
  };
  const e = parseGoogleEvent(raw, { id: "primary", title: "Kai" });
  assert.ok(e);
  return {
    sourceKey: `google:${e.id}`,
    title: e.title,
    startsAt: new Date(e.start),
    endsAt: e.end ? new Date(e.end) : null,
    allDay: e.allDay,
    notes: e.notes,
    videoCall: e.videoCall,
    attendeeEmails: e.attendeeEmails,
    attendees: e.attendees,
    declined: e.declined,
    recurring: e.recurring,
    eventType: e.eventType,
  };
}

const JO = { email: "Jo.Park@gs.com", displayName: "Jo Park" };
const SAM = { email: "sam.ito@gs.com", displayName: "Sam Ito" };
const LEE = { email: "LEE.CHEN@gs.com", displayName: "Lee Chen" };
const BOTS: RawAttendee[] = [
  { email: "noreply@gs.com" },
  { email: "nyc-conf-12@resource.calendar.google.com", resource: true },
  { email: "scheduling@goodtime.io" },
];

// ---- what the student sees, at a moment

async function owed(u: User, now: Date): Promise<ThankYouPrompt[]> {
  prime(u.id, now);
  return getThankYouPrompts(u.id, now);
}
async function prompt(u: User, key: string, now: Date): Promise<ThankYouPrompt | undefined> {
  return (await owed(u, now)).find((t) => t.key === key);
}

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

/** Every banner one page load after another shows today, until silence. */
async function dayOfBanners(u: User, now: Date) {
  const shown = [];
  for (let i = 0; i < 12; i++) {
    const p = await seeBanner(u, now);
    if (!p) break;
    shown.push(p);
  }
  return shown;
}

/** The banner for this key today, seen - or null if another spoke or none did. */
async function seeBannerFor(u: User, key: string, now: Date) {
  const shown = await dayOfBanners(u, now);
  return shown.find((s) => s.flashKey.startsWith(`${key}:`)) ?? null;
}

/** completeThankYouPrompt ("That's everyone"), step for step. */
async function thatsEveryone(u: User, key: string, now: Date): Promise<boolean> {
  const t = await prompt(u, key, now);
  if (!t) return false;
  await upsertNotification({ userId: u.id, ...thankYouNotification(t), now });
  await closeNotificationByKey(u.id, t.key, "manual", now);
  return true;
}

/** completeTask on a thank-you row, step for step. */
async function tickTodo(u: User, key: string, now: Date): Promise<boolean> {
  prime(u.id, now);
  const task = (await getAllTasks(u, now)).find((t) => t.id === `thanks-${key}`);
  if (!task) return false;
  assert.equal(task.doneKey, key);
  await thatsEveryone(u, task.doneKey, now);
  await h.db.insert(todoDismissals).values({ userId: u.id, taskId: task.id }).onConflictDoNothing();
  return true;
}

async function todo(u: User, now: Date) {
  prime(u.id, now);
  return (await getAllTasks(u, now)).filter((t) => t.kind === "thank_you");
}

/** /outreach?thank=<key>: who the outside form is prefilled with, if anyone. */
async function outsidePrefill(u: User, href: string, now: Date) {
  const key = new URL(href, "https://offerly.test").searchParams.get("thank");
  if (!key) return undefined;
  const p = (await owed(u, now)).find((t) => t.key === key) ?? null;
  return p && !p.next.contactId ? { name: p.next.name, email: p.next.email, firm: p.next.firm } : undefined;
}

/** The outside form, submitted: the person saved as a contact, as generateDraft does. */
async function writeOutside(u: User, fields: { name: string | null; email: string | null; firm: string | null }) {
  const fd = new FormData();
  fd.set("outsideName", fields.name ?? "");
  fd.set("outsideFirm", fields.firm ?? "");
  fd.set("outsideEmail", fields.email ?? "");
  const r = await resolveRecipient(u.id, "outside", fd);
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  return r.contact.id;
}

async function mkDraft(userId: string, contactId: string, templateId: string, kind: "thank_you" | "cold_outreach" = "thank_you") {
  const [d] = await h.db
    .insert(emailDrafts)
    .values({ userId, contactId, kind, templateId, subject: "Thank you", body: "Thank you for your time today." })
    .returning({ id: emailDrafts.id });
  return d.id;
}

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** markDraftSent, the parts that touch thank-yous: first sentAt kept, the To
 *  line fills a missing address, then every job it answered closes. */
async function markSent(u: User, draftId: string, at: Date, to = "") {
  const draft = await h.db.query.emailDrafts.findFirst({
    where: eq(emailDrafts.id, draftId),
    with: { contact: { columns: { id: true, email: true } } },
  });
  assert.ok(draft);
  await h.db.update(emailDrafts).set({ sentAt: draft.sentAt ?? at, updatedAt: at }).where(eq(emailDrafts.id, draftId));
  if (draft.contact && !draft.contact.email && EMAIL.test(to.trim())) {
    await h.db.update(contacts).set({ email: to.trim() }).where(eq(contacts.id, draft.contact.id));
  }
  if (draft.kind === "thank_you") {
    prime(u.id, at);
    await reconcileThankYouJobs(u.id, at);
  }
}

/** Write and send one note. */
async function sendNote(
  u: User,
  contactId: string,
  at: Date,
  opts: { template?: string; kind?: "thank_you" | "cold_outreach"; to?: string } = {},
) {
  const d = await mkDraft(u.id, contactId, opts.template ?? "thank_you_interview", opts.kind);
  await markSent(u, d, at, opts.to);
  return d;
}

/** Follow the prompt's own link: to the saved contact, or through the outside
 *  form prefilled from the key. Returns the draft sent. */
async function thankNext(u: User, key: string, at: Date, template = "thank_you_interview") {
  const t = await prompt(u, key, at);
  assert.ok(t, `${key} is owed at ${at.toISOString()}`);
  let contactId = t.next.contactId;
  if (!contactId) {
    const pre = await outsidePrefill(u, t.href, at);
    assert.ok(pre, "the outside form is prefilled");
    // Whatever the prompt could not fill, the student types.
    seq += 1;
    contactId = await writeOutside(u, {
      name: pre.name ?? `Pat Doe ${seq}`,
      email: pre.email ?? `pat.doe.${seq}@example.com`,
      firm: pre.firm ?? "Goldman Sachs",
    });
  }
  return sendNote(u, contactId, at, { template });
}

/** setDraftSent(false), step for step. */
async function unsend(u: User, draftId: string, now: Date) {
  await h.db.update(emailDrafts).set({ sentAt: null, updatedAt: now }).where(eq(emailDrafts.id, draftId));
  prime(u.id, now);
  await reopenOwedThankYouJobs(u.id, now);
}

async function openJobs(u: User, now: Date) {
  prime(u.id, now);
  return (await getNotifications(u.id, now)).open.filter((n) => n.kind === "thank_you");
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

const outsideHref = (box: string, key: string) =>
  `/outreach?occasion=thanks&box=${box}&thank=${encodeURIComponent(key)}`;
const contactHref = (id: string, box: string) => `/outreach?contact=${id}&occasion=thanks&box=${box}`;

// ---- the three-person Goldman panel every journey below starts from

type Panel = { u: User; key: string; lee: string };

/** Goldman Sachs first round, Monday 10-11am on Google: Jo Park, Sam Ito and
 *  Lee Chen (a saved contact) invited, plus a no-reply sender, a room and a
 *  scheduling bot. Goldman Sachs is on the student's list. */
async function panel(opts: { track?: boolean } = {}): Promise<Panel> {
  const u = await mkUser();
  if (opts.track !== false) await trackFirm(u.id, "Goldman Sachs");
  const lee = await mkContact(u.id, "Lee Chen", "lee.chen@gs.com");
  seedGoogle(u.id, [
    google({ id: `gs-r1-${seq}`, title: "Goldman Sachs first round", start: mon(10), end: mon(11), attendees: [JO, SAM, LEE, ...BOTS] }),
  ]);
  return { u, key: googleKey(`gs-r1-${seq}`), lee };
}

// ================================================= a three-person Google panel

describe("a three-person Google panel: who is on it", () => {
  test("bots, rooms and the student are not interviewers", async () => {
    const { u, key } = await panel();
    const t = await prompt(u, key, mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.email), ["jo.park@gs.com", "sam.ito@gs.com", "lee.chen@gs.com"]);
  });

  test("the invitation's names are kept", async () => {
    const { u, key } = await panel();
    const t = await prompt(u, key, mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.name), ["Jo Park", "Sam Ito", "Lee Chen"]);
  });

  test("Lee is recognised as a saved contact whatever the address's case", async () => {
    const { u, key, lee } = await panel();
    const t = await prompt(u, key, mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.contactId), [null, null, lee]);
  });

  test("nobody is thanked yet and no notes are counted", async () => {
    const { u, key } = await panel();
    const t = await prompt(u, key, mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.thanked), [false, false, false]);
    assert.equal(t?.notesSent, 0);
  });

  test("it is an interview on the interview template", async () => {
    const { u, key } = await panel();
    const t = await prompt(u, key, mon(13));
    assert.equal(t?.occasion, "interview");
    assert.ok(t?.href.includes("box=thanks.interview"));
  });

  test("not owed during the interview or in the two hours after", async () => {
    const { u } = await panel();
    assert.deepEqual(await owed(u, mon(10, 30)), []);
    assert.deepEqual(await owed(u, mon(12, 59)), []);
  });

  test("owed from exactly two hours after it ends", async () => {
    const { u, key } = await panel();
    assert.equal((await owed(u, mon(13))).map((t) => t.key).join(), key);
  });

  test("a panel is 'Thank your interviewers', even with Lee a saved contact", async () => {
    const { u } = await panel();
    const [row] = await todo(u, mon(13));
    assert.equal(row.title, "Thank your interviewers");
  });

  test("a declined interviewer was not in the room and is not on the list", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [google({
      id: "declined-1", title: "Goldman Sachs first round", start: mon(10), end: mon(11),
      attendees: [JO, { ...SAM, responseStatus: "declined" }, LEE],
    })]);
    const t = await prompt(u, googleKey("declined-1"), mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.email), ["jo.park@gs.com", "lee.chen@gs.com"]);
  });

  test("the student's own school address on the invitation is not an interviewer", async () => {
    // The invitation went to their school address and was added to the Gmail
    // calendar they connected, so that address is not flagged `self`.
    const u = await mkUser();
    seedGoogle(u.id, [google({
      id: "own-addr", title: "Goldman Sachs first round", start: mon(10), end: mon(11),
      attendees: [{ email: u.email }, JO],
    })]);
    const t = await prompt(u, googleKey("own-addr"), mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.email), ["jo.park@gs.com"]);
  });

  for (const bot of ["no-reply@hirevue-mail.com", "calendar@evercore.com", "kai-bot@gs.com", "x@calendly.com", "x@zoom.us", "abc@group.calendar.google.com"]) {
    test(`${bot} is filtered off the list`, async () => {
      const u = await mkUser();
      seedGoogle(u.id, [google({ id: `bot-${bot}`, title: "Goldman Sachs first round", start: mon(10), end: mon(11), attendees: [JO, { email: bot }] })]);
      const t = await prompt(u, googleKey(`bot-${bot}`), mon(13));
      assert.deepEqual(t?.interviewers.map((i) => i.email), ["jo.park@gs.com"]);
    });
  }
});

describe("a three-person Google panel, day by day", () => {
  test("Monday: the banner asks to thank them while it is fresh", async () => {
    const { u, key } = await panel();
    const p = await seeBannerFor(u, key, mon(13));
    assert.ok(p);
    assert.equal(p.chip, "thank-you");
    assert.equal(p.subject, "Goldman Sachs first round");
    assert.equal(p.detail, "thank your interviewers while it is fresh");
    assert.equal(p.cta, "Write it");
    assert.equal(p.doneKey, undefined, "no 'That's everyone' before any note");
  });

  test("Monday: Write it opens the outside form for Jo, the first unthanked", async () => {
    const { u, key } = await panel();
    const t = await prompt(u, key, mon(13));
    assert.equal(t?.href, outsideHref("thanks.interview", key));
    assert.deepEqual(await outsidePrefill(u, t!.href, mon(13)), { name: "Jo Park", email: "jo.park@gs.com", firm: "Goldman Sachs" });
  });

  test("Monday: with Goldman not on their list, the firm is left for them to type", async () => {
    const { u, key } = await panel({ track: false });
    const t = await prompt(u, key, mon(13));
    assert.deepEqual(await outsidePrefill(u, t!.href, mon(13)), { name: "Jo Park", email: "jo.park@gs.com", firm: null });
  });

  test("Monday: the bell gets one row, dated by the student's calendar", async () => {
    const { u, key, lee } = await panel();
    await seeBannerFor(u, key, mon(13));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Thank your interviewers");
    assert.equal(rows[0].body, "After “Goldman Sachs first round” · 21 Sep");
    // Lee, the invited saved contact, is who the entry is "with".
    assert.equal(rows[0].subjectKey, `thanks:${lee}`);
  });

  test("Monday: the to-do row says today", async () => {
    const { u, key } = await panel();
    const [row] = await todo(u, mon(13));
    assert.equal(row.detail, "Goldman Sachs first round · today");
    assert.equal(row.doneKey, key);
  });

  test("Monday: shown once - silent for the rest of the day", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    assert.equal(await banner(u, mon(13, 5)), null);
    assert.equal(await banner(u, mon(23, 59)), null);
  });

  test("Monday evening: the note to Jo through the outside form ticks Jo off", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    const t = await prompt(u, key, mon(19, 5));
    assert.deepEqual(t?.interviewers.map((i) => i.thanked), [true, false, false]);
    assert.equal(t?.notesSent, 1);
  });

  test("Monday evening: the outside form saved Jo with the invitation's address", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    const jo = await h.db.query.contacts.findFirst({ where: and(eq(contacts.userId, u.id), eq(contacts.name, "Jo Park")) });
    assert.equal(jo?.email, "jo.park@gs.com");
    assert.equal(jo?.firm, "Goldman Sachs");
  });

  test("Monday evening: the send leaves the bell's job open - two are still owed", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    assert.equal((await jobRow(u.id, key))?.doneAt, null);
    assert.equal((await openJobs(u, mon(20))).length, 1);
  });

  test("Monday evening: no second banner that day", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    assert.equal(await banner(u, mon(20)), null);
  });

  test("Tuesday: the banner says 1 of 3, and offers 'That's everyone'", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    const p = await seeBannerFor(u, key, tue(9));
    assert.ok(p);
    assert.equal(p.chip, "thank-you · yesterday");
    assert.equal(p.detail, "1 of 3 thanked · anyone else to thank?");
    assert.equal(p.cta, "Write the next");
    assert.equal(p.doneKey, key);
    assert.equal(p.doneLabel, "That's everyone");
    assert.equal(p.flashKey, `${key}:2026-09-22`);
  });

  test("Tuesday: Write the next goes to Sam, prefilled", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    const t = await prompt(u, key, tue(9));
    assert.equal(t?.href, outsideHref("thanks.interview", key));
    assert.deepEqual(await outsidePrefill(u, t!.href, tue(9)), { name: "Sam Ito", email: "sam.ito@gs.com", firm: "Goldman Sachs" });
  });

  test("Tuesday: the bell row's body is rewritten with the progress, still one row, unread again", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await h.db.update(notifications).set({ readAt: mon(14) }).where(eq(notifications.userId, u.id));
    await thankNext(u, key, mon(19));
    await seeBannerFor(u, key, tue(9));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "After “Goldman Sachs first round” · 21 Sep · 1 of 3 thanked");
    assert.equal(rows[0].readAt, null);
    assert.equal(rows[0].bumpedAt.getTime(), tue(9).getTime());
  });

  test("Tuesday: the to-do row carries the progress", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    const [row] = await todo(u, tue(9));
    assert.equal(row.detail, "Goldman Sachs first round · 1d ago · 1 of 3 thanked");
    assert.equal(row.title, "Thank your interviewers");
  });

  test("Tuesday evening: Sam's note makes it 2 of 3", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    await thankNext(u, key, tue(19));
    const t = await prompt(u, key, tue(20));
    assert.deepEqual(t?.interviewers.map((i) => i.thanked), [true, true, false]);
    assert.equal(t?.notesSent, 2);
  });

  test("Wednesday: the banner says 2 of 3, two days on", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await seeBannerFor(u, key, tue(9));
    await thankNext(u, key, tue(19));
    const p = await seeBannerFor(u, key, wed(9));
    assert.equal(p?.chip, "thank-you · 2 days");
    assert.equal(p?.detail, "2 of 3 thanked · anyone else to thank?");
  });

  test("Wednesday: the next is Lee, a saved contact - the drafter opens on him", async () => {
    const { u, key, lee } = await panel();
    await thankNext(u, key, mon(19));
    await thankNext(u, key, tue(19));
    const t = await prompt(u, key, wed(9));
    assert.equal(t?.href, contactHref(lee, "thanks.interview"));
    assert.deepEqual(t?.next, { contactId: lee, name: "Lee Chen", email: "lee.chen@gs.com", firm: null });
  });

  test("Wednesday: Lee's link carries no key, so nothing is prefilled outside", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    await thankNext(u, key, tue(19));
    const t = await prompt(u, key, wed(9));
    assert.equal(await outsidePrefill(u, t!.href, wed(9)), undefined);
    // ...and even with the key typed in by hand, a saved contact is not "outside".
    assert.equal(await outsidePrefill(u, outsideHref("thanks.interview", key), wed(9)), undefined);
  });

  test("Wednesday: the bell body says 2 of 3 and points at Lee", async () => {
    const { u, key, lee } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await thankNext(u, key, tue(19));
    await seeBannerFor(u, key, wed(9));
    const row = await jobRow(u.id, key);
    assert.equal(row?.body, "After “Goldman Sachs first round” · 21 Sep · 2 of 3 thanked");
    assert.equal(row?.href, contactHref(lee, "thanks.interview"));
  });

  test("Wednesday evening: Lee's note closes the job by itself, at the send", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await thankNext(u, key, tue(19));
    await thankNext(u, key, wed(19));
    const row = await jobRow(u.id, key);
    assert.equal(row?.doneSource, "auto");
    assert.equal(row?.doneAt?.getTime(), wed(19).getTime());
  });

  test("Thursday: nothing owed, no banner, no to-do row, nothing on the bell", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    for (const at of [mon(19), tue(19), wed(19)]) await thankNext(u, key, at);
    assert.deepEqual(await owed(u, thu(9)), []);
    assert.equal(await banner(u, thu(9)), null);
    assert.deepEqual(await todo(u, thu(9)), []);
    assert.deepEqual(await openJobs(u, thu(9)), []);
  });

  test("five days of banners and three notes leave exactly one closed row", async () => {
    const { u, key } = await panel();
    const notes = [mon(19), tue(19), wed(19)];
    for (const [i, day] of [mon(13), tue(9), wed(9), thu(9), fri(9)].entries()) {
      await dayOfBanners(u, day);
      if (notes[i]) await thankNext(u, key, notes[i]);
    }
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].doneSource, "auto");
  });

  test("banners come on each of the first three days only", async () => {
    const { u, key } = await panel();
    const spoke: string[] = [];
    const notes = [mon(19), tue(19), wed(19)];
    for (const [i, day] of [mon(13), tue(9), wed(9), thu(9), fri(9)].entries()) {
      const p = await seeBannerFor(u, key, day);
      if (p) spoke.push(p.flashKey.slice(key.length + 1));
      if (notes[i]) await thankNext(u, key, notes[i]);
    }
    assert.deepEqual(spoke, ["2026-09-21", "2026-09-22", "2026-09-23"]);
  });

  test("with no notes at all, five days of banners, each day's detail says still owed", async () => {
    const { u, key } = await panel();
    const details = [];
    for (const day of [mon(13), tue(9), wed(9), thu(9), fri(9)]) details.push((await seeBannerFor(u, key, day))?.detail);
    assert.deepEqual(details, [
      "thank your interviewers while it is fresh",
      "your interviewers are still owed a thank-you",
      "your interviewers are still owed a thank-you",
      "your interviewers are still owed a thank-you",
      "your interviewers are still owed a thank-you",
    ]);
  });

  test("all three thanked the same evening: closed that night, no Tuesday banner", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await thankNext(u, key, mon(19, 10));
    await thankNext(u, key, mon(19, 20));
    assert.equal((await jobRow(u.id, key))?.doneSource, "auto");
    assert.equal(await banner(u, tue(9)), null);
  });

  test("thanked out of order - Lee first - the next is Jo", async () => {
    const { u, key, lee } = await panel();
    await sendNote(u, lee, mon(19));
    const t = await prompt(u, key, tue(9));
    assert.equal(t?.next.name, "Jo Park");
    assert.equal(await progressOf(u, key, tue(9)), "1 of 3 thanked");
  });

  test("a note to Jo from a contact saved without an address: the To line fills it and ticks Jo off", async () => {
    const { u, key } = await panel();
    const jo = await mkContact(u.id, "Jo Park");
    await sendNote(u, jo, mon(19), { to: "jo.park@gs.com" });
    const t = await prompt(u, key, mon(20));
    assert.equal(t?.interviewers[0].thanked, true);
    assert.equal(t?.next.name, "Sam Ito");
  });

  test("a chat-template thank-you to Sam still thanks Sam", async () => {
    const { u, key } = await panel();
    const sam = await mkContact(u.id, "Sam Ito", "sam.ito@gs.com");
    await sendNote(u, sam, mon(19), { template: "thank_you_chat" });
    assert.deepEqual((await prompt(u, key, mon(20)))?.interviewers.map((i) => i.thanked), [false, true, false]);
  });

  test("a cold email to Sam is not a thank-you", async () => {
    const { u, key } = await panel();
    const sam = await mkContact(u.id, "Sam Ito", "sam.ito@gs.com");
    await sendNote(u, sam, mon(19), { kind: "cold_outreach", template: "cold_email" });
    const t = await prompt(u, key, mon(20));
    assert.equal(t?.notesSent, 0);
    assert.deepEqual(t?.interviewers.map((i) => i.thanked), [false, false, false]);
  });

  test("a thank-you to Sam written but never sent does not count", async () => {
    const { u, key } = await panel();
    const sam = await mkContact(u.id, "Sam Ito", "sam.ito@gs.com");
    await mkDraft(u.id, sam, "thank_you_interview");
    assert.equal((await prompt(u, key, mon(20)))?.notesSent, 0);
  });

  test("a second note to Jo is still one person thanked", async () => {
    // Two drafts to Jo, both marked sent (a redraft, or a second note after a
    // call). Jo is one of three; Sam and Lee are still owed.
    const { u, key } = await panel();
    const jo = await mkContact(u.id, "Jo Park", "jo.park@gs.com");
    await sendNote(u, jo, mon(19));
    await sendNote(u, jo, mon(21));
    const t = await prompt(u, key, tue(9));
    assert.equal(await progressOf(u, key, tue(9)), "1 of 3 thanked");
    assert.equal(t?.next.name, "Sam Ito");
  });

  test("three notes to Jo do not close a panel of three", async () => {
    const { u, key } = await panel();
    const jo = await mkContact(u.id, "Jo Park", "jo.park@gs.com");
    for (const at of [mon(19), mon(20), mon(21)]) await sendNote(u, jo, at);
    assert.ok(await prompt(u, key, tue(9)), "Sam and Lee were never thanked");
    assert.equal((await jobRow(u.id, key))?.doneAt ?? null, null);
  });

  test("an interview note that reached nobody on the list counts towards the total", async () => {
    // Written to someone saved with no address: matched by time, not person.
    const { u, key } = await panel();
    const someone = await mkContact(u.id, "Pat Doe");
    await sendNote(u, someone, mon(19));
    const t = await prompt(u, key, mon(20));
    assert.equal(t?.notesSent, 1);
    assert.equal(await progressOf(u, key, mon(20)), "1 of 3 thanked");
  });

  test("one named note and two unmatched notes: three notes for three people closes it", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    await sendNote(u, await mkContact(u.id, "Pat Doe"), mon(19, 10));
    await sendNote(u, await mkContact(u.id, "Chris Roe"), mon(19, 20));
    assert.equal((await prompt(u, key, mon(20))), undefined);
  });

  test("a chat-template note to someone not on the list does not count", async () => {
    const { u, key } = await panel();
    await sendNote(u, await mkContact(u.id, "Pat Doe"), mon(19), { template: "thank_you_chat" });
    assert.equal((await prompt(u, key, mon(20)))?.notesSent, 0);
  });

  test("'That's everyone' from Tuesday's banner closes it with Lee unthanked", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    const p = await seeBannerFor(u, key, tue(9));
    assert.ok(await thatsEveryone(u, p!.doneKey!, tue(9, 1)));
    const row = await jobRow(u.id, key);
    assert.equal(row?.doneSource, "manual");
    assert.deepEqual(await owed(u, tue(10)), []);
    assert.equal(await banner(u, wed(9)), null);
  });

  test("after 'That's everyone', a later note to Lee does not reopen it", async () => {
    const { u, key, lee } = await panel();
    await thankNext(u, key, mon(19));
    await thatsEveryone(u, key, tue(9));
    await sendNote(u, lee, tue(19));
    const row = await jobRow(u.id, key);
    assert.equal(row?.doneSource, "manual");
    assert.equal(row?.doneAt?.getTime(), tue(9).getTime());
  });
});

/** The progress the student reads on the to-do row ("1 of 3 thanked",
 *  "2 notes sent"), or null before the first note. */
async function progressOf(u: User, key: string, now: Date): Promise<string | null> {
  const row = (await todo(u, now)).find((r) => r.doneKey === key);
  assert.ok(row, `${key} is on the to-do list at ${now.toISOString()}`);
  const last = row.detail.split(" · ").pop()!;
  return /(?:thanked|sent)$/.test(last) ? last : null;
}

// ==================================================== an Offerly interview, no list

describe("an Offerly interview lists nobody", () => {
  test("owed with no interviewers and nobody to route to", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    const t = await prompt(u, offerlyKey(e), mon(13));
    assert.deepEqual(t?.interviewers, []);
    assert.deepEqual(t?.next, { contactId: null, name: null, email: null, firm: null });
  });

  test("Write it opens the outside form with only the firm filled in", async () => {
    const u = await mkUser();
    await trackFirm(u.id, "Goldman Sachs");
    const e = await mkInterview(u.id);
    const t = await prompt(u, offerlyKey(e), mon(13));
    assert.equal(t?.href, outsideHref("thanks.interview", offerlyKey(e)));
    assert.deepEqual(await outsidePrefill(u, t!.href, mon(13)), { name: null, email: null, firm: "Goldman Sachs" });
  });

  test("an untracked firm leaves the form blank", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    assert.deepEqual(await outsidePrefill(u, outsideHref("thanks.interview", offerlyKey(e)), mon(13)), { name: null, email: null, firm: null });
  });

  test("the longest tracked name in the title wins", async () => {
    const u = await mkUser();
    await trackFirm(u.id, "Evercore");
    await trackFirm(u.id, "Evercore ISI");
    const e = await mkInterview(u.id, { title: "Evercore ISI first round" });
    const t = await prompt(u, offerlyKey(e), mon(13));
    assert.equal(t?.next.firm, "Evercore ISI");
  });

  test("'Goldman first round' prefills Goldman Sachs, known by its alias", async () => {
    const u = await mkUser();
    await trackFirm(u.id, "Goldman Sachs", ["Goldman", "GS"]);
    const e = await mkInterview(u.id, { title: "Goldman first round" });
    const t = await prompt(u, offerlyKey(e), mon(13));
    assert.equal(t?.next.firm, "Goldman Sachs");
  });

  test("the first banner has no 'That's everyone'", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    const p = await seeBannerFor(u, offerlyKey(e), mon(13));
    assert.equal(p?.detail, "thank your interviewers while it is fresh");
    assert.equal(p?.doneKey, undefined);
  });

  test("the first note moves it to '1 note sent' - still owed", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    const t = await prompt(u, offerlyKey(e), mon(20));
    assert.equal(t?.notesSent, 1);
    assert.equal(await progressOf(u, offerlyKey(e), mon(20)), "1 note sent");
  });

  test("the send leaves the bell's job open", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await seeBannerFor(u, offerlyKey(e), mon(13));
    await thankNext(u, offerlyKey(e), mon(19));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt, null);
    assert.equal((await openJobs(u, mon(20))).length, 1);
  });

  test("next morning: '1 note sent · anyone else to thank?', Write the next, That's everyone", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await seeBannerFor(u, offerlyKey(e), mon(13));
    await thankNext(u, offerlyKey(e), mon(19));
    const p = await seeBannerFor(u, offerlyKey(e), tue(9));
    assert.equal(p?.detail, "1 note sent · anyone else to thank?");
    assert.equal(p?.cta, "Write the next");
    assert.equal(p?.doneKey, offerlyKey(e));
    assert.equal(p?.doneLabel, "That's everyone");
  });

  test("the next note still opens the outside form, still only the firm", async () => {
    const u = await mkUser();
    await trackFirm(u.id, "Goldman Sachs");
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    const t = await prompt(u, offerlyKey(e), tue(9));
    assert.deepEqual(await outsidePrefill(u, t!.href, tue(9)), { name: null, email: null, firm: "Goldman Sachs" });
  });

  test("a second note: '2 notes sent'", async () => {
    const u = await mkUser();
    await trackFirm(u.id, "Goldman Sachs");
    const e = await mkInterview(u.id);
    await sendNote(u, await writeOutside(u, { name: "Jo Park", email: "jo@gs.com", firm: "Goldman Sachs" }), mon(19));
    await sendNote(u, await writeOutside(u, { name: "Sam Ito", email: "sam@gs.com", firm: "Goldman Sachs" }), mon(19, 10));
    const p = await seeBannerFor(u, offerlyKey(e), tue(9));
    assert.equal(p?.detail, "2 notes sent · anyone else to thank?");
  });

  test("five notes never close it by themselves", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    for (let i = 0; i < 5; i++) await sendNote(u, await mkContact(u.id, `Person ${i} ${seq}`), plus(mon(19), i * MIN));
    assert.equal((await prompt(u, offerlyKey(e), tue(9)))?.notesSent, 5);
    assert.equal((await openJobs(u, tue(9))).length, 0, "no row filed yet - no banner was shown");
  });

  test("the to-do row carries '1 note sent'", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    const [row] = await todo(u, mon(20));
    assert.equal(row.detail, "Goldman Sachs first round · today · 1 note sent");
    assert.equal(row.doneKey, offerlyKey(e));
  });

  test("the bell's body is rewritten the next day with '1 note sent'", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await seeBannerFor(u, offerlyKey(e), mon(13));
    await thankNext(u, offerlyKey(e), mon(19));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.body, "After “Goldman Sachs first round” · 21 Sep");
    await seeBannerFor(u, offerlyKey(e), tue(9));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.body, "After “Goldman Sachs first round” · 21 Sep · 1 note sent");
  });

  test("'That's everyone' from the banner closes it by hand", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    const p = await seeBannerFor(u, offerlyKey(e), tue(9));
    assert.ok(await thatsEveryone(u, p!.doneKey!, tue(9, 1)));
    const row = await jobRow(u.id, offerlyKey(e));
    assert.equal(row?.doneSource, "manual");
    assert.equal(row?.doneAt?.getTime(), tue(9, 1).getTime());
  });

  test("after 'That's everyone': no banner later that day, no to-do row, nothing owed, nothing on the bell", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    await seeBannerFor(u, offerlyKey(e), tue(9));
    await thatsEveryone(u, offerlyKey(e), tue(9, 1));
    assert.equal(await banner(u, tue(15)), null);
    assert.deepEqual(await todo(u, tue(15)), []);
    assert.deepEqual(await owed(u, tue(15)), []);
    assert.deepEqual(await openJobs(u, tue(15)), []);
  });

  test("after 'That's everyone': silent every day after", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    await thatsEveryone(u, offerlyKey(e), mon(20));
    for (const day of [tue(9), wed(9), thu(9), fri(9)]) assert.equal(await banner(u, day), null, day.toISOString());
  });

  test("'That's everyone' the same evening as the note: no Tuesday banner", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await seeBannerFor(u, offerlyKey(e), mon(13));
    await thankNext(u, offerlyKey(e), mon(19));
    await thatsEveryone(u, offerlyKey(e), mon(19, 5));
    assert.equal(await banner(u, tue(9)), null);
    assert.equal((await jobRows(u.id)).length, 1);
  });

  test("'That's everyone' from the to-do tick closes it by hand and records the tick", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    assert.ok(await tickTodo(u, offerlyKey(e), mon(20)));
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "manual");
    const ticks = await h.db.query.todoDismissals.findMany({ where: eq(todoDismissals.userId, u.id) });
    assert.deepEqual(ticks.map((t) => t.taskId), [`thanks-${offerlyKey(e)}`]);
  });

  test("the to-do tick before the banner ever dropped files the job and closes it: one row", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    await tickTodo(u, offerlyKey(e), mon(20));
    const rows = await jobRows(u.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "After “Goldman Sachs first round” · 21 Sep · 1 note sent");
    assert.equal(rows[0].doneSource, "manual");
  });

  test("the to-do tick stops the banner the same day", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    await tickTodo(u, offerlyKey(e), tue(8));
    assert.equal(await banner(u, tue(9)), null);
  });

  test("the to-do tick with no note sent (thanked outside Offerly) closes it too", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    assert.ok(await tickTodo(u, offerlyKey(e), mon(14)));
    assert.deepEqual(await owed(u, mon(15)), []);
  });

  test("'That's everyone' twice is once: the first close time stands", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    assert.equal(await thatsEveryone(u, offerlyKey(e), mon(20)), true);
    assert.equal(await thatsEveryone(u, offerlyKey(e), mon(21)), false);
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneAt?.getTime(), mon(20).getTime());
  });

  test("a note after 'That's everyone' does not bring it back", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await thankNext(u, offerlyKey(e), mon(19));
    await thatsEveryone(u, offerlyKey(e), mon(20));
    await sendNote(u, await mkContact(u.id, "Late Note"), tue(10));
    assert.deepEqual(await owed(u, tue(11)), []);
    assert.equal((await jobRow(u.id, offerlyKey(e)))?.doneSource, "manual");
  });

  test("reading the bell after each note leaves it open", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await seeBannerFor(u, offerlyKey(e), mon(13));
    for (const at of [mon(19), tue(19), wed(19)]) {
      await sendNote(u, await mkContact(u.id, `Note ${at.getTime()}`), at);
      assert.equal((await openJobs(u, plus(at, HOUR))).length, 1, at.toISOString());
    }
  });

  test("an Offerly interview linked to Dana names her and opens the drafter on her", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@gs.com");
    const e = await mkInterview(u.id, { contactId: dana });
    const t = await prompt(u, offerlyKey(e), mon(13));
    assert.equal(t?.href, contactHref(dana, "thanks.interview"));
    assert.equal((await todo(u, mon(13)))[0].title, "Thank Dana Reed");
  });

  test("an Offerly interview naming Dana in its title routes to her too", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@gs.com");
    const e = await mkInterview(u.id, { title: "Interview with Dana Reed" });
    assert.equal((await prompt(u, offerlyKey(e), mon(13)))?.next.contactId, dana);
  });

  for (const [template, box, title] of [
    ["thank_you_interview", "thanks.interview", "Goldman Sachs first round"],
    ["thank_you_superday", "thanks.superday", "Evercore superday"],
    ["thank_you_phone_screen", "thanks.screen", "Jefferies HR screen"],
  ] as const) {
    test(`'${title}' opens ${box}, and a ${template} note counts for it`, async () => {
      const u = await mkUser();
      const e = await mkInterview(u.id, { title });
      assert.equal((await prompt(u, offerlyKey(e), mon(13)))?.href, outsideHref(box, offerlyKey(e)));
      await sendNote(u, await mkContact(u.id, "Someone New"), mon(19), { template });
      assert.equal((await prompt(u, offerlyKey(e), mon(20)))?.notesSent, 1);
    });
  }

  for (const template of ["thank_you_chat", "thank_you_event", "thank_you_hirevue"]) {
    test(`a ${template} note to a stranger does not count for an interview`, async () => {
      const u = await mkUser();
      const e = await mkInterview(u.id);
      await sendNote(u, await mkContact(u.id, "Someone New"), mon(19), { template });
      assert.equal((await prompt(u, offerlyKey(e), mon(20)))?.notesSent, 0);
    });
  }
});

// ======================================== the Offerly entry and the invitation

describe("the interview logged in Offerly and also on the Google invitation", () => {
  test("one prompt, not two", async () => {
    const u = await mkUser();
    await mkInterview(u.id);
    seedGoogle(u.id, [google({ id: "dup-inv", title: "Interview: Goldman Sachs", start: mon(10), end: mon(11), attendees: [JO, SAM, LEE] })]);
    assert.equal((await owed(u, mon(13))).length, 1);
  });

  test("the invitation's panel is not lost: the Offerly entry thanks Jo, Sam and Lee", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    seedGoogle(u.id, [google({ id: "dup-inv2", title: "Interview: Goldman Sachs", start: mon(10), end: mon(11), attendees: [JO, SAM, LEE] })]);
    const [t] = await owed(u, mon(13));
    assert.equal(t?.key, offerlyKey(e));
    assert.deepEqual(t?.interviewers.map((i) => i.email), ["jo.park@gs.com", "sam.ito@gs.com", "lee.chen@gs.com"]);
  });
});

describe("the invitation merged onto the Offerly entry", () => {
  test("the merged panel closes by itself once everyone on the invite is thanked", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    seedGoogle(u.id, [google({ id: "merge-close", title: "Interview: Goldman Sachs", start: mon(10), end: mon(11), attendees: [JO, SAM] })]);
    await seeBannerFor(u, e, mon(13));
    await thankNext(u, e, mon(19));
    await thankNext(u, e, mon(19, 10));
    assert.equal((await jobRow(u.id, e))?.doneSource, "auto");
  });

  test("an entry linked to Dana plus the invite's Jo: both are on the list, Dana first", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@gs.com");
    const e = offerlyKey(await mkInterview(u.id, { contactId: dana }));
    seedGoogle(u.id, [google({ id: "merge-dana", title: "Interview: Goldman Sachs", start: mon(10), end: mon(11), attendees: [JO] })]);
    const t = await prompt(u, e, mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.name), ["Dana Reed", "Jo Park"]);
  });

  test("an invitation at another tracked firm in the same slot is its own interview", async () => {
    const u = await mkUser();
    await trackFirm(u.id, "Goldman Sachs");
    await trackFirm(u.id, "Evercore");
    await mkInterview(u.id);
    seedGoogle(u.id, [google({ id: "merge-other", title: "Evercore first round", start: mon(10, 15), end: mon(11), attendees: [SAM] })]);
    assert.equal((await owed(u, mon(13))).length, 2);
  });

  test("a superday of 30-minute rounds: each round gets its own interviewer", async () => {
    // Four back-to-back rounds logged in Offerly, and the four invitations
    // the firm sent, one interviewer each, at the same times.
    const u = await mkUser();
    const keys: string[] = [];
    for (let i = 0; i < 4; i++) {
      keys.push(offerlyKey(await mkInterview(u.id, {
        title: `Evercore Superday round ${i + 1}`, eventDate: plus(mon(9), i * 30 * MIN), endDate: plus(mon(9), (i + 1) * 30 * MIN),
      })));
    }
    seedGoogle(u.id, ["a", "b", "c", "d"].map((x, i) => google({
      id: `sd30-${x}`, title: `Evercore Superday round ${i + 1}`, start: plus(mon(9), i * 30 * MIN), end: plus(mon(9), (i + 1) * 30 * MIN),
      attendees: [{ email: `${x}@evercore.com`, displayName: `Person ${x.toUpperCase()}` }],
    })));
    const t = await owed(u, mon(14));
    assert.deepEqual(
      keys.map((k) => t.find((x) => x.key === k)?.interviewers.map((i) => i.email)),
      [["a@evercore.com"], ["b@evercore.com"], ["c@evercore.com"], ["d@evercore.com"]],
    );
  });

  test("a Google outage does not bring back a merged interview everyone was thanked for", async () => {
    // The panel came from the invitation. With Google down the invitation is
    // missing, so the Offerly entry is back to "no list" - but nothing new has
    // happened: the finished thank-you must not prompt again.
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    seedGoogle(u.id, [google({ id: "merge-outage", title: "Interview: Goldman Sachs", start: mon(10), end: mon(11), attendees: [JO, SAM] })]);
    await seeBannerFor(u, e, mon(13));
    await thankNext(u, e, mon(19));
    await thankNext(u, e, mon(19, 10));
    assert.equal((await jobRow(u.id, e))?.doneSource, "auto");
    failGoogle(u.id);
    assert.equal(await banner(u, tue(9)), null, "no banner for a finished thank-you");
    assert.deepEqual(await todo(u, tue(9)), [], "no to-do row either");
  });
});

// ================================================ superday as four entries

describe("a superday booked as four entries", () => {
  async function superday(u: User) {
    const keys: string[] = [];
    for (let i = 0; i < 4; i++) {
      keys.push(offerlyKey(await mkInterview(u.id, {
        title: `Evercore Superday interview ${i + 1}`, eventDate: mon(9 + i), endDate: mon(9 + i, 45),
      })));
    }
    return keys;
  }

  test("four owed, each on the superday template, oldest first", async () => {
    const u = await mkUser();
    const keys = await superday(u);
    const t = await owed(u, mon(15));
    assert.deepEqual(t.map((x) => x.key), keys);
    assert.ok(t.every((x) => x.href.includes("box=thanks.superday")));
  });

  test("each is owed two hours after its own round", async () => {
    const u = await mkUser();
    const keys = await superday(u);
    // Round 1 ends 9:45 (due 11:45), round 2 ends 10:45 (due 12:45).
    assert.deepEqual((await owed(u, mon(12))).map((x) => x.key), keys.slice(0, 1));
    assert.deepEqual((await owed(u, mon(12, 45))).map((x) => x.key), keys.slice(0, 2));
  });

  test("four banners that afternoon, in the order they happened, then silence", async () => {
    const u = await mkUser();
    const keys = await superday(u);
    const shown = await dayOfBanners(u, mon(15));
    assert.deepEqual(shown.map((s) => s.flashKey), keys.map((k) => `${k}:2026-09-21`));
    assert.equal(await banner(u, mon(16)), null);
  });

  test("four rows under the bell", async () => {
    const u = await mkUser();
    await superday(u);
    await dayOfBanners(u, mon(15));
    assert.equal((await openJobs(u, mon(15, 30))).length, 4);
  });

  test("one superday note that evening is credited to all four", async () => {
    const u = await mkUser();
    await superday(u);
    await sendNote(u, await mkContact(u.id, "Someone New"), mon(19), { template: "thank_you_superday" });
    assert.deepEqual((await owed(u, mon(20))).map((t) => t.notesSent), [1, 1, 1, 1]);
  });

  test("a note the next morning is still that day's superday", async () => {
    const u = await mkUser();
    await superday(u);
    await sendNote(u, await mkContact(u.id, "Someone New"), tue(8), { template: "thank_you_superday" });
    assert.deepEqual((await owed(u, tue(9))).map((t) => t.notesSent), [1, 1, 1, 1]);
  });

  test("a note between rounds 2 and 3 is credited to rounds 1 and 2 only", async () => {
    const u = await mkUser();
    await superday(u);
    await sendNote(u, await mkContact(u.id, "Someone New"), mon(10, 50), { template: "thank_you_superday" });
    assert.deepEqual((await owed(u, mon(15))).map((t) => t.notesSent), [1, 1, 0, 0]);
  });

  test("'That's everyone' on round 1 leaves the other three", async () => {
    const u = await mkUser();
    const keys = await superday(u);
    await sendNote(u, await mkContact(u.id, "Someone New"), mon(19), { template: "thank_you_superday" });
    await thatsEveryone(u, keys[0], mon(20));
    assert.deepEqual((await owed(u, mon(20, 5))).map((t) => t.key), keys.slice(1));
  });

  test("'That's everyone' on all four closes all four; the next day is silent", async () => {
    const u = await mkUser();
    const keys = await superday(u);
    await dayOfBanners(u, mon(15));
    await sendNote(u, await mkContact(u.id, "Someone New"), mon(19), { template: "thank_you_superday" });
    for (const k of keys) await thatsEveryone(u, k, mon(20));
    assert.deepEqual(await openJobs(u, mon(20, 5)), []);
    assert.equal(await banner(u, tue(9)), null);
  });

  test("next day: four banners, each '1 note sent · anyone else to thank?'", async () => {
    const u = await mkUser();
    await superday(u);
    await sendNote(u, await mkContact(u.id, "Someone New"), mon(19), { template: "thank_you_superday" });
    const shown = await dayOfBanners(u, tue(9));
    assert.equal(shown.length, 4);
    assert.ok(shown.every((s) => s.detail === "1 note sent · anyone else to thank?"));
  });

  test("a superday the following week is not credited with this week's note", async () => {
    const u = await mkUser();
    await superday(u);
    const next = offerlyKey(await mkInterview(u.id, { title: "Moelis Superday", eventDate: sep(28, 9), endDate: sep(28, 10) }));
    await sendNote(u, await mkContact(u.id, "Someone New"), mon(19), { template: "thank_you_superday" });
    assert.equal((await prompt(u, next, sep(28, 13)))?.notesSent, 0);
  });

  test("four Google entries with one interviewer each: a note to round 2's closes only round 2", async () => {
    const u = await mkUser();
    const people = ["a", "b", "c", "d"].map((x) => ({ email: `${x}@evercore.com`, displayName: `Person ${x.toUpperCase()}` }));
    seedGoogle(u.id, people.map((p, i) => google({ id: `sd4-${i}`, title: `Evercore Superday - Round ${i + 1}`, start: mon(9 + i), end: mon(9 + i, 45), attendees: [p] })));
    await dayOfBanners(u, mon(15));
    await sendNote(u, await mkContact(u.id, "Person B", "b@evercore.com"), mon(19), { template: "thank_you_superday" });
    assert.deepEqual((await owed(u, mon(20))).map((t) => t.key), [googleKey("sd4-0"), googleKey("sd4-2"), googleKey("sd4-3")]);
    assert.equal((await jobRow(u.id, googleKey("sd4-1")))?.doneSource, "auto");
  });

  test("four Google entries: each routes to its own interviewer", async () => {
    const u = await mkUser();
    const people = ["a", "b", "c", "d"].map((x) => ({ email: `${x}@evercore.com`, displayName: `Person ${x.toUpperCase()}` }));
    seedGoogle(u.id, people.map((p, i) => google({ id: `sd4r-${i}`, title: `Evercore Superday - Round ${i + 1}`, start: mon(9 + i), end: mon(9 + i, 45), attendees: [p] })));
    const t = await owed(u, mon(15));
    assert.deepEqual(t.map((x) => x.next.email), ["a@evercore.com", "b@evercore.com", "c@evercore.com", "d@evercore.com"]);
  });

  test("four Google entries: four notes to the four people close all four", async () => {
    const u = await mkUser();
    const people = ["a", "b", "c", "d"].map((x) => ({ email: `${x}@evercore.com`, displayName: `Person ${x.toUpperCase()}` }));
    seedGoogle(u.id, people.map((p, i) => google({ id: `sd4c-${i}`, title: `Evercore Superday - Round ${i + 1}`, start: mon(9 + i), end: mon(9 + i, 45), attendees: [p] })));
    await dayOfBanners(u, mon(15));
    for (const k of (await owed(u, mon(19))).map((t) => t.key)) await thankNext(u, k, mon(19));
    assert.deepEqual(await openJobs(u, mon(20)), []);
  });

  test("four Google entries with one interviewer each: one unmatched superday note closes only the last", async () => {
    // A note that reached nobody listed counts only for the latest listed
    // round - one stray note must not close four rounds that say who was there.
    const u = await mkUser();
    const people = ["a", "b", "c", "d"].map((x) => ({ email: `${x}@evercore.com`, displayName: `Person ${x.toUpperCase()}` }));
    seedGoogle(u.id, people.map((p, i) => google({ id: `sd4u-${i}`, title: `Evercore Superday - Round ${i + 1}`, start: mon(9 + i), end: mon(9 + i, 45), attendees: [p] })));
    await sendNote(u, await mkContact(u.id, "Someone Else"), mon(19), { template: "thank_you_superday" });
    assert.deepEqual(
      (await owed(u, mon(20))).map((t) => t.key).sort(),
      ["sd4u-0", "sd4u-1", "sd4u-2"].map(googleKey).sort(),
    );
  });

  test("an all-day superday: a note to Jo the evening before does not count", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [google({ id: "sd-allday-eve", title: "Evercore Superday", start: new Date(0), end: null, allDayDates: ["2026-09-21", "2026-09-22"], attendees: [JO, SAM] })]);
    await sendNote(u, await mkContact(u.id, "Jo Park", "jo.park@gs.com"), sep(20, 21));
    assert.equal((await prompt(u, googleKey("sd-allday-eve"), mon(18)))?.interviewers[0].thanked, false);
  });

  test("an all-day superday: a note to Jo that evening does", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [google({ id: "sd-allday-day", title: "Evercore Superday", start: new Date(0), end: null, allDayDates: ["2026-09-21", "2026-09-22"], attendees: [JO, SAM] })]);
    await sendNote(u, await mkContact(u.id, "Jo Park", "jo.park@gs.com"), mon(17));
    assert.equal((await prompt(u, googleKey("sd-allday-day"), mon(18)))?.interviewers[0].thanked, true);
  });

  test("an all-day Google superday with a panel is due at 6pm and lists the panel", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [google({ id: "sd-allday", title: "Evercore Superday", start: new Date(0), end: null, allDayDates: ["2026-09-21", "2026-09-22"], attendees: [JO, SAM] })]);
    assert.deepEqual(await owed(u, mon(17, 59)), []);
    const t = await prompt(u, googleKey("sd-allday"), mon(18));
    assert.equal(t?.interviewers.length, 2);
    assert.equal(t?.href, outsideHref("thanks.superday", googleKey("sd-allday")));
  });
});

// ============================================= a coordinator on the invite

describe("a coordinator on the invite", () => {
  async function coordinated() {
    const u = await mkUser();
    await trackFirm(u.id, "Evercore");
    const dana = await mkContact(u.id, "Dana Reed", "dana.reed@evercore.com");
    seedGoogle(u.id, [google({
      id: `coord-${seq}`, title: "Evercore interview with Dana Reed", start: mon(10), end: mon(11),
      attendees: [{ email: "recruiting.ops@evercore.com", displayName: "Morgan Lee" }],
    })]);
    return { u, dana, key: googleKey(`coord-${seq}`) };
  }

  test("the named contact comes first, then the coordinator", async () => {
    const { u, dana, key } = await coordinated();
    const t = await prompt(u, key, mon(13));
    assert.deepEqual(t?.interviewers.map((i) => [i.name, i.contactId]), [["Dana Reed", dana], ["Morgan Lee", null]]);
  });

  test("two people: 'Thank your interviewers', routed to Dana first", async () => {
    const { u, dana, key } = await coordinated();
    const [row] = await todo(u, mon(13));
    assert.equal(row.title, "Thank your interviewers");
    assert.equal(row.href, contactHref(dana, "thanks.interview"));
  });

  test("after Dana: 1 of 2, and the coordinator is prefilled outside with the firm", async () => {
    const { u, dana, key } = await coordinated();
    await sendNote(u, dana, mon(19));
    const t = await prompt(u, key, tue(9));
    assert.equal(await progressOf(u, key, tue(9)), "1 of 2 thanked");
    assert.deepEqual(await outsidePrefill(u, t!.href, tue(9)), { name: "Morgan Lee", email: "recruiting.ops@evercore.com", firm: "Evercore" });
  });

  test("'That's everyone' without thanking the coordinator closes it", async () => {
    const { u, dana, key } = await coordinated();
    await sendNote(u, dana, mon(19));
    assert.ok(await thatsEveryone(u, key, tue(9)));
    assert.deepEqual(await owed(u, tue(10)), []);
  });

  test("thanking the coordinator too closes it by itself", async () => {
    const { u, dana, key } = await coordinated();
    await seeBannerFor(u, key, mon(13));
    await sendNote(u, dana, mon(19));
    await thankNext(u, key, mon(19, 10));
    assert.equal((await jobRow(u.id, key))?.doneSource, "auto");
  });

  test("a scheduling bot as the only other attendee: Dana alone, 'Thank Dana Reed'", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana.reed@evercore.com");
    seedGoogle(u.id, [google({ id: "coord-bot", title: "Interview with Dana Reed", start: mon(10), end: mon(11), attendees: [{ email: "no-reply@modernloop.io" }] })]);
    const t = await prompt(u, googleKey("coord-bot"), mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.contactId), [dana]);
    assert.equal((await todo(u, mon(13)))[0].title, "Thank Dana Reed");
  });

  test("Dana both invited and named is listed once", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana.reed@evercore.com");
    seedGoogle(u.id, [google({ id: "coord-both", title: "Interview with Dana Reed", start: mon(10), end: mon(11), attendees: [{ email: "Dana.Reed@evercore.com", displayName: "Dana R." }] })]);
    const t = await prompt(u, googleKey("coord-both"), mon(13));
    assert.deepEqual(t?.interviewers.map((i) => i.contactId), [dana]);
  });

  test("with Dana the only interviewer, her note closes it by itself", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana.reed@evercore.com");
    seedGoogle(u.id, [google({ id: "coord-one", title: "Evercore interview", start: mon(10), end: mon(11), attendees: [{ email: "dana.reed@evercore.com" }] })]);
    await seeBannerFor(u, googleKey("coord-one"), mon(13));
    await sendNote(u, dana, mon(19));
    assert.equal((await jobRow(u.id, googleKey("coord-one")))?.doneSource, "auto");
  });

  test("an attendee with no display name: prefilled by address, name left blank", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [google({ id: "noname", title: "Evercore interview", start: mon(10), end: mon(11), attendees: [{ email: "x.y@evercore.com" }] })]);
    const t = await prompt(u, googleKey("noname"), mon(13));
    assert.deepEqual(await outsidePrefill(u, t!.href, mon(13)), { name: null, email: "x.y@evercore.com", firm: null });
  });
});

// ============================================== notes before the interview

describe("notes sent before the interview", () => {
  test("a note to Jo the day before does not thank her", async () => {
    const { u, key } = await panel();
    await sendNote(u, await mkContact(u.id, "Jo Park", "jo.park@gs.com"), sep(20, 18));
    assert.equal((await prompt(u, key, mon(13)))?.interviewers[0].thanked, false);
  });

  test("a minute before it starts does not count; at the start it does", async () => {
    const { u, key } = await panel();
    const jo = await mkContact(u.id, "Jo Park", "jo.park@gs.com");
    await sendNote(u, jo, mon(9, 59));
    assert.equal((await prompt(u, key, mon(13)))?.notesSent, 0);
    await sendNote(u, jo, mon(10));
    assert.equal((await prompt(u, key, mon(13)))?.notesSent, 1);
  });

  test("an interview note that morning, with no earlier interview, is credited to nothing", async () => {
    const u = await mkUser();
    const e = await mkInterview(u.id);
    await sendNote(u, await mkContact(u.id, "Someone New"), mon(8));
    assert.equal((await prompt(u, offerlyKey(e), mon(13)))?.notesSent, 0);
  });

  test("an interview note before Tuesday's round is Monday's, not Tuesday's", async () => {
    const u = await mkUser();
    const monday = offerlyKey(await mkInterview(u.id));
    const tuesday = offerlyKey(await mkInterview(u.id, { title: "Evercore first round", eventDate: tue(10), endDate: tue(11) }));
    await sendNote(u, await mkContact(u.id, "Someone New"), tue(8));
    const t = await owed(u, tue(13));
    assert.equal(t.find((x) => x.key === monday)?.notesSent, 1);
    assert.equal(t.find((x) => x.key === tuesday)?.notesSent, 0);
  });

  test("a note to Jo before the round does not stop the Monday banner", async () => {
    const { u, key } = await panel();
    await sendNote(u, await mkContact(u.id, "Jo Park", "jo.park@gs.com"), mon(9));
    const p = await seeBannerFor(u, key, mon(13));
    assert.equal(p?.detail, "thank your interviewers while it is fresh");
  });

  test("Jo on Monday's round and Wednesday's: Monday's note does not thank her for Wednesday", async () => {
    const { u, key } = await panel();
    seeded.get(u.id)!.events.push(google({ id: `gs-r2-${seq}`, title: "Goldman Sachs second round", start: wed(10), end: wed(11), attendees: [JO] }));
    const r2 = googleKey(`gs-r2-${seq}`);
    await sendNote(u, await mkContact(u.id, "Jo Park", "jo.park@gs.com"), mon(19));
    assert.equal((await prompt(u, key, wed(13)))?.interviewers[0].thanked, true);
    assert.equal((await prompt(u, r2, wed(13)))?.interviewers[0].thanked, false);
  });

  test("a late-night interview is credited with a note after midnight", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id, { title: "Nomura interview (Tokyo)", eventDate: mon(22), endDate: mon(23) }));
    await sendNote(u, await mkContact(u.id, "Someone New"), tue(1, 30));
    assert.equal((await prompt(u, e, tue(2)))?.notesSent, 1);
  });
});

// ======================================================= unsending a note

describe("taking a note back", () => {
  test("unsending Sam's note: back to 1 of 3, and Sam is next again", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    const sam = await thankNext(u, key, tue(19));
    await unsend(u, sam, tue(20));
    const t = await prompt(u, key, tue(20, 5));
    assert.equal(await progressOf(u, key, tue(20, 5)), "1 of 3 thanked");
    assert.equal(t?.next.name, "Sam Ito");
  });

  test("unsending Lee's note after it closed the panel reopens the job", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await thankNext(u, key, mon(19, 10));
    const lee = await thankNext(u, key, mon(19, 20));
    assert.equal((await jobRow(u.id, key))?.doneSource, "auto");
    await unsend(u, lee, tue(9));
    const row = await jobRow(u.id, key);
    assert.equal(row?.doneAt, null);
    assert.equal(row?.readAt, null);
    assert.equal(row?.bumpedAt.getTime(), tue(9).getTime());
    assert.equal((await openJobs(u, tue(9, 5))).length, 1);
  });

  test("...and the prompt is back at 2 of 3, pointing at Lee", async () => {
    const { u, key, lee } = await panel();
    await thankNext(u, key, mon(19));
    await thankNext(u, key, mon(19, 10));
    const note = await thankNext(u, key, mon(19, 20));
    await unsend(u, note, tue(9));
    const t = await prompt(u, key, tue(9, 5));
    assert.equal(await progressOf(u, key, tue(9, 5)), "2 of 3 thanked");
    assert.equal(t?.next.contactId, lee);
  });

  test("...and the next day's banner speaks again with 2 of 3", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await thankNext(u, key, mon(19, 10));
    const note = await thankNext(u, key, mon(19, 20));
    await unsend(u, note, mon(22));
    const p = await seeBannerFor(u, key, tue(9));
    assert.equal(p?.detail, "2 of 3 thanked · anyone else to thank?");
  });

  test("resending it closes it again", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await thankNext(u, key, mon(19, 10));
    const note = await thankNext(u, key, mon(19, 20));
    await unsend(u, note, tue(9));
    await markSent(u, note, tue(10));
    assert.equal((await jobRow(u.id, key))?.doneSource, "auto");
    assert.deepEqual(await owed(u, tue(11)), []);
  });

  test("no list: unsending the only note takes it back out of the partial state", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    const note = await thankNext(u, e, mon(19));
    await unsend(u, note, mon(20));
    const p = await seeBannerFor(u, e, tue(9));
    assert.equal(p?.detail, "your interviewers are still owed a thank-you");
    assert.equal(p?.doneKey, undefined);
  });

  test("no list: unsending one of two notes: '1 note sent'", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    await thankNext(u, e, mon(19));
    const second = await sendNote(u, await mkContact(u.id, "Sam Ito"), mon(19, 10));
    await unsend(u, second, mon(20));
    assert.equal(await progressOf(u, e, mon(20, 5)), "1 note sent");
  });

  test("a job closed with 'That's everyone' stays closed when a note is taken back", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    const sam = await thankNext(u, key, mon(19, 10));
    await thatsEveryone(u, key, mon(20));
    await unsend(u, sam, tue(9));
    assert.equal((await jobRow(u.id, key))?.doneSource, "manual");
    assert.deepEqual(await owed(u, tue(9, 5)), []);
  });

  test("deleting the sent note that closed the panel reopens the job, as unsending does", async () => {
    // deleteDraft: the row is deleted, then the page redirects. The bell is
    // then read (getNotifications) the way the student would read it.
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await thankNext(u, key, mon(19, 10));
    const lee = await thankNext(u, key, mon(19, 20));
    await h.db.delete(emailDrafts).where(eq(emailDrafts.id, lee));
    // ...and what deleteDraft does after a sent thank-you goes.
    prime(u.id, mon(20));
    await reopenOwedThankYouJobs(u.id, mon(20));
    assert.ok(await prompt(u, key, mon(20)), "owed again");
    assert.equal((await openJobs(u, mon(20))).length, 1, "so the bell should show it again");
  });

  test("unsending a note that answered nothing reopens nothing else", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    for (const at of [mon(19), mon(19, 10), mon(19, 20)]) await thankNext(u, key, at);
    const stray = await sendNote(u, await mkContact(u.id, "Someone Else"), tue(10), { template: "thank_you_chat" });
    await unsend(u, stray, tue(11));
    assert.equal((await jobRow(u.id, key))?.doneSource, "auto");
  });
});

// ============================================ Google read failure mid-panel

describe("Google fails to answer mid-panel", () => {
  test("a failed read does not close the panel's open row", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    const live = seeded.get(u.id)!;
    failGoogle(u.id);
    assert.equal((await openJobs(u, tue(9))).length, 1);
    assert.equal((await jobRow(u.id, key))?.doneAt, null);
    seedGoogle(u.id, live.events);
  });

  test("the last note sent while Google is down closes nothing - and the next good read closes it", async () => {
    const { u, key, lee } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await thankNext(u, key, mon(19, 10));
    const live = seeded.get(u.id)!;
    failGoogle(u.id);
    await sendNote(u, lee, mon(19, 20));
    assert.equal((await jobRow(u.id, key))?.doneAt, null, "nothing concluded from a failed read");
    seedGoogle(u.id, live.events);
    assert.deepEqual(await openJobs(u, mon(20)), []);
    assert.equal((await jobRow(u.id, key))?.doneSource, "auto");
  });

  test("a failed read never closes it as 'auto' while it is still owed", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    const live = seeded.get(u.id)!;
    for (const at of [mon(14), mon(18), tue(9)]) {
      failGoogle(u.id);
      await openJobs(u, at);
      seedGoogle(u.id, live.events);
      await openJobs(u, plus(at, MIN));
    }
    assert.equal((await jobRow(u.id, key))?.doneAt, null);
  });

  test("progress resumes where it was when Google answers again", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    const live = seeded.get(u.id)!;
    failGoogle(u.id);
    await openJobs(u, tue(9));
    seedGoogle(u.id, live.events);
    assert.equal(await progressOf(u, key, tue(10)), "1 of 3 thanked");
  });

  test("an Offerly interview's row is still judged while Google is down", async () => {
    const { u } = await panel();
    const e = offerlyKey(await mkInterview(u.id, { title: "Evercore first round", eventDate: mon(8), endDate: mon(9) }));
    await dayOfBanners(u, mon(13));
    await thatsEveryone(u, e, mon(14));
    failGoogle(u.id);
    const open = await openJobs(u, mon(15));
    assert.ok(open.every((o) => o.href !== outsideHref("thanks.interview", e)));
    assert.equal((await jobRow(u.id, e))?.doneSource, "manual");
  });

  test("a panel row past its fortnight closes as expired even while Google is down", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    failGoogle(u.id);
    await openJobs(u, plus(mon(13), 15 * DAY));
    assert.equal((await jobRow(u.id, key))?.doneSource, "expired");
  });

  test("the failed read is flagged, so thank-you-db knows not to trust it", async () => {
    const { u } = await panel();
    failGoogle(u.id);
    prime(u.id, mon(13));
    assert.equal(googleCache().get(u.id)?.ok, false);
  });
});

// ========================================================= two students

describe("two students on the same invitation", () => {
  async function pair() {
    const a = await mkUser();
    const b = await mkUser();
    const ev = google({ id: `shared-${seq}`, title: "Goldman Sachs Superday", start: mon(10), end: mon(11), attendees: [JO, SAM] });
    seedGoogle(a.id, [ev]);
    seedGoogle(b.id, [ev]);
    return { a, b, key: ev.sourceKey.replace(/^google:/, "thank_you:google:") };
  }

  test("each owes it, under the same key", async () => {
    const { a, b, key } = await pair();
    assert.ok(await prompt(a, key, mon(13)));
    assert.ok(await prompt(b, key, mon(13)));
  });

  test("A's note to Jo does not thank Jo for B", async () => {
    const { a, b, key } = await pair();
    await sendNote(a, await mkContact(a.id, "Jo Park", "jo.park@gs.com"), mon(19));
    assert.equal((await prompt(a, key, mon(20)))?.interviewers[0].thanked, true);
    assert.equal((await prompt(b, key, mon(20)))?.interviewers[0].thanked, false);
  });

  test("A's saved contact is not B's", async () => {
    const { a, b, key } = await pair();
    await mkContact(a.id, "Jo Park", "jo.park@gs.com");
    assert.equal((await prompt(b, key, mon(13)))?.interviewers[0].contactId, null);
  });

  test("A's banner does not silence B's", async () => {
    const { a, b, key } = await pair();
    await seeBannerFor(a, key, mon(13));
    assert.ok(await seeBannerFor(b, key, mon(13)));
  });

  test("each has one row of their own", async () => {
    const { a, b, key } = await pair();
    await seeBannerFor(a, key, mon(13));
    await seeBannerFor(b, key, mon(13));
    assert.equal((await jobRows(a.id)).length, 1);
    assert.equal((await jobRows(b.id)).length, 1);
  });

  test("A's 'That's everyone' does not close B's", async () => {
    const { a, b, key } = await pair();
    await seeBannerFor(a, key, mon(13));
    await seeBannerFor(b, key, mon(13));
    await sendNote(a, await mkContact(a.id, "Jo Park", "jo.park@gs.com"), mon(19));
    await thatsEveryone(a, key, mon(20));
    assert.equal((await jobRow(b.id, key))?.doneAt, null);
    assert.ok(await prompt(b, key, mon(20)));
  });

  test("A's closing notes do not close B's row", async () => {
    const { a, b, key } = await pair();
    await seeBannerFor(a, key, mon(13));
    await seeBannerFor(b, key, mon(13));
    await thankNext(a, key, mon(19));
    await thankNext(a, key, mon(19, 5));
    assert.equal((await jobRow(a.id, key))?.doneSource, "auto");
    assert.equal((await jobRow(b.id, key))?.doneAt, null);
  });

  test("B cannot prefill from A's Offerly interview's key", async () => {
    const a = await mkUser();
    const b = await mkUser();
    await trackFirm(a.id, "Goldman Sachs");
    const e = offerlyKey(await mkInterview(a.id));
    assert.ok(await outsidePrefill(a, outsideHref("thanks.interview", e), mon(13)));
    assert.equal(await outsidePrefill(b, outsideHref("thanks.interview", e), mon(13)), undefined);
  });

  test("B's 'That's everyone' on A's key does nothing to A", async () => {
    const a = await mkUser();
    const b = await mkUser();
    const e = offerlyKey(await mkInterview(a.id));
    await seeBannerFor(a, e, mon(13));
    assert.equal(await thatsEveryone(b, e, mon(14)), false);
    assert.equal((await jobRow(a.id, e))?.doneAt, null);
    assert.deepEqual(await jobRows(b.id), []);
  });

  test("A's tracked firm does not prefill B's form", async () => {
    const a = await mkUser();
    const b = await mkUser();
    await trackFirm(a.id, "Goldman Sachs");
    const e = offerlyKey(await mkInterview(b.id));
    assert.deepEqual(await outsidePrefill(b, outsideHref("thanks.interview", e), mon(13)), { name: null, email: null, firm: null });
  });
});

// ============================================ forged and finished thank keys

describe("the outside form's key prefills only a thank-you owed now", () => {
  const forged = [
    ["a made-up Offerly id", "thank_you:offerly:00000000-0000-0000-0000-000000000000"],
    ["a made-up Google id", "thank_you:google:nope"],
    ["no prefix", "gs-r1"],
    ["SQL-looking junk", "thank_you:offerly:' OR 1=1 --"],
    ["the chat subject key", "thanks:00000000-0000-0000-0000-000000000000"],
    ["an empty key", ""],
  ] as const;
  for (const [what, key] of forged) {
    test(`${what}: nothing is prefilled`, async () => {
      const { u } = await panel();
      assert.equal(await outsidePrefill(u, outsideHref("thanks.interview", key), mon(13)), undefined);
    });
  }

  test("the panel's own key round-trips through the link", async () => {
    const { u, key } = await panel();
    const t = await prompt(u, key, mon(13));
    assert.equal(new URL(t!.href, "https://x.test").searchParams.get("thank"), key);
  });

  test("a Google id with characters a URL must escape round-trips", async () => {
    const u = await mkUser();
    seedGoogle(u.id, [google({ id: "a b/c+d&e=f", title: "Goldman Sachs Interview", start: mon(10), end: mon(11), attendees: [JO] })]);
    const [t] = await owed(u, mon(13));
    assert.equal(new URL(t.href, "https://x.test").searchParams.get("thank"), t.key);
    assert.equal((await outsidePrefill(u, t.href, mon(13)))?.email, "jo.park@gs.com");
  });

  test("a key closed with 'That's everyone' prefills nothing", async () => {
    const { u, key } = await panel();
    const href = (await prompt(u, key, mon(13)))!.href;
    await thatsEveryone(u, key, mon(14));
    assert.equal(await outsidePrefill(u, href, mon(15)), undefined);
  });

  test("a panel everyone has been thanked for prefills nothing", async () => {
    const { u, key } = await panel();
    const href = (await prompt(u, key, mon(13)))!.href;
    for (const at of [mon(19), mon(19, 10), mon(19, 20)]) await thankNext(u, key, at);
    assert.equal(await outsidePrefill(u, href, mon(20)), undefined);
  });

  test("a key a fortnight old prefills nothing", async () => {
    const { u, key } = await panel();
    const href = (await prompt(u, key, mon(13)))!.href;
    assert.equal(await outsidePrefill(u, href, plus(mon(13), 15 * DAY)), undefined);
  });

  test("a key before its interview is due prefills nothing", async () => {
    const { u, key } = await panel();
    assert.equal(await outsidePrefill(u, outsideHref("thanks.interview", key), mon(12)), undefined);
  });

  test("an old link after Jo was thanked now prefills Sam, not Jo", async () => {
    const { u, key } = await panel();
    const href = (await prompt(u, key, mon(13)))!.href;
    await thankNext(u, key, mon(19));
    assert.equal((await outsidePrefill(u, href, mon(20)))?.name, "Sam Ito");
  });

  test("a deleted entry's key prefills nothing", async () => {
    const u = await mkUser();
    const id = await mkInterview(u.id);
    const href = outsideHref("thanks.interview", offerlyKey(id));
    await h.db.delete(events).where(eq(events.id, id));
    assert.equal(await outsidePrefill(u, href, mon(13)), undefined);
  });

  test("a link with no key prefills nothing", async () => {
    const { u } = await panel();
    assert.equal(await outsidePrefill(u, "/outreach?occasion=thanks&box=thanks.interview", mon(13)), undefined);
  });
});

// ===================================================== "That's everyone" when not owed

describe("'That's everyone' when the thank-you is not owed does nothing", () => {
  test("a made-up key writes no row", async () => {
    const u = await mkUser();
    assert.equal(await thatsEveryone(u, "thank_you:offerly:00000000-0000-0000-0000-000000000000", mon(13)), false);
    assert.deepEqual(await jobRows(u.id), []);
  });

  test("before it is due: no row, and it is owed normally at 1pm", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    assert.equal(await thatsEveryone(u, e, mon(12)), false);
    assert.deepEqual(await jobRows(u.id), []);
    assert.ok(await prompt(u, e, mon(13)));
  });

  test("during the interview: nothing", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    assert.equal(await thatsEveryone(u, e, mon(10, 30)), false);
    assert.deepEqual(await jobRows(u.id), []);
  });

  test("already closed by hand: the close time stands", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    await thatsEveryone(u, e, mon(14));
    await thatsEveryone(u, e, tue(9));
    assert.equal((await jobRow(u.id, e))?.doneAt?.getTime(), mon(14).getTime());
  });

  test("closed by the last note: stays 'auto', at the send's time", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    for (const at of [mon(19), mon(19, 10), mon(19, 20)]) await thankNext(u, key, at);
    assert.equal(await thatsEveryone(u, key, mon(21)), false);
    const row = await jobRow(u.id, key);
    assert.equal(row?.doneSource, "auto");
    assert.equal(row?.doneAt?.getTime(), mon(19, 20).getTime());
  });

  test("expired: stays expired", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    await seeBannerFor(u, e, mon(13));
    const late = plus(mon(13), 15 * DAY);
    await openJobs(u, late);
    assert.equal(await thatsEveryone(u, e, plus(late, MIN)), false);
    assert.equal((await jobRow(u.id, e))?.doneSource, "expired");
  });

  test("a chat already thanked: nothing", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed");
    const [chat] = await h.db.insert(events).values({ userId: u.id, type: "coffee_chat", title: "Coffee chat", contactId: dana, eventDate: mon(14), endDate: mon(14, 30) }).returning({ id: events.id });
    await sendNote(u, dana, mon(18), { template: "thank_you_chat" });
    assert.equal(await thatsEveryone(u, offerlyKey(chat.id), mon(19)), false);
  });

  test("a Google interview while Google is down: nothing, and its row stays open", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    const live = seeded.get(u.id)!;
    failGoogle(u.id);
    assert.equal(await thatsEveryone(u, key, mon(14)), false);
    assert.equal((await jobRow(u.id, key))?.doneAt, null);
    seedGoogle(u.id, live.events);
  });

  test("the to-do tick on a row that is not on the list does nothing", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    assert.equal(await tickTodo(u, e, mon(12)), false);
    assert.deepEqual(await h.db.query.todoDismissals.findMany({ where: eq(todoDismissals.userId, u.id) }), []);
  });
});

// ======================================================= expiry at 14 days

describe("a fortnight on", () => {
  test("the panel with one note is owed until 14 days after it fell due", async () => {
    const { u, key } = await panel();
    await thankNext(u, key, mon(19));
    assert.ok(await prompt(u, key, plus(mon(13), 14 * DAY - MIN)));
    assert.equal(await prompt(u, key, plus(mon(13), 14 * DAY + MIN)), undefined);
  });

  test("its bell row closes as expired, not answered", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    await openJobs(u, plus(mon(13), 14 * DAY + MIN));
    assert.equal((await jobRow(u.id, key))?.doneSource, "expired");
  });

  test("the row's expiry is 14 days after it fell due", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    assert.equal((await jobRow(u.id, key))?.expiresAt?.getTime(), plus(mon(13), 14 * DAY).getTime());
  });

  test("a partial Offerly interview's last banner is on day 14, then silence", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    await thankNext(u, e, mon(19));
    const last = await seeBannerFor(u, e, plus(mon(12), 14 * DAY));
    assert.equal(last?.chip, "thank-you · 14 days");
    assert.equal(last?.detail, "1 note sent · anyone else to thank?");
    assert.equal(await banner(u, plus(mon(12), 15 * DAY)), null);
  });

  test("the to-do row is gone at fifteen days", async () => {
    const u = await mkUser();
    const e = offerlyKey(await mkInterview(u.id));
    await thankNext(u, e, mon(19));
    assert.equal((await todo(u, plus(mon(13), 13 * DAY))).length, 1);
    assert.deepEqual(await todo(u, plus(mon(13), 15 * DAY)), []);
  });

  test("a note sent after it expired does not reopen it", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    const late = plus(mon(13), 15 * DAY);
    await openJobs(u, late);
    await sendNote(u, await mkContact(u.id, "Jo Park", "jo.park@gs.com"), plus(late, HOUR));
    assert.equal((await jobRow(u.id, key))?.doneSource, "expired");
    assert.deepEqual(await owed(u, plus(late, 2 * HOUR)), []);
  });

  test("an interview more than 14 days old is never owed, whatever was sent", async () => {
    const u = await mkUser();
    await mkInterview(u.id, { eventDate: sep(1, 10), endDate: sep(1, 11) });
    assert.deepEqual(await owed(u, mon(13)), []);
  });
});

// ========================================================= the bell's one row

describe("the bell's one row per interview", () => {
  test("rewritten every day's banner: body, href, and unread", async () => {
    const { u, key, lee } = await panel();
    const seen: { body: string; href: string }[] = [];
    const notes = [mon(19), tue(19)];
    for (const [i, day] of [mon(13), tue(9), wed(9)].entries()) {
      await seeBannerFor(u, key, day);
      const row = await jobRow(u.id, key);
      seen.push({ body: row!.body, href: row!.href });
      if (notes[i]) await thankNext(u, key, notes[i]);
    }
    assert.deepEqual(seen, [
      { body: "After “Goldman Sachs first round” · 21 Sep", href: outsideHref("thanks.interview", key) },
      { body: "After “Goldman Sachs first round” · 21 Sep · 1 of 3 thanked", href: outsideHref("thanks.interview", key) },
      { body: "After “Goldman Sachs first round” · 21 Sep · 2 of 3 thanked", href: contactHref(lee, "thanks.interview") },
    ]);
  });

  test("the title stays 'Thank your interviewers' all the way through", async () => {
    const { u, key } = await panel();
    const titles = new Set<string>();
    for (const [i, day] of [mon(13), tue(9), wed(9)].entries()) {
      await seeBannerFor(u, key, day);
      titles.add((await jobRow(u.id, key))!.title);
      if (i < 2) await thankNext(u, key, plus(day, 8 * HOUR));
    }
    assert.deepEqual([...titles], ["Thank your interviewers"]);
  });

  test("a linked contact's interview row carries the contact's subject", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana@gs.com");
    const e = offerlyKey(await mkInterview(u.id, { contactId: dana }));
    await seeBannerFor(u, e, mon(13));
    const row = await jobRow(u.id, e);
    assert.equal(row?.subjectKey, `thanks:${dana}`);
    assert.equal(row?.title, "Thank Dana Reed");
  });

  test("reading the bell mid-panel does not close it or change its body", async () => {
    const { u, key } = await panel();
    await seeBannerFor(u, key, mon(13));
    await thankNext(u, key, mon(19));
    const before = (await jobRow(u.id, key))!.body;
    await openJobs(u, mon(20));
    await openJobs(u, tue(8));
    const row = await jobRow(u.id, key);
    assert.equal(row?.doneAt, null);
    assert.equal(row?.body, before);
  });

  test("a late day's banner is the one that rewrites the row, and bumps it to the top", async () => {
    const { u, key } = await panel();
    const e = offerlyKey(await mkInterview(u.id, { title: "Evercore first round", eventDate: mon(8), endDate: mon(9) }));
    await dayOfBanners(u, mon(13));
    await thankNext(u, key, mon(19));
    await dayOfBanners(u, tue(9));
    const open = await openJobs(u, tue(9, 5));
    assert.equal(open.length, 2);
    assert.ok(open.some((o) => o.body.endsWith("1 of 3 thanked")));
    assert.ok(open.some((o) => o.href === outsideHref("thanks.interview", e)));
  });
});

// ================================== interview and chat with the same person

describe("an interview and a chat with the same person the same day", () => {
  async function both() {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana.reed@gs.com");
    const [chat] = await h.db.insert(events).values({ userId: u.id, type: "coffee_chat", title: "Coffee chat", contactId: dana, eventDate: mon(9), endDate: mon(9, 30) }).returning({ id: events.id });
    seedGoogle(u.id, [google({ id: `both-${seq}`, title: "Goldman Sachs first round", start: mon(14), end: mon(15), attendees: [{ email: "dana.reed@gs.com", displayName: "Dana Reed" }, SAM] })]);
    return { u, dana, chat: offerlyKey(chat.id), interview: googleKey(`both-${seq}`) };
  }

  test("both are owed that evening, each its own prompt", async () => {
    const { u, chat, interview } = await both();
    assert.deepEqual((await owed(u, mon(17))).map((t) => t.key), [chat, interview]);
  });

  test("two banners that day: the chat's and the interview's", async () => {
    const { u, chat, interview } = await both();
    const shown = await dayOfBanners(u, mon(17));
    assert.deepEqual(shown.map((s) => s.flashKey.replace(/:2026-09-21$/, "")), [chat, interview]);
  });

  test("the interview lists Dana as the saved contact she is", async () => {
    const { u, dana, interview } = await both();
    assert.equal((await prompt(u, interview, mon(17)))?.interviewers[0].contactId, dana);
  });

  test("one note to Dana that evening answers the chat and ticks her off the interview", async () => {
    const { u, dana, chat, interview } = await both();
    await dayOfBanners(u, mon(17));
    await sendNote(u, dana, mon(19));
    assert.equal((await jobRow(u.id, chat))?.doneSource, "auto");
    const t = await prompt(u, interview, mon(20));
    assert.equal(await progressOf(u, interview, mon(20)), "1 of 2 thanked");
    assert.equal(t?.next.name, "Sam Ito");
  });

  test("a note to Dana at lunch answers the chat only", async () => {
    const { u, dana, chat, interview } = await both();
    await sendNote(u, dana, mon(12), { template: "thank_you_chat" });
    assert.equal(await prompt(u, chat, mon(17)), undefined);
    assert.equal((await prompt(u, interview, mon(17)))?.interviewers[0].thanked, false);
  });

  test("with an Offerly interview (no list) that day, an interview note to Dana still counts for it", async () => {
    const u = await mkUser();
    const dana = await mkContact(u.id, "Dana Reed", "dana.reed@gs.com");
    const [chat] = await h.db.insert(events).values({ userId: u.id, type: "coffee_chat", title: "Coffee chat", contactId: dana, eventDate: mon(9), endDate: mon(9, 30) }).returning({ id: events.id });
    const e = offerlyKey(await mkInterview(u.id, { eventDate: mon(14), endDate: mon(15) }));
    await sendNote(u, dana, mon(19));
    assert.equal(await prompt(u, offerlyKey(chat.id), mon(20)), undefined);
    assert.equal((await prompt(u, e, mon(20)))?.notesSent, 1);
  });

  test("closing the interview with 'That's everyone' leaves the chat owed", async () => {
    const { u, chat, interview } = await both();
    await thatsEveryone(u, interview, mon(17));
    assert.deepEqual((await owed(u, mon(17, 5))).map((t) => t.key), [chat]);
  });

  test("thanking both interviewers leaves an unthanked chat owed", async () => {
    const { u, dana, chat, interview } = await both();
    const sam = await mkContact(u.id, "Sam Ito", "sam.ito@gs.com");
    await sendNote(u, sam, mon(19));
    assert.ok(await prompt(u, interview, mon(20)));
    await sendNote(u, dana, mon(12), { template: "thank_you_chat" });
    // Dana's lunchtime note was before the interview: the interview still waits on her.
    assert.equal((await prompt(u, interview, mon(20)))?.next.contactId, dana);
    assert.equal(await prompt(u, chat, mon(20)), undefined);
  });
});
