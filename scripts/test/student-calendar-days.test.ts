// "Today", "tomorrow" and "1d ago" are the student's days, not the server's.
//
// The server runs in UTC. A student in New York is four or five hours behind,
// so for the last few hours of every evening the server has already started
// tomorrow. Anything that counted days on the server's clock - by
// setHours(0, 0, 0, 0) - told that student their 7pm coffee chat was "1d ago"
// at 10pm, and cut tonight's recruiting event off a firm page at 8pm.
//
// Everything here goes through the real queries (getAllTasks,
// listFirmRecruitingEvents) over an in-memory PGlite migrated from
// drizzle/*.sql. NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed,
// fetch throws.

// Production (Vercel) runs in UTC. Pin it, so anything that reads the server's
// own clock instead of the student's behaves here as it does there.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import "./helpers/no-network";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { events, firmRecruitingEvents, firms, users } from "@/db/schema";
import { listFirmRecruitingEvents } from "@/lib/recruiting-events-feed";
import { startOfLocalDay, zonedTime } from "@/lib/time-zone";
import { getAllTasks } from "@/lib/today-tasks";

delete process.env.DATABASE_URL;

const TZ = "America/New_York";

/** An instant by the New York wall clock. */
const et = (y: number, m: number, d: number, h: number, min = 0) => zonedTime(y, m, d, h, min, TZ);
/** Tuesday 22 September 2026, by the New York wall clock. */
const tue = (h: number, min = 0) => et(2026, 9, 22, h, min);

/** 10pm in New York - already 2am Wednesday in UTC. */
const NOW = tue(22);

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

async function mkUser() {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({ email: `calendar-days-${seq}-${Date.now()}@example.edu`, passwordHash: "x", name: `Student ${seq}` })
    .returning();
  return u;
}

test("the scenario is real: 10pm in New York is already tomorrow on the server's clock", () => {
  assert.equal(new Date().getTimezoneOffset(), 0, "TZ is pinned to UTC");
  assert.equal(NOW.toISOString(), "2026-09-23T02:00:00.000Z");
  // What setHours(0, 0, 0, 0) used to call "today": UTC Wednesday.
  const serverMidnight = new Date(NOW);
  serverMidnight.setHours(0, 0, 0, 0);
  assert.ok(tue(19).getTime() < serverMidnight.getTime(), "7pm ET falls before the server's midnight");
});

describe("startOfLocalDay", () => {
  test("is the student's midnight, not the server's", () => {
    assert.equal(startOfLocalDay(NOW, TZ).toISOString(), tue(0).toISOString());
    assert.equal(startOfLocalDay(NOW, TZ).toISOString(), "2026-09-22T04:00:00.000Z");
  });

  test("just after midnight is the new day", () => {
    assert.equal(startOfLocalDay(et(2026, 9, 23, 0, 30), TZ).toISOString(), et(2026, 9, 23, 0).toISOString());
  });

  test("follows the zone off daylight time", () => {
    // 10pm on 2 December in New York is 3am UTC on the 3rd, and midnight is 5am UTC.
    assert.equal(startOfLocalDay(et(2026, 12, 2, 22), TZ).toISOString(), "2026-12-02T05:00:00.000Z");
  });

  test("another zone counts its own day", () => {
    const la = "America/Los_Angeles";
    const now = zonedTime(2026, 9, 22, 22, 0, la);
    assert.equal(startOfLocalDay(now, la).toISOString(), zonedTime(2026, 9, 22, 0, 0, la).toISOString());
  });
});

describe("to-do list rows count days on the student's calendar", () => {
  test("an 11pm Schedule entry viewed at 10pm reads today", async () => {
    const u = await mkUser();
    // Still ahead at 10pm. (One that has already ended leaves the list for its
    // thank-you row, whatever the day - see today-tasks.)
    await h.db.insert(events).values({ userId: u.id, type: "coffee_chat", title: "Coffee with an analyst", eventDate: tue(23), completed: false });

    const tasks = await getAllTasks(u, NOW);
    const row = tasks.find((t) => t.kind === "event");
    // 11pm in New York is already Wednesday in UTC: under the server's clock
    // this read "tomorrow".
    assert.ok(row, "tonight's entry is still on the list");
    assert.equal(row.detail, "Scheduled today");
    assert.equal(row.score, 80);
  });

  test("a 7pm deadline viewed at 10pm reads today and scores as today", async () => {
    const u = await mkUser();
    await h.db.insert(events).values({ userId: u.id, type: "deadline", title: "Evercore application", eventDate: tue(19), completed: false });

    const row = (await getAllTasks(u, NOW)).find((t) => t.kind === "deadline");
    assert.ok(row);
    assert.equal(row.detail, "Application deadline today");
    assert.equal(row.score, 100);
  });

  test("tomorrow morning viewed tonight reads tomorrow", async () => {
    const u = await mkUser();
    // 9am Wednesday in New York is Wednesday in UTC too - the server's clock
    // called this "today" because it had already moved on to Wednesday.
    await h.db.insert(events).values({ userId: u.id, type: "meeting", title: "Call with a VP", eventDate: et(2026, 9, 23, 9), completed: false });

    const row = (await getAllTasks(u, NOW)).find((t) => t.kind === "event");
    assert.ok(row);
    assert.equal(row.detail, "Scheduled tomorrow");
    assert.equal(row.score, 76);
  });

  test("yesterday evening's deadline reads 1d ago", async () => {
    const u = await mkUser();
    await h.db.insert(events).values({ userId: u.id, type: "deadline", title: "Lazard application", eventDate: et(2026, 9, 21, 19), completed: false });

    const row = (await getAllTasks(u, NOW)).find((t) => t.kind === "deadline");
    assert.ok(row);
    assert.equal(row.detail, "Application deadline 1d ago");
  });
});

describe("a firm's recruiting events are cut at the student's midnight", () => {
  test("tonight's 7pm event is still listed at 10pm; last night's is not", async () => {
    const [firm] = await h.db
      .insert(firms)
      .values({
        slug: `calendar-days-firm-${Date.now()}`,
        name: "Calendar Days Partners",
        headquarters: "New York",
        keyOffices: "New York",
        website: "example.com",
        description: "A test firm.",
      })
      .returning();
    await h.db.insert(firmRecruitingEvents).values([
      { firmId: firm.id, title: "Tonight's info session", eventDate: tue(19), eventUrl: "https://example.com/tonight" },
      { firmId: firm.id, title: "Last night's info session", eventDate: et(2026, 9, 21, 19), eventUrl: "https://example.com/last-night" },
    ]);

    const titles = (await listFirmRecruitingEvents(firm.id, NOW, undefined, TZ)).map((e) => e.title);
    assert.deepEqual(titles, ["Tonight's info session"]);
  });
});
