// The cold-email ladder against a REAL database.
//
// outreach-ladder.test.ts proves the pure rules. This file drives the queries
// that sit on top of them - recordOutreachSend, undoOutreachSend,
// setContactReplied, getDueLadderFollowUps, getLadders,
// ladderProgressBySubject - and the bell's auto-close in getNotifications, over
// an in-memory PGlite migrated by replaying drizzle/*.sql. The unique index on
// (contact_id, step), the cascades and the enum values are the real ones.
//
// NOTHING HERE TOUCHES PRODUCTION: no DATABASE_URL is read (it is removed
// below so getDb() could never fall through to it), and no network.
//
// One database for the file, one fresh student per test: the tests cannot see
// each other's rows, and a PGlite per test would make the file take minutes.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import "./helpers/no-network";
import { and, asc, eq, sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

import { applyMigrations, createTestDb, type TestDatabase } from "./helpers/test-db";
import { contacts, emailDrafts, events, notifications, outreachSends, users } from "@/db/schema";
import { DEFAULT_TIME_ZONE, parseTimeZone, zonedTime } from "@/lib/time-zone";
import { pinUtcClock } from "@/db/utc-clock";
import {
  closeNotificationByKey,
  getNotifications,
  upsertNotification,
} from "@/lib/notifications";
import { normalizeFirmName } from "@/lib/network-coverage";
import {
  followUpNotificationKey,
  followUpSubjectKey,
  parseFollowUpSubject,
} from "@/lib/outreach-ladder";
import {
  getDueLadderFollowUps,
  getLadders,
  ladderProgressBySubject,
  recordOutreachSend,
  setContactReplied,
  undoOutreachSend,
} from "@/lib/outreach-ladder-db";

delete process.env.DATABASE_URL;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-22T15:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);
/** A date column's string, read the way ladderState reads it: local midnight. */
/**
 * Midnight on the STUDENT'S clock, which is what the code under test means.
 *
 * This was `new Date(\`${day}T00:00:00\`)`, and a datetime string with no zone
 * suffix is parsed as HOST-local. "local" is the ambiguity that made it wrong:
 * the ladder resolves a `date` column in the student's zone
 * (DEFAULT_TIME_ZONE, see parseDay in outreach-ladder.ts) and never in the
 * server's - the production comment there is explicit that on a UTC server
 * "1 Oct" began at 8pm on 30 Sep in New York.
 *
 * Host-local and student-local coincide on a UTC-4 laptop and are four hours
 * apart on a UTC host, so two tests here passed locally and failed in CI and
 * in any cloud session. Computed through the same helper the code uses, so the
 * two cannot drift apart again - including across a DST boundary, which a
 * fixed offset would get wrong.
 */
const localMidnight = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return zonedTime(y, m, d, 0, 0, parseTimeZone(DEFAULT_TIME_ZONE));
};

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

let seq = 0;

async function mkUser(): Promise<string> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({ email: `ladder-${seq}-${Date.now()}@example.edu`, passwordHash: "x", name: `Student ${seq}` })
    .returning({ id: users.id });
  return u.id;
}

type ContactOver = Partial<typeof contacts.$inferInsert>;

async function mkContact(userId: string, over: ContactOver = {}): Promise<string> {
  seq += 1;
  const [c] = await h.db
    .insert(contacts)
    .values({ userId, name: `Person ${seq}`, firm: "Evercore", ...over })
    .returning({ id: contacts.id });
  return c.id;
}

async function mkDraft(userId: string, contactId: string | null): Promise<string> {
  const [d] = await h.db
    .insert(emailDrafts)
    .values({ userId, contactId, subject: "Hello", body: "Body", kind: "cold_outreach" })
    .returning({ id: emailDrafts.id });
  return d.id;
}

/**
 * A coffee chat that ended a few hours before NOW, so a thank-you is owed for
 * it - the bell keeps a thank-you job open only while one is. Returns the
 * job's key.
 */
async function owedChat(userId: string, contactId: string | null): Promise<string> {
  const [e] = await h.db
    .insert(events)
    .values({
      userId,
      type: "coffee_chat",
      title: "Coffee chat",
      contactId,
      eventDate: ago(5 * HOUR),
      endDate: ago(4.5 * HOUR),
    })
    .returning({ id: events.id });
  return `thank_you:offerly:${e.id}`;
}

/** Write a send directly, for tests about reading the ladder at exact times. */
async function putSend(
  userId: string,
  contactId: string,
  step: number,
  sentAt: Date,
  source: "copy" | "manual" = "copy",
) {
  const [row] = await h.db
    .insert(outreachSends)
    .values({ userId, contactId, step, sentAt, source })
    .returning();
  return row;
}

async function sendsOf(contactId: string) {
  return h.db.query.outreachSends.findMany({
    where: eq(outreachSends.contactId, contactId),
    orderBy: [asc(outreachSends.step)],
  });
}

async function contactRow(id: string) {
  const row = await h.db.query.contacts.findFirst({ where: eq(contacts.id, id) });
  assert.ok(row, "contact row missing");
  return row;
}

async function notificationRow(userId: string, dedupeKey: string) {
  const row = await h.db.query.notifications.findFirst({
    where: and(eq(notifications.userId, userId), eq(notifications.dedupeKey, dedupeKey)),
  });
  assert.ok(row, "notification row missing");
  return row;
}

/** A follow_up job under the bell for one rung, as prompt-flash writes it. */
async function followUpRow(userId: string, contactId: string, step: number, now = NOW) {
  await upsertNotification({
    userId,
    kind: "follow_up",
    dedupeKey: followUpNotificationKey(contactId, step),
    subjectKey: followUpSubjectKey(contactId, step),
    title: "Follow up",
    body: "no reply",
    href: "/outreach",
    expiresAt: null,
    now,
  });
  return followUpNotificationKey(contactId, step);
}

const rec = (
  userId: string,
  contactId: string,
  extra: { draftId?: string | null; source?: "copy" | "manual"; now?: Date } = {},
) =>
  recordOutreachSend({
    userId,
    contactId,
    draftId: extra.draftId ?? null,
    source: extra.source ?? "manual",
    now: extra.now ?? NOW,
  });

// ============================================================ recordOutreachSend

