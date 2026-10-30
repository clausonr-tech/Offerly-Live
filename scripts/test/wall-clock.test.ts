// A time typed into a datetime-local input is the student's clock, not the
// server's. The server runs in UTC on Vercel, so these tests pin it there: a
// parse that leaned on the process zone would pass on a laptop in New York
// and file every entry 4-5 hours early in production.
process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMON_TIME_ZONES,
  DEFAULT_TIME_ZONE,
  isTimeZone,
  parseWallClock,
  resolveTimeZone,
  wallClockDate,
  wallClockInputValue,
} from "../../src/lib/time-zone";

const NY = "America/New_York";

test("the process really is on UTC, so the zone comes from the argument", () => {
  assert.equal(new Date("2026-09-22T19:00").toISOString(), "2026-09-22T19:00:00.000Z");
});

test("7pm in New York is stored as 23:00Z, not 19:00Z", () => {
  assert.equal(parseWallClock("2026-09-22T19:00", NY)?.toISOString(), "2026-09-22T23:00:00.000Z");
});

test("in winter it is an hour later in UTC", () => {
  assert.equal(parseWallClock("2026-12-01T19:00", NY)?.toISOString(), "2026-12-02T00:00:00.000Z");
});

test("another zone is read in that zone", () => {
  assert.equal(
    parseWallClock("2026-09-22T19:00", "America/Los_Angeles")?.toISOString(),
    "2026-09-23T02:00:00.000Z",
  );
  assert.equal(parseWallClock("2026-09-22T19:00", "Europe/London")?.toISOString(), "2026-09-22T18:00:00.000Z");
});

test("seconds from some browsers are accepted", () => {
  assert.equal(parseWallClock("2026-09-22T19:00:30", NY)?.toISOString(), "2026-09-22T23:00:00.000Z");
});

test("an import's 9am deadline is 9am on the student's clock", () => {
  assert.equal(parseWallClock("2026-10-01T09:00", NY)?.toISOString(), "2026-10-01T13:00:00.000Z");
});

test("anything that is not a real date and time is refused", () => {
  for (const junk of ["", "tomorrow", "2026-09-22", "2026-09-22T7pm", "2026-02-30T10:00", "2026-09-22T25:00", "2026-09-22T19:00Z"]) {
    assert.equal(parseWallClock(junk, NY), null, junk);
  }
});

test("the edit form's prefill reads back to the same instant", () => {
  const stored = new Date("2026-09-22T23:00:00Z");
  const shown = wallClockInputValue(stored, NY);
  assert.equal(shown, "2026-09-22T19:00");
  assert.equal(parseWallClock(shown, NY)?.toISOString(), stored.toISOString());
});

test("round-trips across a year in several zones", () => {
  for (const zone of [NY, "America/Chicago", "America/Los_Angeles", "Europe/London", "Asia/Kolkata"]) {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 19 * 3600_000 + 13 * 60_000) {
      const instant = new Date(t - (t % 60_000));
      const shown = wallClockInputValue(instant, zone);
      const back = parseWallClock(shown, zone);
      // The one hour a year that repeats (clocks back) is ambiguous on the
      // wall; either reading shows the same digits.
      assert.equal(back && wallClockInputValue(back, zone), shown, `${zone} ${instant.toISOString()}`);
    }
  }
});

// The zone a student picks on their profile.

test("a picked zone wins over the one the browser reported", () => {
  assert.equal(resolveTimeZone("America/Los_Angeles", "Europe/London"), "America/Los_Angeles");
});

test("with no pick, the browser's zone is used, then the default", () => {
  assert.equal(resolveTimeZone(undefined, "Europe/London"), "Europe/London");
  assert.equal(resolveTimeZone(null, null), DEFAULT_TIME_ZONE);
});

test("a junk pick is ignored rather than trusted, and the browser's zone stands", () => {
  assert.equal(resolveTimeZone("Mars/Olympus_Mons", "Europe/London"), "Europe/London");
  assert.equal(resolveTimeZone("%E0%A4%A", "America/Chicago"), "America/Chicago");
});

test("only real zones are accepted as a pick", () => {
  assert.equal(isTimeZone("America/New_York"), true);
  assert.equal(isTimeZone("auto"), false);
  assert.equal(isTimeZone(""), false);
  assert.equal(isTimeZone("x".repeat(100)), false);
  for (const z of COMMON_TIME_ZONES) assert.equal(isTimeZone(z.zone), true, z.zone);
});

test("the calendar places 23:00Z at 7pm on the 22nd for a New York student", () => {
  const d = wallClockDate(new Date("2026-09-22T23:00:00Z"), "America/New_York");
  assert.deepEqual([d.getDate(), d.getHours(), d.getMinutes()], [22, 19, 0]);
});

test("and at 4pm the same day for one who picked Los Angeles", () => {
  const d = wallClockDate(new Date("2026-09-22T23:00:00Z"), "America/Los_Angeles");
  assert.deepEqual([d.getDate(), d.getHours()], [22, 16]);
});

test("a slot clicked on that calendar saves as the same instant", () => {
  const stored = new Date("2026-09-22T23:00:00Z");
  const slot = wallClockDate(stored, "America/Los_Angeles");
  const pad = (n: number) => String(n).padStart(2, "0");
  // QuickAddDialog's formatting: the draft's local fields.
  const typed = `${slot.getFullYear()}-${pad(slot.getMonth() + 1)}-${pad(slot.getDate())}T${pad(slot.getHours())}:${pad(slot.getMinutes())}`;
  assert.equal(parseWallClock(typed, "America/Los_Angeles")?.toISOString(), stored.toISOString());
});
