// "Your Evercore application closes in 3 days, and you haven't applied" -
// adversarially, pure and end to end against a real (in-memory) Postgres.
//
// The spec (the owner's decisions):
//   - Which: tracker entries still not_started / in_progress, plus open real
//     postings at firms on the student's list that fit them (the Upcoming
//     panel's admission, uncapped). A tracker entry and a posting for the same
//     role are ONE application. Anything submitted / interviewing / offer /
//     rejected is never reminded. A tracker entry with no open posting is
//     reminded only with a linked "deadline" event on the Schedule, counted on
//     the day it falls on for the student.
//   - When: banner + bell job at 14, 7, 3, 1 and 0 days (a missed mark fires at
//     the next visit in its band, never twice), on the student's calendar. The
//     day-of banner names the cut-off time. A to-do row "Apply to <firm>" from
//     14 days out until done. Rolling: banner weekly, to-do row the whole time.
//   - Stops: "I applied" (banner or to-do tick -> markReminderApplied), the
//     posting closing / withdrawn, the deadline passing (bell job expires at
//     the end of the deadline day, local).
//
// Every checkpoint is a PAGE LOAD (the banner queue drained the way the layout
// does it - file the bell job, record the banner - then the to-do list, then
// the bell), and each one checks banners, to-do rows, bell rows and tracker
// rows. Server actions that need a signed-in user are replayed with the same
// lib calls, step for step.
//
// The clock is faked (global Date) so code that reads `new Date()` itself -
// getUpcomingApplications, postingTiming, the server actions - agrees with the
// simulated moment. The student's zone is the same `tz` cookie the app reads.
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
  activityEvents,
  applications,
  events,
  firms,
  flashesShown,
  internshipPostings,
  notifications,
  todoDismissals,
  userTopFirms,
  users,
} from "@/db/schema";
import {
  REMINDER_MARKS,
  REMINDER_TODO_DAYS,
  ROLLING_EVERY_DAYS,
  dueLabel,
  reminderDetail,
  reminderMark,
  reminderNotificationKey,
  reminderScore,
  reminderTaskId,
  selectReminders,
  type ReminderCandidate,
} from "@/lib/application-reminders";
import { deadlineFromPostingText } from "@/lib/posting-deadline";
import { localDateString, zonedTime } from "@/lib/time-zone";
import type { PendingFlash } from "@/lib/prompt-flash";
import type { NotificationList } from "@/lib/notifications";
import type { TodayTask } from "@/lib/today-tasks";

delete process.env.DATABASE_URL;

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";
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

// ================================================================== PURE

/** The mark the spec says is due at `n` days out, computed independently. */
function expectedMark(n: number): number | null {
  if (n < 0 || n > 14) return null;
  if (n === 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 3;
  if (n <= 7) return 7;
  return 14;
}

const utcDay = (iso: string) => new Date(`${iso}T00:00:00Z`);

function cand(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    key: "posting:p1",
    firmName: "Evercore",
    role: "2027 IB Summer Analyst",
    applyUrl: "https://evercore.example.com/apply/1",
    deadline: utcDay("2026-11-06"),
    deadlineTime: null,
    rolling: false,
    applicationId: null,
    ...over,
  };
}

/** Local wall-clock `h:min` on the day `n` days before `iso`, in `tz`. */
function daysBefore(iso: string, n: number, h: number, min: number, tz: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return zonedTime(y, m, d - n, h, min, tz);
}

describe("pure: reminderMark", () => {
  for (let n = -3; n <= 25; n++) {
    test(`${n} days left -> mark ${expectedMark(n)}`, () => {
      assert.equal(reminderMark(n), expectedMark(n));
    });
  }
  test("the marks are exactly 14, 7, 3, 1, 0 and the to-do window is 14", () => {
    assert.deepEqual([...REMINDER_MARKS], [14, 7, 3, 1, 0]);
    assert.equal(REMINDER_TODO_DAYS, 14);
    assert.equal(ROLLING_EVERY_DAYS, 7);
  });
});

// Every day 0-20 out (and 1-2 days after), three local hours each (a minute
// past midnight, noon, a minute to midnight), in zones on both sides of UTC,
// for a countdown crossing the autumn DST change and one crossing the spring.
const ZONES = [NY, LA, "Europe/London", "Australia/Sydney", "Pacific/Kiritimati", "Pacific/Pago_Pago"];
const DST_DEADLINES = ["2026-11-10", "2027-03-20"];
const HOURS: [number, number][] = [
  [0, 1],
  [12, 0],
  [23, 59],
];

describe("pure: selectReminders, every day 0-20 out, across zones and DST", () => {
  for (const tz of ZONES) {
    for (const iso of DST_DEADLINES) {
      for (let n = -2; n <= 20; n++) {
        test(`${tz} · deadline ${iso} · ${n} days out`, () => {
          for (const [h, min] of HOURS) {
            const now = daysBefore(iso, n, h, min, tz);
            // Sanity: the instant really is on the intended local day.
            const [y, m, d] = iso.split("-").map(Number);
            assert.equal(
              localDateString(now, tz),
              new RealDate(RealDate.UTC(y, m - 1, d - n)).toISOString().slice(0, 10),
            );
            const out = selectReminders({ candidates: [cand({ deadline: utcDay(iso) })], now, timeZone: tz });
            if (n < 0) {
              assert.equal(out.length, 0, `past deadline must not remind (${h}:${min})`);
              continue;
            }
            assert.equal(out.length, 1, `${h}:${min}`);
            const r = out[0];
            assert.equal(r.daysLeft, n, `${h}:${min}`);
            const mark = expectedMark(n);
            assert.equal(r.flashKey, mark === null ? null : `deadline:posting:p1:${iso}:m${mark}`, `${h}:${min}`);
            assert.equal(r.onTodo, n <= 14, `${h}:${min}`);
          }
        });
      }
    }
  }
});

describe("pure: time zone boundaries", () => {
  test("the same instant is a different mark on either side of the date line", () => {
    // 2026-11-05 11:00 UTC: Kiritimati (UTC+14) is already on the 6th - due
    // today; Pago Pago (UTC-11) is still on the 5th... at 00:00 - due tomorrow.
    const now = new RealDate("2026-11-05T11:00:00Z");
    const [kir] = selectReminders({ candidates: [cand()], now, timeZone: "Pacific/Kiritimati" });
    const [pago] = selectReminders({ candidates: [cand()], now, timeZone: "Pacific/Pago_Pago" });
    assert.equal(kir.daysLeft, 0);
    assert.equal(pago.daysLeft, 1);
  });
  test("a junk tz cookie falls back to New York, not UTC", () => {
    // 2026-11-06 02:00 UTC is 9pm on the 5th in New York: due tomorrow.
    const now = new RealDate("2026-11-06T02:00:00Z");
    const [r] = selectReminders({ candidates: [cand()], now, timeZone: "Not/AZone" });
    assert.equal(r.daysLeft, 1);
  });
  test("the default zone is New York", () => {
    const now = new RealDate("2026-11-06T02:00:00Z");
    const [r] = selectReminders({ candidates: [cand()], now });
    assert.equal(r.daysLeft, 1);
  });
  test("the fall-back hour (1:30am twice on 1 Nov in New York) is one day", () => {
    const first = new RealDate("2026-11-01T05:30:00Z"); // 1:30 EDT
    const second = new RealDate("2026-11-01T06:30:00Z"); // 1:30 EST
    for (const now of [first, second]) {
      const [r] = selectReminders({ candidates: [cand()], now, timeZone: NY });
      assert.equal(r.daysLeft, 5);
      assert.equal(r.flashKey, "deadline:posting:p1:2026-11-06:m7");
    }
  });
  test("an Invalid Date deadline is dropped, not reminded as NaN days", () => {
    const out = selectReminders({ candidates: [cand({ deadline: new RealDate("nope") })], now: new RealDate("2026-11-01T12:00:00Z") });
    assert.equal(out.length, 0);
  });
  test("a deadline that moves is a new countdown (the date is in the key)", () => {
    const now = daysBefore("2026-11-06", 5, 9, 0, NY);
    const [a] = selectReminders({ candidates: [cand()], now, timeZone: NY });
    const [b] = selectReminders({ candidates: [cand({ deadline: utcDay("2026-11-07") })], now, timeZone: NY });
    assert.notEqual(a.flashKey, b.flashKey);
  });
});