describe("recordOutreachSend", () => {
  test("the first email to an untouched contact is step 1 and names the contact", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { name: "Ada Lovelace" });
    const r = await rec(u, c);
    assert.ok(r);
    assert.equal(r.step, 1);
    assert.equal(r.contactName, "Ada Lovelace");
    const rows = await sendsOf(c);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, r.sendId);
  });

  test("the row carries the student, the time given and the source", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { source: "copy", now: ago(3 * HOUR) });
    const [row] = await sendsOf(c);
    assert.equal(row.userId, u);
    assert.equal(row.source, "copy");
    assert.equal(row.sentAt.getTime(), ago(3 * HOUR).getTime());
    assert.equal(row.draftId, null);
  });

  test("an untouched contact moves to reached_out", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
  });

  test("the contact's updatedAt becomes the send time", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(2 * DAY) });
    assert.equal((await contactRow(c)).updatedAt.getTime(), ago(2 * DAY).getTime());
  });

  test("lastContactDate is set once an email is recorded", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    assert.equal((await contactRow(c)).lastContactDate, null);
    await rec(u, c);
    assert.match(String((await contactRow(c)).lastContactDate), /^\d{4}-\d{2}-\d{2}$/);
  });

  test(
    "lastContactDate is the day of the send, not the day the server ran it",
        async () => {
      const u = await mkUser();
      const c = await mkContact(u);
      const when = new Date("2026-03-10T15:00:00Z");
      await rec(u, c, { now: when });
      assert.equal((await contactRow(c)).lastContactDate, "2026-03-10");
    },
  );

  test("a reached_out contact stays reached_out on the next rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    await rec(u, c);
    assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
  });

  test("steps climb 1, 2, 3", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const steps = [];
    for (let i = 0; i < 3; i++) steps.push((await rec(u, c, { now: later(i * 8 * DAY) }))?.step);
    assert.deepEqual(steps, [1, 2, 3]);
    assert.deepEqual((await sendsOf(c)).map((s) => s.step), [1, 2, 3]);
  });

  test("a follow-up may be recorded before the week is up", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(HOUR) });
    assert.equal((await rec(u, c))?.step, 2);
  });

  test("a fourth email returns null and writes nothing", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    for (let i = 0; i < 3; i++) await rec(u, c, { now: later(i * DAY) });
    const before = await contactRow(c);
    const r = await rec(u, c, { now: later(30 * DAY) });
    assert.equal(r, null);
    assert.equal((await sendsOf(c)).length, 3);
    const afterRow = await contactRow(c);
    assert.equal(afterRow.updatedAt.getTime(), before.updatedAt.getTime(), "a refused send touched the contact");
  });

  test("a fourth and fifth attempt with fresh drafts are still refused", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    for (let i = 0; i < 3; i++) await rec(u, c, { draftId: await mkDraft(u, c), source: "copy" });
    assert.equal(await rec(u, c, { draftId: await mkDraft(u, c), source: "copy" }), null);
    assert.equal(await rec(u, c, { draftId: await mkDraft(u, c), source: "copy" }), null);
    assert.equal((await sendsOf(c)).length, 3);
  });

  test("the same draft copied twice is one email: same row, same step", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const d = await mkDraft(u, c);
    const a = await rec(u, c, { draftId: d, source: "copy" });
    const b = await rec(u, c, { draftId: d, source: "copy", now: later(DAY) });
    assert.ok(a && b);
    assert.equal(b.sendId, a.sendId);
    assert.equal(b.step, 1);
    assert.equal((await sendsOf(c)).length, 1);
  });

  test("re-copying the same draft does not move the send time", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const d = await mkDraft(u, c);
    await rec(u, c, { draftId: d, source: "copy", now: ago(DAY) });
    await rec(u, c, { draftId: d, source: "copy", now: NOW });
    assert.equal((await sendsOf(c))[0].sentAt.getTime(), ago(DAY).getTime());
  });

  test("the draft id is stored on the row", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const d = await mkDraft(u, c);
    await rec(u, c, { draftId: d, source: "copy" });
    assert.equal((await sendsOf(c))[0].draftId, d);
  });

  test("re-copying an earlier draft after climbing returns the earlier rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const d1 = await mkDraft(u, c);
    const d2 = await mkDraft(u, c);
    const a = await rec(u, c, { draftId: d1, source: "copy", now: ago(10 * DAY) });
    await rec(u, c, { draftId: d2, source: "copy" });
    const again = await rec(u, c, { draftId: d1, source: "copy", now: later(DAY) });
    assert.equal(again?.step, 1);
    assert.equal(again?.sendId, a?.sendId);
    assert.equal((await sendsOf(c)).length, 2);
  });

  test("two different drafts are two rungs", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const r1 = await rec(u, c, { draftId: await mkDraft(u, c), source: "copy" });
    const r2 = await rec(u, c, { draftId: await mkDraft(u, c), source: "copy" });
    assert.equal(r1?.step, 1);
    assert.equal(r2?.step, 2);
    assert.notEqual(r1?.sendId, r2?.sendId);
  });

  test("the same draft recorded against a DIFFERENT contact is that contact's own email", async () => {
    const u = await mkUser();
    const c1 = await mkContact(u);
    const c2 = await mkContact(u);
    const d = await mkDraft(u, c1);
    await rec(u, c1, { draftId: d, source: "copy" });
    const r = await rec(u, c2, { draftId: d, source: "copy" });
    assert.equal(r?.step, 1);
    assert.equal((await sendsOf(c2)).length, 1);
    assert.equal((await sendsOf(c1)).length, 1);
  });

  test("a draft id that does not exist is rejected by the foreign key and changes nothing", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await assert.rejects(
      rec(u, c, { draftId: "00000000-0000-4000-8000-000000000000", source: "copy" }),
    );
    assert.equal((await sendsOf(c)).length, 0);
    assert.equal((await contactRow(c)).relationshipStatus, "not_contacted");
  });

  test("a double-click (two concurrent manual sends) lands on ONE rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const [a, b] = await Promise.all([rec(u, c), rec(u, c)]);
    assert.ok(a && b);
    assert.equal(a.step, 1);
    assert.equal(b.step, 1);
    assert.equal(a.sendId, b.sendId);
    assert.equal((await sendsOf(c)).length, 1);
  });

  test("a legacy 'reached out' contact gets its implied step 1 written, then step 2", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-01" });
    const r = await rec(u, c);
    assert.equal(r?.step, 2);
    const rows = await sendsOf(c);
    assert.deepEqual(rows.map((s) => s.step), [1, 2]);
    assert.equal(rows[0].sentAt.getTime(), localMidnight("2026-09-01").getTime());
    assert.equal(rows[1].sentAt.getTime(), NOW.getTime());
  });

  test("the materialised legacy step 1 is 'manual' with no draft", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-01" });
    const d = await mkDraft(u, c);
    await rec(u, c, { draftId: d, source: "copy" });
    const [first, second] = await sendsOf(c);
    assert.equal(first.source, "manual");
    assert.equal(first.draftId, null);
    assert.equal(second.draftId, d);
    assert.equal(second.source, "copy");
  });

  test("a legacy contact with no date uses updatedAt as its first email", async () => {
    const u = await mkUser();
    const stamp = ago(12 * DAY);
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: null, updatedAt: stamp });
    await rec(u, c);
    const [first] = await sendsOf(c);
    assert.equal(first.step, 1);
    assert.equal(first.sentAt.getTime(), stamp.getTime());
  });

  test("a legacy contact climbs to 3 and then stops", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-08-01" });
    assert.equal((await rec(u, c))?.step, 2);
    assert.equal((await rec(u, c, { now: later(8 * DAY) }))?.step, 3);
    assert.equal(await rec(u, c, { now: later(16 * DAY) }), null);
    assert.equal((await sendsOf(c)).length, 3);
  });

  test("a legacy contact's status stays reached_out after the rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-01" });
    await rec(u, c);
    assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
  });

  for (const status of ["in_conversation", "ongoing"] as const) {
    test(`a ${status} contact (replied) gets no rung and no row`, async () => {
      const u = await mkUser();
      const c = await mkContact(u, { relationshipStatus: status, lastContactDate: "2026-09-01" });
      assert.equal(await rec(u, c), null);
      assert.equal((await sendsOf(c)).length, 0);
      assert.equal((await contactRow(c)).relationshipStatus, status);
    });
  }

  test("a contact that replied mid-ladder gets no further rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(10 * DAY) });
    await setContactReplied(u, c, true);
    assert.equal(await rec(u, c), null);
    assert.equal((await sendsOf(c)).length, 1);
  });

  test("a cold contact with one email gets no further rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(10 * DAY) });
    await h.db.update(contacts).set({ relationshipStatus: "cold" }).where(eq(contacts.id, c));
    assert.equal(await rec(u, c), null);
  });

  test("a legacy cold contact (no rows) gets no rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "cold", lastContactDate: "2026-09-01" });
    assert.equal(await rec(u, c), null);
    assert.equal((await sendsOf(c)).length, 0);
  });

  test("re-copying a draft to a contact who has since replied returns the existing row", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const d = await mkDraft(u, c);
    const a = await rec(u, c, { draftId: d, source: "copy" });
    await setContactReplied(u, c, true);
    const b = await rec(u, c, { draftId: d, source: "copy" });
    assert.equal(b?.sendId, a?.sendId);
    assert.equal((await contactRow(c)).relationshipStatus, "in_conversation");
  });

  test("another student's contact returns null and is untouched", async () => {
    const owner = await mkUser();
    const intruder = await mkUser();
    const c = await mkContact(owner);
    assert.equal(await rec(intruder, c), null);
    assert.equal((await sendsOf(c)).length, 0);
    assert.equal((await contactRow(c)).relationshipStatus, "not_contacted");
  });

  test("another student cannot replay the owner's draft id onto the owner's contact", async () => {
    const owner = await mkUser();
    const intruder = await mkUser();
    const c = await mkContact(owner);
    const d = await mkDraft(owner, c);
    await rec(owner, c, { draftId: d, source: "copy" });
    assert.equal(await rec(intruder, c, { draftId: d, source: "copy" }), null);
  });

  test("a contact id that does not exist returns null", async () => {
    const u = await mkUser();
    assert.equal(await rec(u, "00000000-0000-4000-8000-000000000001"), null);
  });

  test("sends to one contact never climb another contact's ladder", async () => {
    const u = await mkUser();
    const c1 = await mkContact(u);
    const c2 = await mkContact(u);
    await rec(u, c1);
    await rec(u, c1);
    assert.equal((await rec(u, c2))?.step, 1);
  });
});

