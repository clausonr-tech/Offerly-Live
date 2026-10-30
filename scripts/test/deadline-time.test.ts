// resolveDeadlineInstant turns a firm's stated cut-off into a real instant.
//
// The regression this guards: an Evercore deadline stored as 15 Nov rendered
// as "14 Nov, 4:00 PM" for anyone west of UTC, because a midnight-UTC calendar
// date was being read in local time. The rule is that the stored date's UTC
// PARTS are the firm's calendar day, and the zone offset is applied after.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeadlineInstant } from "../../src/lib/deadline-time";

const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

test("11:55 PM EST on the 15th is still the 15th in Eastern time", () => {
  const at = resolveDeadlineInstant(day(2026, 11, 15), "11:55 PM EST");
  assert.ok(at);
  // 11:55 PM UTC-5 == 04:55 UTC the next calendar day.
  assert.equal(at.toISOString(), "2026-11-16T04:55:00.000Z");
});

test("midnight and noon are not confused", () => {
  const midnight = resolveDeadlineInstant(day(2026, 11, 15), "12:00 AM EST");
  const noon = resolveDeadlineInstant(day(2026, 11, 15), "12:00 PM EST");
  assert.equal(midnight?.toISOString(), "2026-11-15T05:00:00.000Z");
  assert.equal(noon?.toISOString(), "2026-11-15T17:00:00.000Z");
  assert.notEqual(midnight?.getTime(), noon?.getTime());
});

test("daylight saving is carried by the abbreviation itself", () => {
  const std = resolveDeadlineInstant(day(2026, 1, 15), "5:00 PM PST");
  const dst = resolveDeadlineInstant(day(2026, 7, 15), "5:00 PM PDT");
  assert.equal(std?.toISOString(), "2026-01-16T01:00:00.000Z"); // UTC-8
  assert.equal(dst?.toISOString(), "2026-07-16T00:00:00.000Z"); // UTC-7
});

test("a zone the table does not claim to know produces no conversion", () => {
  // The safety property: never a wrong instant, only no instant.
  assert.equal(resolveDeadlineInstant(day(2026, 11, 15), "11:55 PM XYZ"), null);
  assert.equal(resolveDeadlineInstant(day(2026, 11, 15), "11:55 PM IST"), null);
});

test("missing or unparseable input returns null rather than guessing", () => {
  assert.equal(resolveDeadlineInstant(null, "11:55 PM EST"), null);
  assert.equal(resolveDeadlineInstant(day(2026, 11, 15), null), null);
  assert.equal(resolveDeadlineInstant(day(2026, 11, 15), "end of day"), null);
  assert.equal(resolveDeadlineInstant(day(2026, 11, 15), "11:75 PM EST"), null);
  assert.equal(resolveDeadlineInstant(day(2026, 11, 15), "25:00 EST"), null);
});

test("a 24-hour time with no meridiem still resolves", () => {
  const at = resolveDeadlineInstant(day(2026, 11, 15), "23:59 GMT");
  assert.equal(at?.toISOString(), "2026-11-15T23:59:00.000Z");
});
