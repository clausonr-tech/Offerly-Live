// Crawling harder when a firm is about to open.
//
// The half of roadmap item #1 that was never built. opening-history.ts derives
// a window from Internet Archive snapshots; until now nothing read it, so a
// derived window changed nothing about when anything was crawled.
//
// Two properties matter more than any individual band, and most of this file
// is about them:
//
//   1. It may only ever speed a source UP. A window is `source: "prediction"`,
//      the weakest evidence in the system. Being wrong in the fast direction
//      costs a few HTTP requests; being wrong in the slow direction costs a
//      student the internship.
//   2. It expires on its own. It is recomputed from today's date every time,
//      so there is no stored state to clean up and no way for a firm to get
//      stuck on an expensive cadence.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  windowUrgency,
  applyUrgency,
  MIN_INTERVAL_MS,
} from "../../src/lib/monitoring/opening-window";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-19T12:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);

/** A window opening `n` days from NOW and lasting `span` days. */
const window = (n: number, span = 14) => ({
  opensStart: inDays(n),
  opensEnd: inDays(n + span),
});

// ------------------------------------------------------------ nothing to say

test("no window is neutral", () => {
  const urgency = windowUrgency(null, NOW);
  assert.equal(urgency.intervalMultiplier, 1);
  assert.equal(urgency.priorityBoost, 0);
  assert.equal(urgency.imminent, false);
});

test("an undefined window is neutral", () => {
  assert.equal(windowUrgency(undefined, NOW).intervalMultiplier, 1);
});

test("a far-off window is neutral", () => {
  const urgency = windowUrgency(window(120), NOW);
  assert.equal(urgency.intervalMultiplier, 1);
  assert.equal(urgency.imminent, false);
  assert.match(urgency.reason, /days away/);
});

test("a long-past window is neutral again", () => {
  // It must decay on its own - that is what makes this safe to leave running.
  const urgency = windowUrgency(window(-120), NOW);
  assert.equal(urgency.intervalMultiplier, 1);
  assert.equal(urgency.imminent, false);
});

// --------------------------------------------------------------- the bands

const bands: [string, number, number][] = [
  ["120 days out", 120, 1],
  ["30 days out", 30, 1],
  ["15 days out", 15, 1],
  ["14 days out", 14, 0.5],
  ["10 days out", 10, 0.5],
  ["8 days out", 8, 0.5],
  ["7 days out", 7, 0.25],
  ["5 days out", 5, 0.25],
  ["4 days out", 4, 0.25],
  ["3 days out", 3, 0.1],
  ["1 day out", 1, 0.1],
  ["opens today", 0, 0.1],
];
for (const [name, days, expected] of bands) {
  test(`${name} -> x${expected}`, () => {
    assert.equal(windowUrgency(window(days), NOW).intervalMultiplier, expected);
  });
}

test("the bands only ever tighten as the date approaches", () => {
  // A gradient that went the wrong way anywhere would slow a source down at
  // the worst possible moment.
  let previous = 1;
  for (let days = 60; days >= 0; days--) {
    const current = windowUrgency(window(days), NOW).intervalMultiplier;
    assert.ok(current <= previous, `x${current} at ${days} days is looser than x${previous}`);
    previous = current;
  }
});

test("the priority boost rises as the date approaches", () => {
  let previous = 0;
  for (let days = 60; days >= 0; days--) {
    const current = windowUrgency(window(days), NOW).priorityBoost;
    assert.ok(current >= previous, `boost ${current} at ${days} days is below ${previous}`);
    previous = current;
  }
});

// ------------------------------------------------------- inside the window

test("inside the window is the most urgent state", () => {
  const urgency = windowUrgency({ opensStart: inDays(-2), opensEnd: inDays(5) }, NOW);
  assert.equal(urgency.intervalMultiplier, 0.1);
  assert.equal(urgency.priorityBoost, 50);
  assert.equal(urgency.imminent, true);
  assert.match(urgency.reason, /inside the historical opening window/);
});

test("the first and last day of the window both count as inside", () => {
  assert.equal(windowUrgency({ opensStart: NOW, opensEnd: inDays(10) }, NOW).imminent, true);
  assert.equal(windowUrgency({ opensStart: inDays(-10), opensEnd: NOW }, NOW).imminent, true);
});