// ============================================================ undoOutreachSend

describe("undoOutreachSend", () => {
  test("undoing the only email deletes it and puts the contact back to not_contacted", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const r = await rec(u, c);
    assert.equal(await undoOutreachSend(u, r!.sendId), true);
    assert.equal((await sendsOf(c)).length, 0);
    const row = await contactRow(c);
    assert.equal(row.relationshipStatus, "not_contacted");
    assert.equal(row.lastContactDate, null);
  });

  test("email 1 cannot be taken back from under email 2", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const r1 = await rec(u, c, { now: ago(8 * DAY) });
    await rec(u, c);
    assert.equal(await undoOutreachSend(u, r1!.sendId), false);
    assert.deepEqual((await sendsOf(c)).map((s) => s.step), [1, 2]);
  });

  test("email 2 of 3 cannot be taken back either", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    const r2 = await rec(u, c);
    await rec(u, c);
    assert.equal(await undoOutreachSend(u, r2!.sendId), false);
    assert.equal((await sendsOf(c)).length, 3);
  });

  test("undoing the top rung keeps the one below and the reached_out status", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    const r2 = await rec(u, c);
    assert.equal(await undoOutreachSend(u, r2!.sendId), true);
    assert.deepEqual((await sendsOf(c)).map((s) => s.step), [1]);
    assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
  });

  test("after undoing the top rung, lastContactDate is the remaining email's day", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const first = new Date("2026-09-05T15:00:00Z");
    await rec(u, c, { now: first });
    const r2 = await rec(u, c);
    await undoOutreachSend(u, r2!.sendId);
    assert.equal((await contactRow(c)).lastContactDate, "2026-09-05");
  });

  test("the ladder can be walked all the way back down, top first", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await rec(u, c))!.sendId);
    for (const id of ids.reverse()) assert.equal(await undoOutreachSend(u, id), true);
    assert.equal((await sendsOf(c)).length, 0);
    assert.equal((await contactRow(c)).relationshipStatus, "not_contacted");
  });

  test("after undoing step 3, the next record is step 3 again", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await rec(u, c);
    const r3 = await rec(u, c);
    await undoOutreachSend(u, r3!.sendId);
    assert.equal((await rec(u, c))?.step, 3);
  });

  test("a draft copied, undone and copied again lands on the same step with a new row", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const d = await mkDraft(u, c);
    const a = await rec(u, c, { draftId: d, source: "copy" });
    await undoOutreachSend(u, a!.sendId);
    const b = await rec(u, c, { draftId: d, source: "copy" });
    assert.equal(b?.step, 1);
    assert.notEqual(b?.sendId, a?.sendId);
  });

  test("another student cannot undo someone else's email", async () => {
    const owner = await mkUser();
    const intruder = await mkUser();
    const c = await mkContact(owner);
    const r = await rec(owner, c);
    assert.equal(await undoOutreachSend(intruder, r!.sendId), false);
    assert.equal((await sendsOf(c)).length, 1);
    assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
  });

  test("an id that does not exist is false", async () => {
    const u = await mkUser();
    assert.equal(await undoOutreachSend(u, "00000000-0000-4000-8000-000000000002"), false);
  });

  test("undoing the same email twice: the second is false", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const r = await rec(u, c);
    assert.equal(await undoOutreachSend(u, r!.sendId), true);
    assert.equal(await undoOutreachSend(u, r!.sendId), false);
  });

  for (const status of ["in_conversation", "ongoing"] as const) {
    test(`undoing the last email never downgrades a contact who is ${status}`, async () => {
      const u = await mkUser();
      const c = await mkContact(u);
      const r = await rec(u, c);
      await h.db.update(contacts).set({ relationshipStatus: status }).where(eq(contacts.id, c));
      const dateBefore = (await contactRow(c)).lastContactDate;
      assert.equal(await undoOutreachSend(u, r!.sendId), true);
      assert.equal((await sendsOf(c)).length, 0);
      const row = await contactRow(c);
      assert.equal(row.relationshipStatus, status);
      assert.equal(row.lastContactDate, dateBefore);
    });
  }

  test("undoing the only email of a cold contact leaves them not_contacted", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const r = await rec(u, c);
    await h.db.update(contacts).set({ relationshipStatus: "cold" }).where(eq(contacts.id, c));
    await undoOutreachSend(u, r!.sendId);
    assert.equal((await contactRow(c)).relationshipStatus, "not_contacted");
  });

  test("undoing a legacy contact's step 2 keeps the materialised step 1", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-01" });
    const r = await rec(u, c);
    assert.equal(await undoOutreachSend(u, r!.sendId), true);
    const rows = await sendsOf(c);
    assert.deepEqual(rows.map((s) => s.step), [1]);
    assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
  });

  test("undo on one contact does not touch a sibling contact", async () => {
    const u = await mkUser();
    const c1 = await mkContact(u);
    const c2 = await mkContact(u);
    const r1 = await rec(u, c1);
    await rec(u, c2);
    await undoOutreachSend(u, r1!.sendId);
    assert.equal((await sendsOf(c2)).length, 1);
    assert.equal((await contactRow(c2)).relationshipStatus, "reached_out");
  });
});