describe("pure: rolling rhythm", () => {
  const today = "2026-10-20";
  const now = zonedTime(2026, 10, 20, 9, 0, NY);
  test("never shown -> due today, keyed by today", () => {
    const [r] = selectReminders({ candidates: [cand({ rolling: true, deadline: null })], now, timeZone: NY });
    assert.equal(r.flashKey, `deadline:posting:p1:rolling:${today}`);
    assert.equal(r.daysLeft, null);
    assert.equal(r.onTodo, true);
  });
  for (let since = 0; since <= 15; since++) {
    test(`last spoke ${since} days ago -> ${since >= 7 ? "due" : "quiet"}`, () => {
      const last = new RealDate(RealDate.UTC(2026, 9, 20 - since)).toISOString().slice(0, 10);
      const [r] = selectReminders({
        candidates: [cand({ rolling: true, deadline: null })],
        now,
        timeZone: NY,
        lastRollingShown: new Map([["posting:p1", last]]),
      });
      assert.equal(r.flashKey, since >= 7 ? `deadline:posting:p1:rolling:${today}` : null);
      assert.equal(r.onTodo, true, "the to-do row stays the whole time");
    });
  }
  test("the week is counted in calendar days across the DST change", () => {
    // Last spoke 28 Oct in New York; 4 Nov is 7 calendar days later though
    // only 7*24+1 hours have passed.
    const [r] = selectReminders({
      candidates: [cand({ rolling: true, deadline: null })],
      now: zonedTime(2026, 11, 4, 0, 5, NY),
      timeZone: NY,
      lastRollingShown: new Map([["posting:p1", "2026-10-28"]]),
    });
    assert.equal(r.flashKey, "deadline:posting:p1:rolling:2026-11-04");
  });
  test("another application's last banner does not quiet this one", () => {
    const [r] = selectReminders({
      candidates: [cand({ rolling: true, deadline: null })],
      now,
      timeZone: NY,
      lastRollingShown: new Map([["posting:p2", today]]),
    });
    assert.ok(r.flashKey);
  });
  test("no date and not rolling says nothing", () => {
    assert.equal(selectReminders({ candidates: [cand({ deadline: null })], now }).length, 0);
  });
});

describe("pure: sorting and de-duplication", () => {
  const now = zonedTime(2026, 10, 20, 9, 0, NY);
  test("soonest first, rolling last, ties by firm then role", () => {
    const out = selectReminders({
      now,
      timeZone: NY,
      candidates: [
        cand({ key: "a", firmName: "Zeta", deadline: null, rolling: true }),
        cand({ key: "b", firmName: "Moelis", deadline: utcDay("2026-10-30") }),
        cand({ key: "c", firmName: "Alpha", deadline: null, rolling: true }),
        cand({ key: "d", firmName: "Lazard", deadline: utcDay("2026-10-22") }),
        cand({ key: "e", firmName: "Evercore", role: "B role", deadline: utcDay("2026-10-30") }),
        cand({ key: "f", firmName: "Evercore", role: "A role", deadline: utcDay("2026-10-30") }),
        cand({ key: "g", firmName: "Centerview", deadline: utcDay("2026-10-20") }),
      ],
    });
    assert.deepEqual(
      out.map((r) => r.key),
      ["g", "d", "f", "e", "b", "c", "a"],
    );
  });
  test("a key seen twice is one reminder (the first)", () => {
    const out = selectReminders({
      now,
      timeZone: NY,
      candidates: [cand({ key: "x", firmName: "First" }), cand({ key: "x", firmName: "Second" })],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].firmName, "First");
  });
  test("a closed one does not hide a later one", () => {
    const out = selectReminders({
      now,
      timeZone: NY,
      candidates: [cand({ key: "old", deadline: utcDay("2026-10-19") }), cand({ key: "new", deadline: utcDay("2026-10-21") })],
    });
    assert.deepEqual(
      out.map((r) => r.key),
      ["new"],
    );
  });
});

describe("pure: labels and score", () => {
  const cases: [number | null, string][] = [
    [null, "rolling"],
    [0, "due today"],
    [1, "due tomorrow"],
    [2, "due in 2 days"],
    [7, "due in 7 days"],
    [14, "due in 14 days"],
  ];
  for (const [daysLeft, label] of cases) {
    test(`dueLabel(${daysLeft}) = ${label}`, () => assert.equal(dueLabel({ daysLeft }), label));
  }
  test("day-of detail names the stated cut-off time", () => {
    assert.equal(
      reminderDetail({ role: "IB Summer Analyst", daysLeft: 0, deadlineTime: "11:55 PM EST" }),
      "IB Summer Analyst · you haven't applied yet · closes 11:55 PM EST",
    );
  });
  test("the cut-off time is only on the day itself", () => {
    for (const d of [1, 3, 7, 14]) {
      assert.equal(
        reminderDetail({ role: "IB Summer Analyst", daysLeft: d, deadlineTime: "11:55 PM EST" }),
        "IB Summer Analyst · you haven't applied yet",
      );
    }
  });
  test("day-of detail with no stated time says no time", () => {
    assert.equal(reminderDetail({ role: "R", daysLeft: 0, deadlineTime: null }), "R · you haven't applied yet");
  });
  test("rolling detail", () => {
    assert.equal(reminderDetail({ role: "R", daysLeft: null, deadlineTime: null }), "R · rolling, earlier is better");
  });
  test("score climbs as the deadline nears and never drops below 55", () => {
    let prev = -1;
    for (let d = 20; d >= 0; d--) {
      const s = reminderScore({ daysLeft: d });
      assert.ok(s >= 55 && s <= 99, `${d}: ${s}`);
      assert.ok(s >= prev, `score at ${d} (${s}) below the day before (${prev})`);
      prev = s;
    }
    assert.equal(reminderScore({ daysLeft: 0 }), 99);
    assert.equal(reminderScore({ daysLeft: 1 }), 96);
    assert.equal(reminderScore({ daysLeft: null }), 60);
  });
  test("ids and keys", () => {
    assert.equal(reminderNotificationKey("posting:x"), "deadline:posting:x");
    assert.equal(reminderTaskId("posting:x"), "deadline-posting:x");
  });
  test("the fixture's stated deadline parses to the cut-off the banner should name", () => {
    const got = deadlineFromPostingText(CUTOFF_DESC);
    assert.equal(got?.timeText, "11:55 PM EST");
    assert.equal(got?.date?.toISOString(), "2026-11-06T00:00:00.000Z");
  });
});

// ================================================================== DB

type Libs = typeof import("@/lib/prompt-flash") &
  typeof import("@/lib/notifications") &
  typeof import("@/lib/today-list") &
  typeof import("@/lib/today-tasks") &
  typeof import("@/lib/application-reminders-db");
let L: Libs;
type Storage = { run: <R>(store: never, fn: () => R) => R };
let workStorage: Storage;
let workUnitStorage: Storage;

function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const jar = { get: (name: string) => (name === "tz" ? { name, value: tz } : undefined) };
  return workStorage.run({ route: "/reminders" } as never, () =>
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
    ...(await import("@/lib/application-reminders-db")),
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

// ------------------------------------------------------------------ fixtures

/** The deadline every dated journey counts down to: Friday 6 Nov 2026. The
 *  countdown crosses the end of daylight saving in New York (1 Nov). */
const DL = "2026-11-06";
const DEADLINE = utcDay(DL);
/** Local `h:min` on the day `n` days before the deadline. */
const out = (n: number, hr = 9, min = 0, tz = NY) => daysBefore(DL, n, hr, min, tz);
const ROLE = "2027 Investment Banking Summer Analyst";
const CUTOFF_DESC =
  "Ten-week summer analyst programme in investment banking. Application Deadline: 06 Nov 2026 11:55 PM EST";

type User = typeof users.$inferSelect;
type Student = { u: User; tz: string };
let seq = 0;

async function mkStudent(tag: string, tz = NY, over: Partial<typeof users.$inferInsert> = {}): Promise<Student> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `rem-${tag}-${seq}@example.edu`,
      passwordHash: "x",
      name: `Student ${tag}`,
      gradYear: 2028,
      targetInternshipYear: 2027,
      preferredCategories: ["investment_banking"],
      nicheInterests: [],
      ...over,
    })
    .returning();
  return { u, tz };
}

async function mkFirm(name: string, aliases: string[] = []) {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `rem-${name.toLowerCase().replace(/\W+/g, "-")}-${seq}`,
      name,
      aliases,
      headquarters: "New York, NY",
      keyOffices: "New York",
      website: `firm${seq}.example.com`,
      description: "A firm.",
    })
    .returning();
  return f;
}

async function track(s: Student, firmId: string) {
  await h.db.insert(userTopFirms).values({ userId: s.u.id, firmId });
}

type PostingOpts = Partial<typeof internshipPostings.$inferInsert>;

async function mkPosting(firm: { id: string; website: string }, o: PostingOpts = {}) {
  seq += 1;
  const [p] = await h.db
    .insert(internshipPostings)
    .values({
      firmId: firm.id,
      categories: ["investment_banking"],
      roleTitle: ROLE,
      location: "New York, NY",
      programYear: 2027,
      eligibleGradYears: [2028],
      deadlineStatus: "confirmed",
      deadlineDate: DEADLINE,
      opensAt: null,
      descriptionFull: CUTOFF_DESC,
      sourceUrl: `https://${firm.website}/careers`,
      applicationUrl: `https://${firm.website}/apply/${seq}`,
      isActive: true,
      ...o,
    })
    .returning();
  return p;
}

async function updatePosting(id: string, set: PostingOpts) {
  await h.db.update(internshipPostings).set(set).where(eq(internshipPostings.id, id));
}

/** A tracker entry, as the Track button or the /applications form makes one. */
async function mkApplication(s: Student, firm: string, role: string, over: Partial<typeof applications.$inferInsert> = {}) {
  const [a] = await h.db
    .insert(applications)
    .values({ userId: s.u.id, firm, role, ...over })
    .returning();
  return a;
}

async function mkDeadlineEvent(s: Student, applicationId: string | null, eventDate: Date, over: Partial<typeof events.$inferInsert> = {}) {
  const [e] = await h.db
    .insert(events)
    .values({ userId: s.u.id, type: "deadline", title: "Application deadline", eventDate, applicationId, ...over })
    .returning();
  return e;
}

