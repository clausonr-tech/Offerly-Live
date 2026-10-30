/**
 * Reading an invitation costs the same whatever the sender wrote in it.
 *
 * parseGoogleEvent runs the video-link pattern over an entry's location and
 * notes, and anybody who can send the student an invitation writes both. The
 * pattern used to begin at a \b, so every letter/hyphen transition inside a
 * long run was a place the match could start and the greedy [\w-]+ ran to the
 * end of the run and backtracked a character at a time looking for a dot:
 * quadratic. Measured on the old pattern: 3ms at 2,000 characters, 41ms at
 * 8,000, 252ms at 20,000 - and listCalendarEvents parses up to 1,000 entries
 * per calendar, synchronously, on the Schedule and home pages.
 *
 *   npx tsx --test scripts/test/calendar-video-link-cost.test.ts
 *
 * Pure: no database, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { parseGoogleEvent } from "@/lib/google-calendar";

const CAL = { id: "primary", title: "Kai" };

function parse(over: Record<string, unknown> = {}) {
  return parseGoogleEvent(
    {
      id: "abc",
      summary: "Coffee chat",
      htmlLink: "https://calendar.google.com/x",
      start: { dateTime: "2026-09-22T15:00:00-04:00" },
      end: { dateTime: "2026-09-22T15:30:00-04:00" },
      ...over,
    },
    CAL,
  )!;
}

test("a long hyphen-separated description is read in bounded time", () => {
  const hostile = "a-".repeat(60_000); // 120,000 characters
  const started = process.hrtime.bigint();
  const e = parse({ description: hostile });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(e.videoCall, false);
  // The old pattern needed about 250ms for 20,000 characters and grows with
  // the square, so this text would have cost minutes. A linear scan over the
  // capped slice is well under a millisecond; 50ms leaves room for a slow
  // machine while still failing the quadratic one by orders of magnitude.
  assert.ok(ms < 50, `parse took ${ms.toFixed(1)}ms`);
});

test("cost grows with the text, not with its square", () => {
  const time = (n: number) => {
    const text = "a-".repeat(n / 2);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) parse({ description: text });
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  time(2_000); // warm the JIT so the first measurement is not the slow one
  const small = Math.max(time(2_000), 0.05);
  const large = time(20_000);
  // Ten times the text, nowhere near a hundred times the work.
  assert.ok(large / small < 25, `x10 the input cost x${(large / small).toFixed(1)}`);
});

test("every kind of real meeting link is still a video call", () => {
  const sources: Record<string, unknown>[] = [
    { location: "https://us02web.zoom.us/j/123456789" },
    { description: 'Join: <a href="https://zoom.us/j/987">zoom</a>' },
    { location: "https://evercore.zoom.us/j/111" },
    { description: "https://teams.microsoft.com/l/meetup-join/19%3ameeting" },
    { description: "Join at meet.google.com/abc-defg-hij" },
    { location: "https://evercore.my.webex.com/meet/dreed" },
    { location: "Zoom" },
    { hangoutLink: "https://meet.google.com/abc-defg-hij" },
  ];
  for (const over of sources) {
    assert.equal(parse(over).videoCall, true, JSON.stringify(over));
  }
});

test("a host that merely ends in a provider's name is not a meeting link", () => {
  // "not-zoom.us" is somebody else's domain. The old \b start treated the
  // hyphen as the beginning of a host name and called it a Zoom call.
  assert.equal(parse({ location: "https://not-zoom.us/phish" }).videoCall, false);
  assert.equal(parse({ location: "Blue Bottle Coffee, 54 W 40th St" }).videoCall, false);
  assert.equal(parse({ description: "Zoom out on the org chart before we meet" }).videoCall, false);
});

test("the scan covers as much notes as any real invitation carries", () => {
  const padded = `${"filler words ".repeat(700)}https://zoom.us/j/555`;
  assert.ok(padded.length > 8_000 && padded.length < 10_000, "inside the cap");
  assert.equal(parse({ description: padded }).videoCall, true);
});
