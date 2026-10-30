// Every threshold in the notification center, just under and just over. No database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  APPLY_MILESTONES,
  DEADLINE_SOON_DAYS,
  EVENT_SOON_HOURS,
  insightsFor,
  MATCHED_MILESTONES,
  mondayOf,
  SAVE_MILESTONES,
  SURGE_MIN,
  type InsightSnapshot,
} from "../../src/lib/firm-insights-rules";

const NOW = new Date("2026-09-23T15:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const snap = (over: Partial<InsightSnapshot> = {}): InsightSnapshot => ({
  now: NOW,
  postings: [],
  events: [],
  weekly: Array.from({ length: 8 }, (_, i) => ({ label: `w${i}`, count: 0 })),
  weekStart: mondayOf(NOW),
  pendingTeammates: [],
  studentDataShared: false,
  matched: 0,
  ...over,
});
const P = (over = {}) => ({ id: "p", title: "Role", isActive: true, applyClicks: 0, notified: 0, deadlineStatus: "rolling", deadlineDate: null as Date | null, ...over });
const E = (over = {}) => ({ id: "e", title: "Event", date: null as Date | null, isActive: true, calendarAdds: 0, clicks: 0, notified: 0, ...over });
const keysOf = (s: InsightSnapshot) => insightsFor(s).map((i) => i.dedupeKey);

describe("apply-click milestones", () => {
  for (const line of APPLY_MILESTONES) {
    test(`${line - 1} clicks does not announce ${line}`, () => {
      assert.ok(!keysOf(snap({ postings: [P({ applyClicks: line - 1 })] })).includes(`apply:p:${line}`));
    });
    test(`${line} clicks announces ${line}, and only ${line}`, () => {
      const keys = keysOf(snap({ postings: [P({ applyClicks: line })] })).filter((k) => k.startsWith("apply:"));
      assert.deepEqual(keys, [`apply:p:${line}`]);
    });
  }
});

describe("calendar-save milestones", () => {
  for (const line of SAVE_MILESTONES) {
    test(`${line - 1} saves: nothing; ${line}: announced`, () => {
      assert.ok(!keysOf(snap({ events: [E({ calendarAdds: line - 1 })] })).includes(`saves:e:${line}`));
      assert.ok(keysOf(snap({ events: [E({ calendarAdds: line })] })).includes(`saves:e:${line}`));
    });
  }
});

describe("student-match milestones, only while sharing is on", () => {
  for (const line of MATCHED_MILESTONES) {
    test(`${line} matched: ${line} announced with sharing on, nothing with it off`, () => {
      assert.deepEqual(keysOf(snap({ matched: line, studentDataShared: true })), [`matched:${line}`]);
      assert.deepEqual(keysOf(snap({ matched: line, studentDataShared: false })), []);
    });
  }
});

describe("deadlines", () => {
  const at = (ms: number, over = {}) => P({ deadlineStatus: "confirmed", deadlineDate: new Date(NOW.getTime() + ms), ...over });
  const cases: [string, number, string | null][] = [
    ["an hour away", HOUR, "deadline_soon"],
    ["a day away", DAY, "deadline_soon"],
    [`exactly ${DEADLINE_SOON_DAYS} days away`, DEADLINE_SOON_DAYS * DAY, "deadline_soon"],
    [`${DEADLINE_SOON_DAYS} days and a minute away`, DEADLINE_SOON_DAYS * DAY + 60_000, null],
    ["a week away", 7 * DAY, null],
    ["passed an hour ago", -HOUR, "deadline_passed"],
    ["passed a month ago", -30 * DAY, "deadline_passed"],
  ];
  for (const [label, ms, kind] of cases) {
    test(`an open posting whose deadline is ${label} -> ${kind ?? "nothing"}`, () => {
      const k = keysOf(snap({ postings: [at(ms)] })).filter((x) => x.startsWith("deadline"));
      assert.deepEqual(k.map((x) => x.split(":")[0]), kind ? [kind] : []);
    });
  }
  for (const [label, over] of [
    ["closed", { isActive: false }],
    ["rolling", { deadlineStatus: "rolling" }],
    ["tbd", { deadlineStatus: "tbd" }],
  ] as [string, object][]) {
    test(`a ${label} posting gets no deadline note`, () => {
      assert.deepEqual(keysOf(snap({ postings: [at(DAY, over)] })).filter((x) => x.startsWith("deadline")), []);
    });
  }
  test("moving the deadline announces the new date too", () => {
    const a = keysOf(snap({ postings: [at(DAY)] }));
    const b = keysOf(snap({ postings: [at(2 * DAY)] }));
    assert.notDeepEqual(a, b);
  });
  test("the days left read naturally: 1 day, 2 days", () => {
    assert.match(insightsFor(snap({ postings: [at(20 * HOUR)] }))[0].title, /closes in 1 day$/);
    assert.match(insightsFor(snap({ postings: [at(47 * HOUR)] }))[0].title, /closes in 2 days$/);
  });
});

