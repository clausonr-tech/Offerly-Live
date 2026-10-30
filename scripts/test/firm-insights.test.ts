// What earns a firm a notification. No database.

import { test } from "node:test";
import assert from "node:assert/strict";

import { highestCrossed, insightsFor, isUnread, mondayOf, type InsightSnapshot } from "../../src/lib/firm-insights-rules";

const NOW = new Date("2026-09-23T15:00:00Z"); // a Wednesday
const DAY = 24 * 60 * 60 * 1000;

function snap(over: Partial<InsightSnapshot> = {}): InsightSnapshot {
  return {
    now: NOW,
    postings: [],
    events: [],
    weekly: Array.from({ length: 8 }, (_, i) => ({ label: `w${i}`, count: 0 })),
    weekStart: mondayOf(NOW),
    pendingTeammates: [],
    studentDataShared: false,
    matched: 0,
    ...over,
  };
}

const posting = (over = {}) => ({
  id: "p1",
  title: "IB Summer Analyst",
  isActive: true,
  applyClicks: 0,
  notified: 0,
  deadlineStatus: "rolling",
  deadlineDate: null as Date | null,
  ...over,
});

const keys = (s: InsightSnapshot) => insightsFor(s).map((i) => i.dedupeKey).sort();

test("a quiet firm hears nothing", () => {
  assert.deepEqual(insightsFor(snap({ postings: [posting()] })), []);
});

test("only the highest milestone crossed is announced, so a jump is one note", () => {
  assert.equal(highestCrossed(9, [10, 25]), null);
  assert.equal(highestCrossed(30, [10, 25, 50]), 25);
  assert.deepEqual(keys(snap({ postings: [posting({ applyClicks: 30 })] })), ["apply:p1:25"]);
  // Crossing the next line later is a new key, so it is announced; the old one is not repeated.
  assert.deepEqual(keys(snap({ postings: [posting({ applyClicks: 55 })] })), ["apply:p1:50"]);
});

test("a new post's reach is announced once it has been sent to students", () => {
  const out = insightsFor(snap({ postings: [posting({ notified: 180 })] }));
  assert.equal(out[0].dedupeKey, "reach:posting:p1");
  assert.match(out[0].title, /reached 180 matched students/);
});

test("an open posting closing within three days gets a reminder; a past-deadline one gets a nudge to close it", () => {
  const soon = posting({ deadlineStatus: "confirmed", deadlineDate: new Date(NOW.getTime() + 2 * DAY) });
  assert.deepEqual(keys(snap({ postings: [soon] })), ["deadline_soon:p1:2026-09-25"]);
  const far = posting({ deadlineStatus: "confirmed", deadlineDate: new Date(NOW.getTime() + 10 * DAY) });
  assert.deepEqual(keys(snap({ postings: [far] })), []);
  const past = posting({ deadlineStatus: "confirmed", deadlineDate: new Date(NOW.getTime() - DAY) });
  assert.deepEqual(keys(snap({ postings: [past] })), ["deadline_passed:p1:2026-09-22"]);
  assert.deepEqual(keys(snap({ postings: [{ ...past, isActive: false }] })), [], "closed postings are left alone");
});

test("an event in the next day and a half gets a heads-up with its saves", () => {
  const e = { id: "e1", title: "Info session", date: new Date(NOW.getTime() + DAY), isActive: true, calendarAdds: 12, clicks: 30, notified: 0 };
  const out = insightsFor(snap({ events: [e] }));
  assert.deepEqual(out.map((i) => i.dedupeKey).sort(), ["event_soon:e1", "saves:e1:10"]);
  assert.match(out.find((i) => i.kind === "event_soon")!.body, /12 students saved it/);
  assert.deepEqual(keys(snap({ events: [{ ...e, date: new Date(NOW.getTime() + 3 * DAY), calendarAdds: 0 }] })), []);
});

test("a surge needs double the week before and at least ten clicks", () => {
  const weekly = (last: number, now: number) =>
    [0, 0, 0, 0, 0, 0, last, now].map((count, i) => ({ label: `w${i}`, count }));
  assert.ok(keys(snap({ weekly: weekly(10, 20) })).includes("surge:2026-09-21"));
  assert.ok(!keys(snap({ weekly: weekly(10, 19) })).includes("surge:2026-09-21"), "under double");
  assert.ok(!keys(snap({ weekly: weekly(2, 9) })).includes("surge:2026-09-21"), "under ten");
});

test("last week is summarised once, keyed by the week it describes, with the change on the week before", () => {
  const weekly = [0, 0, 0, 0, 0, 20, 30, 1].map((count, i) => ({ label: `w${i}`, count }));
  const out = insightsFor(snap({ weekly })).find((i) => i.kind === "weekly")!;
  assert.equal(out.dedupeKey, "weekly:2026-09-14");
  assert.match(out.title, /30 clicks/);
  assert.match(out.body, /Up 50%/);
  const quiet = [0, 0, 0, 0, 0, 0, 0, 5].map((count, i) => ({ label: `w${i}`, count }));
  assert.equal(insightsFor(snap({ weekly: quiet })).some((i) => i.kind === "weekly"), false, "nothing last week, nothing to say");
});

test("a colleague waiting for approval is for the owner's eyes only", () => {
  const out = insightsFor(snap({ pendingTeammates: [{ id: "u9", name: "Jordan" }] }));
  assert.deepEqual(out.map((i) => [i.dedupeKey, i.audience]), [["team:u9", "owner"]]);
});

test("student-match milestones wait for student-data sharing", () => {
  assert.deepEqual(keys(snap({ matched: 120 })), []);
  assert.deepEqual(keys(snap({ matched: 120, studentDataShared: true })), ["matched:100"]);
});

test("every insight links inside the portal", () => {
  const out = insightsFor(
    snap({
      postings: [posting({ applyClicks: 60, notified: 10, deadlineStatus: "confirmed", deadlineDate: new Date(NOW.getTime() + DAY) })],
      events: [{ id: "e1", title: "E", date: new Date(NOW.getTime() + DAY), isActive: true, calendarAdds: 6, clicks: 1, notified: 3 }],
      pendingTeammates: [{ id: "u", name: "A" }],
    }),
  );
  for (const i of out) assert.match(i.href, /^\/firms\//, i.dedupeKey);
});

test("unread means written after the account last opened the center", () => {
  assert.equal(isUnread(NOW, null), true);
  assert.equal(isUnread(NOW, new Date(NOW.getTime() - 1)), true);
  assert.equal(isUnread(NOW, NOW), false);
  assert.equal(mondayOf(NOW).toISOString(), "2026-09-21T00:00:00.000Z");
});