/** A student tracking one firm with one open, dated posting. */
async function standard(tag: string, opts: { tz?: string; firm?: string; aliases?: string[]; posting?: PostingOpts } = {}) {
  const s = await mkStudent(tag, opts.tz ?? NY);
  const firm = await mkFirm(opts.firm ?? "Evercore", opts.aliases ?? []);
  await track(s, firm.id);
  const posting = await mkPosting(firm, opts.posting ?? {});
  return { s, firm, posting, key: `posting:${posting.id}` };
}

// ------------------------------------------------------------------ a page load

function act<T>(s: Student, now: Date, fn: () => Promise<T>): Promise<T> {
  clock(now);
  return inZone(s.tz, fn);
}

type BellRow = typeof notifications.$inferSelect;
type Visit = {
  now: Date;
  banners: PendingFlash[];
  /** Deadline-reminder banners only. */
  rem: PendingFlash[];
  all: TodayTask[];
  /** Deadline-reminder to-do rows only. */
  rows: TodayTask[];
  bell: NotificationList;
  /** Every application_deadline row, open or closed, straight from the table. */
  jobs: BellRow[];
  tracker: (typeof applications.$inferSelect)[];
};

const isReminder = (p: PendingFlash) => p.notifications.some((n) => n.kind === "application_deadline");

async function jobsOf(s: Student) {
  return h.db.query.notifications.findMany({
    where: and(eq(notifications.userId, s.u.id), eq(notifications.kind, "application_deadline")),
  });
}
async function trackerOf(s: Student) {
  return h.db.query.applications.findMany({ where: eq(applications.userId, s.u.id) });
}

/** One page load: drain the banner queue (markPromptFlashSeen step for step),
 *  then the whole to-do list, then the bell. */
async function visit(s: Student, now: Date): Promise<Visit> {
  return act(s, now, async () => {
    const banners: PendingFlash[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await L.getPendingFlash(s.u, now);
      if (!p) break;
      for (const n of p.notifications) await L.upsertNotification({ userId: s.u.id, ...n, now });
      await L.markFlashShown(s.u.id, p.flashKey);
      banners.push(p);
    }
    const all = await L.getAllTasks(s.u, now);
    const bell = await L.getNotifications(s.u.id, now);
    return {
      now,
      banners,
      rem: banners.filter(isReminder),
      all,
      rows: all.filter((t) => t.id.startsWith("deadline-")),
      bell,
      jobs: await jobsOf(s),
      tracker: await trackerOf(s),
    };
  });
}

// ------------------------------------------------------------------ the student's actions

/** "I applied" on the banner: markAppliedFromReminder, step for step. */
function appliedByBanner(s: Student, now: Date, key: string): Promise<boolean> {
  return act(s, now, async () => {
    if (typeof key !== "string" || key.length > 200) return false;
    return L.markReminderApplied(s.u, key, now);
  });
}

/** Ticking the to-do row: completeTask, step for step (the deadline branch). */
function tickTodo(s: Student, now: Date, taskId: string): Promise<boolean> {
  return act(s, now, async () => {
    const t = (await L.getAllTasks(s.u, now)).find((x) => x.id === taskId);
    if (!t) return false;
    if (t.id.startsWith("deadline-")) await L.markReminderApplied(s.u, t.id.slice("deadline-".length), now);
    await L.recordCompleted(s.u.id, [t], "manual", now);
    await h.db.insert(todoDismissals).values({ userId: s.u.id, taskId: t.id }).onConflictDoNothing();
    return true;
  });
}

/** The tracker page's checkbox: markApplicationApplied, step for step. */
function trackerApplied(s: Student, now: Date, applicationId: string) {
  return act(s, now, async () => {
    const existing = await h.db.query.applications.findFirst({
      where: and(eq(applications.id, applicationId), eq(applications.userId, s.u.id)),
    });
    if (!existing) return;
    if (existing.status !== "not_started" && existing.status !== "in_progress") return;
    await h.db
      .update(applications)
      .set({ status: "submitted", appliedDate: existing.appliedDate ?? new Date().toISOString().slice(0, 10), updatedAt: new Date() })
      .where(and(eq(applications.id, applicationId), eq(applications.userId, s.u.id)));
  });
}

const openJobs = (v: Visit) => v.jobs.filter((j) => !j.doneAt);
const expiryFor = (iso: string, tz: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return zonedTime(y, m, d + 1, 0, 0, tz);
};

/** The checks at one point in a countdown for a student who has not applied. */
function assertCountdown(v: Visit, n: number, o: { key: string; firm: string; role: string; url: string; banner: number | null; tz?: string; cutoff?: string | null; iso?: string }) {
  const iso = o.iso ?? DL;
  const label = n === 0 ? "due today" : n === 1 ? "due tomorrow" : `due in ${n} days`;
  // Banner
  if (o.banner === null) {
    assert.deepEqual(v.rem.map((b) => b.flashKey), [], `no banner expected at ${n} days`);
  } else {
    assert.equal(v.rem.length, 1, `exactly one banner at ${n} days, got ${v.rem.map((b) => b.flashKey).join(", ")}`);
    const b = v.rem[0];
    assert.equal(b.flashKey, `deadline:${o.key}:${iso}:m${o.banner}`);
    assert.equal(b.chip, label);
    assert.equal(b.subject, o.firm);
    const cut = n === 0 && o.cutoff ? ` · closes ${o.cutoff}` : "";
    assert.equal(b.detail, `${o.role} · you haven't applied yet${cut}`);
    assert.equal(b.cta, "Apply");
    assert.equal(b.href, o.url);
    assert.equal(b.doneKey, o.key);
    assert.equal(b.doneLabel, "I applied");
    assert.equal(b.doneAction, "applied");
  }
  // To-do row
  if (n >= 0 && n <= 14) {
    assert.equal(v.rows.length, 1, `one to-do row at ${n} days`);
    const r = v.rows[0];
    assert.equal(r.id, `deadline-${o.key}`);
    assert.equal(r.kind, "apply");
    assert.equal(r.title, `Apply to ${o.firm}`);
    const cut = n === 0 && o.cutoff ? ` · closes ${o.cutoff}` : "";
    assert.equal(r.detail, `${o.role} · ${label}${cut}`);
    assert.equal(r.href, o.url);
  } else {
    assert.equal(v.rows.length, 0, `no to-do row at ${n} days`);
  }
  // Tracker: nothing written for someone who has not applied.
  assert.equal(v.tracker.filter((a) => a.status === "submitted").length, 0);
}

// ------------------------------------------------------------------ journeys

describe("journey: a student who never applies (NY, countdown across DST)", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  let url: string;
  before(async () => {
    J = await standard("never");
    url = J.posting.applicationUrl!;
  });
  for (const n of [18, 16, 15, 14, 13, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
    test(`${n} days out, 9am`, async () => {
      const v = await visit(J.s, out(n));
      const banner = [14, 7, 3, 1, 0].includes(n) ? n : null;
      assertCountdown(v, n, { key: J.key, firm: "Evercore", role: ROLE, url, banner, cutoff: "11:55 PM EST" });
      // Bell: nothing before the first banner, then ONE open job.
      if (n > 14) {
        assert.equal(v.jobs.length, 0);
      } else {
        assert.equal(v.jobs.length, 1, "one job, however many banners");
        const j = v.jobs[0];
        assert.equal(j.doneAt, null);
        assert.equal(j.dedupeKey, `deadline:${J.key}`);
        assert.equal(j.title, "Apply to Evercore");
        assert.equal(j.body, `${ROLE} · due 6 Nov`);
        assert.equal(j.href, url);
        assert.equal(j.expiresAt?.toISOString(), expiryFor(DL, NY).toISOString());
        assert.ok(v.bell.open.some((i) => i.id === j.id), "listed under the bell");
      }
    });
  }
  test("a second load the same day drops nothing new", async () => {
    const v = await visit(J.s, out(0, 15));
    assert.equal(v.rem.length, 0);
    assert.equal(v.rows.length, 1);
    assert.equal(openJobs(v).length, 1);
  });
  test("23:59 on the deadline day: still live", async () => {
    const v = await visit(J.s, out(0, 23, 59));
    assert.equal(v.rows.length, 1);
    assert.equal(openJobs(v).length, 1);
  });
  test("00:01 the day after: row gone, job expired (not 'auto')", async () => {
    const v = await visit(J.s, out(-1, 0, 1));
    assert.equal(v.rem.length, 0);
    assert.equal(v.rows.length, 0);
    assert.equal(v.jobs.length, 1);
    assert.ok(v.jobs[0].doneAt);
    assert.equal(v.jobs[0].doneSource, "expired");
    assert.equal(v.bell.open.filter((i) => i.kind === "application_deadline").length, 0);
    assert.equal(v.tracker.length, 0);
  });
  test("a week later: still nothing, still expired", async () => {
    const v = await visit(J.s, out(-7));
    assert.equal(v.rem.length + v.rows.length, 0);
    assert.equal(v.jobs[0].doneSource, "expired");
  });
  test("exactly five reminder banners were ever recorded", async () => {
    const shown = await h.db.query.flashesShown.findMany({ where: eq(flashesShown.userId, J.s.u.id) });
    assert.deepEqual(
      shown.map((r) => r.flashKey).filter((k) => k.startsWith("deadline:")).sort(),
      [0, 1, 14, 3, 7].map((m) => `deadline:${J.key}:${DL}:m${m}`).sort(),
    );
  });
});