// ============================================================ setContactReplied

describe("setContactReplied", () => {
  test("replied with no emails recorded: in_conversation, contact date left alone", async () => {
    // A reply does not stamp the contact date: that date is when the student
    // last WROTE, and stamping it made a taken-back reply look like an email.
    const u = await mkUser();
    const c = await mkContact(u);
    await setContactReplied(u, c, true);
    const row = await contactRow(c);
    assert.equal(row.relationshipStatus, "in_conversation");
    assert.equal(row.lastContactDate, null);
  });

  test("replied mid-ladder: in_conversation, sends kept", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await rec(u, c);
    await setContactReplied(u, c, true);
    assert.equal((await contactRow(c)).relationshipStatus, "in_conversation");
    assert.equal((await sendsOf(c)).length, 2);
  });

  test("taking a reply back with emails recorded: reached_out", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await setContactReplied(u, c, true);
    await setContactReplied(u, c, false);
    assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
  });

  test("taking a reply back with no emails and no history: not_contacted", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await setContactReplied(u, c, true);
    await setContactReplied(u, c, false);
    assert.equal((await contactRow(c)).relationshipStatus, "not_contacted");
  });

  test("taking a reply back re-opens the ladder at the next rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await setContactReplied(u, c, true);
    assert.equal(await rec(u, c), null);
    await setContactReplied(u, c, false);
    assert.equal((await rec(u, c))?.step, 2);
  });

  test("replied twice is still in_conversation", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await setContactReplied(u, c, true);
    await setContactReplied(u, c, true);
    assert.equal((await contactRow(c)).relationshipStatus, "in_conversation");
  });

  test("another student cannot mark someone else's contact replied", async () => {
    const owner = await mkUser();
    const intruder = await mkUser();
    const c = await mkContact(owner);
    await rec(owner, c);
    await setContactReplied(intruder, c, true);
    assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
  });

  test("another student cannot take back a reply either", async () => {
    const owner = await mkUser();
    const intruder = await mkUser();
    const c = await mkContact(owner, { relationshipStatus: "in_conversation" });
    await setContactReplied(intruder, c, false);
    assert.equal((await contactRow(c)).relationshipStatus, "in_conversation");
  });

  test("a contact that does not exist is a no-op, not a throw", async () => {
    const u = await mkUser();
    await setContactReplied(u, "00000000-0000-4000-8000-000000000003", true);
  });

  test(
    "a legacy 'reached out' contact marked replied and then un-marked is reached_out again",
        async () => {
      const u = await mkUser();
      const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-01" });
      await setContactReplied(u, c, true);
      await setContactReplied(u, c, false);
      assert.equal((await contactRow(c)).relationshipStatus, "reached_out");
    },
  );

  test(
    "a pre-ladder conversation (in_conversation, no rows) un-marked is not 'never written to'",
        async () => {
      const u = await mkUser();
      const c = await mkContact(u, { relationshipStatus: "in_conversation", lastContactDate: "2026-08-20" });
      await setContactReplied(u, c, false);
      assert.notEqual((await contactRow(c)).relationshipStatus, "not_contacted");
    },
  );
});

// ============================================================ getDueLadderFollowUps