test("a single-day window is still a window", () => {
  // An exactly announced date is a window whose ends are the same day.
  const urgency = windowUrgency({ opensStart: NOW, opensEnd: NOW }, NOW);
  assert.equal(urgency.imminent, true);
  assert.equal(urgency.intervalMultiplier, 0.1);
});

// -------------------------------------------------------- just after it

test("a firm that has not opened yet is still watched", () => {
  // The case we most want to be watching, not least: the window came from two
  // or three observations and being a fortnight late is ordinary.
  const urgency = windowUrgency({ opensStart: inDays(-20), opensEnd: inDays(-5) }, NOW);
  assert.equal(urgency.imminent, true);
  assert.equal(urgency.intervalMultiplier, 0.25);
  assert.match(urgency.reason, /past the historical window/);
});

const trailing: [number, boolean][] = [
  [-1, true],
  [-7, true],
  [-14, true],
  [-15, false],
  [-30, false],
];
for (const [daysPast, stillWatching] of trailing) {
  test(`${-daysPast} day(s) past the window -> ${stillWatching ? "watching" : "neutral"}`, () => {
    const urgency = windowUrgency({ opensStart: inDays(daysPast - 10), opensEnd: inDays(daysPast) }, NOW);
    assert.equal(urgency.imminent, stillWatching);
  });
}

// ------------------------------------------- it may only ever speed things up

test("no input can produce a multiplier above 1", () => {
  // The core safety property. A prediction may spend extra requests on a
  // guess; it may not stop us looking at a firm because a guess said nothing
  // would happen.
  for (let days = -400; days <= 400; days += 3) {
    const urgency = windowUrgency(window(days), NOW);
    assert.ok(urgency.intervalMultiplier <= 1, `x${urgency.intervalMultiplier} at ${days} days`);
    assert.ok(urgency.intervalMultiplier > 0, `x${urgency.intervalMultiplier} at ${days} days`);
  }
});

test("no input can produce a negative priority boost", () => {
  for (let days = -400; days <= 400; days += 3) {
    assert.ok(windowUrgency(window(days), NOW).priorityBoost >= 0, `${days} days`);
  }
});

test("a window spanning a year still cannot slow anything down", () => {
  const urgency = windowUrgency({ opensStart: inDays(-200), opensEnd: inDays(200) }, NOW);
  assert.ok(urgency.intervalMultiplier <= 1);
});

// ------------------------------------------------------------ bad windows

test("an inverted window is refused rather than reordered", () => {
  // Silently swapping the ends would hide whatever produced it.
  const urgency = windowUrgency({ opensStart: inDays(10), opensEnd: inDays(-10) }, NOW);
  assert.equal(urgency.intervalMultiplier, 1);
  assert.match(urgency.reason, /inverted/);
});

test("an unreadable window is neutral, not urgent", () => {
  const bad = [
    { opensStart: new Date("nope"), opensEnd: inDays(5) },
    { opensStart: inDays(1), opensEnd: new Date("nope") },
    { opensStart: new Date("nope"), opensEnd: new Date("nope") },
  ];
  for (const w of bad) {
    const urgency = windowUrgency(w, NOW);
    assert.equal(urgency.intervalMultiplier, 1);
    assert.equal(urgency.imminent, false);
  }
});

test("a non-Date value does not throw", () => {
  const shapes = [
    { opensStart: "2026-09-20" as unknown as Date, opensEnd: inDays(5) },
    { opensStart: null as unknown as Date, opensEnd: null as unknown as Date },
    {} as { opensStart: Date; opensEnd: Date },
  ];
  for (const w of shapes) {
    assert.doesNotThrow(() => windowUrgency(w, NOW));
    assert.equal(windowUrgency(w, NOW).intervalMultiplier, 1);
  }
});

test("every verdict explains itself", () => {
  for (const days of [-100, -10, -1, 0, 3, 7, 14, 30, 200]) {
    const urgency = windowUrgency(window(days), NOW);
    assert.ok(urgency.reason.length > 10, `${days}: "${urgency.reason}"`);
  }
});