describe("journey: Los Angeles student, visits at the edges of the day", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  before(async () => {
    J = await standard("la", { tz: LA });
  });
  test("11:59pm the night before 14 days out: nothing (15 days on their clock, 14 in UTC)", async () => {
    const v = await visit(J.s, out(15, 23, 59, LA));
    assert.equal(v.rem.length, 0);
    assert.equal(v.rows.length, 0);
  });
  test("00:01 at 14 days out: the 14-day banner", async () => {
    const v = await visit(J.s, out(14, 0, 1, LA));
    assert.equal(v.rem.length, 1);
    assert.equal(v.rem[0].chip, "due in 14 days");
  });
  test("5pm the day before the deadline (midnight UTC): 'due tomorrow', not today", async () => {
    const v = await visit(J.s, out(1, 17, 0, LA));
    assert.equal(v.rem.length, 1);
    assert.equal(v.rem[0].chip, "due tomorrow");
    assert.equal(v.rows[0].detail, `${ROLE} · due tomorrow`);
  });
  test("11:30pm on the deadline day (07:30 UTC the day after): still due today", async () => {
    const v = await visit(J.s, out(0, 23, 30, LA));
    assert.equal(v.rem.length, 1, "the day-of banner, first visit that day");
    assert.equal(v.rem[0].chip, "due today");
    assert.equal(v.rows.length, 1);
    assert.equal(openJobs(v).length, 1);
    assert.equal(openJobs(v)[0].expiresAt?.toISOString(), expiryFor(DL, LA).toISOString());
  });
  test("00:05 the day after, on their clock: expired", async () => {
    const v = await visit(J.s, out(-1, 0, 5, LA));
    assert.equal(v.rows.length, 0);
    assert.equal(v.jobs[0].doneSource, "expired");
  });
});

describe("journey: applies at 5 days out, from the banner", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  before(async () => {
    J = await standard("banner5");
  });
  test("14 days: banner", async () => {
    const v = await visit(J.s, out(14));
    assert.equal(v.rem.length, 1);
  });
  test("5 days: the 7-day banner (missed at 7), then 'I applied' on it", async () => {
    const v = await visit(J.s, out(5));
    assert.equal(v.rem.length, 1);
    assert.equal(v.rem[0].flashKey, `deadline:${J.key}:${DL}:m7`);
    assert.equal(v.rem[0].chip, "due in 5 days");
    assert.equal(await appliedByBanner(J.s, out(5, 9, 1), v.rem[0].doneKey!), true);
  });
  test("right after: no row, job closed as the student's, tracker holds it as submitted", async () => {
    const v = await visit(J.s, out(5, 9, 2));
    assert.equal(v.rem.length, 0);
    assert.equal(v.rows.length, 0);
    assert.equal(v.jobs.length, 1);
    assert.equal(v.jobs[0].doneSource, "manual");
    assert.equal(v.tracker.length, 1);
    const a = v.tracker[0];
    assert.equal(a.firm, "Evercore");
    assert.equal(a.role, ROLE);
    assert.equal(a.status, "submitted");
    assert.equal(a.appliedDate, "2026-11-01");
    assert.equal(a.applicationUrl, J.posting.applicationUrl);
  });
  for (const n of [3, 1, 0, -1]) {
    test(`${n} days: silent, and the job stays 'manual'`, async () => {
      const v = await visit(J.s, out(n));
      assert.equal(v.rem.length, 0);
      assert.equal(v.rows.length, 0);
      assert.equal(v.jobs.length, 1);
      assert.equal(v.jobs[0].doneSource, "manual");
      assert.equal(v.tracker.length, 1);
    });
  }
  test("'I applied' again does nothing", async () => {
    assert.equal(await appliedByBanner(J.s, out(-1, 10), J.key), false);
    assert.equal((await trackerOf(J.s)).length, 1);
  });
});

describe("journey: applies at 5 days out, by ticking the to-do row", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  before(async () => {
    J = await standard("todo5");
  });
  test("14 and 7 days: banners", async () => {
    assert.equal((await visit(J.s, out(14))).rem.length, 1);
    assert.equal((await visit(J.s, out(7))).rem.length, 1);
  });
  test("5 days: tick the row", async () => {
    const v = await visit(J.s, out(5));
    assert.equal(v.rem.length, 0);
    assert.equal(v.rows.length, 1);
    assert.equal(await tickTodo(J.s, out(5, 9, 1), v.rows[0].id), true);
  });
  test("after: no row, no banner, manual close, one submitted tracker row", async () => {
    for (const n of [5, 3, 1, 0]) {
      const v = await visit(J.s, out(n, 12));
      assert.equal(v.rem.length, 0, `${n}`);
      assert.equal(v.rows.length, 0, `${n}`);
      assert.equal(v.jobs[0].doneSource, "manual", `${n}`);
      assert.equal(v.tracker.length, 1, `${n}`);
      assert.equal(v.tracker[0].status, "submitted");
    }
  });
  test("ticking it twice does nothing more", async () => {
    assert.equal(await tickTodo(J.s, out(0, 13), `deadline-${J.key}`), false);
    assert.equal((await trackerOf(J.s)).length, 1);
  });
});

describe("journey: applies at 5 days out, on the tracker page", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  let appId: string;
  before(async () => {
    J = await standard("tracker5");
    // Tracked from Discovery: same firm and role strings as the posting.
    appId = (await mkApplication(J.s, "Evercore", ROLE, { applicationUrl: J.posting.applicationUrl })).id;
  });
  test("14 days: ONE banner and ONE row for the tracked posting", async () => {
    const v = await visit(J.s, out(14));
    assert.equal(v.rem.length, 1);
    assert.equal(v.rows.length, 1);
    assert.equal(v.rem[0].doneKey, J.key);
  });
  test("5 days: 7-day banner, then the tracker checkbox", async () => {
    const v = await visit(J.s, out(5));
    assert.equal(v.rem.length, 1);
    await trackerApplied(J.s, out(5, 9, 1), appId);
  });
  test("after: silent, job closed by the app ('auto', not expired), still one tracker row", async () => {
    const v = await visit(J.s, out(5, 9, 2));
    assert.equal(v.rem.length, 0);
    assert.equal(v.rows.length, 0);
    assert.equal(v.jobs.length, 1);
    assert.equal(v.jobs[0].doneSource, "auto");
    assert.equal(v.tracker.length, 1);
    assert.equal(v.tracker[0].status, "submitted");
  });
  test("to the end: nothing, and the close stays 'auto'", async () => {
    for (const n of [3, 1, 0, -1]) {
      const v = await visit(J.s, out(n));
      assert.equal(v.rem.length + v.rows.length, 0, `${n}`);
      assert.equal(v.jobs[0].doneSource, "auto", `${n}`);
    }
  });
});

describe("journey: first visit at 5 days out", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  before(async () => {
    J = await standard("late");
  });
  const plan: [number, number | null][] = [
    [5, 7],
    [4, null],
    [3, 3],
    [2, null],
    [1, 1],
    [0, 0],
  ];
  for (const [n, banner] of plan) {
    test(`${n} days out -> ${banner === null ? "no banner" : `the ${banner}-day banner`}`, async () => {
      const v = await visit(J.s, out(n));
      assertCountdown(v, n, { key: J.key, firm: "Evercore", role: ROLE, url: J.posting.applicationUrl!, banner, cutoff: "11:55 PM EST" });
      assert.equal(v.jobs.length, 1);
      assert.equal(openJobs(v).length, 1);
    });
  }
  test("the 14-day mark was never fired late on top of the 7", async () => {
    const shown = await h.db.query.flashesShown.findMany({ where: eq(flashesShown.userId, J.s.u.id) });
    assert.ok(!shown.some((r) => r.flashKey.endsWith(":m14")));
  });
});

describe("journey: a mark whose band had no visit is not replayed later", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  before(async () => {
    J = await standard("gap");
  });
  test("14 days: 14-day banner", async () => {
    assert.equal((await visit(J.s, out(14))).rem[0]?.chip, "due in 14 days");
  });
  test("2 days (skipped the whole 7 band): one banner, the 3-day one", async () => {
    const v = await visit(J.s, out(2));
    assert.deepEqual(v.rem.map((b) => b.flashKey), [`deadline:${J.key}:${DL}:m3`]);
  });
});

describe("journey: tracker-only application with a Schedule deadline", () => {
  let s: Student;
  let appId: string;
  let key: string;
  before(async () => {
    s = await mkStudent("orphan");
    // Not a firm on their list, no posting anywhere: typed on /applications.
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst", {
      status: "in_progress",
      applicationUrl: "https://moelis.example.com/apply",
    });
    appId = a.id;
    key = `application:${appId}`;
    // 11:59pm Eastern on 6 Nov.
    await mkDeadlineEvent(s, appId, zonedTime(2026, 11, 6, 23, 59, NY));
  });
  for (const [n, banner] of [
    [15, null],
    [14, 14],
    [9, null],
    [7, 7],
    [3, 3],
    [1, 1],
    [0, 0],
  ] as [number, number | null][]) {
    test(`${n} days out`, async () => {
      const v = await visit(s, out(n));
      assertCountdown(v, n, {
        key,
        firm: "Moelis & Company",
        role: "Summer Analyst",
        url: "https://moelis.example.com/apply",
        banner,
        cutoff: null,
      });
      if (n <= 14) {
        assert.equal(openJobs(v).length, 1);
        assert.equal(openJobs(v)[0].expiresAt?.toISOString(), expiryFor(DL, NY).toISOString());
      }
    });
  }
  test("the day after: expired", async () => {
    const v = await visit(s, out(-1));
    assert.equal(v.rows.length, 0);
    assert.equal(v.jobs[0].doneSource, "expired");
    assert.equal(v.tracker[0].status, "in_progress", "the tracker is not touched");
  });
});