describe("getDueLadderFollowUps", () => {
  test("a student with no contacts has nothing due", async () => {
    const u = await mkUser();
    assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
  });

  test("email 1 exactly seven days old: follow-up 2 is due, 0 days overdue", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(7 * DAY) });
    const due = await getDueLadderFollowUps(u, NOW);
    assert.equal(due.length, 1);
    assert.equal(due[0].contactId, c);
    assert.equal(due[0].step, 2);
    assert.equal(due[0].daysOverdue, 0);
    assert.equal(due[0].dueAt.getTime(), NOW.getTime());
    assert.equal(due[0].lastSentAt.getTime(), ago(7 * DAY).getTime());
  });

  test("one millisecond short of seven days: not due", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(7 * DAY - 1) });
    assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
  });

  test("six days twenty-three hours: not due", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(6 * DAY + 23 * HOUR) });
    assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
  });

  test("nine and a half days: 2 days overdue", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(9.5 * DAY) });
    const [d] = await getDueLadderFollowUps(u, NOW);
    assert.equal(d.daysOverdue, 2);
  });

  test("email 2 a week old: follow-up 3 is due, measured from email 2", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(20 * DAY) });
    await rec(u, c, { now: ago(8 * DAY) });
    const [d] = await getDueLadderFollowUps(u, NOW);
    assert.equal(d.step, 3);
    assert.equal(d.lastSentAt.getTime(), ago(8 * DAY).getTime());
    assert.equal(d.daysOverdue, 1);
  });

  test("email 2 sent a day ago resets the clock: nothing due", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(20 * DAY) });
    await rec(u, c, { now: ago(DAY) });
    assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
  });

  test("three emails a month ago: the ladder is finished, nothing due", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    for (const d of [40, 32, 30]) await rec(u, c, { now: ago(d * DAY) });
    assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
  });

  for (const status of ["in_conversation", "ongoing", "cold"] as const) {
    test(`a ${status} contact with an old email is never due`, async () => {
      const u = await mkUser();
      const c = await mkContact(u);
      await rec(u, c, { now: ago(30 * DAY) });
      await h.db.update(contacts).set({ relationshipStatus: status }).where(eq(contacts.id, c));
      assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
    });
  }

  test("marking replied through setContactReplied clears the due follow-up", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(10 * DAY) });
    assert.equal((await getDueLadderFollowUps(u, NOW)).length, 1);
    await setContactReplied(u, c, true);
    assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
  });

  test("an untouched contact is never due", async () => {
    const u = await mkUser();
    await mkContact(u);
    assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
  });

  test("a legacy 'reached out' contact ten days back is due for email 2", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-10" });
    const [d] = await getDueLadderFollowUps(u, NOW);
    assert.equal(d.contactId, c);
    assert.equal(d.step, 2);
    assert.equal(d.lastSentAt.getTime(), localMidnight("2026-09-10").getTime());
  });

  test("a legacy contact dated yesterday is not due yet", async () => {
    const u = await mkUser();
    await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-21" });
    assert.deepEqual(await getDueLadderFollowUps(u, NOW), []);
  });

  test("a legacy contact with no date is dated by updatedAt", async () => {
    const u = await mkUser();
    await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: null, updatedAt: ago(8 * DAY) });
    const due = await getDueLadderFollowUps(u, NOW);
    assert.equal(due.length, 1);
    assert.equal(due[0].lastSentAt.getTime(), ago(8 * DAY).getTime());
  });

  test("longest-waiting first", async () => {
    const u = await mkUser();
    const a = await mkContact(u, { name: "Zed" });
    const b = await mkContact(u, { name: "Amy" });
    const c = await mkContact(u, { name: "Mo" });
    await rec(u, a, { now: ago(20 * DAY) });
    await rec(u, b, { now: ago(8 * DAY) });
    await rec(u, c, { now: ago(12 * DAY) });
    assert.deepEqual((await getDueLadderFollowUps(u, NOW)).map((d) => d.contactId), [a, c, b]);
  });

  test("same due moment: alphabetical by name", async () => {
    const u = await mkUser();
    const z = await mkContact(u, { name: "Zoe" });
    const a = await mkContact(u, { name: "Abe" });
    await rec(u, z, { now: ago(9 * DAY) });
    await rec(u, a, { now: ago(9 * DAY) });
    assert.deepEqual((await getDueLadderFollowUps(u, NOW)).map((d) => d.contactId), [a, z]);
  });

  test("carries the contact's name and firm", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { name: "Grace Hopper", firm: "Lazard" });
    await rec(u, c, { now: ago(8 * DAY) });
    const [d] = await getDueLadderFollowUps(u, NOW);
    assert.equal(d.name, "Grace Hopper");
    assert.equal(d.firm, "Lazard");
  });

  test("another student's due contacts are not listed", async () => {
    const owner = await mkUser();
    const other = await mkUser();
    const c = await mkContact(owner);
    await rec(owner, c, { now: ago(9 * DAY) });
    assert.deepEqual(await getDueLadderFollowUps(other, NOW), []);
    assert.equal((await getDueLadderFollowUps(owner, NOW)).length, 1);
  });

  test("mixed book: only the one owed a follow-up is listed", async () => {
    const u = await mkUser();
    const due = await mkContact(u);
    const waiting = await mkContact(u);
    const replied = await mkContact(u);
    const done = await mkContact(u);
    await rec(u, due, { now: ago(10 * DAY) });
    await rec(u, waiting, { now: ago(2 * DAY) });
    await rec(u, replied, { now: ago(10 * DAY) });
    await setContactReplied(u, replied, true);
    for (const d of [30, 20, 10]) await rec(u, done, { now: ago(d * DAY) });
    assert.deepEqual((await getDueLadderFollowUps(u, NOW)).map((d) => d.contactId), [due]);
  });

  test(
    "getLadders and getDueLadderFollowUps agree when a contact with emails is edited back to not_contacted",
        async () => {
      const u = await mkUser();
      const c = await mkContact(u);
      await rec(u, c, { now: ago(10 * DAY) });
      // The contact edit form (contacts/actions.ts updateContact) writes the
      // status directly and leaves outreach_sends alone.
      await h.db.update(contacts).set({ relationshipStatus: "not_contacted" }).where(eq(contacts.id, c));
      const ladderSaysDue = (await getLadders(u, NOW)).get(c)?.stage === "due";
      const listSaysDue = (await getDueLadderFollowUps(u, NOW)).some((d) => d.contactId === c);
      assert.equal(listSaysDue, ladderSaysDue);
    },
  );
});

// ============================================================ getLadders

describe("getLadders", () => {
  test("every contact the student has, keyed by id", async () => {
    const u = await mkUser();
    const a = await mkContact(u);
    const b = await mkContact(u);
    const ladders = await getLadders(u, NOW);
    assert.deepEqual([...ladders.keys()].sort(), [a, b].sort());
  });

  test("an untouched contact is not_contacted with next step 1", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const s = (await getLadders(u, NOW)).get(c)!;
    assert.equal(s.stage, "not_contacted");
    assert.equal(s.nextStep, 1);
    assert.deepEqual(s.sends, []);
  });

  test("a fresh email is waiting, due a week later", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(DAY) });
    const s = (await getLadders(u, NOW)).get(c)!;
    assert.equal(s.stage, "waiting");
    assert.equal(s.nextStep, 2);
    assert.equal(s.dueAt?.getTime(), ago(DAY).getTime() + 7 * DAY);
  });

  test("a week-old email is due", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(7 * DAY) });
    assert.equal((await getLadders(u, NOW)).get(c)!.stage, "due");
  });

  test("three emails is finished", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    for (let i = 0; i < 3; i++) await rec(u, c);
    const s = (await getLadders(u, NOW)).get(c)!;
    assert.equal(s.stage, "finished");
    assert.equal(s.nextStep, null);
    assert.deepEqual(s.sends.map((x) => x.step), [1, 2, 3]);
  });

  test("replied is replied, with the emails still listed", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await setContactReplied(u, c, true);
    const s = (await getLadders(u, NOW)).get(c)!;
    assert.equal(s.stage, "replied");
    assert.equal(s.sends.length, 1);
  });

  test("a legacy contact reads as an implied 'legacy' email 1", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-18" });
    const s = (await getLadders(u, NOW)).get(c)!;
    assert.equal(s.stage, "waiting");
    assert.deepEqual(s.sends.map((x) => [x.step, x.source]), [[1, "legacy"]]);
  });

  test("once materialised, the legacy email reads as 'manual'", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { relationshipStatus: "reached_out", lastContactDate: "2026-09-01" });
    await rec(u, c);
    const s = (await getLadders(u, NOW)).get(c)!;
    assert.deepEqual(s.sends.map((x) => [x.step, x.source]), [[1, "manual"], [2, "manual"]]);
  });

  test("sends of two contacts are not mixed up", async () => {
    const u = await mkUser();
    const a = await mkContact(u);
    const b = await mkContact(u);
    await rec(u, a);
    await rec(u, a);
    await rec(u, b);
    const ladders = await getLadders(u, NOW);
    assert.equal(ladders.get(a)!.sends.length, 2);
    assert.equal(ladders.get(b)!.sends.length, 1);
  });

  test("another student's contacts are absent", async () => {
    const owner = await mkUser();
    const other = await mkUser();
    const c = await mkContact(owner);
    assert.equal((await getLadders(other, NOW)).has(c), false);
  });

  test("a student with no contacts gets an empty map", async () => {
    const u = await mkUser();
    assert.equal((await getLadders(u, NOW)).size, 0);
  });
});