test("an urgent verdict quotes the dates it is acting on", () => {
  const urgency = windowUrgency(window(2), NOW);
  assert.match(urgency.reason, /\d{4}-\d{2}-\d{2}/);
});

// ------------------------------------------------------- applying the interval

test("the multiplier shortens the interval", () => {
  const hourly = 60 * 60 * 1000;
  assert.equal(applyUrgency(hourly, windowUrgency(null, NOW)), hourly);
});

test("a floor stops the multiplier becoming impoliteness", () => {
  // An hourly tier at x0.1 is six minutes - more often than any careers page
  // meaningfully changes, and more often than this crawler should hit a host.
  const hourly = 60 * 60 * 1000;
  const accelerated = applyUrgency(hourly, windowUrgency(window(0), NOW));
  assert.equal(accelerated, MIN_INTERVAL_MS);
  assert.ok(accelerated >= MIN_INTERVAL_MS);
});

test("the floor never lengthens an already-short interval", () => {
  // A source on a tighter cadence than the floor must not be SLOWED by it.
  const fiveMinutes = 5 * 60 * 1000;
  const out = applyUrgency(fiveMinutes, windowUrgency(null, NOW));
  assert.ok(out >= fiveMinutes, "the floor must not be applied to a neutral verdict as a reduction");
});

const intervals: [string, number][] = [
  ["hourly", 60 * 60 * 1000],
  ["six-hourly", 6 * 60 * 60 * 1000],
  ["daily", 24 * 60 * 60 * 1000],
  ["weekly", 7 * 24 * 60 * 60 * 1000],
];
for (const [name, base] of intervals) {
  test(`a ${name} source is accelerated but never below the floor`, () => {
    for (const days of [0, 2, 5, 10, 30]) {
      const out = applyUrgency(base, windowUrgency(window(days), NOW));
      assert.ok(out >= MIN_INTERVAL_MS, `${name} at ${days} days -> ${out}ms`);
      assert.ok(out <= base, `${name} at ${days} days was slowed to ${out}ms`);
    }
  });
}

test("a weekly source inside its window drops to hours, not days", () => {
  // The whole point: a source nobody would otherwise look at for a week is
  // checked repeatedly on the days its own history says it opens.
  const weekly = 7 * 24 * 60 * 60 * 1000;
  const out = applyUrgency(weekly, windowUrgency(window(0), NOW));
  assert.ok(out < 24 * 60 * 60 * 1000, `still ${Math.round(out / 3600000)}h`);
});

test("acceleration composes with the seasonal multiplier", () => {
  // monitor-run applies this AFTER seasonFor, so a firm opening outside its
  // sector's normal season - precisely the case a sector timeline gets wrong -
  // is still caught.
  const hourly = 60 * 60 * 1000;
  const outOfSeason = hourly * 4; // what seasonFor returns when nothing is opening
  const out = applyUrgency(outOfSeason, windowUrgency(window(1), NOW));
  assert.ok(out < outOfSeason, "the window must be able to overcome an out-of-season slowdown");
  assert.ok(out <= hourly, "and should land at least back at the base cadence");
});

// ----------------------------------------------------------- it self-expires

test("the same window gives different answers as the date moves", () => {
  // There is no stored state, so nothing has to un-set this.
  const fixed = { opensStart: new Date("2026-10-01"), opensEnd: new Date("2026-10-14") };
  const far = windowUrgency(fixed, new Date("2026-08-01"));
  const near = windowUrgency(fixed, new Date("2026-09-28"));
  const inside = windowUrgency(fixed, new Date("2026-10-05"));
  const after = windowUrgency(fixed, new Date("2026-12-01"));

  assert.equal(far.imminent, false);
  assert.equal(near.imminent, true);
  assert.equal(inside.imminent, true);
  assert.equal(after.imminent, false);
  assert.equal(after.intervalMultiplier, 1);
});

test("a window from a past year does not keep firing forever", () => {
  const lastYear = { opensStart: new Date("2025-09-01"), opensEnd: new Date("2025-09-20") };
  assert.equal(windowUrgency(lastYear, NOW).imminent, false);
});