describe("tracker-only: which entries speak", () => {
  test("no Schedule deadline -> no reminder", async () => {
    const s = await mkStudent("orphan-none");
    await mkApplication(s, "Moelis & Company", "Summer Analyst");
    const v = await visit(s, out(3));
    assert.equal(v.rem.length + v.rows.length + v.jobs.length, 0);
  });
  test("a deadline already ticked done on the Schedule -> no reminder", async () => {
    const s = await mkStudent("orphan-done");
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst");
    await mkDeadlineEvent(s, a.id, zonedTime(2026, 11, 6, 17, 0, NY), { completed: true });
    const v = await visit(s, out(3));
    assert.equal(v.rows.length, 0);
  });
  test("a meeting (not a deadline) linked to it -> no reminder", async () => {
    const s = await mkStudent("orphan-meeting");
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst");
    await mkDeadlineEvent(s, a.id, zonedTime(2026, 11, 6, 17, 0, NY), { type: "meeting" });
    const v = await visit(s, out(3));
    assert.equal(v.rows.length, 0);
  });
  test("an unlinked deadline event -> no reminder", async () => {
    const s = await mkStudent("orphan-unlinked");
    await mkApplication(s, "Moelis & Company", "Summer Analyst");
    await mkDeadlineEvent(s, null, zonedTime(2026, 11, 6, 17, 0, NY));
    const v = await visit(s, out(3));
    assert.equal(v.rows.length, 0);
  });
  for (const status of ["submitted", "interviewing", "offer", "rejected"] as const) {
    test(`a tracker entry marked ${status} with a Schedule deadline -> never reminded`, async () => {
      const s = await mkStudent(`orphan-${status}`);
      const a = await mkApplication(s, "Moelis & Company", "Summer Analyst", { status });
      await mkDeadlineEvent(s, a.id, zonedTime(2026, 11, 6, 17, 0, NY));
      const v = await visit(s, out(3));
      assert.equal(v.rem.length + v.rows.length + v.jobs.length, 0);
    });
  }
  test("the deadline is the day the event falls on for the STUDENT (Tokyo)", async () => {
    const s = await mkStudent("orphan-tokyo", TOKYO);
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst");
    // 11:59pm Eastern on 6 Nov is 1:59pm on 7 Nov in Tokyo.
    await mkDeadlineEvent(s, a.id, zonedTime(2026, 11, 6, 23, 59, NY));
    const v = await visit(s, zonedTime(2026, 11, 6, 9, 0, TOKYO));
    assert.equal(v.rows.length, 1);
    assert.equal(v.rows[0].detail, "Summer Analyst · due tomorrow");
    const job = openJobs(v)[0];
    assert.equal(job.body, "Summer Analyst · due 7 Nov");
    assert.equal(job.expiresAt?.toISOString(), zonedTime(2026, 11, 8, 0, 0, TOKYO).toISOString());
  });
  test("a deadline event earlier today still counts as due today", async () => {
    const s = await mkStudent("orphan-earlier");
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst");
    await mkDeadlineEvent(s, a.id, zonedTime(2026, 11, 6, 0, 30, NY));
    const v = await visit(s, out(0, 15));
    assert.equal(v.rows.length, 1);
    assert.equal(v.rows[0].detail, "Summer Analyst · due today");
  });
  test("two deadline events -> the nearer one counts", async () => {
    const s = await mkStudent("orphan-two");
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst");
    await mkDeadlineEvent(s, a.id, zonedTime(2026, 11, 20, 17, 0, NY));
    await mkDeadlineEvent(s, a.id, zonedTime(2026, 11, 6, 17, 0, NY));
    const v = await visit(s, out(3));
    assert.equal(v.rows.length, 1);
    assert.equal(v.rows[0].detail, "Summer Analyst · due in 3 days");
  });
  test("ticking the tracker-only row marks THAT entry submitted, no new row", async (t) => {
    const s = await mkStudent("orphan-tick");
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst");
    await mkDeadlineEvent(s, a.id, zonedTime(2026, 11, 6, 17, 0, NY));
    await visit(s, out(3));
    assert.equal(await tickTodo(s, out(3, 10), `deadline-application:${a.id}`), true);
    const v = await visit(s, out(3, 11));
    assert.equal(v.rows.length, 0);
    assert.equal(v.tracker.length, 1);
    assert.equal(v.tracker[0].id, a.id);
    assert.equal(v.tracker[0].status, "submitted");
    assert.equal(v.jobs[0].doneSource, "manual");
    // Observation for the report (a product question, not asserted): the
    // Schedule's own deadline row for the same entry is still on the list.
    t.diagnostic(`other to-do rows after "I applied": ${v.all.filter((x) => x.id.startsWith("event-")).map((x) => `${x.id.slice(0, 14)}… "${x.title}" / "${x.detail}" score ${x.score}`).join("; ") || "none"}`);
  });
});

describe("journey: a tracker entry and a posting for the same role", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  let appId: string;
  before(async () => {
    J = await standard("same");
    appId = (await mkApplication(J.s, "Evercore", ROLE, { status: "not_started" })).id;
    // A Schedule deadline for the entry too, on a different day - the posting
    // still speaks for it: one application, one countdown.
    await mkDeadlineEvent(J.s, appId, zonedTime(2026, 11, 3, 17, 0, NY));
  });
  test("14 days: one banner, one row, one job - keyed by the posting", async () => {
    const v = await visit(J.s, out(14));
    assert.equal(v.rem.length, 1);
    assert.equal(v.rows.length, 1);
    assert.equal(v.rows[0].id, `deadline-${J.key}`);
    assert.equal(v.jobs.length, 1);
  });
  test("7 days: still one", async () => {
    const v = await visit(J.s, out(7));
    assert.equal(v.rem.length, 1);
    assert.equal(v.rows.length, 1);
    assert.equal(v.jobs.length, 1);
  });
  test("'I applied' updates the tracker entry - never a second row", async () => {
    assert.equal(await appliedByBanner(J.s, out(6), J.key), true);
    const t = await trackerOf(J.s);
    assert.equal(t.length, 1);
    assert.equal(t[0].id, appId);
    assert.equal(t[0].status, "submitted");
    assert.equal(t[0].appliedDate, "2026-10-31");
  });
  test("after: nothing from either source", async () => {
    const v = await visit(J.s, out(3));
    assert.equal(v.rem.length + v.rows.length, 0);
    assert.equal(v.jobs.length, 1);
    assert.equal(v.jobs[0].doneSource, "manual");
  });
});

describe("same role, spelled differently", () => {
  const spellings: [string, string, string[]][] = [
    ["evercore inc.", "2027 investment banking summer-analyst", []],
    ["The Evercore Group", "2027 Investment Banking  Summer Analyst", []],
    ["EVR", ROLE, ["EVR"]],
    ["Evercore Partners", `${ROLE}.`, []],
    ["Évercore", "2027 INVESTMENT BANKING SUMMER ANALYST", []],
  ];
  for (const [firm, role, aliases] of spellings) {
    test(`tracker "${firm}" / "${role}" is the same application as the posting`, async () => {
      const J = await standard(`spell-${seq}`, { aliases });
      const a = await mkApplication(J.s, firm, role, { status: "in_progress" });
      const v = await visit(J.s, out(3));
      assert.equal(v.rows.length, 1, "one row");
      assert.equal(v.rem.length, 1, "one banner");
      assert.equal(await appliedByBanner(J.s, out(3, 10), J.key), true);
      const t = await trackerOf(J.s);
      assert.equal(t.length, 1, `never a second tracker row: ${t.map((x) => `${x.firm}/${x.role}/${x.status}`).join("; ")}`);
      assert.equal(t[0].id, a.id);
      assert.equal(t[0].status, "submitted");
      assert.equal((await visit(J.s, out(1))).rows.length, 0);
    });
  }
  test("the same role already submitted under another spelling -> never reminded", async () => {
    const J = await standard("spell-submitted", { aliases: ["EVR"] });
    await mkApplication(J.s, "EVR", "2027 investment banking summer analyst", { status: "submitted" });
    const v = await visit(J.s, out(3));
    assert.equal(v.rem.length + v.rows.length + v.jobs.length, 0);
  });
  test("a different role at the same firm is a different application", async () => {
    const J = await standard("spell-other");
    await mkApplication(J.s, "Evercore", "2027 Restructuring Summer Analyst", { status: "submitted" });
    const v = await visit(J.s, out(3));
    assert.equal(v.rows.length, 1);
  });
});