// ============================================================ ladderProgressBySubject

describe("ladderProgressBySubject", () => {
  const subj = (contactId: string, step: number) => ({
    key: followUpSubjectKey(contactId, step),
    contactId,
    step,
  });

  test("no subjects, empty map", async () => {
    const u = await mkUser();
    assert.equal((await ladderProgressBySubject(u, [])).size, 0);
  });

  test("rung not yet sent: 1 of 1 left", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    const m = await ladderProgressBySubject(u, [subj(c, 2)]);
    assert.deepEqual(m.get(followUpSubjectKey(c, 2)), { remaining: 1, total: 1 });
  });

  test("rung sent: nothing left", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await rec(u, c);
    const m = await ladderProgressBySubject(u, [subj(c, 2)]);
    assert.equal(m.get(followUpSubjectKey(c, 2))?.remaining, 0);
  });

  test("a later rung sent also finishes the earlier job", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    for (let i = 0; i < 3; i++) await rec(u, c);
    const m = await ladderProgressBySubject(u, [subj(c, 2)]);
    assert.equal(m.get(followUpSubjectKey(c, 2))?.remaining, 0);
  });

  test("an earlier rung does not finish a later job", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await rec(u, c);
    const m = await ladderProgressBySubject(u, [subj(c, 3)]);
    assert.equal(m.get(followUpSubjectKey(c, 3))?.remaining, 1);
  });

  for (const status of ["in_conversation", "ongoing", "cold"] as const) {
    test(`${status}: nothing left`, async () => {
      const u = await mkUser();
      const c = await mkContact(u);
      await rec(u, c);
      await h.db.update(contacts).set({ relationshipStatus: status }).where(eq(contacts.id, c));
      const m = await ladderProgressBySubject(u, [subj(c, 2)]);
      assert.equal(m.get(followUpSubjectKey(c, 2))?.remaining, 0);
    });
  }

  test("a deleted contact: nothing left", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await h.db.delete(contacts).where(eq(contacts.id, c));
    const m = await ladderProgressBySubject(u, [subj(c, 2)]);
    assert.deepEqual(m.get(followUpSubjectKey(c, 2)), { remaining: 0, total: 1 });
  });

  test("someone else's contact: nothing left (not theirs to chase)", async () => {
    const owner = await mkUser();
    const other = await mkUser();
    const c = await mkContact(owner);
    await rec(owner, c);
    const m = await ladderProgressBySubject(other, [subj(c, 2)]);
    assert.equal(m.get(followUpSubjectKey(c, 2))?.remaining, 0);
  });

  test("several subjects for several rungs and people at once", async () => {
    const u = await mkUser();
    const a = await mkContact(u);
    const b = await mkContact(u);
    await rec(u, a);
    await rec(u, a);
    await rec(u, b);
    const m = await ladderProgressBySubject(u, [subj(a, 2), subj(a, 3), subj(b, 2)]);
    assert.equal(m.get(followUpSubjectKey(a, 2))?.remaining, 0);
    assert.equal(m.get(followUpSubjectKey(a, 3))?.remaining, 1);
    assert.equal(m.get(followUpSubjectKey(b, 2))?.remaining, 1);
  });

  test(
    "every email taken back (contact back to not_contacted): the follow-up job is over",
        async () => {
      const u = await mkUser();
      const c = await mkContact(u);
      const r = await rec(u, c, { now: ago(8 * DAY) });
      await undoOutreachSend(u, r!.sendId);
      const m = await ladderProgressBySubject(u, [subj(c, 2)]);
      assert.equal(m.get(followUpSubjectKey(c, 2))?.remaining, 0);
    },
  );
});

// ============================================================ getNotifications

