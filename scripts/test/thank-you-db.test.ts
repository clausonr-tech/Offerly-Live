// The thank-you prompt against a real schema: an interview on the calendar
// becomes a job under the bell, and the interview thank-you that answers it
// closes that job - with nobody on the job to match it by.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import "./helpers/no-network";
import { and, eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { contacts, emailDrafts, events, notifications, users } from "@/db/schema";
import { closeNotificationByKey, upsertNotification } from "@/lib/notifications";
import { thankYouNotification } from "@/lib/prompt-flash";
import { reconcileThankYouJobs, getThankYouPrompts } from "@/lib/thank-you-db";

delete process.env.DATABASE_URL;

const HOUR = 3_600_000;
const NOW = new Date();
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

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

async function mkUser(): Promise<string> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({ email: `thanks-${seq}-${Date.now()}@example.edu`, passwordHash: "x", name: `Student ${seq}` })
    .returning({ id: users.id });
  return u.id;
}

async function mkEvent(userId: string, over: Partial<typeof events.$inferInsert>) {
  const [e] = await h.db
    .insert(events)
    .values({ userId, type: "interview", title: "Goldman Sachs first round", eventDate: ago(5), endDate: ago(4), ...over })
    .returning({ id: events.id });
  return e.id;
}

async function sendThankYou(userId: string, templateId: string, at: Date, contactName = "New Interviewer") {
  const [c] = await h.db.insert(contacts).values({ userId, name: contactName }).returning({ id: contacts.id });
  await h.db.insert(emailDrafts).values({
    userId,
    contactId: c.id,
    kind: "thank_you",
    templateId,
    subject: "Thank you",
    body: "Thank you for your time today.",
    sentAt: at,
  });
  return c.id;
}

async function fileJobs(userId: string) {
  for (const t of await getThankYouPrompts(userId, NOW)) {
    await upsertNotification({ userId, ...thankYouNotification(t) });
  }
}

/** "That's everyone" (completeThankYouPrompt), step for step. */
async function thatsEveryone(userId: string, key: string) {
  const t = (await getThankYouPrompts(userId, NOW)).find((p) => p.key === key);
  assert.ok(t, `${key} is owed`);
  await upsertNotification({ userId, ...thankYouNotification(t) });
  await closeNotificationByKey(userId, key, "manual");
}

const key = (eventId: string) => `thank_you:offerly:${eventId}`;
const outside = (box: string, eventId: string) =>
  `/outreach?occasion=thanks&box=${box}&thank=${encodeURIComponent(key(eventId))}`;

async function openJobs(userId: string) {
  const rows = await h.db.query.notifications.findMany({
    where: and(eq(notifications.userId, userId), eq(notifications.kind, "thank_you")),
  });
  return rows.filter((r) => !r.doneAt).map((r) => r.title);
}

test("an interview on the calendar is a thank-you owed, on the interview template", async () => {
  const u = await mkUser();
  const e = await mkEvent(u, {});
  const [t] = await getThankYouPrompts(u, NOW);
  assert.equal(t.occasion, "interview");
  assert.equal(t.href, outside("thanks.interview", e));
  await fileJobs(u);
  assert.deepEqual(await openJobs(u), ["Thank your interviewers"]);
});

test("an interview thank-you to a brand-new contact closes the interview's job", async () => {
  const u = await mkUser();
  const e = await mkEvent(u, {});
  await fileJobs(u);
  await sendThankYou(u, "thank_you_interview", ago(1));
  await reconcileThankYouJobs(u, NOW);
  // Nobody listed: the note moves it to "anyone else?", it does not close it.
  assert.deepEqual(await openJobs(u), ["Thank your interviewers"]);
  const [t] = await getThankYouPrompts(u, NOW);
  assert.equal(t.notesSent, 1);
  // "That's everyone" does.
  await thatsEveryone(u, key(e));
  assert.deepEqual(await openJobs(u), []);
  assert.deepEqual(await getThankYouPrompts(u, NOW), []);
  const [row] = await h.db.query.notifications.findMany({ where: eq(notifications.userId, u) });
  assert.equal(row.doneSource, "manual");
});

test("...but leaves a coffee chat's job open", async () => {
  const u = await mkUser();
  const e = await mkEvent(u, {});
  await mkEvent(u, { type: "coffee_chat", title: "Coffee with an analyst", eventDate: ago(6), endDate: ago(5.5) });
  await fileJobs(u);
  await sendThankYou(u, "thank_you_interview", ago(1));
  await reconcileThankYouJobs(u, NOW);
  assert.deepEqual((await openJobs(u)).sort(), ["Send a thank-you", "Thank your interviewers"]);
  await thatsEveryone(u, key(e));
  assert.deepEqual(await openJobs(u), ["Send a thank-you"]);
});

test("a chat thank-you does not close an interview's job", async () => {
  const u = await mkUser();
  await mkEvent(u, {});
  await fileJobs(u);
  await sendThankYou(u, "thank_you_chat", ago(1));
  await reconcileThankYouJobs(u, NOW);
  assert.deepEqual(await openJobs(u), ["Thank your interviewers"]);
});

test("a superday opens the superday template", async () => {
  const u = await mkUser();
  const e = await mkEvent(u, { type: "meeting", title: "Evercore Superday" });
  const [t] = await getThankYouPrompts(u, NOW);
  assert.equal(t.href, outside("thanks.superday", e));
});

test("a HireVue filed as an interview is not a thank-you", async () => {
  const u = await mkUser();
  await mkEvent(u, { title: "HireVue - JPMorgan" });
  assert.deepEqual(await getThankYouPrompts(u, NOW), []);
});
