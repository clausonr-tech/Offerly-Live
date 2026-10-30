// "Before an internship application opens": adversarial tests for the pure rules.
//
// If a student tracks a posting with a PUBLISHED opening date and has saved
// people at that firm they have never emailed, the app asks them to write to
// those people before applications open:
//   - a flash (banner) from 30 days out, repeating every other day,
//   - ONE to-do row per firm from 14 days out until it opens,
//   - one bell job per firm and opening.
//
// The other outreach suites (outreach-selection, outreach-timing,
// outreach-firm-matching, prompt-timing-fuzz) check each rule at a UTC midday
// with whole-day offsets. This file checks the places those skip:
//   - day counts on the STUDENT'S clock, in several zones and across DST
//     changes,
//   - how often the flash repeats when a firm or a contact shows up late,
//   - firm spellings not yet covered, and near-misses that must not match,
//   - all 14 sectors, real/unreal postings, and every relationship status,
//   - a seeded fuzz with invariants.
//
// Openings are CALENDAR DATES stored at midnight UTC (see formatDay /
// signalTiming in upcoming-applications.ts and dayKey here), so "opens in N
// days" means N days on the student's calendar, counted to that date.
//
// No database. Nothing here writes anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FLASH_WINDOW_DAYS,
  TODO_WINDOW_DAYS,
  dayFlashKey,
  dayKey,
  flashDueToday,
  flashPrefix,
  nextFlash,
  selectOutreachNudges,
  todoNudges,
  type OutreachNudge,
} from "../../src/lib/application-outreach";
import { normalizeFirmName } from "../../src/lib/firm-name";
import { isRealPosting } from "../../src/lib/internship-postings";
import { autoCloseable, outreachNotificationKey } from "../../src/lib/notifications";
import { localDateString, zonedTime } from "../../src/lib/time-zone";
import { firmProgramCategoryEnum, relationshipStatusEnum } from "../../src/db/schema";
import { opening, person, type Application, type ContactRow } from "./outreach-fixtures";

// ------------------------------------------------------------------ helpers

const DAY = 86_400_000;
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const HNL = "Pacific/Honolulu";
const LON = "Europe/London";
const KOL = "Asia/Kolkata";
const TYO = "Asia/Tokyo";
const SYD = "Australia/Sydney";
const AKL = "Pacific/Auckland";