describe("statuses the tracker says are past applying", () => {
  for (const status of ["submitted", "interviewing", "offer", "rejected"] as const) {
    test(`${status}: the posting is never reminded`, async () => {
      const J = await standard(`st-${status}`);
      await mkApplication(J.s, "Evercore", ROLE, { status });
      for (const n of [14, 7, 3, 1, 0]) {
        const v = await visit(J.s, out(n));
        assert.equal(v.rem.length + v.rows.length + v.jobs.length, 0, `${status} at ${n}`);
      }
    });
  }
  test("moved to 'interviewing' mid-countdown on the tracker: the open job closes as auto", async () => {
    const J = await standard("st-mid");
    const a = await mkApplication(J.s, "Evercore", ROLE);
    await visit(J.s, out(7));
    await h.db.update(applications).set({ status: "interviewing" }).where(eq(applications.id, a.id));
    const v = await visit(J.s, out(6));
    assert.equal(v.rows.length, 0);
    assert.equal(v.jobs[0].doneSource, "auto");
  });
});

describe("admission: only postings that fit the student", () => {
  test("a firm not on their list -> nothing", async () => {
    const s = await mkStudent("adm-list");
    const f = await mkFirm("Evercore");
    await mkPosting(f);
    const v = await visit(s, out(3));
    assert.equal(v.rows.length, 0);
  });
  test("no application link -> nothing", async () => {
    const J = await standard("adm-url", { posting: { applicationUrl: null } });
    assert.equal((await visit(J.s, out(3))).rows.length, 0);
  });
  test("another sector -> nothing", async () => {
    const J = await standard("adm-sector", { posting: { categories: ["private_equity"], roleTitle: "2027 Private Equity Summer Analyst" } });
    assert.equal((await visit(J.s, out(3))).rows.length, 0);
  });
  test("their coverage group -> reminded; another group -> not", async () => {
    const s = await mkStudent("adm-group", NY, { nicheInterests: ["Healthcare"] });
    const f = await mkFirm("Evercore");
    await track(s, f.id);
    await mkPosting(f, { roleTitle: "2027 Healthcare Investment Banking Summer Analyst" });
    await mkPosting(f, { roleTitle: "2027 Technology Investment Banking Summer Analyst" });
    const v = await visit(s, out(3));
    assert.deepEqual(
      v.rows.map((r) => r.detail.split(" · ")[0]),
      ["2027 Healthcare Investment Banking Summer Analyst"],
    );
  });
  test("a degree they can't apply with -> nothing", async () => {
    const s = await mkStudent("adm-degree", NY, { degreeLevel: "mba" } as never);
    const f = await mkFirm("Evercore");
    await track(s, f.id);
    await mkPosting(f, { roleTitle: "2027 Investment Banking Summer Analyst", descriptionFull: "Candidates must be pursuing a bachelor's degree, in the penultimate year of their undergraduate studies." });
    assert.equal((await visit(s, out(3))).rows.length, 0);
  });
  test("not open yet (opens in the future) -> nothing", async () => {
    const J = await standard("adm-future", { posting: { opensAt: utcDay("2026-11-02") } });
    assert.equal((await visit(J.s, out(10))).rows.length, 0);
  });
  test("an inactive posting -> nothing", async () => {
    const J = await standard("adm-inactive", { posting: { isActive: false } });
    assert.equal((await visit(J.s, out(3))).rows.length, 0);
  });
  test("deadlineStatus 'closed' -> nothing", async () => {
    const J = await standard("adm-closed", { posting: { deadlineStatus: "closed" } });
    assert.equal((await visit(J.s, out(3))).rows.length, 0);
  });
  test("TBD deadline (no date, not rolling) -> nothing", async () => {
    const J = await standard("adm-tbd", { posting: { deadlineStatus: "tbd", deadlineDate: null } });
    assert.equal((await visit(J.s, out(3))).rows.length, 0);
  });
});

describe("uncapped: every open application at a firm is its own reminder", () => {
  test("two different roles at one firm, same city, same group, both dated -> two reminders", async () => {
    const s = await mkStudent("two-roles");
    const f = await mkFirm("Evercore");
    await track(s, f.id);
    await mkPosting(f, { roleTitle: "2027 Investment Banking Summer Analyst", deadlineDate: utcDay("2026-11-06") });
    await mkPosting(f, { roleTitle: "2027 Investment Banking Diversity Fellowship", deadlineDate: utcDay("2026-11-04") });
    const v = await visit(s, out(3));
    assert.deepEqual(
      v.rows.map((r) => r.detail.split(" · ")[0]).sort(),
      ["2027 Investment Banking Diversity Fellowship", "2027 Investment Banking Summer Analyst"],
    );
  });
  test("applied to the sooner of two roles in one group -> the other is still reminded", async () => {
    const s = await mkStudent("two-roles-applied");
    const f = await mkFirm("Evercore");
    await track(s, f.id);
    const sooner = await mkPosting(f, { roleTitle: "2027 Investment Banking Diversity Fellowship", deadlineDate: utcDay("2026-11-04") });
    await mkPosting(f, { roleTitle: "2027 Investment Banking Summer Analyst", deadlineDate: utcDay("2026-11-06") });
    await visit(s, out(7));
    assert.equal(await appliedByBanner(s, out(7, 10), `posting:${sooner.id}`), true);
    const v = await visit(s, out(3));
    assert.deepEqual(
      v.rows.map((r) => r.detail.split(" · ")[0]),
      ["2027 Investment Banking Summer Analyst"],
      "the Summer Analyst application, due in 3 days and never applied to, is never reminded",
    );
  });
  test("a dated role and a rolling role at one firm -> two reminders", async () => {
    const s = await mkStudent("two-roles-rolling");
    const f = await mkFirm("Evercore");
    await track(s, f.id);
    await mkPosting(f, { roleTitle: "2027 Investment Banking Summer Analyst" });
    await mkPosting(f, { roleTitle: "2027 Investment Banking Off-Cycle Intern", deadlineStatus: "rolling", deadlineDate: null });
    const v = await visit(s, out(3));
    assert.equal(v.rows.length, 2, v.rows.map((r) => r.detail).join(" | "));
  });
  test("more than 8 firms and more than 2 roles per firm are all reminded", async () => {
    const s = await mkStudent("many");
    const groups = ["Healthcare", "Technology", "Industrials"];
    for (let i = 0; i < 9; i++) {
      const f = await mkFirm(`Firm ${String.fromCharCode(65 + i)}`);
      await track(s, f.id);
      for (const g of groups) await mkPosting(f, { roleTitle: `2027 ${g} Investment Banking Summer Analyst` });
    }
    const v = await visit(s, out(3));
    assert.equal(v.rows.length, 27);
  });
  test("several due at once: every banner drops, soonest first, one job each", async () => {
    const s = await mkStudent("several");
    for (const [name, iso] of [["Lazard", "2026-11-04"], ["Centerview", "2026-11-03"], ["PJT", "2026-11-10"]] as const) {
      const f = await mkFirm(name);
      await track(s, f.id);
      await mkPosting(f, { deadlineDate: utcDay(iso), descriptionFull: "Summer analyst programme." });
    }
    // 3 Nov 9am: Centerview today, Lazard tomorrow, PJT in 7 days.
    const v = await visit(s, zonedTime(2026, 11, 3, 9, 0, NY));
    assert.deepEqual(
      v.rem.map((b) => `${b.subject}:${b.chip}`),
      ["Centerview:due today", "Lazard:due tomorrow", "PJT:due in 7 days"],
    );
    assert.equal(openJobs(v).length, 3);
    // To-do rows ranked by urgency.
    assert.deepEqual(
      v.rows.map((r) => r.title),
      ["Apply to Centerview", "Apply to Lazard", "Apply to PJT"],
    );
  });
});

describe("journey: rolling posting, weekly for five weeks, then closed", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  const start = (d: number, hr = 9) => zonedTime(2026, 10, 5 + d, hr, 0, NY);
  const banners: number[] = [];
  before(async () => {
    J = await standard("rolling", { posting: { deadlineStatus: "rolling", deadlineDate: null, descriptionFull: "Rolling applications." } });
  });
  test("every day for five weeks (across DST): the banner on days 0, 7, 14, 21, 28 only; the row every day; one job", async () => {
    for (let d = 0; d <= 34; d++) {
      const v = await visit(J.s, start(d));
      if (v.rem.length) banners.push(d);
      assert.ok(v.rem.length <= 1, `day ${d}: ${v.rem.length} banners`);
      if (v.rem.length) {
        const b = v.rem[0];
        assert.equal(b.chip, "rolling");
        assert.equal(b.detail, `${ROLE} · rolling, earlier is better`);
        assert.equal(b.flashKey, `deadline:${J.key}:rolling:${localDateString(start(d), NY)}`);
      }
      assert.equal(v.rows.length, 1, `day ${d}: row`);
      assert.equal(v.rows[0].detail, `${ROLE} · rolling`);
      assert.equal(v.rows[0].score, 60);
      assert.equal(v.jobs.length, 1, `day ${d}: one job`);
      assert.equal(openJobs(v).length, 1, `day ${d}: open`);
      assert.equal(v.jobs[0].expiresAt, null);
      assert.equal(v.jobs[0].body, `${ROLE} · rolling`);
    }
    assert.deepEqual(banners, [0, 7, 14, 21, 28]);
  });
  test("closed on day 35: row gone, job closed by the app (not expired, not left open)", async () => {
    await updatePosting(J.posting.id, { deadlineStatus: "closed" });
    const v = await visit(J.s, start(35));
    assert.equal(v.rem.length, 0);
    assert.equal(v.rows.length, 0);
    assert.equal(v.jobs[0].doneSource, "auto");
    assert.equal(v.tracker.length, 0);
  });
  test("a missed week: first visit 10 days after the last banner speaks, then 7 days from THAT", async () => {
    const K = await standard("rolling-gap", { posting: { deadlineStatus: "rolling", deadlineDate: null, descriptionFull: "Rolling." } });
    const seen: number[] = [];
    for (const d of [0, 10, 12, 16, 17]) if ((await visit(K.s, start(d))).rem.length) seen.push(d);
    assert.deepEqual(seen, [0, 10, 17]);
  });
  test("'I applied' on a rolling banner: tracker row, manual close, silence afterwards", async () => {
    const K = await standard("rolling-apply", { posting: { deadlineStatus: "rolling", deadlineDate: null, descriptionFull: "Rolling." } });
    const v = await visit(K.s, start(0));
    assert.equal(await appliedByBanner(K.s, start(0, 10), v.rem[0].doneKey!), true);
    for (const d of [1, 7, 14]) {
      const w = await visit(K.s, start(d));
      assert.equal(w.rem.length + w.rows.length, 0, `day ${d}`);
      assert.equal(w.jobs[0].doneSource, "manual");
    }
    const t = await trackerOf(K.s);
    assert.equal(t.length, 1);
    assert.equal(t[0].status, "submitted");
  });
});

