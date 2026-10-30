// The student's clock, from a cookie their browser set.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TIME_ZONE, localParts, parseTimeZone, zonedTime } from "../../src/lib/time-zone";

test("a real zone is kept", () => {
  assert.equal(parseTimeZone("America/Los_Angeles"), "America/Los_Angeles");
});

test("an encoded zone is decoded", () => {
  assert.equal(parseTimeZone("America%2FChicago"), "America/Chicago");
});

test("junk from a cookie falls back rather than throwing", () => {
  assert.equal(parseTimeZone("not/a zone"), DEFAULT_TIME_ZONE);
  assert.equal(parseTimeZone(""), DEFAULT_TIME_ZONE);
  assert.equal(parseTimeZone(undefined), DEFAULT_TIME_ZONE);
});

test("local parts read the zone's wall clock", () => {
  assert.deepEqual(localParts(new Date("2026-09-25T13:00:00Z"), "America/New_York"), {
    year: 2026,
    month: 9,
    day: 25,
    hour: 9,
    minute: 0,
  });
});

test("a wall-clock time converts to the right instant in summer", () => {
  assert.equal(zonedTime(2026, 9, 25, 8, 0, "America/New_York").toISOString(), "2026-09-25T12:00:00.000Z");
});

test("and in winter, an hour later in UTC", () => {
  assert.equal(zonedTime(2026, 12, 1, 8, 0, "America/New_York").toISOString(), "2026-12-01T13:00:00.000Z");
});

test("across the autumn clock change", () => {
  // 1 Nov 2026 is the change; 6pm that day is EST.
  assert.equal(zonedTime(2026, 11, 1, 18, 0, "America/New_York").toISOString(), "2026-11-01T23:00:00.000Z");
});

test("day 0 is the last day of the month before", () => {
  assert.equal(zonedTime(2026, 10, 0, 18, 0, "America/New_York").toISOString(), "2026-09-30T22:00:00.000Z");
});