describe("getNotifications auto-close", () => {
  test("a follow-up job stays open while only email 1 is sent", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    const key = await followUpRow(u, c, 2);
    const list = await getNotifications(u, NOW);
    assert.equal(list.openCount, 1);
    assert.deepEqual(list.open[0].progress, { done: 0, total: 1 });
    assert.equal((await notificationRow(u, key)).doneAt, null);
  });

  test("it closes, as 'auto', once email 2 is recorded", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    const key = await followUpRow(u, c, 2);
    await getNotifications(u, NOW);
    await rec(u, c);
    const list = await getNotifications(u, later(HOUR));
    assert.equal(list.openCount, 0);
    const row = await notificationRow(u, key);
    assert.equal(row.doneSource, "auto");
    assert.equal(row.doneAt?.getTime(), later(HOUR).getTime());
  });

  test("it closes once they reply", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    const key = await followUpRow(u, c, 2);
    await setContactReplied(u, c, true);
    await getNotifications(u, NOW);
    assert.equal((await notificationRow(u, key)).doneSource, "auto");
  });

  test("it closes once the contact is deleted", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    const key = await followUpRow(u, c, 2);
    await h.db.delete(contacts).where(eq(contacts.id, c));
    assert.equal((await getNotifications(u, NOW)).openCount, 0);
    assert.equal((await notificationRow(u, key)).doneSource, "auto");
  });

  test("it closes once the contact is marked cold", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    await followUpRow(u, c, 2);
    await h.db.update(contacts).set({ relationshipStatus: "cold" }).where(eq(contacts.id, c));
    assert.equal((await getNotifications(u, NOW)).openCount, 0);
  });

  test("the step-3 job is NOT closed by sending step 2", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(20 * DAY) });
    await rec(u, c, { now: ago(8 * DAY) });
    const key = await followUpRow(u, c, 3);
    await getNotifications(u, NOW);
    assert.equal((await notificationRow(u, key)).doneAt, null);
  });

  test("a step-2 job and a step-3 job for one person close independently", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(20 * DAY) });
    const k2 = await followUpRow(u, c, 2);
    const k3 = await followUpRow(u, c, 3);
    await rec(u, c, { now: ago(DAY) });
    await getNotifications(u, NOW);
    assert.equal((await notificationRow(u, k2)).doneSource, "auto");
    assert.equal((await notificationRow(u, k3)).doneAt, null);
  });

  test("a follow-up row for another student's contact id closes (not theirs)", async () => {
    const owner = await mkUser();
    const other = await mkUser();
    const c = await mkContact(owner);
    await rec(owner, c, { now: ago(8 * DAY) });
    const key = await followUpRow(other, c, 2);
    await getNotifications(other, NOW);
    assert.equal((await notificationRow(other, key)).doneSource, "auto");
  });

  test("re-firing a closed follow-up reopens it, and the read pass closes it again when sent", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c, { now: ago(8 * DAY) });
    const key = await followUpRow(u, c, 2);
    await rec(u, c);
    await getNotifications(u, NOW);
    await followUpRow(u, c, 2, later(HOUR));
    assert.equal((await notificationRow(u, key)).doneAt, null);
    await getNotifications(u, later(2 * HOUR));
    assert.equal((await notificationRow(u, key)).doneSource, "auto");
  });

  test("a thank_you row with subject thanks:<contactId> is NOT auto-closed", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { firm: "Evercore" });
    const key = await owedChat(u, c);
    await upsertNotification({
      userId: u,
      kind: "thank_you",
      dedupeKey: key,
      subjectKey: `thanks:${c}`,
      title: "Thank them",
      body: "After the chat",
      href: "/outreach",
      now: NOW,
    });
    const list = await getNotifications(u, NOW);
    assert.equal(list.openCount, 1);
    assert.equal(list.open[0].progress, null);
    assert.equal((await notificationRow(u, key)).doneAt, null);
  });

  test("a thanks: row survives even when the student has no contacts at all", async () => {
    const u = await mkUser();
    await upsertNotification({
      userId: u,
      kind: "thank_you",
      dedupeKey: await owedChat(u, null),
      subjectKey: "thanks:00000000-0000-4000-8000-000000000009",
      title: "Thank them",
      body: "After the chat",
      href: "/outreach",
      now: NOW,
    });
    assert.equal((await getNotifications(u, NOW)).openCount, 1);
  });

  test("a thanks: row closes by key, by hand", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await upsertNotification({
      userId: u,
      kind: "thank_you",
      dedupeKey: "thank_you:k",
      subjectKey: `thanks:${c}`,
      title: "t",
      body: "b",
      href: "/",
      now: NOW,
    });
    await closeNotificationByKey(u, "thank_you:k", "manual", NOW);
    assert.equal((await notificationRow(u, "thank_you:k")).doneSource, "manual");
    assert.equal((await getNotifications(u, NOW)).openCount, 0);
  });

  test("a malformed ladder: subject is not read as a firm and does not close", async () => {
    const u = await mkUser();
    await upsertNotification({
      userId: u,
      kind: "follow_up",
      dedupeKey: "follow_up:bad",
      subjectKey: "ladder:not-a-uuid:2",
      title: "t",
      body: "b",
      href: "/",
      now: NOW,
    });
    assert.equal((await getNotifications(u, NOW)).openCount, 1);
  });

  // These file a job with no opening behind it: no tracked firm, no posting.
  // Such a job is about a date that is not coming, so it closes as expired -
  // the live-opening versions (staying open, progress, closing when finished)
  // are in internship-opening-lifecycle.test.ts, against real postings.
  test("an outreach row with no live opening behind it closes as expired, work left or not", async () => {
    const u = await mkUser();
    await mkContact(u, { firm: "Moelis & Company" });
    const c2 = await mkContact(u, { firm: "Moelis & Company" });
    await rec(u, c2);
    await upsertNotification({
      userId: u,
      kind: "outreach",
      dedupeKey: "outreach:moelis:2026-10-01",
      subjectKey: normalizeFirmName("Moelis & Company"),
      title: "Email Moelis",
      body: "b",
      href: "/",
      now: NOW,
    });
    const list = await getNotifications(u, NOW);
    assert.equal(list.openCount, 0);
    assert.equal((await notificationRow(u, "outreach:moelis:2026-10-01")).doneSource, "expired");
  });

  test("an outreach firm row closes once everyone there has been written to", async () => {
    const u = await mkUser();
    const c1 = await mkContact(u, { firm: "Centerview Partners" });
    await upsertNotification({
      userId: u,
      kind: "outreach",
      dedupeKey: "outreach:cv:2026-10-01",
      subjectKey: normalizeFirmName("Centerview Partners"),
      title: "Email Centerview",
      body: "b",
      href: "/",
      now: NOW,
    });
    // Everyone written to before the bell is read: finished beats expired.
    await rec(u, c1);
    assert.equal((await getNotifications(u, NOW)).openCount, 0);
    assert.equal((await notificationRow(u, "outreach:cv:2026-10-01")).doneSource, "auto");
  });

  test("an outreach row past its expiry closes as 'expired', not 'auto'", async () => {
    const u = await mkUser();
    await mkContact(u, { firm: "PJT Partners" });
    await upsertNotification({
      userId: u,
      kind: "outreach",
      dedupeKey: "outreach:pjt:x",
      subjectKey: normalizeFirmName("PJT Partners"),
      title: "t",
      body: "b",
      href: "/",
      expiresAt: ago(HOUR),
      now: ago(DAY),
    });
    await getNotifications(u, NOW);
    assert.equal((await notificationRow(u, "outreach:pjt:x")).doneSource, "expired");
  });

  test("a quiz: row with no practice stays open", async () => {
    const u = await mkUser();
    await upsertNotification({
      userId: u,
      kind: "interview_prep",
      dedupeKey: "prep:x",
      subjectKey: "quiz:investment_banking",
      title: "t",
      body: "b",
      href: "/",
      now: NOW,
    });
    assert.equal((await getNotifications(u, NOW)).openCount, 1);
  });

  test("the badge counts open jobs and the dot counts unread ones", async () => {
    const u = await mkUser();
    const a = await mkContact(u);
    const b = await mkContact(u);
    await rec(u, a, { now: ago(8 * DAY) });
    await rec(u, b, { now: ago(8 * DAY) });
    await followUpRow(u, a, 2);
    await followUpRow(u, b, 2);
    await h.db
      .update(notifications)
      .set({ readAt: NOW })
      .where(and(eq(notifications.userId, u), eq(notifications.dedupeKey, followUpNotificationKey(a, 2))));
    const list = await getNotifications(u, NOW);
    assert.equal(list.openCount, 2);
    assert.equal(list.unreadCount, 1);
  });

  test("mixed bell: the finished follow-up closes, the firm with no live opening expires; thanks and quiz stay", async () => {
    const u = await mkUser();
    const c = await mkContact(u, { firm: "Guggenheim" });
    await mkContact(u, { firm: "Guggenheim" });
    await rec(u, c, { now: ago(8 * DAY) });
    await followUpRow(u, c, 2);
    const chatKey = await owedChat(u, c);
    for (const [kind, key, subject] of [
      ["thank_you", chatKey, `thanks:${c}`],
      ["interview_prep", "q:1", "quiz:x"],
      ["outreach", "o:1", normalizeFirmName("Guggenheim")],
    ] as const) {
      await upsertNotification({ userId: u, kind, dedupeKey: key, subjectKey: subject, title: "t", body: "b", href: "/", now: NOW });
    }
    await rec(u, c);
    const list = await getNotifications(u, NOW);
    assert.equal(list.openCount, 2);
    assert.equal((await notificationRow(u, followUpNotificationKey(c, 2))).doneSource, "auto");
    assert.equal((await notificationRow(u, "o:1")).doneSource, "expired");
  });
});