describe("journey: posting withdrawn mid-countdown", () => {
  test("isActive=false at 5 days: silent from then, job closed 'auto' (not expired), tracker untouched", async () => {
    const J = await standard("withdrawn");
    await visit(J.s, out(14));
    await visit(J.s, out(7));
    await updatePosting(J.posting.id, { isActive: false });
    const v = await visit(J.s, out(5));
    assert.equal(v.rem.length + v.rows.length, 0);
    assert.equal(v.jobs.length, 1);
    assert.equal(v.jobs[0].doneSource, "auto");
    assert.equal(v.tracker.length, 0);
    for (const n of [3, 1, 0, -1]) {
      const w = await visit(J.s, out(n));
      assert.equal(w.rem.length + w.rows.length, 0, `${n}`);
      assert.equal(w.jobs[0].doneSource, "auto", `${n}`);
    }
  });
  test("deadlineStatus 'closed' at 2 days: same", async () => {
    const J = await standard("closed-early");
    await visit(J.s, out(3));
    await updatePosting(J.posting.id, { deadlineStatus: "closed" });
    const v = await visit(J.s, out(2));
    assert.equal(v.rows.length, 0);
    assert.equal(v.jobs[0].doneSource, "auto");
  });
  test("'I applied' on a withdrawn posting's stale banner key does nothing", async () => {
    const J = await standard("withdrawn-click");
    await visit(J.s, out(7));
    await updatePosting(J.posting.id, { isActive: false });
    assert.equal(await appliedByBanner(J.s, out(7, 10), J.key), false);
    assert.equal((await trackerOf(J.s)).length, 0);
  });
});

describe("journey: deadline moved", () => {
  test("pushed back from 6 Nov to 13 Nov at 5 days out: the new date's marks, nothing on the old date", async () => {
    const J = await standard("moved-later", { posting: { descriptionFull: "Summer analyst programme." } });
    await visit(J.s, out(14));
    await visit(J.s, out(7));
    await updatePosting(J.posting.id, { deadlineDate: utcDay("2026-11-13") });
    // 1 Nov = 12 days before the 13th.
    const v5 = await visit(J.s, out(5));
    assert.equal(v5.rows.length, 1);
    assert.equal(v5.rows[0].detail, `${ROLE} · due in 12 days`);
    // Old deadline day and the day after it: still live, not expired.
    const v0 = await visit(J.s, out(0));
    assert.equal(v0.rem.filter((b) => b.flashKey.includes(DL)).length, 0, "no banner for the old date");
    assert.equal(v0.rows[0].detail, `${ROLE} · due in 7 days`);
    const vAfter = await visit(J.s, out(-1));
    assert.equal(vAfter.rows.length, 1);
    assert.equal(openJobs(vAfter).length, 1, "not expired on the old date");
    // The new date's 3-day mark, and the job now expires after the new date.
    const v3 = await visit(J.s, zonedTime(2026, 11, 10, 9, 0, NY));
    assert.deepEqual(v3.rem.map((b) => b.chip), ["due in 3 days"]);
    assert.equal(openJobs(v3)[0].body, `${ROLE} · due 13 Nov`);
    assert.equal(openJobs(v3)[0].expiresAt?.toISOString(), expiryFor("2026-11-13", NY).toISOString());
    const vEnd = await visit(J.s, zonedTime(2026, 11, 14, 9, 0, NY));
    assert.equal(vEnd.jobs[0].doneSource, "expired");
  });
  test("pushed back beyond two weeks: the bell never shows the old date as the deadline", async () => {
    const J = await standard("moved-far", { posting: { descriptionFull: "Summer analyst programme." } });
    await visit(J.s, out(7));
    await updatePosting(J.posting.id, { deadlineDate: utcDay("2026-11-27") });
    const v = await visit(J.s, out(5)); // 26 days before the new date
    assert.equal(v.rows.length, 0, "not on the to-do list 26 days out");
    for (const j of openJobs(v)) {
      assert.ok(!j.body.includes("6 Nov"), `open bell job still says "${j.body}" though the deadline is 27 Nov`);
    }
  });
  test("brought forward from 6 Nov to 2 Nov at 7 days out: the 3-day banner at once, job expires after 2 Nov", async () => {
    const J = await standard("moved-earlier", { posting: { descriptionFull: "Summer analyst programme." } });
    await visit(J.s, out(10)); // 27 Oct: 14-day banner
    await updatePosting(J.posting.id, { deadlineDate: utcDay("2026-11-02") });
    const v = await visit(J.s, zonedTime(2026, 10, 30, 9, 0, NY)); // 3 days before 2 Nov
    assert.deepEqual(v.rem.map((b) => b.chip), ["due in 3 days"]);
    assert.equal(openJobs(v)[0].expiresAt?.toISOString(), expiryFor("2026-11-02", NY).toISOString());
    const vAfter = await visit(J.s, zonedTime(2026, 11, 3, 9, 0, NY));
    assert.equal(vAfter.rows.length, 0);
    assert.equal(vAfter.jobs[0].doneSource, "expired");
  });
});

describe("two students, one posting: isolated", () => {
  let A: Student;
  let B: Student;
  let key: string;
  let bApp: string;
  before(async () => {
    A = await mkStudent("iso-a");
    B = await mkStudent("iso-b", LA);
    const f = await mkFirm("Evercore");
    await track(A, f.id);
    await track(B, f.id);
    const p = await mkPosting(f);
    key = `posting:${p.id}`;
    bApp = (await mkApplication(B, "Moelis & Company", "Summer Analyst")).id;
    await mkDeadlineEvent(B, bApp, zonedTime(2026, 11, 6, 17, 0, NY));
  });
  test("both get the 7-day banner", async () => {
    assert.equal((await visit(A, out(7))).rem.length, 1);
    assert.equal((await visit(B, out(7, 9, 0, LA))).rem.length, 2);
  });
  test("A applies; B still has everything", async () => {
    assert.equal(await appliedByBanner(A, out(6), key), true);
    const vb = await visit(B, out(3, 9, 0, LA));
    assert.equal(vb.rows.length, 2);
    assert.equal(openJobs(vb).length, 2);
    assert.equal((await trackerOf(B)).filter((a) => a.status === "submitted").length, 0);
    const va = await visit(A, out(3));
    assert.equal(va.rows.length, 0);
    assert.equal((await trackerOf(A)).length, 1);
  });
  test("A cannot mark B's tracker-only application applied", async () => {
    assert.equal(await appliedByBanner(A, out(3), `application:${bApp}`), false);
    const t = await trackerOf(B);
    assert.equal(t.find((a) => a.id === bApp)?.status, "not_started");
    assert.equal((await trackerOf(A)).length, 1, "and nothing was added to A's tracker");
    const vb = await visit(B, out(3, 10, 0, LA));
    assert.equal(openJobs(vb).length, 2);
  });
  test("A ticking B's to-do id does nothing", async () => {
    assert.equal(await tickTodo(A, out(3, 11), `deadline-application:${bApp}`), false);
    assert.equal((await trackerOf(B)).find((a) => a.id === bApp)?.status, "not_started");
  });
});

