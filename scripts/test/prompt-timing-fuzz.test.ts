// Adversarial timing tests for the four prompts: interview prep, thank-yous,
// the outreach flash, and the cold-email ladder.
//
// Every expected instant below is written out in UTC with the real offset on
// that date, worked by hand:
//   America/New_York   EDT -4 until 2026-11-01 06:00Z, EST -5 until 2027-03-14 07:00Z
//   Europe/London      BST +1 until 2026-10-25 01:00Z, GMT until 2027-03-28 01:00Z
//   Asia/Kolkata       +5:30 all year
//   Australia/Sydney   AEST +10 until 2026-10-03 16:00Z, AEDT +11 until 2027-04-03 16:00Z
//   Pacific/Kiritimati +14 all year
//   America/St_Johns   NDT -2:30 until 2026-11-01 04:30Z, NST -3:30 until 2027-03-14 05:30Z

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calendarDaysBetween,
  prepIntervalFor,
  refresherAt,
  selectInterviewPrep,
  type PracticeRound,
  type TrackedFirms,
} from "../../src/lib/interview-prep";
import { looksLikeInterview } from "../../src/lib/interview-prep-words";
import { DEFAULT_TIME_ZONE, localDateString, localParts, parseTimeZone, zonedTime } from "../../src/lib/time-zone";
import {
  contactInTitle,
  isChatEvent,
  selectThankYous,
  thankYouDueAt,
  type ChatEvent,
  type ThankContact,
} from "../../src/lib/thank-you";
import {
  flashKey,
  flashPrefix,
  flashRound,
  nextFlash,
  todoNudges,
  type OutreachNudge,
} from "../../src/lib/application-outreach";
import { daysOverdue, ladderState, repeatRound } from "../../src/lib/outreach-ladder";
import { NOW as OUTREACH_NOW, daysOut, nudgesFor, opening, person } from "./outreach-fixtures";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const Z = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

const NY = "America/New_York";
const LON = "Europe/London";
const KOL = "Asia/Kolkata";
const SYD = "Australia/Sydney";
const KIR = "Pacific/Kiritimati";
const STJ = "America/St_Johns";
const ZONES = [NY, LON, KOL, SYD, KIR, STJ, "America/Los_Angeles", "Pacific/Auckland", "Asia/Tokyo"];

type PrepEvent = Parameters<typeof selectInterviewPrep>[0]["events"][number];

function interview(eventDate: Date, over: Partial<PrepEvent> = {}): PrepEvent {
  return {
    id: "e1",
    title: "Evercore superday",
    notes: null,
    type: "meeting",
    eventDate,
    completed: false,
    ...over,
  };
}

function prep(
  events: PrepEvent[],
  now: Date,
  opts: { practice?: PracticeRound[]; timeZone?: string; trackedFirms?: TrackedFirms } = {},
) {
  return selectInterviewPrep({
    events,
    now,
    ...opts,
  });
}

// =====================================================================
// time-zone.ts
// =====================================================================

test("parseTimeZone keeps every zone in the matrix", () => {
  for (const z of ZONES) assert.equal(parseTimeZone(z), z);
});

test("parseTimeZone decodes an encoded half-hour zone", () => {
  assert.equal(parseTimeZone(encodeURIComponent(STJ)), STJ);
});

test("parseTimeZone falls back on junk, including malformed percent-encoding", () => {
  assert.equal(parseTimeZone("Mars/Olympus_Mons"), DEFAULT_TIME_ZONE);
  assert.equal(parseTimeZone(null), DEFAULT_TIME_ZONE);
  // A cookie is user-controlled; "%E0%A4%A" is not valid URI encoding.
  assert.equal(parseTimeZone("%E0%A4%A"), DEFAULT_TIME_ZONE);
});

test("localParts reads midnight as hour 0, never 24", () => {
  for (const z of ZONES) {
    const midnight = zonedTime(2026, 10, 1, 0, 0, z);
    const p = localParts(midnight, z);
    assert.equal(p.hour, 0, z);
    assert.equal(p.day, 1, z);
  }
});

test("localParts in Kolkata crosses midnight at 18:30Z", () => {
  assert.deepEqual(localParts(Z("2026-09-30T18:29:00Z"), KOL), { year: 2026, month: 9, day: 30, hour: 23, minute: 59 });
  assert.deepEqual(localParts(Z("2026-09-30T18:30:00Z"), KOL), { year: 2026, month: 10, day: 1, hour: 0, minute: 0 });
});

test("localParts in Kiritimati is a day ahead of UTC at New Year", () => {
  assert.deepEqual(localParts(Z("2026-12-31T10:00:00Z"), KIR), { year: 2027, month: 1, day: 1, hour: 0, minute: 0 });
});

const ZONED_CASES: [string, number, number, number, number, number, string][] = [
  [NY, 2026, 11, 1, 8, 0, "2026-11-01T13:00:00.000Z"],
  [NY, 2026, 10, 31, 18, 0, "2026-10-31T22:00:00.000Z"],
  [NY, 2027, 3, 14, 8, 0, "2027-03-14T12:00:00.000Z"],
  [NY, 2027, 3, 13, 18, 0, "2027-03-13T23:00:00.000Z"],
  [LON, 2026, 10, 24, 18, 0, "2026-10-24T17:00:00.000Z"],
  [LON, 2026, 10, 25, 8, 0, "2026-10-25T08:00:00.000Z"],
  [LON, 2027, 3, 27, 18, 0, "2027-03-27T18:00:00.000Z"],
  [LON, 2027, 3, 28, 8, 0, "2027-03-28T07:00:00.000Z"],
  [KOL, 2026, 9, 30, 18, 0, "2026-09-30T12:30:00.000Z"],
  [KOL, 2026, 10, 1, 8, 0, "2026-10-01T02:30:00.000Z"],
  [SYD, 2026, 10, 3, 18, 0, "2026-10-03T08:00:00.000Z"],
  [SYD, 2026, 10, 4, 8, 0, "2026-10-03T21:00:00.000Z"],
  [SYD, 2027, 4, 3, 18, 0, "2027-04-03T07:00:00.000Z"],
  [SYD, 2027, 4, 4, 8, 0, "2027-04-03T22:00:00.000Z"],
  [KIR, 2026, 12, 31, 18, 0, "2026-12-31T04:00:00.000Z"],
  [KIR, 2027, 1, 1, 8, 0, "2026-12-31T18:00:00.000Z"],
  [STJ, 2026, 10, 31, 18, 0, "2026-10-31T20:30:00.000Z"],
  [STJ, 2026, 11, 1, 8, 0, "2026-11-01T11:30:00.000Z"],
  [STJ, 2027, 3, 13, 18, 0, "2027-03-13T21:30:00.000Z"],
  [STJ, 2027, 3, 14, 8, 0, "2027-03-14T10:30:00.000Z"],
];

for (const [z, y, mo, d, h, mi, want] of ZONED_CASES) {
  test(`zonedTime ${y}-${mo}-${d} ${h}:00 in ${z} is ${want}`, () => {
    assert.equal(iso(zonedTime(y, mo, d, h, mi, z)), want);
  });
}

