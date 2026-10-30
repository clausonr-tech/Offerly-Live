// When a sector is worth the full request budget.
//
// The timelines have been wired into monitor-run since 19 September and had
// never once slowed anything down. Measured across all 184 boards and twelve
// months: the multiplier came back 1 in every sector in every month.
//
// The cause was a definition, not a bug in the arithmetic. Eleven of the
// fourteen industries carry a `rolling` track spanning the whole fifteen-month
// axis - an honest description of private equity and off-cycle hiring - and a
// rolling phase counted exactly as much as an open application window. So
// every one of those sectors was permanently in season and the multiplier had
// nothing to say.
//
// The rule now distinguishes the two. Everything else about the design is
// deliberately unchanged: it is a multiplier, never a gate, because a run in
// September 2026 found live Summer 2028 Evercore postings in a month the
// bulge-bracket track calls closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { seasonBand, seasonFor } from "../../src/lib/monitoring/season";
import { CATEGORY_TIMELINE_TRACKS, type FirmProgramCategory } from "../../src/lib/firm-metadata";

const on = (month: number) => new Date(Date.UTC(2026, month - 1, 15));
const ALL = Object.keys(CATEGORY_TIMELINE_TRACKS) as FirmProgramCategory[];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

// ------------------------------------------------- never a gate, ever

test("no sector is ever silenced", () => {
  // The worst case for slowing down is an off-cycle posting found some hours
  // late. The worst case for a gate is never finding it at all.
  for (const category of ALL) {
    for (const month of MONTHS) {
      const verdict = seasonFor(category, on(month));
      assert.ok(verdict.intervalMultiplier > 0, `${category} in month ${month}`);
      assert.ok(Number.isFinite(verdict.intervalMultiplier), `${category} in month ${month}`);
    }
  }
});

test("the multiplier never makes a source faster than its tier", () => {
  for (const category of ALL) {
    for (const month of MONTHS) {
      assert.ok(seasonFor(category, on(month)).intervalMultiplier >= 1, `${category} ${month}`);
    }
  }
});

test("every verdict explains itself", () => {
  for (const category of ALL) {
    assert.ok(seasonFor(category, on(6)).reason.length > 10, category);
  }
});

// ------------------------------------ the change: rolling is not a window

test("the schedule now varies at all", () => {
  // The regression that matters. If every sector is 1 in every month, the
  // timelines are decorative again.
  const seen = new Set<number>();
  for (const category of ALL) {
    for (const month of MONTHS) seen.add(seasonFor(category, on(month)).intervalMultiplier);
  }
  assert.ok(seen.size > 1, `only ever returned ${[...seen].join(", ")}`);
});

test("private equity runs at full cadence around its on-cycle window", () => {
  // This test used to assert the opposite - "never at full cadence, because it
  // has no window" - and that was true of the DATA, not of private equity.
  // Both its tracks were a hatched "off-cycle and unpredictable" band. The
  // real cycle is the most time-critical process in finance: on-cycle
  // interviews run Jun-Jan and a firm's whole process takes about 72 hours
  // with same-day offers. Crawling that at half cadence is how you miss it.
  for (const month of [7, 8, 9, 10, 11, 12, 1, 2]) {
    assert.equal(seasonFor("private_equity", on(month)).intervalMultiplier, 1, `month ${month}`);
  }
  // May and June sit between the undergraduate postings and the on-cycle
  // sprint, so they fall back to the year-round off-cycle track.
  for (const month of [5, 6]) {
    const v = seasonFor("private_equity", on(month));
    assert.equal(v.intervalMultiplier, 2, `month ${month}`);
    assert.equal(v.inSeason, true, "still watched - rolling is not closed");
  }
});

test("real estate runs full cadence around its autumn window and quieter in spring", () => {
  // Brokerage postings open Sep-Nov and the investment tracks Dec-Jan.
  // Spending the same budget on it in spring is the waste this whole
  // mechanism exists to stop.
  assert.equal(seasonFor("real_estate", on(10)).intervalMultiplier, 1, "October is its window");
  assert.equal(seasonFor("real_estate", on(11)).intervalMultiplier, 1, "November is its window");
  assert.equal(seasonFor("real_estate", on(4)).intervalMultiplier, 4, "April is well outside it");
  assert.equal(seasonFor("real_estate", on(5)).intervalMultiplier, 4, "nor is May");
});

test("venture capital is full cadence around its fellowship deadlines", () => {
  // Its deadlines are Aug-Sep and Dec-Jan, not a summer window - the earlier
  // data had that wrong. Outside them the firm postings track keeps it at
  // half cadence, because venture capital genuinely has no standard cycle.
  assert.equal(seasonFor("venture_capital", on(8)).intervalMultiplier, 1, "August deadlines");
  assert.equal(seasonFor("venture_capital", on(12)).intervalMultiplier, 1, "December deadlines");
  assert.equal(seasonFor("venture_capital", on(4)).intervalMultiplier, 2, "April has neither");
});