// ============================================================ keys

describe("subject keys against real ids", () => {
  test("a database uuid round-trips through the ladder subject key", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    assert.deepEqual(parseFollowUpSubject(followUpSubjectKey(c, 3)), { contactId: c, step: 3 });
  });

  test("a thanks: key is never parsed as a ladder subject", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    assert.equal(parseFollowUpSubject(`thanks:${c}`), null);
  });
});

// ============================================================ schema and migration

describe("outreach_sends schema", () => {
  test("the unique index refuses a second row on the same rung", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await putSend(u, c, 1, NOW);
    await assert.rejects(putSend(u, c, 1, later(HOUR)));
  });

  test("deleting a contact cascades its outreach_sends", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    await rec(u, c);
    await rec(u, c);
    await h.db.delete(contacts).where(eq(contacts.id, c));
    assert.equal((await sendsOf(c)).length, 0);
  });

  test("deleting a draft keeps the send but nulls its draft_id", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const d = await mkDraft(u, c);
    const r = await rec(u, c, { draftId: d, source: "copy" });
    await h.db.delete(emailDrafts).where(eq(emailDrafts.id, d));
    const [row] = await sendsOf(c);
    assert.equal(row.id, r!.sendId);
    assert.equal(row.draftId, null);
  });

  test("after its draft is deleted, the rung still counts toward the ladder", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const d = await mkDraft(u, c);
    await rec(u, c, { draftId: d, source: "copy" });
    await h.db.delete(emailDrafts).where(eq(emailDrafts.id, d));
    assert.equal((await rec(u, c))?.step, 2);
  });

  test("deleting the student cascades their sends", async () => {
    const u = await mkUser();
    const c = await mkContact(u);
    const r = await rec(u, c);
    await h.db.delete(users).where(eq(users.id, u));
    const left = await h.db.query.outreachSends.findFirst({ where: eq(outreachSends.id, r!.sendId) });
    assert.equal(left, undefined);
  });

  test("the foreign keys have the documented ON DELETE actions", async () => {
    const res = await h.client.query<{ conname: string; confdeltype: string }>(
      "select conname, confdeltype from pg_constraint where conrelid = 'outreach_sends'::regclass and contype = 'f' order by conname",
    );
    const byName = Object.fromEntries(res.rows.map((r) => [r.conname, r.confdeltype]));
    assert.deepEqual(byName, {
      outreach_sends_contact_id_contacts_id_fk: "c",
      outreach_sends_draft_id_email_drafts_id_fk: "n",
      outreach_sends_user_id_users_id_fk: "c",
    });
  });

  test("notification_kind has follow_up and thank_you", async () => {
    const res = await h.db.execute(
      sql`select unnest(enum_range(null::notification_kind))::text as k`,
    );
    const kinds = (res as unknown as { rows: { k: string }[] }).rows.map((r) => r.k);
    for (const k of ["outreach", "interview_prep", "follow_up", "thank_you"]) assert.ok(kinds.includes(k), k);
  });

  test("email_drafts.sent_at exists and is nullable", async () => {
    const res = await h.client.query<{ is_nullable: string }>(
      "select is_nullable from information_schema.columns where table_name='email_drafts' and column_name='sent_at'",
    );
    assert.equal(res.rows[0]?.is_nullable, "YES");
  });
});

describe("migration 0011 is re-runnable", () => {
  async function shape(client: PGlite) {
    const q = async (text: string) => (await client.query<{ c: string }>(text)).rows.map((r) => r.c).join(",");
    return {
      cols: await q(
        "select column_name || ':' || data_type || ':' || is_nullable as c from information_schema.columns where table_name='outreach_sends' order by 1",
      ),
      idx: await q("select indexdef as c from pg_indexes where tablename='outreach_sends' order by 1"),
      con: await q(
        "select conname || ':' || pg_get_constraintdef(oid) as c from pg_constraint where conrelid='outreach_sends'::regclass order by 1",
      ),
      kinds: await q("select unnest(enum_range(null::notification_kind))::text as c"),
      draftCols: await q(
        "select column_name as c from information_schema.columns where table_name='email_drafts' order by 1",
      ),
    };
  }

  // Only 0008, 0010 and 0011 are written to be re-runnable; 0000 creates bare
  // types and cannot be replayed, so the whole chain is applied once and 0011
  // on top of it twice more.
  test("0011 applied twice more over a fully migrated database throws nothing", async () => {
    const client = new PGlite();
    await pinUtcClock(client);
    await applyMigrations(client);
    const text = readFileSync("drizzle/0011_outreach_sends.sql", "utf8");
    for (let round = 0; round < 2; round++) {
      for (const statement of text.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) await client.exec(trimmed);
      }
    }
    const n = await client.query<{ n: number }>("select count(*)::int as n from outreach_sends");
    assert.equal(n.rows[0].n, 0);
    await client.close();
  });

  test("replaying 0011 alone leaves the schema exactly as it was", async () => {
    const client = new PGlite();
    await pinUtcClock(client);
    await applyMigrations(client);
    const before = await shape(client);
    const text = readFileSync("drizzle/0011_outreach_sends.sql", "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
    assert.deepEqual(await shape(client), before);
    await client.close();
  });

  test("replaying 0011 keeps existing sends and their links", async () => {
    const client = new PGlite();
    await pinUtcClock(client);
    await applyMigrations(client);
    await client.exec(`
      insert into users (id, email, password_hash) values ('11111111-1111-4111-8111-111111111111', 'r@example.edu', 'x');
      insert into contacts (id, user_id, name) values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'P');
      insert into outreach_sends (user_id, contact_id, step, source) values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 'copy');
    `);
    const text = readFileSync("drizzle/0011_outreach_sends.sql", "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
    const n = await client.query<{ n: number }>("select count(*)::int as n from outreach_sends");
    assert.equal(n.rows[0].n, 1);
    // The cascade survives the drop-and-re-add of its constraint.
    await client.exec("delete from contacts where id = '22222222-2222-4222-8222-222222222222'");
    const m = await client.query<{ n: number }>("select count(*)::int as n from outreach_sends");
    assert.equal(m.rows[0].n, 0);
    await client.close();
  });

  test("0011 is in the journal", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
      entries: { tag: string }[];
    };
    assert.ok(journal.entries.some((e) => e.tag === "0011_outreach_sends"));
  });
});
