/**
 * One student's stored events cannot decide whose reminders a run sends.
 *
 * sendDueReminderEmails reads every unsent event in the next seven days across
 * all users, ordered by date alone, and used to take the first 500. A bulk
 * import is all it takes for one student to own 500 events dated ahead of
 * everybody else's, so a run would spend itself entirely on them - and rows
 * that keep failing, or whose owner has no address, are deliberately left
 * unmarked so a later run retries them, which turned "wait for the next run"
 * into waiting forever. Each student now gets a share of a run.
 *
 *   node --import tsx --conditions=react-server --test \
 *     scripts/test/import-reminder-queue-fairness.test.ts
 *
 * Real (in-memory) Postgres. The mail driver is replaced with a recorder, so
 * nothing is sent and no provider is contacted.
 */

import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

import "./helpers/no-network";

// src/lib/email.ts is the lowest seam the reminder job has: stubbed here, no
// message leaves the process and the test can see exactly what was attempted.
type Attempt = { to: string; subject: string; text: string };
const attempts: Attempt[] = [];
let failFor: (to: string) => boolean = () => false;
{
  const emailPath = require.resolve("@/lib/email");
  const stub = new Module(emailPath);
  stub.filename = emailPath;
  stub.loaded = true;
  stub.exports = {
    __esModule: true,
    sendEmail: async (message: Attempt) => {
      attempts.push(message);
      if (failFor(message.to)) throw new Error("provider refused");
    },
  };
  require.cache[emailPath] = stub;
}

import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { events, users } from "@/db/schema";

const LOUD = "66666666-6666-4666-8666-666666666666";
const QUIET = "77777777-7777-4777-8777-777777777777";
const NO_EMAIL = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 3_600_000;

async function withTwoStudents(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  attempts.length = 0;
  failFor = () => false;
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values([
      { id: LOUD, email: "loud@example.edu", passwordHash: "x", name: "Loud Student" },
      { id: QUIET, email: "quiet@example.edu", passwordHash: "x", name: "Quiet Student" },
      // users.email is NOT NULL, so "no address to send to" - the case the job
      // skips without marking the row - is the empty one.
      { id: NO_EMAIL, email: "", passwordHash: "x", name: "No Address" },
    ]);
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

/** `count` events for `userId`, the first of them `fromHours` ahead of now. */
function manyEvents(userId: string, count: number, fromHours: number) {
  return Array.from({ length: count }, (_, i) => ({
    userId,
    type: "deadline" as const,
    title: `Imported row ${i}`,
    eventDate: new Date(NOW.getTime() + (fromHours + i * 0.001) * HOUR),
  }));
}

test("a student with 600 imported events does not spend the whole run", async () => {
  await withTwoStudents(async (h) => {
    // Every one of the loud student's events is dated before the quiet one's,
    // which is exactly what filled the old window.
    await h.db.insert(events).values(manyEvents(LOUD, 600, 1));
    await h.db.insert(events).values(manyEvents(QUIET, 1, 100));

    const { sendDueReminderEmails } = await import("@/lib/reminder-emails");
    const run = await sendDueReminderEmails(NOW);

    const to = attempts.map((a) => a.to);
    assert.equal(to.filter((t) => t === "loud@example.edu").length, 25, "one student's share of a run");
    assert.equal(to.filter((t) => t === "quiet@example.edu").length, 1, "the other student is still reminded");
    assert.deepEqual({ sent: run.sent, failed: run.failed, skipped: run.skipped }, { sent: 26, failed: 0, skipped: 0 });

    // What the share left behind is unmarked, so the next run picks it up.
    const unsent = await h.db.query.events.findMany({ columns: { id: true, reminderEmailSentAt: true } });
    assert.equal(unsent.filter((e) => e.reminderEmailSentAt === null).length, 601 - 26);
  });
});

test("sends that keep failing still cannot starve anybody else", async () => {
  await withTwoStudents(async (h) => {
    failFor = (to) => to === "loud@example.edu";
    await h.db.insert(events).values(manyEvents(LOUD, 600, 1));
    await h.db.insert(events).values(manyEvents(QUIET, 1, 100));

    const { sendDueReminderEmails } = await import("@/lib/reminder-emails");
    for (let run = 0; run < 3; run++) {
      attempts.length = 0;
      const outcome = await sendDueReminderEmails(NOW);
      assert.equal(outcome.failed, 25, `run ${run + 1}: the failing student's share failed`);
      assert.equal(
        attempts.filter((a) => a.to === "quiet@example.edu").length,
        run === 0 ? 1 : 0,
        `run ${run + 1}: the quiet student was reached on the first run and is done`,
      );
    }
  });
});

test("an owner with no address takes a share, not the window", async () => {
  await withTwoStudents(async (h) => {
    await h.db.insert(events).values(manyEvents(NO_EMAIL, 600, 1));
    await h.db.insert(events).values(manyEvents(QUIET, 2, 100));

    const { sendDueReminderEmails } = await import("@/lib/reminder-emails");
    const run = await sendDueReminderEmails(NOW);
    assert.deepEqual({ sent: run.sent, failed: run.failed, skipped: run.skipped }, { sent: 2, failed: 0, skipped: 25 });
    assert.deepEqual(
      attempts.map((a) => a.to),
      ["quiet@example.edu", "quiet@example.edu"],
    );
  });
});

test("an ordinary week still sends everything in it, oldest first", async () => {
  await withTwoStudents(async (h) => {
    await h.db.insert(events).values([
      ...manyEvents(LOUD, 3, 48),
      ...manyEvents(QUIET, 2, 1),
      // Outside the lead window, completed, and already emailed: all skipped
      // the same way they were before.
      { userId: QUIET, type: "deadline" as const, title: "Too far off", eventDate: new Date(NOW.getTime() + 40 * 24 * HOUR) },
      { userId: QUIET, type: "deadline" as const, title: "Done", eventDate: new Date(NOW.getTime() + 2 * HOUR), completed: true },
      { userId: QUIET, type: "deadline" as const, title: "Already sent", eventDate: new Date(NOW.getTime() + 3 * HOUR), reminderEmailSentAt: NOW },
    ]);

    const { sendDueReminderEmails } = await import("@/lib/reminder-emails");
    const run = await sendDueReminderEmails(NOW);
    assert.deepEqual({ sent: run.sent, failed: run.failed, skipped: run.skipped }, { sent: 5, failed: 0, skipped: 0 });
    assert.deepEqual(
      attempts.map((a) => a.to),
      ["quiet@example.edu", "quiet@example.edu", "loud@example.edu", "loud@example.edu", "loud@example.edu"],
      "soonest first, as before",
    );
    assert.match(attempts[0].subject, /^Coming up: Imported row 0$/);
  });
});
