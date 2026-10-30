/**
 * One student cannot empty themselves into another student's inbox, and the
 * reads that inbox feeds are bounded.
 *
 * There is no block, mute, report or delete in the messaging feature yet, so
 * the write caps in sendMessage are the whole defence - and the read side is
 * where a flood actually lands: getThreads runs on EVERY page in the app (the
 * message bubble in the (app) layout), and both it and getThread used to have
 * no LIMIT at all. The cost of rendering any page for the victim was a
 * function of how much mail someone else had sent them.
 *
 * Real database (PGlite, real migrations - the rate_events table and the
 * messages indexes are the real ones). No network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { messages, rateEvents, users } from "@/db/schema";
import { eq } from "drizzle-orm";

const SENDER = "11111111-2222-4222-8222-111111111111";
const VICTIM = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-2222-4222-8222-333333333333";

async function withStudents(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values(
      [
        [SENDER, "sender@example.edu", "The Sender"],
        [VICTIM, "victim@example.edu", "The Recipient"],
        [THIRD, "third@example.edu", "Someone Else"],
      ].map(([id, email, name]) => ({
        id,
        email,
        name,
        passwordHash: "x",
        school: "University of Southern California",
        gradYear: 2028,
      })),
    );
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

/** Fill a rate-limit bucket to the brim without going through the feature, so
 *  the boundary can be asserted without writing a thousand rows. */
async function fillBucket(bucket: string, subject: string, times: number): Promise<void> {
  const { rateLimit } = await import("@/lib/rate-limit");
  for (let i = 0; i < times; i++) await rateLimit(bucket, subject, times, 60 * 60_000);
}

test("a sent message records against the sender, in both windows", async () => {
  await withStudents(async (h) => {
    const { sendMessage } = await import("@/lib/people");
    const ok = await sendMessage(SENDER, VICTIM, "Hey - are you going to the info session?");
    assert.equal(ok.error, undefined);

    const burst = await h.db.select().from(rateEvents).where(eq(rateEvents.bucket, "dm:send"));
    assert.equal(burst.length, 1, "counted per sender");
    assert.equal(burst[0].subject, SENDER, "and the subject is the server-resolved sender");

    const pair = await h.db.select().from(rateEvents).where(eq(rateEvents.bucket, "dm:to"));
    assert.equal(pair.length, 1, "and counted per pair");
    assert.ok(pair[0].subject.startsWith(SENDER), "keyed by sender and recipient, not by either alone");
    assert.ok(pair[0].subject.includes(VICTIM));
  });
});

test("the per-recipient day cap stops one sender aiming everything at one person", async () => {
  await withStudents(async (h) => {
    const { sendMessage } = await import("@/lib/people");
    await fillBucket("dm:to", `${SENDER}:${VICTIM}`, 60);

    const refused = await sendMessage(SENDER, VICTIM, "and another one");
    assert.match(refused.error ?? "", /a lot of messages today/i);
    assert.match(refused.error ?? "", /try again/i, "and says when to come back");
    assert.equal(
      (await h.db.select().from(messages).where(eq(messages.recipientId, VICTIM))).length,
      0,
      "nothing was written",
    );

    // Not a ban on the sender: a different person still hears from them.
    const elsewhere = await sendMessage(SENDER, THIRD, "hey, separate question");
    assert.equal(elsewhere.error, undefined, "the pair cap is per pair");
  });
});

test("the hourly cap bounds the sender across every recipient", async () => {
  await withStudents(async () => {
    const { sendMessage } = await import("@/lib/people");
    await fillBucket("dm:send", SENDER, 90);
    const refused = await sendMessage(SENDER, THIRD, "one more");
    assert.match(refused.error ?? "", /a lot of messages just now/i);
  });
});

test("the inbox summary is bounded and still right", async () => {
  await withStudents(async (h) => {
    const { getThreads, unreadCount } = await import("@/lib/people");
    // A flood, written straight to the table: the caps above are the write
    // side, this is what the victim's every page render then costs.
    const base = Date.now() - 5_000_000;
    const rows = Array.from({ length: 400 }, (_, i) => ({
      senderId: SENDER,
      recipientId: VICTIM,
      body: "x".repeat(2000),
      createdAt: new Date(base + i * 1000),
    }));
    await h.db.insert(messages).values(rows);
    await h.db.insert(messages).values({
      senderId: THIRD,
      recipientId: VICTIM,
      body: "a real message",
      createdAt: new Date(base + 500_000),
    });

    const threads = await getThreads(VICTIM);
    assert.equal(threads.length, 2, "one row per counterpart, however much was sent");
    const flood = threads.find((t) => t.otherId === SENDER)!;
    assert.equal(flood.unreadCount, 400, "the unread tally is still exact");
    assert.equal(flood.lastBody, "x".repeat(2000), "and the preview is the newest message's body");
    const real = threads.find((t) => t.otherId === THIRD)!;
    assert.equal(real.lastBody, "a real message");
    assert.equal(threads[0].otherId, THIRD, "newest thread first");

    assert.equal(await unreadCount(VICTIM), 401, "counted in the database, not by reading rows back");
  });
});

test("one conversation renders at most the newest thousand messages, oldest first", async () => {
  await withStudents(async (h) => {
    const { getThread } = await import("@/lib/people");
    const base = Date.now() - 5_000_000;
    await h.db.insert(messages).values(
      Array.from({ length: 1005 }, (_, i) => ({
        senderId: SENDER,
        recipientId: VICTIM,
        body: `message ${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    );

    const thread = await getThread(VICTIM, SENDER);
    assert.equal(thread.length, 1000, "bounded");
    assert.equal(thread[0].body, "message 5", "the limit takes the NEWEST end");
    assert.equal(thread.at(-1)?.body, "message 1004");
    assert.ok(
      thread[0].createdAt.getTime() < thread[1].createdAt.getTime(),
      "and it is still read top to bottom",
    );
  });
});