describe("'I applied' on a key the student doesn't have", () => {
  let J: Awaited<ReturnType<typeof standard>>;
  before(async () => {
    J = await standard("nokey");
    await visit(J.s, out(3));
  });
  const junk = [
    "",
    "posting:",
    "posting:00000000-0000-0000-0000-000000000000",
    "application:00000000-0000-0000-0000-000000000000",
    "application:not-a-uuid",
    "posting:' OR 1=1 --",
    "deadline:posting:x",
    "x".repeat(500),
  ];
  for (const k of junk) {
    test(`"${k.slice(0, 40)}${k.length > 40 ? "…" : ""}" does nothing`, async () => {
      assert.equal(await appliedByBanner(J.s, out(3, 10), k), false);
      assert.equal((await trackerOf(J.s)).length, 0);
      assert.equal(openJobs({ jobs: await jobsOf(J.s) } as Visit).length, 1);
    });
  }
  test("a real posting at a firm NOT on their list does nothing", async () => {
    const f = await mkFirm("Lazard");
    const p = await mkPosting(f);
    assert.equal(await appliedByBanner(J.s, out(3, 11), `posting:${p.id}`), false);
    assert.equal((await trackerOf(J.s)).length, 0);
  });
  test("their own submitted tracker entry's key does nothing (no status change back or forth)", async () => {
    const a = await mkApplication(J.s, "Houlihan Lokey", "Summer Analyst", { status: "offer" });
    assert.equal(await appliedByBanner(J.s, out(3, 12), `application:${a.id}`), false);
    assert.equal((await trackerOf(J.s)).find((x) => x.id === a.id)?.status, "offer");
    await h.db.delete(applications).where(eq(applications.id, a.id));
  });
  test("the real key still works afterwards", async () => {
    assert.equal(await appliedByBanner(J.s, out(3, 13), J.key), true);
    assert.equal((await trackerOf(J.s)).length, 1);
  });
});

describe("idempotency and races", () => {
  test("two 'I applied' clicks at once -> one tracker row, one close", async () => {
    const J = await standard("race");
    await visit(J.s, out(3));
    const results = await Promise.all([appliedByBanner(J.s, out(3, 10), J.key), appliedByBanner(J.s, out(3, 10), J.key)]);
    assert.ok(results.includes(true));
    const t = await trackerOf(J.s);
    assert.equal(t.length, 1);
    assert.equal(t[0].status, "submitted");
    const jobs = await jobsOf(J.s);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].doneSource, "manual");
  });
  test("banner click then to-do tick -> still one row, the tick is a no-op", async () => {
    const J = await standard("both");
    await visit(J.s, out(3));
    assert.equal(await appliedByBanner(J.s, out(3, 10), J.key), true);
    assert.equal(await tickTodo(J.s, out(3, 10, 1), `deadline-${J.key}`), false);
    assert.equal((await trackerOf(J.s)).length, 1);
  });
  test("the close time is not rewritten by a second click", async () => {
    const J = await standard("close-time");
    await visit(J.s, out(3));
    await appliedByBanner(J.s, out(3, 10), J.key);
    const first = (await jobsOf(J.s))[0].doneAt?.toISOString();
    await appliedByBanner(J.s, out(3, 11), J.key);
    assert.equal((await jobsOf(J.s))[0].doneAt?.toISOString(), first);
  });
  test("ten page loads in one minute file one job and record the banner once", async () => {
    const J = await standard("reload");
    let banners = 0;
    for (let i = 0; i < 10; i++) banners += (await visit(J.s, new RealDate(out(7).getTime() + i * 5000))).rem.length;
    assert.equal(banners, 1);
    assert.equal((await jobsOf(J.s)).length, 1);
  });
  test("a job closed by 'I applied' is never re-opened by a later load", async () => {
    const J = await standard("no-reopen");
    await visit(J.s, out(7));
    await appliedByBanner(J.s, out(7, 10), J.key);
    for (const n of [7, 3, 1, 0]) await visit(J.s, out(n, 12));
    const jobs = await jobsOf(J.s);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].doneSource, "manual");
  });
  test("applied late at night in Los Angeles: appliedDate is their date, not UTC's", async () => {
    const J = await standard("la-night", { tz: LA });
    await visit(J.s, out(3, 23, 0, LA));
    await appliedByBanner(J.s, out(3, 23, 30, LA), J.key);
    assert.equal((await trackerOf(J.s))[0].appliedDate, "2026-11-03");
  });
});

describe("the day-of banner names the stated cut-off", () => {
  test("stated time on the posting -> named on the banner and the row, on the day only", async () => {
    const J = await standard("cutoff");
    const v1 = await visit(J.s, out(1));
    assert.ok(!v1.rem[0].detail.includes("closes"));
    assert.ok(!v1.rows[0].detail.includes("closes"));
    const v0 = await visit(J.s, out(0));
    assert.equal(v0.rem[0].detail, `${ROLE} · you haven't applied yet · closes 11:55 PM EST`);
    assert.equal(v0.rows[0].detail, `${ROLE} · due today · closes 11:55 PM EST`);
  });
  test("no stated time -> no invented one", async () => {
    const J = await standard("no-cutoff", { posting: { descriptionFull: "Summer analyst programme." } });
    const v0 = await visit(J.s, out(0));
    assert.equal(v0.rem[0].detail, `${ROLE} · you haven't applied yet`);
    assert.equal(v0.rows[0].detail, `${ROLE} · due today`);
  });
});

describe("bell reconciliation, directly", () => {
  test("a job whose application went away before its expiry closes 'auto'", async () => {
    const J = await standard("rec-auto");
    await visit(J.s, out(7));
    await updatePosting(J.posting.id, { isActive: false });
    const bell = await act(J.s, out(6), () => L.getNotifications(J.s.u.id, out(6)));
    assert.equal(bell.open.filter((i) => i.kind === "application_deadline").length, 0);
    assert.equal((await jobsOf(J.s))[0].doneSource, "auto");
  });
  test("a job whose application went away AFTER its expiry closes 'expired'", async () => {
    const J = await standard("rec-expired");
    await visit(J.s, out(7));
    // Nobody opens the bell until two days after the deadline.
    const bell = await act(J.s, out(-2), () => L.getNotifications(J.s.u.id, out(-2)));
    assert.equal(bell.open.filter((i) => i.kind === "application_deadline").length, 0);
    assert.equal((await jobsOf(J.s))[0].doneSource, "expired");
  });
  test("a live job whose deadline has since moved out closes - it named a date that is no longer the deadline", async () => {
    const J = await standard("rec-live");
    await visit(J.s, out(7));
    await updatePosting(J.posting.id, { deadlineDate: utcDay("2026-11-30") });
    await act(J.s, out(6), () => L.getNotifications(J.s.u.id, out(6)));
    const [job] = await jobsOf(J.s);
    assert.ok(job.doneAt, "closed");
    assert.equal(job.doneSource, "expired");
  });
});

// A student who gets an offer announces it on the feed, keyed on the
// application id - and an application that stops being an offer has to take
// that announcement with it, or they are left announcing an offer they can no
// longer reach from the tracker. The tracker's own actions do that; the writes
// behind "I applied" move a row to "submitted" too, and did not.
describe("'I applied' never leaves an offer announced", () => {
  /** The offer rows standing for one application, straight from the table. */
  function announcements(s: Student, applicationId: string) {
    return h.db.query.activityEvents.findMany({
      where: and(
        eq(activityEvents.userId, s.u.id),
        eq(activityEvents.kind, "offer"),
        eq(activityEvents.dedupeKey, applicationId),
      ),
    });
  }

  test("the write that overwrites an offer row takes its announcement down with it", async () => {
    // "Internship Program" is every word a title can be padded with and
    // nothing else, so sameRole cannot call two copies of it the same role:
    // the tracker row below is NOT recognised as this posting's, and the
    // insert behind "I applied" collides on the unique (student, firm, role)
    // index instead. That conflict branch is the write that really can move a
    // row off "offer".
    const J = await standard("offer-conflict", { posting: { roleTitle: "Internship Program" } });
    const app = await mkApplication(J.s, "Evercore", "Internship Program", {
      status: "offer",
      appliedDate: "2026-10-01",
    });
    const { recordOffer } = await import("@/lib/activity");
    await recordOffer(J.s.u.id, app.id, "Evercore", "Internship Program");
    assert.equal((await announcements(J.s, app.id)).length, 1, "the offer was announced");

    // The reminder really is the one that cannot see the tracker row.
    const open = await act(J.s, out(3), () => L.getOpenApplications(J.s.u, out(3)));
    const r = open.find((o) => o.key === J.key);
    assert.ok(r, "the posting is still on the 'Applied yet?' list");
    assert.equal(r.applicationId, null, "and not linked to the tracker row");
    assert.equal(r.firmName, "Evercore");
    assert.equal(r.role, "Internship Program");

    assert.equal(await appliedByBanner(J.s, out(3, 10), J.key), true);

    const tracker = await trackerOf(J.s);
    assert.equal(tracker.length, 1, "one row, overwritten rather than duplicated");
    assert.equal(tracker[0].id, app.id);
    assert.equal(tracker[0].status, "submitted");
    assert.deepEqual(
      await announcements(J.s, app.id),
      [],
      "the tracker says submitted while the feed still announces an offer",
    );
  });

  test("an offer announced for a different application is left standing", async () => {
    const J = await standard("offer-other");
    // A real offer elsewhere on the tracker, announced. Applying to something
    // else must not quietly take it down.
    const other = await mkApplication(J.s, "Lazard", "2027 Restructuring Summer Analyst", { status: "offer" });
    const { recordOffer } = await import("@/lib/activity");
    await recordOffer(J.s.u.id, other.id, "Lazard", "2027 Restructuring Summer Analyst");

    await visit(J.s, out(3));
    assert.equal(await appliedByBanner(J.s, out(3, 10), J.key), true);

    assert.equal((await announcements(J.s, other.id)).length, 1, "someone else's offer row came down");
    const lazard = (await trackerOf(J.s)).find((a) => a.firm === "Lazard");
    assert.equal(lazard?.status, "offer", "and its tracker row is untouched");
  });
});
