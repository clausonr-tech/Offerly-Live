// The Analytics tab's privacy rules. No database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { breakdown, MIN_GROUP, multiBreakdown, percent, STUDENT_DATA_SHARING_ENABLED, weeklyCounts } from "../../src/lib/firm-analytics-rules";

const many = (label: string, n: number) => Array.from({ length: n }, () => label);

test("a group smaller than five is never its own row", () => {
  const b = breakdown([...many("Penn", 12), ...many("Duke", 3), ...many("NYU", 6)]);
  assert.deepEqual(b.rows, [
    { label: "Penn", count: 12 },
    { label: "NYU", count: 6 },
  ]);
  assert.equal(b.hidden, 3, "Duke's three are hidden, not shown as Other on their own");
  assert.equal(b.total, 21);
  for (const r of b.rows) assert.ok(r.count >= MIN_GROUP);
});

test("small groups fold into Other once Other is big enough to show", () => {
  const b = breakdown([...many("Penn", 12), ...many("Duke", 3), ...many("Yale", 2), ...many("Rice", 1)]);
  assert.deepEqual(b.rows, [
    { label: "Penn", count: 12 },
    { label: "Other", count: 6 },
  ]);
  assert.equal(b.hidden, 0);
});

test("past the row cap, the rest is Other", () => {
  const values = ["A", "B", "C", "D"].flatMap((l) => many(l, 5));
  const b = breakdown(values, 2);
  assert.deepEqual(b.rows.map((r) => r.label), ["A", "B", "Other"]);
});

test("a multi-choice answer counts each student once per choice, and the total is students", () => {
  const b = multiBreakdown([...many("x", 5).map(() => ["IB", "PE"]), ["IB"]]);
  assert.deepEqual(b.rows, [
    { label: "IB", count: 6 },
    { label: "PE", count: 5 },
  ]);
  assert.equal(b.total, 6);
});

test("student-data sharing is on, now that the privacy policy describes opt-in sharing", () => {
  // Counted over opted-in students only - see sharedWithFirmsWhere in the cohort.
  assert.equal(STUDENT_DATA_SHARING_ENABLED, true);
});

test("the analytics never read GPA or visa sponsorship", () => {
  for (const file of ["src/lib/firm-analytics.ts", "src/lib/firm-analytics-rules.ts", "src/lib/firm-analytics-sample.ts"]) {
    const code = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    assert.ok(!/gpaBand|sponsorshipNeeded|gpa_band|sponsorship_needed/.test(code), `${file} reads GPA or sponsorship`);
  }
});

test("weekly counts land in the right Monday-starting week", () => {
  const now = new Date("2026-09-23T12:00:00Z"); // a Wednesday
  const w = weeklyCounts([new Date("2026-09-21T01:00:00Z"), new Date("2026-09-20T23:00:00Z"), new Date("2026-06-01T00:00:00Z")], now);
  assert.equal(w.length, 8);
  assert.equal(w[7].count, 1, "Monday the 21st is this week");
  assert.equal(w[6].count, 1, "Sunday the 20th is last week");
  assert.equal(w.reduce((a, b) => a + b.count, 0), 2, "older than eight weeks is left out");
});

test("percent has nothing to divide by when the base is zero", () => {
  assert.equal(percent(3, 0), null);
  assert.equal(percent(1, 3), 33);
});