describe("upcoming events", () => {
  const cases: [string, number, boolean][] = [
    ["in an hour", HOUR, true],
    [`in ${EVENT_SOON_HOURS} hours`, EVENT_SOON_HOURS * HOUR, true],
    [`in ${EVENT_SOON_HOURS} hours and a minute`, EVENT_SOON_HOURS * HOUR + 60_000, false],
    ["already started", -HOUR, false],
  ];
  for (const [label, ms, yes] of cases) {
    test(`an event ${label} -> ${yes ? "heads-up" : "nothing"}`, () => {
      assert.equal(keysOf(snap({ events: [E({ date: new Date(NOW.getTime() + ms) })] })).includes("event_soon:e"), yes);
    });
  }
  test("a closed event gets no heads-up", () => {
    assert.ok(!keysOf(snap({ events: [E({ date: new Date(NOW.getTime() + HOUR), isActive: false })] })).includes("event_soon:e"));
  });
  test("an event with no date gets no heads-up", () => {
    assert.ok(!keysOf(snap({ events: [E()] })).includes("event_soon:e"));
  });
});

describe("surges and weekly summaries", () => {
  const weeks = (before: number, last: number, current: number) =>
    [0, 0, 0, 0, 0, before, last, current].map((count, i) => ({ label: `w${i}`, count }));
  const surges: [number, number, boolean][] = [
    [0, SURGE_MIN, true],
    [0, SURGE_MIN - 1, false],
    [5, 10, true],
    [6, 11, false],
    [50, 100, true],
    [50, 99, false],
  ];
  for (const [last, current, yes] of surges) {
    test(`last week ${last}, this week ${current} -> ${yes ? "surge" : "no surge"}`, () => {
      assert.equal(keysOf(snap({ weekly: weeks(0, last, current) })).some((k) => k.startsWith("surge:")), yes);
    });
  }
  const summaries: [number, number, RegExp | null][] = [
    [0, 0, null],
    [0, 12, /12 clicks/],
    [10, 15, /Up 50%/],
    [20, 15, /Down 25%/],
    [10, 10, /Up 0%/],
    // A week of one click is one identifiable student: recordEngagement writes
    // one row per student per target per ten minutes. The summary still goes
    // out, with the count floored the way every other student-derived number
    // on the firm surfaces is - and with no percentage, since a change beside
    // a floored total lets the reader divide and recover what was hidden.
    [0, 1, /Fewer than 5 clicks on/],
    [0, 4, /Fewer than 5 clicks on/],
  ];
  for (const [before, last, want] of summaries) {
    test(`week before ${before}, last week ${last} -> ${want ?? "no summary"}`, () => {
      const w = insightsFor(snap({ weekly: weeks(before, last, 0) })).find((i) => i.kind === "weekly");
      if (!want) assert.equal(w, undefined);
      else assert.match(`${w!.title} ${w!.body}`, want);
    });
  }
  test("the summary is keyed by the Monday of the week it describes", () => {
    const w = insightsFor(snap({ weekly: weeks(0, 5, 0) })).find((i) => i.kind === "weekly")!;
    assert.equal(w.dedupeKey, "weekly:2026-09-14");
  });
  const mondays: [string, string][] = [
    ["2026-09-21T00:00:00Z", "2026-09-21"],
    ["2026-09-27T23:59:00Z", "2026-09-21"],
    ["2026-09-28T00:00:00Z", "2026-09-28"],
    ["2026-01-01T12:00:00Z", "2025-12-29"],
  ];
  for (const [instant, monday] of mondays) {
    test(`the week of ${instant} starts on ${monday}`, () => {
      assert.equal(mondayOf(new Date(instant)).toISOString().slice(0, 10), monday);
    });
  }
});

describe("what a note looks like", () => {
  const busy = snap({
    postings: [P({ applyClicks: 120, notified: 300, deadlineStatus: "confirmed", deadlineDate: new Date(NOW.getTime() + DAY) })],
    events: [E({ calendarAdds: 30, notified: 40, date: new Date(NOW.getTime() + DAY) })],
    weekly: [0, 0, 0, 0, 0, 10, 30, 70].map((count, i) => ({ label: `w${i}`, count })),
    pendingTeammates: [{ id: "u1", name: "Jordan" }],
  });
  const all = insightsFor(busy);
  test("a busy week produces one note per kind of news, and no two share a key", () => {
    assert.equal(new Set(all.map((i) => i.dedupeKey)).size, all.length);
    for (const kind of ["milestone", "reach", "surge", "weekly", "deadline", "event_soon", "team"]) {
      assert.ok(all.some((i) => i.kind === kind), kind);
    }
  });
  test("every note has a title, a body, and a link inside the portal", () => {
    for (const i of all) {
      assert.ok(i.title.trim(), i.dedupeKey);
      assert.ok(i.body.trim(), i.dedupeKey);
      assert.match(i.href, /^\/firms\//);
    }
  });
  test("only team notes are owner-only", () => {
    for (const i of all) assert.equal(i.audience === "owner", i.kind === "team", i.dedupeKey);
  });
  test("numbers are written with thousands separators", () => {
    const n = insightsFor(snap({ postings: [P({ applyClicks: 1200 })] }))[0];
    assert.match(n.body, /1,200 apply clicks/);
  });
  test("titles never carry a firm's text unescaped into a link", () => {
    const n = insightsFor(snap({ postings: [P({ id: "p", title: "<img src=x onerror=alert(1)>", applyClicks: 10 })] }))[0];
    // Rendered as React text, never HTML - but the link must not depend on the title.
    assert.equal(n.href, "/firms/analytics");
  });
});