test("zonedTime day 0 of January is 31 December of the year before", () => {
  assert.equal(iso(zonedTime(2027, 1, 0, 18, 0, NY)), "2026-12-31T23:00:00.000Z");
});

test("zonedTime day 0 of March is 28 Feb in 2027 and 29 Feb in 2028", () => {
  assert.equal(iso(zonedTime(2027, 3, 0, 18, 0, NY)), "2027-02-28T23:00:00.000Z");
  assert.equal(iso(zonedTime(2028, 3, 0, 18, 0, NY)), "2028-02-29T23:00:00.000Z");
});

test("zonedTime in the spring-forward gap picks one of the two readings of 02:30", () => {
  // 02:30 on 14 Mar 2027 does not exist in New York. Either offset is a
  // defensible answer: 02:30 EST = 07:30Z, or 02:30 EDT = 06:30Z.
  const got = iso(zonedTime(2027, 3, 14, 2, 30, NY));
  assert.ok(["2027-03-14T06:30:00.000Z", "2027-03-14T07:30:00.000Z"].includes(got), got);
});

test("zonedTime round-trips every existing wall-clock hour on every DST-change day in the matrix", () => {
  const days: [number, number, number][] = [
    [2026, 10, 3], [2026, 10, 4], [2026, 10, 24], [2026, 10, 25], [2026, 10, 31], [2026, 11, 1],
    [2027, 3, 13], [2027, 3, 14], [2027, 3, 27], [2027, 3, 28], [2027, 4, 3], [2027, 4, 4],
  ];
  const failures: string[] = [];
  for (const z of ZONES) {
    for (const [y, mo, d] of days) {
      for (let h = 0; h < 24; h++) {
        for (const mi of [0, 30]) {
          const got = zonedTime(y, mo, d, h, mi, z);
          const p = localParts(got, z);
          // Skip wall-clock times inside a spring-forward gap.
          const inGap = p.hour !== h || p.minute !== mi;
          if (inGap) {
            // A gap is at most an hour: the answer must be within an hour of asked.
            const asked = Date.UTC(y, mo - 1, d, h, mi);
            const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
            if (Math.abs(shown - asked) > HOUR) failures.push(`${z} ${y}-${mo}-${d} ${h}:${mi}`);
            continue;
          }
          if (p.year !== y || p.month !== mo || p.day !== d) failures.push(`${z} ${y}-${mo}-${d} ${h}:${mi} date`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

// =====================================================================
// refresherAt
// =====================================================================

const REFRESHER_CASES: [string, string, string, string][] = [
  // [label, interview instant, zone, expected refresher]
  ["NY 9am on fall-back day -> 6pm EDT the day before", "2026-11-01T14:00:00Z", NY, "2026-10-31T22:00:00.000Z"],
  ["NY 2pm on fall-back day -> 8am EST that day", "2026-11-01T19:00:00Z", NY, "2026-11-01T13:00:00.000Z"],
  ["NY 1:30am EDT (first 1:30) on fall-back day", "2026-11-01T05:30:00Z", NY, "2026-10-31T22:00:00.000Z"],
  ["NY 1:30am EST (second 1:30) on fall-back day", "2026-11-01T06:30:00Z", NY, "2026-10-31T22:00:00.000Z"],
  ["NY 9am on spring-forward day -> 6pm EST the day before", "2027-03-14T13:00:00Z", NY, "2027-03-13T23:00:00.000Z"],
  ["NY 2pm on spring-forward day -> 8am EDT", "2027-03-14T18:00:00Z", NY, "2027-03-14T12:00:00.000Z"],
  ["NY 3:30am EDT just after the gap", "2027-03-14T07:30:00Z", NY, "2027-03-13T23:00:00.000Z"],
  ["NY midnight is a morning interview", "2026-10-01T04:00:00Z", NY, "2026-09-30T22:00:00.000Z"],
  ["NY exactly noon is an afternoon interview", "2026-10-01T16:00:00Z", NY, "2026-10-01T12:00:00.000Z"],
  ["NY 11:59 is a morning interview", "2026-10-01T15:59:00Z", NY, "2026-09-30T22:00:00.000Z"],
  ["NY 23:59 is an afternoon interview", "2026-10-02T03:59:00Z", NY, "2026-10-01T12:00:00.000Z"],
  ["NY 9am on 1 Jan -> 6pm 31 Dec of the year before", "2027-01-01T14:00:00Z", NY, "2026-12-31T23:00:00.000Z"],
  ["NY 10am 1 Mar 2027 -> 6pm 28 Feb", "2027-03-01T15:00:00Z", NY, "2027-02-28T23:00:00.000Z"],
  ["NY 10am 1 Mar 2028 -> 6pm 29 Feb (leap)", "2028-03-01T15:00:00Z", NY, "2028-02-29T23:00:00.000Z"],
  ["NY 1pm 1 Mar 2028 -> 8am 1 Mar", "2028-03-01T18:00:00Z", NY, "2028-03-01T13:00:00.000Z"],
  ["London 9am GMT on fall-back day -> 6pm BST", "2026-10-25T09:00:00Z", LON, "2026-10-24T17:00:00.000Z"],
  ["London 9am BST on spring-forward day -> 6pm GMT", "2027-03-28T08:00:00Z", LON, "2027-03-27T18:00:00.000Z"],
  ["London 2pm BST on spring-forward day -> 8am BST", "2027-03-28T13:00:00Z", LON, "2027-03-28T07:00:00.000Z"],
  ["Kolkata 9am IST", "2026-10-01T03:30:00Z", KOL, "2026-09-30T12:30:00.000Z"],
  ["Kolkata midnight (still 30 Sep in UTC)", "2026-09-30T18:30:00Z", KOL, "2026-09-30T12:30:00.000Z"],
  ["Kolkata 3pm IST", "2026-10-01T09:30:00Z", KOL, "2026-10-01T02:30:00.000Z"],
  ["Kolkata 11:59pm IST on 1 Oct", "2026-10-01T18:29:00Z", KOL, "2026-10-01T02:30:00.000Z"],
  ["Sydney 9am AEDT on spring-forward day -> 6pm AEST", "2026-10-03T22:00:00Z", SYD, "2026-10-03T08:00:00.000Z"],
  ["Sydney 9am AEST on fall-back day -> 6pm AEDT", "2027-04-03T23:00:00Z", SYD, "2027-04-03T07:00:00.000Z"],
  ["Sydney 10am on 1 Jan -> 6pm 31 Dec", "2026-12-31T23:00:00Z", SYD, "2026-12-31T07:00:00.000Z"],
  ["Kiritimati 9am on 1 Oct", "2026-09-30T19:00:00Z", KIR, "2026-09-30T04:00:00.000Z"],
  ["Kiritimati midnight on 1 Jan 2027", "2026-12-31T10:00:00Z", KIR, "2026-12-31T04:00:00.000Z"],
  ["Kiritimati 2pm on 1 Oct", "2026-10-01T00:00:00Z", KIR, "2026-09-30T18:00:00.000Z"],
  ["St John's 9am NST on fall-back day -> 6pm NDT", "2026-11-01T12:30:00Z", STJ, "2026-10-31T20:30:00.000Z"],
  ["St John's 2pm NDT on spring-forward day -> 8am NDT", "2027-03-14T16:30:00Z", STJ, "2027-03-14T10:30:00.000Z"],
  ["St John's 9am NDT on spring-forward day -> 6pm NST", "2027-03-14T11:30:00Z", STJ, "2027-03-13T21:30:00.000Z"],
];

for (const [label, startsAt, z, want] of REFRESHER_CASES) {
  test(`refresherAt: ${label}`, () => {
    assert.equal(iso(refresherAt(Z(startsAt), z)), want);
  });
}

test("refresherAt defaults to New York", () => {
  assert.equal(iso(refresherAt(Z("2026-10-01T16:00:00Z"))), "2026-10-01T12:00:00.000Z");
});

test("refresherAt fuzz: every half-hour for 60 days in every zone lands at 8:00 or 18:00 local, strictly before the interview", () => {
  const failures: string[] = [];
  const start = Date.UTC(2026, 9, 1); // 1 Oct 2026 covers Sydney, London and US fall-back
  for (const z of ZONES) {
    for (let t = start; t < start + 60 * DAY; t += 30 * MIN) {
      const startsAt = new Date(t);
      const at = refresherAt(startsAt, z);
      const s = localParts(startsAt, z);
      const r = localParts(at, z);
      const morning = s.hour < 12;
      const wantHour = morning ? 18 : 8;
      const dayGap = calendarDaysBetween(at, startsAt, z);
      if (r.hour !== wantHour || r.minute !== 0 || dayGap !== (morning ? 1 : 0) || at.getTime() >= t) {
        failures.push(`${z} ${iso(startsAt)} -> ${iso(at)}`);
        if (failures.length > 5) break;
      }
      // Never more than 19 hours ahead (11:59am after a fall-back night).
      if (t - at.getTime() > 19 * HOUR) failures.push(`${z} ${iso(startsAt)} too early ${iso(at)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("refresherAt fuzz: same across the spring changes of 2027", () => {
  const failures: string[] = [];
  const start = Date.UTC(2027, 2, 1);
  for (const z of ZONES) {
    for (let t = start; t < start + 45 * DAY; t += 30 * MIN) {
      const startsAt = new Date(t);
      const at = refresherAt(startsAt, z);
      const s = localParts(startsAt, z);
      const r = localParts(at, z);
      const wantHour = s.hour < 12 ? 18 : 8;
      if (r.hour !== wantHour || r.minute !== 0 || at.getTime() >= t) {
        failures.push(`${z} ${iso(startsAt)} -> ${iso(at)}`);
        if (failures.length > 5) break;
      }
    }
  }
  assert.deepEqual(failures, []);
});

// =====================================================================
// calendarDaysBetween
// =====================================================================

const CAL_CASES: [string, string, string, string, number][] = [
  ["NY evening before fall-back to 9am EST", "2026-11-01T00:00:00Z", "2026-11-01T14:00:00Z", NY, 1],
  ["NY 11pm EST to 1am EST across spring-forward midnight", "2027-03-14T04:00:00Z", "2027-03-14T06:00:00Z", NY, 1],
  ["NY same UTC date, different local dates", "2026-10-01T00:00:00Z", "2026-10-01T13:00:00Z", NY, 1],
  ["Kolkata 23:30 to 00:00 next day, same UTC date", "2026-09-30T18:00:00Z", "2026-09-30T18:30:00Z", KOL, 1],
  ["Kiritimati 23:59 to 00:00", "2026-09-30T09:59:00Z", "2026-09-30T10:00:00Z", KIR, 1],
  ["NY New Year's Eve to New Year's Day", "2027-01-01T01:00:00Z", "2027-01-01T14:00:00Z", NY, 1],
  ["NY 28 Feb to 1 Mar 2027", "2027-02-28T17:00:00Z", "2027-03-01T17:00:00Z", NY, 1],
  ["NY 28 Feb to 1 Mar 2028 (leap)", "2028-02-28T17:00:00Z", "2028-03-01T17:00:00Z", NY, 2],
  ["NY a week across fall-back", "2026-10-28T16:00:00Z", "2026-11-04T17:00:00Z", NY, 7],
  ["Sydney a week across spring-forward", "2026-09-30T02:00:00Z", "2026-10-07T01:00:00Z", SYD, 7],
  ["St John's 23:00 NST to 01:00 NDT across spring-forward", "2027-03-14T02:30:00Z", "2027-03-14T04:30:00Z", STJ, 1],
  ["backwards is negative", "2026-10-02T16:00:00Z", "2026-10-01T16:00:00Z", NY, -1],
  ["same instant is zero", "2026-10-02T16:00:00Z", "2026-10-02T16:00:00Z", KIR, 0],
];

for (const [label, a, b, z, want] of CAL_CASES) {
  test(`calendarDaysBetween: ${label} = ${want}`, () => {
    assert.equal(calendarDaysBetween(Z(a), Z(b), z), want);
  });
}

// =====================================================================
// prepIntervalFor
// =====================================================================

test("prepIntervalFor maps every day 0..7 to the tightest threshold reached", () => {
  const want = [1, 1, 3, 3, 7, 7, 7, 7];
  for (let d = 0; d <= 7; d++) assert.equal(prepIntervalFor(d), want[d], `day ${d}`);
});

test("prepIntervalFor is null outside the week, for negatives and NaN", () => {
  for (const d of [8, 30, -1, -0.001, Number.NaN, Infinity]) assert.equal(prepIntervalFor(d), null, String(d));
});

test("prepIntervalFor on fractions rounds toward the tighter mark", () => {
  assert.equal(prepIntervalFor(0.5), 1);
  assert.equal(prepIntervalFor(1.0001), 3);
  assert.equal(prepIntervalFor(6.999), 7);
});

// =====================================================================
// selectInterviewPrep
// =====================================================================

// 9am EST on the fall-back morning. Refresher 6pm EDT on 31 Oct = 22:00Z.
const FALLBACK_9AM = Z("2026-11-01T14:00:00Z");
const FALLBACK_REFRESH = Z("2026-10-31T22:00:00Z");

test("prep: one millisecond before the refresher is still the countdown", () => {
  const [n] = prep([interview(FALLBACK_9AM)], new Date(FALLBACK_REFRESH.getTime() - 1));
  assert.equal(n.phase, "prep");
  assert.equal(n.daysUntil, 1);
  assert.equal(n.interval, 1);
  assert.equal(n.dayLabel, "tomorrow");
});

test("prep: exactly at the refresher instant it becomes the refresher", () => {
  const [n] = prep([interview(FALLBACK_9AM)], FALLBACK_REFRESH);
  assert.equal(n.phase, "refresh");
  assert.equal(n.interval, 1);
});

test("prep: practice exactly at the refresher instant quiets the refresher", () => {
  const out = prep([interview(FALLBACK_9AM)], new Date(FALLBACK_REFRESH.getTime() + 30 * MIN), {
    practice: [{ at: FALLBACK_REFRESH }],
  });
  assert.deepEqual(out, []);
});

test("prep: practice one millisecond before the refresher does not quiet it", () => {
  const out = prep([interview(FALLBACK_9AM)], new Date(FALLBACK_REFRESH.getTime() + 30 * MIN), {
    practice: [{ at: new Date(FALLBACK_REFRESH.getTime() - 1) }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].phase, "refresh");
});

test("prep: that same practice one ms before the refresher DID quiet the countdown", () => {
  const out = prep([interview(FALLBACK_9AM)], new Date(FALLBACK_REFRESH.getTime() - 1), {
    practice: [{ at: new Date(FALLBACK_REFRESH.getTime() - 2) }],
  });
  assert.deepEqual(out, []);
});

test("prep: practice exactly at startsAt-7d quiets the countdown", () => {
  const out = prep([interview(FALLBACK_9AM)], Z("2026-10-29T12:00:00Z"), {
    practice: [{ at: new Date(FALLBACK_9AM.getTime() - 7 * DAY) }],
  });
  assert.deepEqual(out, []);
});

test("prep: practice one ms before startsAt-7d does not", () => {
  const out = prep([interview(FALLBACK_9AM)], Z("2026-10-29T12:00:00Z"), {
    practice: [{ at: new Date(FALLBACK_9AM.getTime() - 7 * DAY - 1) }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].interval, 7); // 3d2h out rounds up to day 4
});

test("prep: practice in any sector quiets a firm's interview - no sector is guessed", () => {
  const trackedFirms: TrackedFirms = new Map([["evercore", { name: "Evercore" }]]);
  const out = prep([interview(FALLBACK_9AM)], Z("2026-10-29T12:00:00Z"), {
    trackedFirms,
    practice: [{ at: Z("2026-10-29T11:00:00Z") }],
  });
  assert.deepEqual(out, []);
});

test("prep: a tracked firm is named in the prompt", () => {
  const trackedFirms: TrackedFirms = new Map([["evercore", { name: "Evercore" }]]);
  const [n] = prep([interview(FALLBACK_9AM)], Z("2026-10-29T12:00:00Z"), { trackedFirms });
  assert.equal(n.firmName, "Evercore");
});

test("prep: spring-forward 9am EDT interview flips to refresher at 6pm EST (23:00Z)", () => {
  const startsAt = Z("2027-03-14T13:00:00Z");
  assert.equal(prep([interview(startsAt)], Z("2027-03-13T22:59:59.999Z"))[0].phase, "prep");
  assert.equal(prep([interview(startsAt)], Z("2027-03-13T23:00:00Z"))[0].phase, "refresh");
});

test("prep: interview created after its refresher time is a refresher immediately, labelled today", () => {
  // 3pm EDT interview, student adds it at 10am EDT. Refresher was 8am EDT = 12:00Z.
  const [n] = prep([interview(Z("2026-10-01T19:00:00Z"))], Z("2026-10-01T14:00:00Z"));
  assert.equal(n.phase, "refresh");
  assert.equal(n.dayLabel, "today");
  assert.equal(n.daysUntil, 1);
  assert.equal(n.interval, 1);
});

test("prep: practice between the refresher and creation quiets that late-created interview", () => {
  const out = prep([interview(Z("2026-10-01T19:00:00Z"))], Z("2026-10-01T14:00:00Z"), {
    practice: [{ at: Z("2026-10-01T13:00:00Z") }],
  });
  assert.deepEqual(out, []);
});

test("prep: midnight interview - 5pm is prep, 6pm is refresher, labelled tomorrow", () => {
  const midnight = Z("2026-10-01T04:00:00Z"); // 00:00 EDT 1 Oct
  const [a] = prep([interview(midnight)], Z("2026-09-30T21:00:00Z"));
  const [b] = prep([interview(midnight)], Z("2026-09-30T22:00:00Z"));
  const [c] = prep([interview(midnight)], Z("2026-10-01T03:59:00Z"));
  assert.equal(a.phase, "prep");
  assert.equal(b.phase, "refresh");
  assert.equal(c.phase, "refresh");
  assert.equal(c.dayLabel, "tomorrow");
});

test("prep: exactly noon - 6pm the night before is still prep, 8am the day is refresh", () => {
  const noon = Z("2026-10-01T16:00:00Z");
  assert.equal(prep([interview(noon)], Z("2026-09-30T22:00:00Z"))[0].phase, "prep");
  assert.equal(prep([interview(noon)], Z("2026-10-01T11:59:59.999Z"))[0].phase, "prep");
  assert.equal(prep([interview(noon)], Z("2026-10-01T12:00:00Z"))[0].phase, "refresh");
});

test("prep: an interview that started one millisecond ago is gone", () => {
  const now = Z("2026-10-01T16:00:00Z");
  assert.deepEqual(prep([interview(new Date(now.getTime() - 1))], now), []);
});

test("prep: an interview starting this instant is today, day 0, refresher", () => {
  const now = Z("2026-10-01T16:00:00Z");
  const [n] = prep([interview(now)], now);
  assert.equal(n.daysUntil, 0);
  assert.equal(n.interval, 1);
  assert.equal(n.phase, "refresh");
  assert.equal(n.dayLabel, "today");
});

test("prep: window edges to the millisecond", () => {
  const now = Z("2026-09-22T16:00:00Z");
  const at = (ms: number) => prep([interview(new Date(now.getTime() + ms))], now);
  assert.equal(at(7 * DAY)[0].interval, 7);
  assert.deepEqual(at(7 * DAY + 1), []);
  assert.equal(at(3 * DAY)[0].interval, 3);
  assert.equal(at(3 * DAY + 1)[0].interval, 7);
  assert.equal(at(1 * DAY)[0].interval, 1);
  assert.equal(at(1 * DAY + 1)[0].interval, 3);
});

test("prep: completed interviews and non-interviews are skipped; typed interviews are kept", () => {
  const now = Z("2026-09-22T16:00:00Z");
  const soon = new Date(now.getTime() + 2 * DAY);
  const out = prep(
    [
      interview(soon, { id: "done", completed: true }),
      interview(soon, { id: "chat", title: "Coffee chat w/ Dana Reed" }),
      interview(soon, { id: "typed", title: "Lunch with Evercore", type: "interview" }),
      interview(soon, { id: "mock-typed", title: "Mock interview", type: "interview" }),
    ],
    now,
  );
  assert.deepEqual(out.map((n) => n.eventId).sort(), ["mock-typed", "typed"]);
});

test("prep: several interviews sort by countdown", () => {
  const now = Z("2026-09-22T16:00:00Z");
  const out = prep(
    [
      interview(new Date(now.getTime() + 6 * DAY), { id: "a", title: "A superday" }),
      interview(new Date(now.getTime() + 12 * HOUR), { id: "b", title: "B superday" }),
      interview(new Date(now.getTime() + 2.5 * DAY), { id: "c", title: "C superday" }),
    ],
    now,
  );
  assert.deepEqual(out.map((n) => n.eventId), ["b", "c", "a"]);
});

test("prep: two interviews in the same 24h block - the sooner one comes first", () => {
  // Both are daysUntil 1. One is in 2 hours (already refresher), the other in
  // 20 hours. Title order would put "Alpha" (the later one) first.
  const now = Z("2026-10-01T14:00:00Z"); // 10am EDT
  const out = prep(
    [
      interview(new Date(now.getTime() + 2 * HOUR), { id: "soon", title: "Zeta Partners superday" }),
      interview(new Date(now.getTime() + 20 * HOUR), { id: "later", title: "Alpha Capital superday" }),
    ],
    now,
  );
  assert.deepEqual(out.map((n) => n.eventId), ["soon", "later"]);
});

test("prep: dayLabel is by the student's calendar in Kolkata, not UTC", () => {
  // 23:30 IST 30 Sep; interview 01:00 IST 1 Oct. Same UTC date.
  const [n] = prep([interview(Z("2026-09-30T19:30:00Z"))], Z("2026-09-30T18:00:00Z"), { timeZone: KOL });
  assert.equal(n.dayLabel, "tomorrow");
  assert.equal(n.phase, "refresh");
});

test("prep: dayLabel in New York when UTC already says tomorrow", () => {
  // 7pm EDT 30 Sep (23:00Z); interview 9pm EDT 30 Sep (01:00Z 1 Oct).
  const [n] = prep([interview(Z("2026-10-01T01:00:00Z"))], Z("2026-09-30T23:00:00Z"));
  assert.equal(n.dayLabel, "today");
});

test("prep: dayLabel 'in 3 days' for a 61-hour gap spanning three midnights", () => {
  const [n] = prep([interview(Z("2026-10-01T13:00:00Z"))], Z("2026-09-29T00:00:00Z"));
  assert.equal(n.daysUntil, 3);
  assert.equal(n.dayLabel, "in 3 days");
});

test("prep: New Year's Day interview seen on New Year's Eve in Kiritimati", () => {
  // 1 Jan 2027 09:00 +14 = 31 Dec 19:00Z. Seen at 31 Dec 17:00 local = 03:00Z.
  // Refresher 6pm 31 Dec local = 04:00Z.
  const startsAt = Z("2026-12-31T19:00:00Z");
  const [a] = prep([interview(startsAt)], Z("2026-12-31T03:00:00Z"), { timeZone: KIR });
  const [b] = prep([interview(startsAt)], Z("2026-12-31T04:00:00Z"), { timeZone: KIR });
  assert.equal(a.phase, "prep");
  assert.equal(a.dayLabel, "tomorrow");
  assert.equal(b.phase, "refresh");
});

test("prep fuzz: over 60 days, every phase=refresh nudge has interval 1 and a today/tomorrow label", () => {
  const failures: string[] = [];
  for (const z of [NY, KOL, SYD, KIR, STJ, LON]) {
    for (let h = 0; h < 24 * 60; h += 7) {
      const startsAt = new Date(Date.UTC(2026, 9, 1) + h * HOUR);
      for (const lead of [1, 6, 13, 17, 23]) {
        const now = new Date(startsAt.getTime() - lead * HOUR);
        const out = prep([interview(startsAt)], now, { timeZone: z });
        if (out.length !== 1) { failures.push(`${z} ${iso(startsAt)} lead ${lead}: none`); continue; }
        const n = out[0];
        const shouldRefresh = now.getTime() >= refresherAt(startsAt, z).getTime();
        if ((n.phase === "refresh") !== shouldRefresh) failures.push(`${z} ${iso(startsAt)} lead ${lead}: phase`);
        if (n.phase === "refresh" && (n.interval !== 1 || !["today", "tomorrow"].includes(n.dayLabel))) {
          failures.push(`${z} ${iso(startsAt)} lead ${lead}: ${n.interval} ${n.dayLabel}`);
        }
      }
    }
  }
  assert.deepEqual(failures.slice(0, 5), []);
});

// =====================================================================
// looksLikeInterview
// =====================================================================

const REAL_INTERVIEWS = [
  "Evercore | Superday - Round 2",
  "Goldman Sachs HireVue",
  "Moelis - 1st Round (Zoom)",
  "PJT R2",
  "Lazard on-site",
  "Centerview final round",
  "Phone screen w/ Jefferies recruiter",
  "Paper LBO - KKR",
  "Blackstone modelling test",
  "Citi assessment centre",
  "INTERVIEW: MORGAN STANLEY S&T",
  "Houlihan Lokey 2nd rd",
  "Online assessment - Barclays",
];

for (const title of REAL_INTERVIEWS) {
  test(`looksLikeInterview("${title}") is true`, () => {
    assert.equal(looksLikeInterview(title), true);
  });
}

const NOT_INTERVIEWS = [
  "Coffee chat w/ Dana Reed",
  "Mock interview w/ career center",
  "Interview prep with Dan",
  "Superday debrief",
  "Finance club meeting",
  "Screen time",
  "Interviewing skills",
  "Informational interview - Dana Reed",
  "Round table: women in finance",
];

for (const title of NOT_INTERVIEWS) {
  test(`looksLikeInterview("${title}") is false`, () => {
    assert.equal(looksLikeInterview(title), false);
  });
}

test("looksLikeInterview: a plain title with the interview in the notes", () => {
  assert.equal(looksLikeInterview("Evercore 2pm", "Your interview with Evercore is confirmed."), true);
});

test("looksLikeInterview: a superday title is not vetoed by a routine 'please prepare' in the invite notes", () => {
  // The docstring: "a title that rules it out rules it out" - notes are the
  // forwarded invitation, and "prepare" is in nearly every real one.
  assert.equal(
    looksLikeInterview("Evercore Superday", "Please prepare to walk through your resume. Dial-in below."),
    true,
  );
});

test("looksLikeInterview: hyphenated stage names ('first-round') count like 'first round'", () => {
  // The other two-word patterns (super-day, hire-vue, on-site) accept a hyphen.
  assert.equal(looksLikeInterview("Lazard first-round"), true);
});

// =====================================================================
// thank-you.ts
// =====================================================================

const T_NOW = Z("2026-09-22T20:00:00Z");
const hoursAgo = (h: number) => new Date(T_NOW.getTime() - h * HOUR);
const DANA: ThankContact = { id: "c-dana", name: "Dana Reed" };
const DANA_SMITH: ThankContact = { id: "c-dana-smith", name: "Dana Reed-Smith" };
const OBRIEN: ThankContact = { id: "c-ob", name: "Sean O'Brien" };
const JOSE: ThankContact = { id: "c-jose", name: "José Álvarez" };
const ANNE: ThankContact = { id: "c-anne", name: "Anne-Marie Lee" };
const MARIE: ThankContact = { id: "c-marie", name: "Marie Lee" };
const CHER: ThankContact = { id: "c-cher", name: "Cher" };

function chat(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "google:1",
    title: "Coffee chat with Dana Reed",
    startsAt: hoursAgo(3),
    endsAt: hoursAgo(2.5),
    ...over,
  };
}

function thanks(events: ChatEvent[], extra: Partial<Parameters<typeof selectThankYous>[0]> = {}) {
  return selectThankYous({
    events,
    contacts: [DANA, DANA_SMITH, OBRIEN, JOSE, ANNE, MARIE, CHER],
    done: new Set(),
    thanked: [],
    now: T_NOW,
    ...extra,
  });
}

test("thankYouDueAt: two hours after the end", () => {
  assert.equal(iso(thankYouDueAt({ startsAt: Z("2026-09-22T14:00:00Z"), endsAt: Z("2026-09-22T15:00:00Z") })), "2026-09-22T17:00:00.000Z");
});

test("thankYouDueAt: null end is 30 minutes after start, plus two hours", () => {
  assert.equal(iso(thankYouDueAt({ startsAt: Z("2026-09-22T14:00:00Z"), endsAt: null })), "2026-09-22T16:30:00.000Z");
});

test("thankYouDueAt: across the fall-back hour it is still two real hours", () => {
  assert.equal(iso(thankYouDueAt({ startsAt: Z("2026-11-01T05:00:00Z"), endsAt: Z("2026-11-01T05:30:00Z") })), "2026-11-01T07:30:00.000Z");
});

test("selectThankYous: due exactly now is included", () => {
  assert.equal(thanks([chat({ endsAt: hoursAgo(2) })]).length, 1);
});

test("selectThankYous: one ms short of due is not", () => {
  assert.deepEqual(thanks([chat({ endsAt: new Date(T_NOW.getTime() - 2 * HOUR + 1) })]), []);
});

test("selectThankYous: null end, started exactly 2.5h ago, is due now", () => {
  const out = thanks([chat({ startsAt: hoursAgo(2.5), endsAt: null })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].dueAt.getTime(), T_NOW.getTime());
});

test("selectThankYous: exactly 14 days past due is still owed; one ms more is not", () => {
  const edge = new Date(T_NOW.getTime() - 14 * DAY - 2 * HOUR);
  assert.equal(thanks([chat({ startsAt: new Date(edge.getTime() - HOUR), endsAt: edge })]).length, 1);
  const past = new Date(edge.getTime() - 1);
  assert.deepEqual(thanks([chat({ startsAt: new Date(past.getTime() - HOUR), endsAt: past })]), []);
});

test("selectThankYous: all-day entries never prompt", () => {
  assert.deepEqual(thanks([chat({ allDay: true })]), []);
});

test("selectThankYous: a done key closes it", () => {
  assert.deepEqual(thanks([chat()], { done: new Set(["thank_you:google:1"]) }), []);
});

test("selectThankYous: a thank-you sent exactly at chat start closes it", () => {
  const ev = chat();
  assert.deepEqual(thanks([ev], { thanked: [{ contactId: DANA.id, at: ev.startsAt }] }), []);
});

test("selectThankYous: a thank-you one ms before the chat started does not", () => {
  const ev = chat();
  assert.equal(thanks([ev], { thanked: [{ contactId: DANA.id, at: new Date(ev.startsAt.getTime() - 1) }] }).length, 1);
});

test("selectThankYous: same contact, two chats - a thank-you between them closes only the first", () => {
  const first = chat({ sourceKey: "google:a", startsAt: hoursAgo(72), endsAt: hoursAgo(71) });
  const second = chat({ sourceKey: "google:b", startsAt: hoursAgo(5), endsAt: hoursAgo(4) });
  const out = thanks([first, second], { thanked: [{ contactId: DANA.id, at: hoursAgo(48) }] });
  assert.deepEqual(out.map((p) => p.key), ["thank_you:google:b"]);
});

test("selectThankYous: the same entry twice is one prompt", () => {
  assert.equal(thanks([chat(), chat()]).length, 1);
});

test("selectThankYous: oldest due first", () => {
  const out = thanks([
    chat({ sourceKey: "google:new", endsAt: hoursAgo(3) }),
    chat({ sourceKey: "google:old", endsAt: hoursAgo(30), startsAt: hoursAgo(31) }),
  ]);
  assert.deepEqual(out.map((p) => p.key), ["thank_you:google:old", "thank_you:google:new"]);
});

test("selectThankYous: a thank-you to someone else does not close it", () => {
  const ev = chat();
  assert.equal(thanks([ev], { thanked: [{ contactId: "c-other", at: T_NOW }] }).length, 1);
});

test("contactInTitle: a single-word contact never matches", () => {
  assert.equal(contactInTitle("Coffee with Cher", [CHER]), null);
});

test("contactInTitle: all caps", () => {
  assert.equal(contactInTitle("COFFEE CHAT - DANA REED", [DANA])?.id, DANA.id);
});

test("contactInTitle: typewriter apostrophe", () => {
  assert.equal(contactInTitle("Coffee with Sean O'Brien", [OBRIEN])?.id, OBRIEN.id);
});

test("contactInTitle: a phone's curly apostrophe matches a straight one in the contact", () => {
  // iOS and macOS substitute ’ (U+2019) as you type.
  assert.equal(contactInTitle("Coffee with Sean O’Brien", [OBRIEN])?.id, OBRIEN.id);
});

test("contactInTitle: accents in NFC", () => {
  assert.equal(contactInTitle("Zoom w/ José Álvarez", [JOSE])?.id, JOSE.id);
});

test("contactInTitle: the same accented name in NFD on both sides still matches", () => {
  const nfd = "José Álvarez".normalize("NFD");
  assert.equal(contactInTitle(`Zoom w/ ${nfd}`, [{ id: "c-nfd", name: nfd }])?.id, "c-nfd");
});

test("contactInTitle: hyphenated first name", () => {
  assert.equal(contactInTitle("Call with Anne-Marie Lee", [ANNE, MARIE])?.id, ANNE.id);
});

test("contactInTitle: 'Marie Lee' is not found inside 'Anne-Marie Lee'", () => {
  assert.equal(contactInTitle("Call with Anne-Marie Lee", [MARIE]), null);
});

test("contactInTitle: 'Dana Reed' is not found inside 'Dana Reed-Smith', and the longer wins", () => {
  assert.equal(contactInTitle("Coffee w/ Dana Reed-Smith", [DANA]), null);
  assert.equal(contactInTitle("Coffee w/ Dana Reed-Smith", [DANA, DANA_SMITH])?.id, DANA_SMITH.id);
  assert.equal(contactInTitle("Coffee w/ Dana Reed-Smith", [DANA_SMITH, DANA])?.id, DANA_SMITH.id);
});

test("contactInTitle: 'Dan Reed' is not 'Dana Reed'", () => {
  assert.equal(contactInTitle("Coffee with Dana Reed", [{ id: "c-dan", name: "Dan Reed" }]), null);
});

test("contactInTitle: a name followed by punctuation", () => {
  assert.equal(contactInTitle("Coffee with Dana Reed.", [DANA])?.id, DANA.id);
  assert.equal(contactInTitle("Coffee (Dana Reed, Evercore)", [DANA])?.id, DANA.id);
});

test("contactInTitle: a contact name with initials and periods matches the same text in a title", () => {
  const jp = { id: "c-jp", name: "J.P. Smith" };
  assert.equal(contactInTitle("Coffee with J.P. Smith", [jp])?.id, jp.id);
});

test("contactInTitle: a double space typed in the title", () => {
  assert.equal(contactInTitle("Coffee with Dana  Reed", [DANA])?.id, DANA.id);
});

test("isChatEvent: coffee, zoom, informational", () => {
  for (const title of ["Coffee", "Zoom w/ Evercore analyst", "Informational interview - Dana Reed", "Virtual coffee"]) {
    assert.equal(isChatEvent(chat({ title }), null), true, title);
  }
});

test("isChatEvent: loose words need a named contact", () => {
  assert.equal(isChatEvent(chat({ title: "Call with Dana Reed" }), DANA), true);
  assert.equal(isChatEvent(chat({ title: "Call with Dana" }), null), false);
});

test("isChatEvent: interviews, classes, family and all-day entries are not chats", () => {
  assert.equal(isChatEvent(chat({ title: "Zoom - Evercore superday" }), null), false);
  assert.equal(isChatEvent(chat({ title: "Zoom: FIN 301 lecture" }), null), false);
  assert.equal(isChatEvent(chat({ title: "Coffee with Mom" }), null), false);
  assert.equal(isChatEvent(chat({ title: "Coffee chat", allDay: true }), null), false);
  assert.equal(isChatEvent(chat({ title: "Anything", type: "coffee_chat" }), null), true);
  assert.equal(isChatEvent(chat({ title: "Coffee chat", type: "deadline" }), null), false);
});

test("isChatEvent: ALL CAPS COFFEE CHAT", () => {
  assert.equal(isChatEvent(chat({ title: "COFFEE CHAT W/ DANA REED" }), DANA), true);
});

test("isChatEvent: preparing for a coffee chat is not the coffee chat", () => {
  assert.equal(isChatEvent(chat({ title: "Prep for coffee chat with Dana Reed" }), DANA), false);
});

// =====================================================================
// application-outreach.ts flash rounds
// =====================================================================

test("flashRound for every day 30..0 pairs (30,29), (28,27), ... (2,1), (0)", () => {
  for (let d = 30; d >= 0; d--) {
    assert.equal(flashRound(d), Math.floor((30 - d) / 2), `day ${d}`);
  }
  assert.equal(flashRound(0), 15);
  assert.equal(flashRound(1), flashRound(2));
});

test("flashRound is non-decreasing as the opening approaches and steps by at most one per day", () => {
  for (let d = 30; d > 0; d--) {
    const step = flashRound(d - 1) - flashRound(d);
    assert.ok(step === 0 || step === 1, `day ${d}`);
  }
});

/**
 * One visit, as prompt-flash handles it: the student's calendar day in the
 * default zone, the flash due that day (if any), and its firing recorded
 * against the opening's prefix.
 */
function visitFlash(nudges: OutreachNudge[], lastShown: Map<string, string>, now: Date): OutreachNudge | null {
  const today = localDateString(now, DEFAULT_TIME_ZONE);
  const n = nextFlash(nudges, lastShown, today);
  if (n) lastShown.set(flashPrefix(n.firmKey, n.opensOn), today);
  return n;
}

/** Whole calendar days between two "YYYY-MM-DD" strings. */
function dayGap(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;
}

test("daily visits 30..0: the flash fires on even days only - once per two-day stretch", () => {
  const opens = daysOut(30, OUTREACH_NOW);
  const shown = new Map<string, string>();
  const fired: number[] = [];
  for (let d = 30; d >= 0; d--) {
    const now = new Date(opens.getTime() - d * DAY);
    const nudges = nudgesFor([opening({ date: opens })], [person()], now);
    if (d === 0) {
      // The day it opens: open, and writing ahead of it is over.
      assert.deepEqual(nudges, []);
      continue;
    }
    assert.equal(nudges[0].daysUntilOpen, d);
    if (visitFlash(nudges, shown, now)) fired.push(d);
  }
  assert.deepEqual(fired, [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2]);
});

test("hourly visits over the whole window: after the first, flashes are exactly 48h apart", () => {
  const opens = daysOut(30, OUTREACH_NOW);
  const shown = new Map<string, string>();
  const firedAt: number[] = [];
  const firedOn: string[] = [];
  for (let t = opens.getTime() - 30 * DAY; t <= opens.getTime(); t += HOUR) {
    const nudges = nudgesFor([opening({ date: opens })], [person()], new Date(t));
    if (visitFlash(nudges, shown, new Date(t))) {
      firedAt.push(t);
      firedOn.push(localDateString(new Date(t), DEFAULT_TIME_ZONE));
    }
  }
  // First firing is the first visit; every later one at local midnight two
  // calendar days on (no DST change inside this window).
  for (let i = 1; i < firedAt.length; i++) {
    assert.ok(firedAt[i] - firedAt[i - 1] >= 24 * HOUR, `gap ${i}`);
    if (i >= 2) assert.equal(firedAt[i] - firedAt[i - 1], 48 * HOUR, `gap ${i}`);
    assert.equal(dayGap(firedOn[i - 1], firedOn[i]), 2, `calendar gap ${i}`);
  }
  assert.equal(firedAt.length, 15, "30, 28, ... 2 days out");
});

test("visits once a day from mid-window at an off hour still never double-fire within a stretch", () => {
  const opens = daysOut(20, OUTREACH_NOW);
  const shown = new Map<string, string>();
  const firedOn: string[] = [];
  for (let t = OUTREACH_NOW.getTime() + 7 * HOUR; t <= opens.getTime(); t += DAY) {
    const nudges = nudgesFor([opening({ date: opens })], [person()], new Date(t));
    if (visitFlash(nudges, shown, new Date(t))) firedOn.push(localDateString(new Date(t), DEFAULT_TIME_ZONE));
  }
  assert.ok(firedOn.length > 0);
  assert.equal(new Set(firedOn).size, firedOn.length, "never twice on one local day");
  for (let i = 1; i < firedOn.length; i++) {
    assert.equal(dayGap(firedOn[i - 1], firedOn[i]), 2, `never two days running (${firedOn[i - 1]} -> ${firedOn[i]})`);
  }
});

test("flashKey: a Date and its UTC day string are the same key", () => {
  assert.equal(flashKey("evercore", Z("2026-10-06T23:30:00Z"), 3), flashKey("evercore", "2026-10-06", 3));
});

test("nextFlash: a second firm waits behind the first, then goes when the first is shown", () => {
  const nudges = nudgesFor(
    [opening({ date: daysOut(10) }), opening({ firmName: "Lazard", firmSlug: "lazard", date: daysOut(12) })],
    [person(), person({ id: "c2", firm: "Lazard", name: "Sam Ito" })],
  );
  const today = localDateString(OUTREACH_NOW, DEFAULT_TIME_ZONE);
  const first = nextFlash(nudges, new Map(), today)!;
  assert.equal(first.firmName, "Evercore");
  const second = nextFlash(nudges, new Map([[flashPrefix(first.firmKey, first.opensOn), today]]), today)!;
  assert.equal(second.firmName, "Lazard");
});

test("todoNudges: 14 calendar days out is on the list at any hour; 15 is not at any hour", () => {
  // Openings are calendar dates at midnight UTC; the student's day is New York's.
  const firstMinute = Z("2026-09-22T04:00:00Z"); // 00:00 on the 22nd in New York
  const lastMs = Z("2026-09-23T03:59:59.999Z"); // 23:59:59.999 on the 22nd
  for (const now of [firstMinute, lastMs]) {
    const on = nudgesFor([opening({ date: Z("2026-10-06T00:00:00Z") })], [person()], now);
    const off = nudgesFor([opening({ date: Z("2026-10-07T00:00:00Z") })], [person()], now);
    assert.equal(todoNudges(on).length, 1, `14 days at ${now.toISOString()}`);
    assert.equal(todoNudges(off).length, 0, `15 days at ${now.toISOString()}`);
  }
  // One ms later it is the 23rd in New York, and the 7 October opening is 14 days out.
  const next = nudgesFor([opening({ date: Z("2026-10-07T00:00:00Z") })], [person()], new Date(lastMs.getTime() + 1));
  assert.equal(todoNudges(next).length, 1);
});

test("selectOutreachNudges: two openings at one firm - the sooner wins, in either order", () => {
  const a = opening({ date: daysOut(20) });
  const b = opening({ date: daysOut(5) });
  assert.equal(nudgesFor([a, b], [person()])[0].daysUntilOpen, 5);
  assert.equal(nudgesFor([b, a], [person()])[0].daysUntilOpen, 5);
});

// =====================================================================
// outreach-ladder.ts
// =====================================================================

const SENT = Z("2026-09-10T15:00:00Z");
const reachedOut = { relationshipStatus: "reached_out", lastContactDate: null };

test("ladder: one ms before seven days is waiting; exactly seven days is due", () => {
  const sends = [{ step: 1, sentAt: SENT, source: "copy" }];
  const before = ladderState(reachedOut, sends, new Date(SENT.getTime() + 7 * DAY - 1));
  const at = ladderState(reachedOut, sends, new Date(SENT.getTime() + 7 * DAY));
  assert.equal(before.stage, "waiting");
  assert.equal(at.stage, "due");
  assert.equal(at.dueAt!.getTime(), SENT.getTime() + 7 * DAY);
  assert.equal(at.nextStep, 2);
});

test("ladder: second rung due seven days after the second send, not the first", () => {
  const sent2 = new Date(SENT.getTime() + 9 * DAY);
  const s = ladderState(
    reachedOut,
    [{ step: 2, sentAt: sent2, source: "copy" }, { step: 1, sentAt: SENT, source: "copy" }],
    new Date(sent2.getTime() + 7 * DAY - 1),
  );
  assert.equal(s.stage, "waiting");
  assert.equal(s.nextStep, 3);
  assert.equal(s.dueAt!.getTime(), sent2.getTime() + 7 * DAY);
});

test("ladder: three sends is finished; a reply beats everything; cold ends it", () => {
  const three = [1, 2, 3].map((step) => ({ step, sentAt: new Date(SENT.getTime() + step * DAY), source: "copy" }));
  assert.equal(ladderState(reachedOut, three, Z("2027-01-01T00:00:00Z")).stage, "finished");
  assert.equal(ladderState({ relationshipStatus: "in_conversation", lastContactDate: null }, three).stage, "replied");
  assert.equal(
    ladderState({ relationshipStatus: "cold", lastContactDate: null }, [{ step: 1, sentAt: SENT, source: "copy" }]).stage,
    "finished",
  );
});

test("ladder: out-of-range steps are ignored", () => {
  const s = ladderState({ relationshipStatus: "not_contacted", lastContactDate: null }, [
    { step: 0, sentAt: SENT, source: "copy" },
    { step: 4, sentAt: SENT, source: "copy" },
  ]);
  assert.equal(s.stage, "not_contacted");
});

test("ladder: legacy 'reached out' uses the date column as local midnight", () => {
  const s = ladderState({ relationshipStatus: "reached_out", lastContactDate: "2026-09-10" }, [], Z("2026-09-30T00:00:00Z"));
  assert.equal(s.sends[0].source, "legacy");
  /**
   * Midnight in the STUDENT'S zone, computed the way ladderState computes it.
   *
   * This read `new Date("2026-09-10T00:00:00")`, and a datetime string with no
   * zone suffix is parsed as HOST-local - so the expectation moved with
   * whatever machine ran the test while the code, correctly, produces a fixed
   * instant in DEFAULT_TIME_ZONE. The two coincide on a UTC-4 laptop and are
   * four hours apart on a UTC host, which is CI and every cloud session: three
   * tests failed there and passed under TZ=America/New_York.
   *
   * Asserting through the same helper the code uses is what makes this
   * host-independent. A literal epoch would work today and rot at the next DST
   * boundary.
   */
  const studentMidnight = zonedTime(2026, 9, 10, 0, 0, parseTimeZone(DEFAULT_TIME_ZONE));
  assert.equal(s.sends[0].sentAt.getTime(), studentMidnight.getTime());
  assert.equal(s.dueAt!.getTime(), studentMidnight.getTime() + 7 * DAY);
  assert.equal(s.stage, "due");
});

test("ladder: legacy with junk date falls back to updatedAt", () => {
  const s = ladderState(
    { relationshipStatus: "reached_out", lastContactDate: "not-a-date", updatedAt: SENT },
    [],
    SENT,
  );
  assert.equal(s.sends[0].sentAt.getTime(), SENT.getTime());
  assert.equal(s.stage, "waiting");
});

test("repeatRound: 0,1 -> 0; 2,3 -> 1; negatives clamp; fractions floor", () => {
  assert.deepEqual([0, 1, 1.999, 2, 3, 4, -1, -5].map(repeatRound), [0, 0, 0, 1, 1, 2, 0, 0]);
});

test("daysOverdue to the millisecond around each whole day", () => {
  const due = Z("2026-09-17T15:00:00Z");
  assert.equal(daysOverdue(due, new Date(due.getTime() - 1)), 0);
  assert.equal(daysOverdue(due, due), 0);
  assert.equal(daysOverdue(due, new Date(due.getTime() + DAY - 1)), 0);
  assert.equal(daysOverdue(due, new Date(due.getTime() + DAY)), 1);
  assert.equal(daysOverdue(due, new Date(due.getTime() + 2 * DAY - 1)), 1);
  assert.equal(daysOverdue(due, new Date(due.getTime() + 2 * DAY)), 2);
});

test("ladder follow-up repeat: daily visits after due fire on overdue days 0, 2, 4, ...", () => {
  const sends = [{ step: 1, sentAt: SENT, source: "copy" }];
  const seen = new Set<number>();
  const fired: number[] = [];
  for (let d = 0; d <= 10; d++) {
    const now = new Date(SENT.getTime() + (7 + d) * DAY);
    const s = ladderState(reachedOut, sends, now);
    assert.equal(s.stage, "due");
    const r = repeatRound(daysOverdue(s.dueAt!, now));
    if (!seen.has(r)) {
      seen.add(r);
      fired.push(d);
    }
  }
  assert.deepEqual(fired, [0, 2, 4, 6, 8, 10]);
});