test("an open application window always beats a rolling track", () => {
  // Both cover October for real estate. The window has to win, or the order
  // the tracks happen to be written in would decide the schedule.
  const verdict = seasonFor("real_estate", on(10));
  assert.equal(verdict.intervalMultiplier, 1);
  assert.ok(!/no fixed window/.test(verdict.reason), verdict.reason);
});

test("a rolling verdict says it is rolling", () => {
  // A reviewer reading the crawl log should be able to tell why a firm is on
  // half cadence without opening this file.
  assert.match(seasonFor("private_equity", on(6)).reason, /no fixed window/);
});

// ------------------------------------------------- investment banking

test("investment banking stays at full cadence all year, and that is correct", () => {
  // Not an oversight. Its three tiers genuinely stagger - bulge bracket
  // sophomore programmes Jan-Apr, summer analyst May-Aug, elite boutique
  // Jun-Sep, middle market Sep-Jan - so between them there is no month when
  // no bank is accepting applications.
  for (const month of MONTHS) {
    assert.equal(seasonFor("investment_banking", on(month)).intervalMultiplier, 1, `month ${month}`);
  }
});

test("a sector with no timeline data is never slowed on the strength of it", () => {
  const verdict = seasonFor("__nonexistent__" as FirmProgramCategory, on(6));
  assert.equal(verdict.intervalMultiplier, 1);
  assert.match(verdict.reason, /no timeline data/);
});

// -------------------------------------------------------- the boundaries

test("the window is padded either side rather than ending on the calendar", () => {
  // Two months ahead because firms open earlier every year, one month after
  // because a closed window still has stragglers.
  assert.equal(seasonFor("real_estate", on(7)).intervalMultiplier, 1, "July leads the Sep window");
  // February still counts: the investment tracks post Dec-Jan and the trailing
  // month carries them into February. March is where it finally drops out.
  assert.equal(seasonFor("real_estate", on(2)).intervalMultiplier, 1, "February is the trailing month");
  assert.equal(seasonFor("real_estate", on(3)).intervalMultiplier, 4, "March is past the padding");
});

test("the answer is stable within a month", () => {
  // A schedule that flips between the 1st and the 28th would re-decide a
  // firm's cadence mid-window for no reason.
  for (const category of ALL) {
    const early = seasonFor(category, new Date(Date.UTC(2026, 5, 2))).intervalMultiplier;
    const late = seasonFor(category, new Date(Date.UTC(2026, 5, 27))).intervalMultiplier;
    assert.equal(early, late, category);
  }
});

test("the multipliers are a small, deliberate set", () => {
  // A continuous gradient would imply a precision these tracks do not have -
  // they are research about a typical cycle, not a measurement.
  const seen = new Set<number>();
  for (const category of ALL) {
    for (const month of MONTHS) seen.add(seasonFor(category, on(month)).intervalMultiplier);
  }
  for (const value of seen) {
    assert.ok([1, 2, 4].includes(value), `unexpected multiplier ${value}`);
  }
});

// ----------------------------------------- it composes with the crawler

test("out of season still leaves a usable cadence", () => {
  // A 12-hour tier at x2 is a day; at x4 it is two days. Quiet, not silent.
  const twelveHours = 12 * 60 * 60 * 1000;
  for (const category of ALL) {
    for (const month of MONTHS) {
      const interval = twelveHours * seasonFor(category, on(month)).intervalMultiplier;
      assert.ok(interval <= 4 * 24 * 60 * 60 * 1000, `${category} month ${month}`);
    }
  }
});

test("a firm's own history can still overcome an out-of-season slowdown", () => {
  // monitor-run applies the opening-window multiplier AFTER this one, so a
  // firm that opens outside its sector's normal season is still caught. This
  // asserts the seasonal side leaves room for that.
  const seasonal = seasonFor("real_estate", on(3)).intervalMultiplier;
  assert.ok(seasonal <= 4, "a slowdown large enough to outrun the window logic would be a gate");
});

// ------------------------------------------------- the run's queue follows the calendar

test("seasonBand agrees with seasonFor in every sector and month", () => {
  // The band is what orders a capped run; the multiplier is what spaces a
  // board's checks. If the two ever disagreed, a sector could be slowed as
  // out of season and still jump the queue, or the reverse.
  for (const category of ALL) {
    for (const month of MONTHS) {
      const { intervalMultiplier } = seasonFor(category, on(month));
      const band = seasonBand(category, on(month));
      const expected = intervalMultiplier === 1 ? 0 : intervalMultiplier === 2 ? 1 : 2;
      assert.equal(band, expected, `${category} in month ${month}`);
    }
  }
});

test("the queue moves between sectors as the year turns", () => {
  // If every sector sat in the same band all year, ordering by band would be
  // decoration - the failure this file opened with, one level up.
  const moved = ALL.filter((category) => new Set(MONTHS.map((m) => seasonBand(category, on(m)))).size > 1);
  assert.ok(moved.length >= 3, `only ${moved.length} sector(s) ever change band: ${moved.join(", ")}`);
});
