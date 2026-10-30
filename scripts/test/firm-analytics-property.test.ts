// The analytics privacy rules, held against thousands of random inputs rather
// than a handful of examples. No database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { breakdown, MIN_GROUP, multiBreakdown, percent, weeklyCounts } from "../../src/lib/firm-analytics-rules";
import { sampleFirmAnalytics } from "../../src/lib/firm-analytics-sample";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const LABELS = ["Penn", "NYU", "Duke", "Yale", "Rice", "USC", "BC", "UVA", "UNC", "Emory", "Tufts", "Brown"];

describe("breakdown, on random data", () => {
  for (let seed = 1; seed <= 25; seed++) {
    test(`seed ${seed}: no row under ${MIN_GROUP}, counts add up, nothing invented`, () => {
      const r = rng(seed);
      const n = Math.floor(r() * 200);
      const values = Array.from({ length: n }, () => (r() < 0.1 ? null : LABELS[Math.floor(r() ** 2 * LABELS.length)]));
      const max = 1 + Math.floor(r() * 8);
      const b = breakdown(values, max);
      for (const row of b.rows) assert.ok(row.count >= MIN_GROUP, `${row.label}: ${row.count}`);
      assert.equal(b.rows.reduce((a, x) => a + x.count, 0) + b.hidden, n, "every student is in a row or counted as hidden");
      assert.ok(b.rows.filter((x) => x.label !== "Other").length <= max, "row cap");
      assert.ok(b.hidden < MIN_GROUP, "hidden only ever holds a too-small remainder");
      assert.equal(b.total, n);
      const labels = b.rows.map((x) => x.label);
      assert.equal(new Set(labels).size, labels.length, "no duplicate rows");
      const named = b.rows.filter((x) => x.label !== "Other");
      for (let i = 1; i < named.length; i++) assert.ok(named[i - 1].count >= named[i].count, "largest first");
    });
  }
  test("an empty base shows nothing and hides nothing", () => {
    assert.deepEqual(breakdown([]), { rows: [], total: 0, hidden: 0 });
  });
  test("one student is never shown, however it is sliced", () => {
    for (const v of ["Penn", null, "  "]) {
      const b = breakdown([v]);
      assert.deepEqual(b.rows, []);
      assert.equal(b.hidden, 1);
    }
  });
  test("labels are trimmed, and blanks become Not given", () => {
    const b = breakdown([...Array(5).fill(" Penn "), ...Array(5).fill(""), ...Array(5).fill(null)]);
    assert.deepEqual(b.rows, [
      { label: "Not given", count: 10 },
      { label: "Penn", count: 5 },
    ]);
  });
});

describe("multi-choice breakdown, on random data", () => {
  for (let seed = 1; seed <= 10; seed++) {
    test(`seed ${seed}: no row under ${MIN_GROUP}, total is students not choices`, () => {
      const r = rng(seed * 97);
      const n = Math.floor(r() * 120);
      const lists = Array.from({ length: n }, () =>
        r() < 0.1 ? [] : [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => LABELS[Math.floor(r() * 5)]))],
      );
      const b = multiBreakdown(lists);
      assert.equal(b.total, n);
      for (const row of b.rows) assert.ok(row.count >= MIN_GROUP);
    });
  }
});

describe("weekly counts", () => {
  for (let seed = 1; seed <= 10; seed++) {
    test(`seed ${seed}: every in-range click lands in exactly one week`, () => {
      const r = rng(seed * 13);
      const now = new Date(Date.UTC(2026, 8, 1 + Math.floor(r() * 60), Math.floor(r() * 24)));
      const dates = Array.from({ length: 300 }, () => new Date(now.getTime() - r() * 70 * 24 * 3600 * 1000));
      const weeks = weeklyCounts(dates, now);
      const start = weeklyStart(now);
      const inRange = dates.filter((d) => d.getTime() >= start.getTime()).length;
      assert.equal(weeks.reduce((a, w) => a + w.count, 0), inRange);
      assert.equal(weeks.length, 8);
    });
  }
  function weeklyStart(now: Date) {
    const x = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7) - 7 * 7);
    return x;
  }
  test("a click in the future is not counted", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    assert.equal(weeklyCounts([new Date("2026-10-30T00:00:00Z")], now).reduce((a, w) => a + w.count, 0), 0);
  });
});

describe("percent", () => {
  const cases: [number, number, number | null][] = [
    [0, 0, null],
    [5, 0, null],
    [0, 10, 0],
    [1, 3, 33],
    [2, 3, 67],
    [10, 10, 100],
  ];
  for (const [p, w, want] of cases) test(`${p} of ${w} -> ${want}`, () => assert.equal(percent(p, w), want));
});

describe("the demo firm's sample data", () => {
  const own = {
    firmName: "Demo",
    postings: [
      { id: "a", title: "A", isActive: true, origin: "firm", applyClicks: 2, students: 1, notified: 3 },
      { id: "b", title: "B", isActive: false, origin: "firm", applyClicks: 0, students: 0, notified: 0 },
    ],
    events: [{ id: "e", title: "E", date: null, isActive: true, clicks: 1, calendarAdds: 1, notified: 2 }],
    weekly: Array.from({ length: 8 }, (_, i) => ({ label: `w${i}`, count: i === 7 ? 3 : 0 })),
    ownPostTotals: { applyClicks: 2, applyClickStudents: 1, eventClicks: 1, calendarAdds: 1, notified: 5 },
    now: new Date("2026-09-23T12:00:00Z"),
  };
  const a = sampleFirmAnalytics(own);
  test("is labelled sample data", () => assert.equal(a.isSample, true));
  test("is the same on every load", () => assert.deepEqual(sampleFirmAnalytics(own), a));
  test("keeps the privacy floor even in the sample", () => {
    for (const b of [a.schools, a.gradYears, a.degrees, a.sectors, a.locations]) for (const r of b.rows) assert.ok(r.count >= MIN_GROUP);
  });
  test("never claims more students clicked apply than there were clicks", () => {
    assert.ok(a.totals.applyClickStudents <= a.totals.applyClicks);
    for (const p of a.postings) assert.ok(p.students <= p.applyClicks, p.title);
  });
  test("the funnel never grows from one step to the next", () => {
    for (let i = 1; i < a.funnel.length; i++) assert.ok(a.funnel[i].count <= a.funnel[i - 1].count, a.funnel[i].label);
  });
  test("includes the demo student's real clicks on top", () => {
    const quieter = sampleFirmAnalytics({ ...own, postings: own.postings.map((p) => ({ ...p, applyClicks: 0 })) });
    assert.ok(a.totals.applyClicks > quieter.totals.applyClicks);
  });
});