/** A calendar date as the database stores it: midnight UTC. */
function utcDay(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

function addDays(ymd: string, n: number): string {
  const d = utcDay(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from one "YYYY-MM-DD" to another. */
function calendarDays(from: string, to: string): number {
  return Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / DAY);
}

/** The instant the wall clock in `zone` reads `ymd hh:mm`. */
function at(ymd: string, hhmm: string, zone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const instant = zonedTime(y, m, d, h, mi, zone);
  // Guard the helper itself: a test about the student's calendar is worthless
  // if the instant it builds is on a different calendar day.
  assert.equal(localDateString(instant, zone), ymd, `helper: ${ymd} ${hhmm} ${zone}`);
  return instant;
}

/** What the student should be told: calendar days from THEIR today to the opening date. */
function studentDays(opensOn: Date, now: Date, zone: string): number {
  return calendarDays(localDateString(now, zone), dayKey(opensOn));
}

/** The selection as the student in `timeZone` sees it (New York by default,
 *  as in the app). */
function select(applications: Application[], contactRows: ContactRow[], now: Date, timeZone: string = NY) {
  return selectOutreachNudges({ applications, contactRows, now, timeZone });
}

/** "firm|opening|": what a flash's last firing is recorded against. */
function nudgePrefix(n: OutreachNudge) {
  return flashPrefix(n.firmKey, n.opensOn);
}

/** A small seeded PRNG (mulberry32), so the fuzz is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    shuffle: <T>(xs: T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

// ======================================================================
// A. Every day 1-40 out, on a New York student's clock at 10:00
// ======================================================================
//
// 10:00 in New York is the same calendar day in UTC, so this section checks
// the window edges (30 for the flash, 14 for the to-do) and that the flash is
// due the first day a firm is seen, with no time-zone effects mixed in.

const A_TODAY = "2026-09-23";
const A_NOW = at(A_TODAY, "10:00", NY);

for (let d = 1; d <= 40; d++) {
  const inWindow = d <= FLASH_WINDOW_DAYS;
  const onList = d <= TODO_WINDOW_DAYS;
  test(`A. ${d} day${d === 1 ? "" : "s"} out (NY 10:00): ${inWindow ? `prompts, flashes${onList ? ", on the to-do list" : ", flash only"}` : "silent"}`, () => {
    const opensOn = utcDay(addDays(A_TODAY, d));
    const nudges = select([opening({ date: opensOn })], [person()], A_NOW);
    if (!inWindow) {
      assert.deepEqual(nudges, []);
      return;
    }
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].daysUntilOpen, d);
    assert.equal(todoNudges(nudges).length, onList ? 1 : 0);
    assert.equal(nextFlash(nudges, new Map(), A_TODAY)?.firmKey, nudges[0].firmKey, "due the first day it is seen");
  });
}

test("A. the opening day itself (NY 10:00): silent - it is open, and writing ahead of it is over", () => {
  assert.deepEqual(select([opening({ date: utcDay(A_TODAY) })], [person()], A_NOW), []);
});

// ======================================================================
// B. The count on the student's own clock, in eight zones
// ======================================================================
//
// For each zone and time of day, walk every opening 1-40 calendar days ahead
// and check: prompted exactly when it is 30 days out or fewer, the stated day
// count matches the student's calendar, and the to-do row appears at 14 days
// or fewer. Mismatches are collected so one run shows the full pattern.

const B_TODAY = "2026-10-05";
const B_ZONES = [NY, LA, HNL, LON, KOL, TYO, AKL] as const;
const B_TIMES = ["00:30", "09:00", "18:30", "23:30"] as const;

for (const zone of B_ZONES) {
  for (const time of B_TIMES) {
    test(`B. ${zone} at ${time}: "opens in N days" is N days on the student's calendar, for every N from 1 to 40`, () => {
      const now = at(B_TODAY, time, zone);
      const wrong: string[] = [];
      for (let c = 1; c <= 40; c++) {
        const opensOn = utcDay(addDays(B_TODAY, c));
        const nudges = select([opening({ date: opensOn })], [person()], now, zone);
        const want = c <= FLASH_WINDOW_DAYS ? c : null;
        const got = nudges[0]?.daysUntilOpen ?? null;
        const wantTodo = c <= TODO_WINDOW_DAYS;
        const gotTodo = todoNudges(nudges).length === 1;
        if (got !== want || gotTodo !== wantTodo) {
          wrong.push(`opens ${dayKey(opensOn)} (${c}d on their calendar): said ${got ?? "nothing"}${gotTodo !== wantTodo ? `, to-do ${gotTodo}` : ""}`);
        }
      }
      assert.deepEqual(wrong, []);
    });
  }
}

// ======================================================================
// C. Daylight-saving changes
// ======================================================================

type DstCase = { label: string; zone: string; today: string; time: string; ahead: number[] };

const DST_CASES: DstCase[] = [
  { label: "NY 19:30 on the last Friday of EDT", zone: NY, today: "2026-10-30", time: "19:30", ahead: [1, 14, 30] },
  { label: "NY 19:30 on the first Monday of EST", zone: NY, today: "2026-11-02", time: "19:30", ahead: [1, 14, 30] },
  { label: "NY 23:30 the night the clocks go back", zone: NY, today: "2026-10-31", time: "23:30", ahead: [1, 2, 15] },
  { label: "NY 00:30 the morning the clocks go back (still EDT)", zone: NY, today: "2026-11-01", time: "00:30", ahead: [1, 14] },
  { label: "NY 22:00 the night before the clocks go forward", zone: NY, today: "2027-03-13", time: "22:00", ahead: [1, 2, 14] },
  { label: "NY 09:00 the day after the clocks go forward", zone: NY, today: "2027-03-15", time: "09:00", ahead: [1, 14, 30] },
  { label: "London 00:30 BST, the Saturday before the clocks go back", zone: LON, today: "2026-10-24", time: "00:30", ahead: [1, 2, 14] },
  { label: "London 00:30 GMT, the Monday after", zone: LON, today: "2026-10-26", time: "00:30", ahead: [1, 2, 14] },
  { label: "Auckland noon NZST, the day before NZDT starts", zone: AKL, today: "2026-09-26", time: "12:00", ahead: [1, 14, 30] },
  { label: "Auckland noon NZDT, the day after it starts", zone: AKL, today: "2026-09-28", time: "12:00", ahead: [1, 14, 30] },
  { label: "Sydney 08:00 AEDT, the day after it starts", zone: SYD, today: "2026-10-05", time: "08:00", ahead: [1, 14] },
];

for (const c of DST_CASES) {
  test(`C. ${c.label}: counts ${c.ahead.join("/")} days on the student's calendar`, () => {
    const now = at(c.today, c.time, c.zone);
    const wrong: string[] = [];
    for (const ahead of c.ahead) {
      const opensOn = utcDay(addDays(c.today, ahead));
      const [n] = select([opening({ date: opensOn })], [person()], now, c.zone);
      const onList = n ? todoNudges([n]).length === 1 : false;
      if (n?.daysUntilOpen !== ahead || onList !== ahead <= TODO_WINDOW_DAYS) {
        wrong.push(`${ahead}d: said ${n?.daysUntilOpen ?? "nothing"}, to-do ${onList}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
}

test("C. New York, hourly for 40 days across the November change: the count only changes at local midnight", () => {
  const opensOn = utcDay("2026-11-20");
  const changes: string[] = [];
  let prev: number | null = null;
  for (let t = at("2026-10-12", "00:00", NY).getTime(); t < opensOn.getTime(); t += 3_600_000) {
    const now = new Date(t);
    const n = select([opening({ date: opensOn })], [person()], now)[0];
    const days = n?.daysUntilOpen ?? null;
    if (prev !== null && days !== prev) {
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: NY, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
      if (local !== "00:00") changes.push(`${localDateString(now, NY)} ${local}: ${prev} -> ${days}`);
    }
    prev = days;
  }
  assert.deepEqual(changes.slice(0, 5), [], `${changes.length} changes away from midnight`);
});

// ======================================================================
// D. The every-two-days repeat
// ======================================================================

type Fire = { date: string; offset: number; time: string };

/**
 * Simulate a student visiting at fixed local times each day, from `from` days
 * before the opening to `to` days before it. After every flash the page
 * refreshes (as the bubble does), so all waiting flashes get a turn.
 */
function simulate(opts: {
  zone: string;
  openYmd: string;
  times: string[];
  from?: number;
  to?: number;
  apps?: (now: Date) => Application[];
  contacts?: (now: Date) => ContactRow[];
}): Fire[] {
  const { zone, openYmd, times } = opts;
  const opensOn = utcDay(openYmd);
  const apps = opts.apps ?? (() => [opening({ date: opensOn })]);
  const contacts = opts.contacts ?? (() => [person()]);
  // When each opening last fired, on the student's calendar - as prompt-flash
  // reads it back from the rows it recorded.
  const lastShown = new Map<string, string>();
  const fires: Fire[] = [];
  for (let offset = opts.from ?? 40; offset >= (opts.to ?? 1); offset--) {
    const date = addDays(openYmd, -offset);
    for (const time of times) {
      const now = at(date, time, zone);
      const today = localDateString(now, zone);
      const nudges = select(apps(now), contacts(now), now, zone);
      for (let guard = 0; guard < 20; guard++) {
        const n = nextFlash(nudges, lastShown, today);
        if (!n) break;
        lastShown.set(nudgePrefix(n), today);
        fires.push({ date, offset, time });
      }
    }
  }
  return fires;
}

const EVERY_OTHER = Array.from({ length: 15 }, (_, i) => 30 - 2 * i); // 30, 28, ... 2

for (const zone of [NY, LA, TYO, AKL]) {
  test(`D. ${zone}, one visit a day at 10:00: fires exactly 30, 28, ... 2 days out`, () => {
    const fires = simulate({ zone, openYmd: "2026-11-10", times: ["10:00"] });
    assert.deepEqual(fires.map((f) => f.offset), EVERY_OTHER);
  });
}

for (const zone of [NY, LON, TYO]) {
  test(`D. ${zone}, visiting every hour: never more than once on one local calendar day`, () => {
    const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:15`);
    const fires = simulate({ zone, openYmd: "2026-11-10", times: hours });
    const perDay = new Map<string, number>();
    for (const f of fires) perDay.set(f.date, (perDay.get(f.date) ?? 0) + 1);
    assert.deepEqual([...perDay].filter(([, n]) => n > 1), []);
  });
}

test("D. NY, morning and evening visits: a posting that appears one morning 29 days out fires once that day, not again that evening", () => {
  const openYmd = "2026-11-10";
  const opensOn = utcDay(openYmd);
  const publishedAt = at(addDays(openYmd, -29), "08:00", NY);
  const fires = simulate({
    zone: NY,
    openYmd,
    times: ["09:00", "21:00"],
    apps: (now) => (now >= publishedAt ? [opening({ date: opensOn })] : []),
  });
  const perDay = new Map<string, number>();
  for (const f of fires) perDay.set(f.date, (perDay.get(f.date) ?? 0) + 1);
  assert.deepEqual([...perDay].filter(([, n]) => n > 1), []);
});

// A firm discovered late: the posting is published (or first tracked) N days
// out. The repeat is "on the day it becomes due, again two days later"
// (repeatRound's own doc), so the second flash must not be the very next day.
for (const discovered of [29, 28, 25, 20, 19, 12, 11, 5]) {
  test(`D. a posting first seen ${discovered} days out: fires that day, then not again for two days`, () => {
    const openYmd = "2026-11-10";
    const opensOn = utcDay(openYmd);
    const publishedAt = at(addDays(openYmd, -discovered), "08:00", NY);
    const fires = simulate({
      zone: NY,
      openYmd,
      times: ["10:00"],
      apps: (now) => (now >= publishedAt ? [opening({ date: opensOn })] : []),
    });
    assert.equal(fires[0]?.offset, discovered, "fires the day it is first seen");
    const gaps = fires.slice(1).map((f, i) => fires[i].offset - f.offset);
    assert.ok(gaps.every((g) => g >= 2), `gaps between flashes in days: ${gaps.join(",")}`);
  });
}

test("D. a contact saved 23 days out: fires that day, then not the next day", () => {
  const openYmd = "2026-11-10";
  const savedAt = at(addDays(openYmd, -23), "08:00", NY);
  const fires = simulate({
    zone: NY,
    openYmd,
    times: ["10:00"],
    contacts: (now) => (now >= savedAt ? [person()] : []),
  });
  assert.equal(fires[0]?.offset, 23);
  assert.notEqual(fires[1]?.offset, 22, "the next flash is two days later, not the next morning");
});

test("D. emailing everyone 20 days out stops the flash for good", () => {
  const openYmd = "2026-11-10";
  const emailedAt = at(addDays(openYmd, -20), "08:00", NY);
  const fires = simulate({
    zone: NY,
    openYmd,
    times: ["10:00"],
    contacts: (now) => [person({ relationshipStatus: now >= emailedAt ? "reached_out" : "not_contacted" })],
  });
  assert.ok(fires.every((f) => f.offset > 20), `fired at ${fires.map((f) => f.offset).join(",")}`);
  assert.ok(fires.length > 0);
});

test("D. three firms, one visit a day: every firm gets its every-other-day flash, none is starved", () => {
  const openYmd = "2026-11-10";
  const opensOn = utcDay(openYmd);
  const firms = ["Evercore", "Lazard", "Moelis"];
  const perFirm = new Map<string, number>();
  const lastShown = new Map<string, string>();
  for (let offset = 35; offset >= 1; offset--) {
    const today = addDays(openYmd, -offset);
    const now = at(today, "10:00", NY);
    const nudges = select(
      firms.map((f) => opening({ firmName: f, firmSlug: f.toLowerCase(), date: opensOn })),
      firms.map((f, i) => person({ id: `c${i}`, name: `Person ${i}`, firm: f })),
      now,
    );
    for (let n = nextFlash(nudges, lastShown, today); n; n = nextFlash(nudges, lastShown, today)) {
      lastShown.set(nudgePrefix(n), today);
      perFirm.set(n.firmName, (perFirm.get(n.firmName) ?? 0) + 1);
    }
  }
  assert.deepEqual(Object.fromEntries(perFirm), { Evercore: 15, Lazard: 15, Moelis: 15 });
});

test("D. one opening keeps one record across the window; each day's firing has its own key, and the day after a firing is not due", () => {
  const opensOn = utcDay("2026-11-10");
  const days = [30, 29, 28].map((off) => addDays("2026-11-10", -off));
  const nudges = days.map((day) => select([opening({ date: opensOn })], [person()], at(day, "10:00", NY))[0]);
  const prefixes = nudges.map(nudgePrefix);
  assert.equal(prefixes[0], prefixes[1]);
  assert.equal(prefixes[1], prefixes[2]);
  const keys = nudges.map((n, i) => dayFlashKey(n.firmKey, n.opensOn, days[i]));
  assert.equal(new Set(keys).size, 3);
  for (const k of keys) assert.ok(k.startsWith(prefixes[0]));
  // Fired 30 days out: not due 29 days out, due again 28 days out.
  assert.equal(flashDueToday(days[0], days[1]), false);
  assert.equal(flashDueToday(days[0], days[2]), true);
});

// ======================================================================
// E. One prompt per firm, however many postings and contacts
// ======================================================================

for (const postings of [1, 2, 3, 7, 20]) {
  for (const people of [1, 4, 40]) {
    test(`E. ${postings} posting${postings === 1 ? "" : "s"} x ${people} contact${people === 1 ? "" : "s"} at Goldman: one prompt, one to-do row, counting ${people}`, () => {
      // Openings from 3 days in the past to 40 ahead; the soonest future one
      // within 30 days is the one that counts.
      const offsets = Array.from({ length: postings }, (_, i) => [9, 33, -3, 12, 25, 2, 40][i % 7] + Math.floor(i / 7));
      const apps = offsets.map((off, i) =>
        opening({
          firmName: "Goldman Sachs",
          firmSlug: "goldman-sachs",
          cycleLabel: i % 2 ? "Summer 2027" : "Summer 2028",
          date: utcDay(addDays(A_TODAY, off)),
        }),
      );
      const contacts = Array.from({ length: people }, (_, i) =>
        person({ id: `g${i}`, name: `Banker ${String(i).padStart(2, "0")}`, firm: ["Goldman Sachs", "GS", "Goldman Sachs & Co. LLC", "The Goldman Sachs Group, Inc."][i % 4] }),
      );
      const nudges = select(apps, contacts, A_NOW);
      const future = offsets.filter((o) => o >= 1 && o <= 30);
      if (future.length === 0) {
        assert.deepEqual(nudges, []);
        return;
      }
      assert.equal(nudges.length, 1);
      assert.equal(nudges[0].contacts.length, people);
      assert.equal(nudges[0].daysUntilOpen, Math.min(...future));
      assert.equal(todoNudges(nudges).length, Math.min(...future) <= 14 ? 1 : 0);
    });
  }
}

test("E. two firms-table rows that are the same bank (J.P. Morgan / JPMorgan) are still one prompt", () => {
  const nudges = select(
    [
      opening({ firmName: "J.P. Morgan", firmSlug: "j-p-morgan", date: utcDay(addDays(A_TODAY, 10)) }),
      opening({ firmName: "JPMorgan", firmSlug: "jpmorgan", date: utcDay(addDays(A_TODAY, 6)) }),
    ],
    [person({ firm: "JPM" }), person({ id: "c2", name: "Ari Cole", firm: "J.P. Morgan" })],
    A_NOW,
  );
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].daysUntilOpen, 6);
  assert.equal(nudges[0].contacts.length, 2);
});

// ======================================================================
// F. Several openings at one firm
// ======================================================================

type MultiCase = { label: string; openings: { off: number; kind?: Application["kind"]; provenance?: Application["provenance"]; cycle?: string }[]; want: number | null };

const MULTI: MultiCase[] = [
  { label: "IB 20 days, S&T 8 days: the sooner one", openings: [{ off: 20 }, { off: 8 }], want: 8 },
  { label: "one opened 2 days ago, another in 12: the future one", openings: [{ off: -2 }, { off: 12 }], want: 12 },
  { label: "a deadline in 2 days and an opening in 25: the opening", openings: [{ off: 2, kind: "due" }, { off: 25 }], want: 25 },
  { label: "an undated tracked row and an opening in 18", openings: [{ off: 3, kind: "undated", provenance: "tracked" }, { off: 18 }], want: 18 },
  { label: "a signal-sourced opening in 4, a posting in 9: the signal (both published)", openings: [{ off: 9 }, { off: 4, provenance: "signal" }], want: 4 },
  { label: "a tracked-provenance 'opens' in 1 and a posting in 29: the posting", openings: [{ off: 1, provenance: "tracked" }, { off: 29 }], want: 29 },
  { label: "summer 2027 and summer 2028 the same day: one prompt", openings: [{ off: 7, cycle: "Summer 2027" }, { off: 7, cycle: "Summer 2028" }], want: 7 },
  { label: "both beyond the window (31, 45): silent", openings: [{ off: 31 }, { off: 45 }], want: null },
  { label: "one inside at 30, one at 31: the one at 30", openings: [{ off: 31 }, { off: 30 }], want: 30 },
  { label: "all in the past: silent", openings: [{ off: -1 }, { off: -30 }], want: null },
];

for (const m of MULTI) {
  test(`F. ${m.label}`, () => {
    const apps = m.openings.map((o) =>
      opening({ date: utcDay(addDays(A_TODAY, o.off)), kind: o.kind ?? "opens", provenance: o.provenance ?? "posting", cycleLabel: o.cycle ?? "Summer 2028" }),
    );
    for (const order of [apps, [...apps].reverse()]) {
      const nudges = select(order, [person()], A_NOW);
      assert.equal(nudges[0]?.daysUntilOpen ?? null, m.want);
      assert.ok(nudges.length <= 1);
    }
  });
}

test("F. once the first opening passes, the firm's next opening is a new flash and a new bell job", () => {
  const first = utcDay(addDays(A_TODAY, 5));
  const second = utcDay(addDays(A_TODAY, 20));
  const apps = [opening({ date: first }), opening({ date: second })];
  const before = select(apps, [person()], A_NOW)[0];
  const after = select(apps, [person()], at(addDays(A_TODAY, 6), "10:00", NY))[0];
  assert.equal(dayKey(before.opensOn), dayKey(first));
  assert.equal(dayKey(after.opensOn), dayKey(second));
  assert.notEqual(outreachNotificationKey(before.firmKey, dayKey(before.opensOn)), outreachNotificationKey(after.firmKey, dayKey(after.opensOn)));
  assert.notEqual(nudgePrefix(before), nudgePrefix(after));
});

// ======================================================================
// G. Estimated, TBD, rolling, closed, and postings that are not real
// ======================================================================

// Anything that is not a published date must stay silent, including values
// the type does not allow but a refactor or a raw query could pass through.
const NOT_A_PUBLISHED_OPENING: [string, Partial<Application>][] = [
  ['provenance "estimate"', { provenance: "estimate" as Application["provenance"] }],
  ['provenance "estimated"', { provenance: "estimated" as Application["provenance"] }],
  ['provenance "prediction"', { provenance: "prediction" as Application["provenance"] }],
  ['provenance "tracked"', { provenance: "tracked" }],
  ["provenance empty", { provenance: "" as Application["provenance"] }],
  ['provenance "POSTING" (wrong case)', { provenance: "POSTING" as Application["provenance"] }],
  ['kind "due" (a deadline)', { kind: "due" }],
  ['kind "undated"', { kind: "undated" }],
  ['kind "Opens" (wrong case)', { kind: "Opens" as Application["kind"] }],
  ["date null", { date: null }],
  ["date is an Invalid Date", { date: new Date("not a date") }],
];

for (const [label, over] of NOT_A_PUBLISHED_OPENING) {
  test(`G. ${label} never produces a countdown`, () => {
    assert.deepEqual(select([opening({ date: utcDay(addDays(A_TODAY, 7)), ...over })], [person()], A_NOW), []);
  });
}

const SKELETON = "Program description not yet captured. Placeholder.";
const REAL = "Ten-week summer analyst programme in New York.";
const NOT_OPEN_TEXTS = [
  "Summer 2028 applications are not open yet.",
  "Application timing is not published for this programme.",
  "US applications open in the spring.",
  "SUMMER 2028 APPLICATIONS ARE NOT OPEN YET.",
];

// isRealPosting is the gate every student-facing list goes through
// (getRelevantPostings filters on it), so the outreach prompt inherits it.
const REALNESS: [string, Parameters<typeof isRealPosting>[0], boolean][] = [];
for (const status of ["tbd", "confirmed", "rolling", "closed", null, undefined] as const) {
  REALNESS.push([`skeleton, status ${status}`, { roleTitle: "Summer Analyst", descriptionFull: SKELETON, deadlineText: "Closes 14 October", deadlineStatus: status }, false]);
}
for (const text of NOT_OPEN_TEXTS) {
  for (const status of ["tbd", "rolling", "closed", null] as const) {
    REALNESS.push([`"${text.slice(0, 32)}...", status ${status}`, { roleTitle: "Summer Analyst", descriptionFull: REAL, deadlineText: text, deadlineStatus: status }, false]);
  }
  REALNESS.push([`"${text.slice(0, 32)}...", status confirmed`, { roleTitle: "Summer Analyst", descriptionFull: REAL, deadlineText: text, deadlineStatus: "confirmed" }, true]);
}
for (const status of ["tbd", "confirmed", "rolling"] as const) {
  REALNESS.push([`a crawled posting, status ${status}`, { roleTitle: "Summer Analyst", descriptionFull: REAL, deadlineText: "Applications close 14 October.", deadlineStatus: status }, true]);
}

for (const [label, posting, real] of REALNESS) {
  test(`G. isRealPosting: ${label} -> ${real ? "real" : "not real"}`, () => {
    assert.equal(isRealPosting(posting), real);
  });
}

// ======================================================================
// H. Free-text firm names: spellings that must match, and near-misses
// ======================================================================

function matches(posted: string, typed: string): boolean {
  return select([opening({ firmName: posted, date: utcDay(addDays(A_TODAY, 10)) })], [person({ firm: typed })], A_NOW).length === 1;
}

// Spellings students actually type, not already covered by
// outreach-firm-matching.test.ts.
const MUST_MATCH: [string, string][] = [
  ["Goldman Sachs", "goldman-sachs"],
  ["Goldman Sachs", "Goldman Sachs."],
  ["Goldman Sachs", "Goldman  Sachs"],
  ["Goldman Sachs", "GOLDMAN SACHS GROUP, INC."],
  ["Goldman Sachs", "Goldman Sachs"],
  ["J.P. Morgan", "JPMorgan"],
  ["J.P. Morgan", "J. P. Morgan"],
  ["J.P. Morgan", "JPM"],
  ["J.P. Morgan", "JPMorgan Chase"],
  ["J.P. Morgan", "JPMorgan Chase & Co."],
  ["J.P. Morgan", "J.P. Morgan Chase & Co."],
  ["J.P. Morgan", "JPMorganChase"],
  ["J.P. Morgan", "JPMC"],
  ["Morgan Stanley", "Morgan Stanley & Co."],
  ["Bank of America", "Bank of America Corporation"],
  ["Bank of America", "BofA Securities"],
  ["Citigroup", "Citigroup Inc."],
  ["Citigroup", "Citi"],
  ["Evercore", "Evercore Partners Inc."],
  ["Lazard", "Lazard, Inc."],
  ["Blackstone", "The Blackstone Group Inc."],
  ["The Carlyle Group", "Carlyle"],
  ["KKR", "KKR & Co"],
  ["KKR", "KKR & Co. L.P."],
  ["Moelis & Company", "Moelis"],
  ["Rothschild & Co", "Rothschild"],
  ["Wells Fargo", "Wells Fargo & Company"],
  ["McKinsey & Company", "McKinsey"],
  ["Bain & Company", "Bain"],
  ["Moody's", "Moody’s"],
  ["Société Générale", "Société Générale"],
  ["Société Générale", "Societe Generale"],
  ["Société Générale", "Société Générale"],
  ["Deutsche Bank", "Deutsche Bank AG"],
  ["UBS", "UBS AG"],
  ["BNP Paribas", "BNP Paribas SA"],
  ["Two Sigma Investments", "Two Sigma Investments, L.P."],
  ["Point72 Asset Management", "Point72 Asset Management, L.P."],
];

for (const [posted, typed] of MUST_MATCH) {
  test(`H. a contact at "${typed}" is counted for a posting at "${posted}"`, () => {
    assert.ok(matches(posted, typed), `"${typed}" -> "${normalizeFirmName(typed)}", "${posted}" -> "${normalizeFirmName(posted)}"`);
  });
}

// Different firms. A match here would tell a student to email the wrong bank.
const MUST_NOT_MATCH: [string, string][] = [
  ["Morgan Stanley", "J.P. Morgan"],
  ["Morgan Stanley", "JPM"],
  ["J.P. Morgan", "MS"],
  ["Evercore", "Evercore ISI"],
  ["Evercore ISI", "Evercore"],
  ["Lazard", "Lazard Asset Management LLC"],
  ["Lazard Asset Management", "Lazard"],
  ["Citigroup", "Citizens Bank"],
  ["Citigroup", "Citizens Financial Group"],
  ["Citigroup", "Citadel"],
  ["Citadel", "Citadel Securities"],
  ["Bank of America", "Bank of Montreal"],
  ["Bank of America", "America First Credit Union"],
  ["UBS", "US Bank"],
  ["Goldman Sachs", "Goldman Lancaster"],
  ["Houlihan Lokey", "Houlihan Capital"],
  ["Centerview Partners", "Centerview Capital"],
  ["Deutsche Bank", "DBS Bank"],
  ["KKR", "Accel-KKR"],
  ["Moelis & Company", "Moelis Asset Catalyst Partners"],
  ["Apollo Global Management", "Apollon Wealth Management"],
];

for (const [posted, typed] of MUST_NOT_MATCH) {
  test(`H. a contact at "${typed}" is NOT counted for "${posted}"`, () => {
    assert.ok(!matches(posted, typed));
  });
}

test('H. "Goldman Sachs Asset Management" vs "Goldman Sachs": whichever the answer, it is the same in both directions', () => {
  assert.equal(matches("Goldman Sachs", "Goldman Sachs Asset Management"), matches("Goldman Sachs Asset Management", "Goldman Sachs"));
});

test("H. only the tracked Evercore is prompted, even with Evercore ISI contacts on the list", () => {
  const nudges = select(
    [opening({ firmName: "Evercore", date: utcDay(addDays(A_TODAY, 5)) })],
    [person({ id: "a", name: "A One", firm: "Evercore" }), person({ id: "b", name: "B Two", firm: "Evercore ISI" }), person({ id: "c", name: "C Three", firm: "Evercore ISI" })],
    A_NOW,
  );
  assert.equal(nudges.length, 1);
  assert.deepEqual(nudges[0].contacts.map((c) => c.id), ["a"]);
});

// ======================================================================
// I. Contacts already emailed, replied to, partly done
// ======================================================================

for (const status of relationshipStatusEnum.enumValues) {
  test(`I. a contact whose status is "${status}" ${status === "not_contacted" ? "is" : "is not"} counted`, () => {
    const nudges = select([opening()], [person({ relationshipStatus: status }), person({ id: "c2", name: "Other Person" })], A_NOW);
    assert.equal(nudges[0].contacts.length, status === "not_contacted" ? 2 : 1);
  });
}

type Mix = { label: string; statuses: string[]; want: number | null };
const MIXES: Mix[] = [
  { label: "5 contacts, none emailed", statuses: Array(5).fill("not_contacted"), want: 5 },
  { label: "5 contacts, 2 emailed", statuses: ["reached_out", "not_contacted", "reached_out", "not_contacted", "not_contacted"], want: 3 },
  { label: "5 contacts, 4 emailed", statuses: ["reached_out", "in_conversation", "ongoing", "cold", "not_contacted"], want: 1 },
  { label: "5 contacts, all emailed", statuses: ["reached_out", "reached_out", "in_conversation", "ongoing", "cold"], want: null },
  { label: "1 contact who replied", statuses: ["in_conversation"], want: null },
  { label: "1 contact never emailed", statuses: ["not_contacted"], want: 1 },
];

for (const m of MIXES) {
  test(`I. ${m.label}: ${m.want === null ? "no prompt" : `${m.want} left`}`, () => {
    const contacts = m.statuses.map((s, i) => person({ id: `p${i}`, name: `Person ${i}`, relationshipStatus: s }));
    const nudges = select([opening()], contacts, A_NOW);
    assert.equal(nudges[0]?.contacts.length ?? null, m.want);
  });
}

test("I. the one person left without an address is still prompted for, as 1 contact", () => {
  const nudges = select(
    [opening()],
    [person({ id: "a", name: "A", relationshipStatus: "reached_out" }), person({ id: "b", name: "B", email: null })],
    A_NOW,
  );
  assert.deepEqual(nudges[0].contacts.map((c) => c.id), ["b"]);
});

test("I. contacts at other firms never add to this firm's count", () => {
  const nudges = select(
    [opening({ firmName: "Lazard", date: utcDay(addDays(A_TODAY, 9)) })],
    [person({ id: "a", name: "A", firm: "Lazard" }), person({ id: "b", name: "B", firm: "Evercore" }), person({ id: "c", name: "C", firm: "Lazard Asset Management" })],
    A_NOW,
  );
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].contacts.length, 1);
});

// ======================================================================
// J. All 14 sectors
// ======================================================================
//
// Sector itself is decided upstream in upcoming-applications (admission); the
// selector only sees firm names. So each sector has a realistic firm and a
// realistic student spelling of it, and each must prompt.

const SECTOR_FIRMS: Record<string, [posted: string, typed: string]> = {
  investment_banking: ["Evercore", "Evercore Inc."],
  private_equity: ["The Carlyle Group", "Carlyle"],
  venture_capital: ["Andreessen Horowitz", "andreessen horowitz llc"],
  private_credit: ["Ares Management", "Ares Management Corporation"],
  real_estate: ["Brookfield Asset Management", "Brookfield Asset Management Ltd."],
  hedge_fund: ["Citadel", "Citadel LLC"],
  sales_trading: ["Jane Street", "Jane Street LLC"],
  asset_wealth_management: ["BlackRock", "BlackRock, Inc."],
  commercial_banking: ["Wells Fargo", "Wells Fargo & Company"],
  insurance: ["Chubb", "Chubb Limited"],
  fintech: ["Stripe", "Stripe, Inc."],
  market_infrastructure: ["Nasdaq", "Nasdaq, Inc."],
  consulting: ["McKinsey & Company", "McKinsey"],
  other_finance: ["Moody's", "Moody’s Corporation"],
};

test("J. the table covers exactly the 14 sectors in the schema", () => {
  assert.deepEqual(Object.keys(SECTOR_FIRMS).sort(), [...firmProgramCategoryEnum.enumValues].sort());
  assert.equal(firmProgramCategoryEnum.enumValues.length, 14);
});

for (const [sector, [posted, typed]] of Object.entries(SECTOR_FIRMS)) {
  test(`J. ${sector}: "${typed}" is prompted for "${posted}" opening in 10 days, one emailed, one left`, () => {
    const nudges = select(
      [opening({ firmName: posted, firmSlug: sector, date: utcDay(addDays(A_TODAY, 10)) })],
      [person({ id: "x", name: "Done Person", firm: typed, relationshipStatus: "reached_out" }), person({ id: "y", name: "Left Person", firm: typed })],
      A_NOW,
    );
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].contacts.length, 1);
    assert.equal(todoNudges(nudges).length, 1);
  });
}

// ======================================================================
// K. The bell job
// ======================================================================

test("K. one bell job per firm and opening: the same key on every day of the window", () => {
  const opensOn = utcDay("2026-11-10");
  const keys = new Set<string>();
  for (let off = 30; off >= 1; off--) {
    const [n] = select([opening({ date: opensOn })], [person()], at(addDays("2026-11-10", -off), "10:00", NY));
    keys.add(outreachNotificationKey(n.firmKey, dayKey(n.opensOn)));
  }
  assert.equal(keys.size, 1);
});

test("K. the bell's subject is what every spelling of the firm normalises to, so auto-close can count them", () => {
  const [n] = select([opening({ firmName: "The Goldman Sachs Group, Inc." })], [person({ firm: "GS" })], A_NOW);
  for (const typed of ["GS", "Goldman Sachs", "Goldman Sachs & Co. LLC", "goldman sachs group"]) {
    assert.equal(normalizeFirmName(typed), n.firmKey, typed);
  }
});

test("K. a job whose firm is all emailed closes as done even after the opening passed", () => {
  const opensOn = utcDay("2026-11-10");
  const rows = [{ id: "j", subjectKey: "goldman sachs", expiresAt: opensOn, doneAt: null }];
  assert.deepEqual(autoCloseable(rows, new Map([["goldman sachs", 0]]), new Date(opensOn.getTime() + DAY)), [{ id: "j", source: "auto" }]);
});

test("K. the job is still open on the student's evening the day before the opening", () => {
  // Opens 10 Nov. At 21:00 on 9 Nov in New York it has not opened on the
  // student's calendar, so the job must not have expired yet.
  const opensOn = utcDay("2026-11-10");
  const now = at("2026-11-09", "21:00", NY);
  const [n] = select([opening({ date: opensOn })], [person()], now);
  assert.ok(n, "still prompted the evening before");
  assert.equal(n.daysUntilOpen, 1, "opens tomorrow");
});

// ======================================================================
// M. Seeded fuzz
// ======================================================================

const FIRMS: { posted: string; typed: string[] }[] = [
  { posted: "Goldman Sachs", typed: ["Goldman Sachs", "GS", "Goldman Sachs & Co. LLC", "The Goldman Sachs Group, Inc.", "goldman sachs"] },
  { posted: "J.P. Morgan", typed: ["JPMorgan", "JPM", "J.P. Morgan", "JP Morgan"] },
  { posted: "Morgan Stanley", typed: ["Morgan Stanley", "MS", "Morgan Stanley & Co. LLC"] },
  { posted: "Evercore", typed: ["Evercore", "Evercore Inc.", "Evercore Partners"] },
  { posted: "Lazard", typed: ["Lazard", "Lazard Ltd"] },
  { posted: "Bank of America", typed: ["BofA", "BAML", "Merrill Lynch", "Bank of America"] },
  { posted: "Moelis & Company", typed: ["Moelis", "Moelis & Co."] },
  { posted: "Blackstone", typed: ["Blackstone", "The Blackstone Group"] },
  { posted: "Citadel", typed: ["Citadel", "Citadel LLC"] },
  { posted: "McKinsey & Company", typed: ["McKinsey", "McKinsey & Company"] },
  { posted: "Chubb", typed: ["Chubb Limited"] },
  { posted: "Nasdaq", typed: ["Nasdaq, Inc."] },
];
// Contacts at firms that are never tracked: near-misses and unrelated banks.
const DISTRACTORS = ["Evercore ISI", "Lazard Asset Management", "Citadel Securities", "Citizens Bank", "Houlihan Capital", "Bain Capital", "", "   "];
const STATUSES = relationshipStatusEnum.enumValues;
const NAMES = ["Dana Reed", "Ari Cole", "Sam Park", "Priya Shah", "Luis Ortega", "Mei Lin", "Jon Beck", "Zoë Adler"];

type FuzzPosting = Application & { roleTitle: string; descriptionFull: string; deadlineText: string | null; deadlineStatus: string };

test("M. fuzz: 300 seeded scenarios hold every invariant", () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    // A New York student in office hours: their calendar day and the UTC day
    // agree, so time-zone effects (section B) do not enter this fuzz.
    const today = addDays("2026-09-01", r.int(0, 200));
    const now = at(today, `${String(r.int(9, 16)).padStart(2, "0")}:${String(r.int(0, 59)).padStart(2, "0")}`, NY);

    const firms = r.shuffle(FIRMS).slice(0, r.int(1, 8));
    const postings: FuzzPosting[] = [];
    for (const f of firms) {
      for (let i = r.int(0, 5); i > 0; i--) {
        // Includes 0: the opening day itself is silent (days < 1 below).
        const off = r.int(-5, 45);
        const realness = r.pick(["real", "real", "real", "skeleton", "unopened", "unopened-confirmed"] as const);
        postings.push({
          ...opening({
            firmName: f.posted,
            firmSlug: f.posted.toLowerCase().replace(/\W+/g, "-"),
            cycleLabel: r.pick(["Summer 2027", "Summer 2028"]),
            date: r.chance(0.08) ? null : utcDay(addDays(today, off)),
            kind: r.pick(["opens", "opens", "opens", "due", "undated"] as const),
            provenance: r.pick(["posting", "posting", "signal", "tracked", "estimate"] as Application["provenance"][]),
          }),
          roleTitle: "Summer Analyst",
          descriptionFull: realness === "skeleton" ? SKELETON : REAL,
          deadlineText: realness.startsWith("unopened") ? r.pick(NOT_OPEN_TEXTS) : null,
          deadlineStatus: realness === "unopened-confirmed" ? "confirmed" : r.pick(["tbd", "rolling", "confirmed"]),
        });
      }
    }
    // What getRelevantPostings lets through.
    const apps: Application[] = postings.filter((p) => isRealPosting(p)).map(({ descriptionFull, deadlineText, deadlineStatus, roleTitle, ...a }) => a);

    const contacts: ContactRow[] = [];
    let id = 0;
    for (const f of FIRMS) {
      for (let i = r.int(0, 4); i > 0; i--) {
        contacts.push(person({
          id: `c${++id}`,
          name: r.chance(0.15) && contacts.length ? contacts[contacts.length - 1].name.toUpperCase() + " " : r.pick(NAMES),
          firm: r.pick(f.typed),
          email: r.chance(0.6) ? `p${id}@x.com` : null,
          relationshipStatus: r.chance(0.55) ? "not_contacted" : r.pick(STATUSES),
        }));
      }
    }
    for (let i = r.int(0, 4); i > 0; i--) {
      contacts.push(person({ id: `d${++id}`, name: r.pick(NAMES), firm: r.pick(DISTRACTORS) }));
    }

    const nudges = select(apps, contacts, now);
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const fail = (msg: string) => failures.push(`seed ${seed}: ${msg}`);

    // Expected, derived independently from the rules as stated.
    const expected = new Map<string, { opens: string; days: number; people: Set<string> }>();
    // The same person saved twice at one firm is one person, and written to if
    // either copy has been.
    const reached = new Set(
      contacts
        .filter((c) => c.relationshipStatus !== "not_contacted" && c.firm?.trim())
        .map((c) => `${normalizeFirmName(c.firm!)}|${c.name.trim().toLowerCase()}`),
    );
    for (const c of contacts) {
      if (c.relationshipStatus !== "not_contacted" || !c.firm?.trim()) continue;
      const key = normalizeFirmName(c.firm);
      if (!key) continue;
      if (reached.has(`${key}|${c.name.trim().toLowerCase()}`)) continue;
      const soonest = apps
        .filter((a) => normalizeFirmName(a.firmName) === key && a.kind === "opens" && (a.provenance === "posting" || a.provenance === "signal") && a.date)
        .map((a) => studentDays(a.date!, now, NY))
        .filter((d) => d >= 1 && d <= FLASH_WINDOW_DAYS)
        .sort((a, b) => a - b)[0];
      if (soonest === undefined) continue;
      const e = expected.get(key) ?? { opens: addDays(localDateString(now, NY), soonest), days: soonest, people: new Set<string>() };
      e.people.add(c.name.trim().toLowerCase());
      expected.set(key, e);
    }

    // One per firm.
    const keys = nudges.map((n) => n.firmKey);
    if (new Set(keys).size !== keys.length) fail(`duplicate firm: ${keys.join(",")}`);
    // Exactly the expected firms.
    if ([...keys].sort().join("|") !== [...expected.keys()].sort().join("|")) fail(`firms ${keys.sort().join(",")} != ${[...expected.keys()].sort().join(",")}`);

    for (const n of nudges) {
      const e = expected.get(n.firmKey);
      if (!e) continue;
      // Never an estimated date, never a non-real posting: the date shown is
      // backed by a real, published opening at this firm.
      const backed = postings.some((p) => isRealPosting(p) && normalizeFirmName(p.firmName) === n.firmKey && p.kind === "opens" && (p.provenance === "posting" || p.provenance === "signal") && p.date?.getTime() === n.opensOn.getTime());
      if (!backed) fail(`${n.firmKey} opens ${dayKey(n.opensOn)} is not backed by a real published opening`);
      if (dayKey(n.opensOn) !== e.opens) fail(`${n.firmKey} opens ${dayKey(n.opensOn)} != ${e.opens}`);
      if (n.daysUntilOpen !== e.days) fail(`${n.firmKey} ${n.daysUntilOpen}d != ${e.days}d`);
      // Count equals un-emailed people (one per name, as the prompt counts them).
      if (n.contacts.length !== e.people.size) fail(`${n.firmKey} counts ${n.contacts.length} != ${e.people.size}`);
      if (n.contacts.length === 0) fail(`${n.firmKey} has an empty contact list`);
      for (const c of n.contacts) {
        const row = byId.get(c.id);
        if (!row || row.relationshipStatus !== "not_contacted") fail(`${n.firmKey} offers ${c.id}, who was already contacted`);
        if (row && normalizeFirmName(row.firm ?? "") !== n.firmKey) fail(`${n.firmKey} offers ${c.id} from "${row.firm}"`);
      }
    }

    // Sorted by urgency, ties by name.
    for (let i = 1; i < nudges.length; i++) {
      const a = nudges[i - 1];
      const b = nudges[i];
      if (a.daysUntilOpen > b.daysUntilOpen || (a.daysUntilOpen === b.daysUntilOpen && a.firmName.localeCompare(b.firmName) > 0)) fail(`order ${a.firmName}(${a.daysUntilOpen}) before ${b.firmName}(${b.daysUntilOpen})`);
    }

    // To-do list is the <=14-day subset, order kept.
    const todo = todoNudges(nudges);
    if (todo.map((n) => n.firmKey).join("|") !== nudges.filter((n) => n.daysUntilOpen <= TODO_WINDOW_DAYS).map((n) => n.firmKey).join("|")) fail("to-do list is not the 14-day subset in order");

    // The flash picks the most urgent one not shown in the last two days.
    const localToday = localDateString(now, NY);
    const shownOn = (day: string) => new Map(nudges.map((n) => [nudgePrefix(n), day]));
    if ((nextFlash(nudges, new Map(), localToday)?.firmKey ?? null) !== (nudges[0]?.firmKey ?? null)) fail("first flash is not the most urgent");
    if (nextFlash(nudges, shownOn(localToday), localToday) !== null) fail("a flash shown today fires again today");
    if (nextFlash(nudges, shownOn(addDays(localToday, -1)), localToday) !== null) fail("a flash shown yesterday fires again today");
    if ((nextFlash(nudges, shownOn(addDays(localToday, -2)), localToday)?.firmKey ?? null) !== (nudges[0]?.firmKey ?? null)) fail("a flash shown two days ago does not come back");

    // Stable across input order.
    const project = (ns: OutreachNudge[]) => ns.map((n) => `${n.firmKey}@${dayKey(n.opensOn)}:${n.daysUntilOpen}:${n.contacts.map((c) => c.name.trim().toLowerCase()).join(",")}`).join(" | ");
    const shuffled = select(r.shuffle(apps), r.shuffle(contacts), now);
    if (project(shuffled) !== project(nudges)) fail(`order-dependent:\n  ${project(nudges)}\n  ${project(shuffled)}`);
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} failures`);
});
