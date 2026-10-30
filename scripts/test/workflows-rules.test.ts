// Adversarial tests for the recruiting-prompt workflows OTHER than the
// thank-you rules, and for how they interact:
//
//   - the cold-email ladder (outreach-ladder.ts, outreach-ladder-db.ts)
//   - copy-to-send detection (copy-send.ts)
//   - interview detection, countdown and refresher (interview-prep*.ts)
//   - the one banner across every kind (prompt-flash.ts getPendingFlash)
//   - the to-do list and its batches of five (today-tasks, today-list, todo-batch)
//   - time-zone arithmetic and the bell's pure parts
//
// Every assertion states the behaviour the workflow promises. A failing test
// here is a bug report, not a typo - see the comment on each.
//
// The banner's candidate builders and its sort are private, so banner order is
// tested through the real getPendingFlash over an in-memory PGlite migrated
// from drizzle/*.sql, exactly as thank-you-lifecycle.test.ts does. The student
// clock there is the default (America/New_York): there is no cookie jar
// outside a request.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed, fetch throws.

// Production (Vercel) runs in UTC. Pin it, so anything that reads the server's
// own clock instead of the student's behaves here as it does there.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import "./helpers/no-network";
import { eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import {
  contacts,
  emailDrafts,
  events,
  firms,
  internshipPostings,
  outreachSends,
  todoDismissals,
  userTopFirms,
  users,
} from "@/db/schema";
import { getOutreachNudges } from "@/lib/application-outreach";
import { SEND_COPY_SHARE, copyCountsAsSend } from "@/lib/copy-send";
import {
  MORNING_ENDS_HOUR,
  MORNING_OF_HOUR,
  NIGHT_BEFORE_HOUR,
  getInterviewPrepNudges,
  refresherAt,
  selectInterviewPrep,
} from "@/lib/interview-prep";
import { looksLikeInterview } from "@/lib/interview-prep-words";
import { autoCloseable, toNotificationList, type NotificationRow } from "@/lib/notifications";
import {
  FOLLOW_UP_AFTER_DAYS,
  MAX_EMAILS,
  followUpSubjectKey,
  ladderState,
  parseFollowUpSubject,
} from "@/lib/outreach-ladder";
import { getDueLadderFollowUps, recordOutreachSend } from "@/lib/outreach-ladder-db";
import { getPendingFlash, markFlashShown, type PendingFlash } from "@/lib/prompt-flash";
import { selectThankYous, type ChatEvent } from "@/lib/thank-you";
import { getThankYouPrompts } from "@/lib/thank-you-db";
import { localDateString, localParts, zonedTime } from "@/lib/time-zone";
import { groupByDay, type CompletedTask } from "@/lib/todo-batch";
import { getCompletedHistory, getTodayList, loadNextBatch } from "@/lib/today-list";
import { getAllTasks, type TodayTask } from "@/lib/today-tasks";

delete process.env.DATABASE_URL;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NY = "America/New_York";

const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
/** An instant by the New York wall clock. */
const et = (y: number, m: number, d: number, h: number, min = 0) => zonedTime(y, m, d, h, min, NY);

// =====================================================================
// 1. The cold-email ladder - pure rules
// =====================================================================

const T0 = new Date("2026-09-01T16:00:00Z");
const at = (days: number) => plus(T0, days * DAY);
const who = (relationshipStatus = "reached_out", lastContactDate: string | null = null) => ({
  relationshipStatus,
  lastContactDate,
  updatedAt: null,
});
const sends = (...days: number[]) => days.map((d, i) => ({ step: i + 1, sentAt: at(d), source: "copy" }));

describe("ladder: a reply ends it at every rung, however overdue", () => {
  for (const status of ["in_conversation", "ongoing"]) {
    for (const n of [0, 1, 2, 3]) {
      test(`${status} after ${n} email(s), 40 days on: replied, nothing next`, () => {
        const s = ladderState(who(status), sends(...[0, 7, 14].slice(0, n)), at(40));
        assert.equal(s.stage, "replied");
        assert.equal(s.nextStep, null);
        assert.equal(s.dueAt, null);
        assert.equal(s.sends.length, n);
      });
    }
  }
  test("a reply on a legacy 'reached out' still reads its implied first email", () => {
    const s = ladderState(who("in_conversation", "2026-08-20"), [], at(40));
    assert.equal(s.stage, "replied");
    assert.equal(s.sends.length, 1);
  });
});

describe("ladder: follow-ups sent early or late re-base the clock on the latest email", () => {
  const rows: [string, number[], number, string, number | null, number | null][] = [
    // label, send days, now (days), stage, nextStep, dueAt (days)
    ["2nd sent 3 days early: 3rd due 7 days after it", [0, 4], 10.99, "waiting", 3, 11],
    ["2nd sent 3 days early: due exactly 7 days after it", [0, 4], 11, "due", 3, 11],
    ["2nd sent 5 days late: 3rd not due at day 18.99", [0, 12], 18.99, "waiting", 3, 19],
    ["2nd sent 5 days late: 3rd due at day 19", [0, 12], 19, "due", 3, 19],
    ["2nd sent a minute after the 1st: still a full week", [0, 1 / 1440], 7, "waiting", 3, 7 + 1 / 1440],
    ["3rd sent early (day 9): finished, never a 4th", [0, 7, 9], 60, "finished", null, null],
    ["3rd sent 20 days late: finished", [0, 7, 34], 34, "finished", null, null],
    ["1st email only, 6.99 days on: waiting", [0], 6.99, "waiting", 2, 7],
    ["1st email only, 30 days on: due, still the 2nd", [0], 30, "due", 2, 7],
  ];
  for (const [label, days, now, stage, next, due] of rows) {
    test(label, () => {
      const s = ladderState(who(), sends(...days), at(now));
      assert.equal(s.stage, stage);
      assert.equal(s.nextStep, next);
      assert.equal(s.dueAt?.getTime() ?? null, due === null ? null : at(due).getTime());
    });
  }
  test("a contact edited back to 'not contacted' with emails on record is on the ladder by them", () => {
    const s = ladderState(who("not_contacted"), sends(0), at(8));
    assert.equal(s.stage, "due");
    assert.equal(s.nextStep, 2);
  });
  test("'cold' with a follow-up due ends the ladder", () => {
    assert.equal(ladderState(who("cold"), sends(0, 7), at(30)).stage, "finished");
  });
  test(`the ladder never offers a rung past ${MAX_EMAILS}`, () => {
    for (let n = 1; n <= 3; n++) {
      const s = ladderState(who(), sends(...[0, 7, 14].slice(0, n)), at(100));
      assert.ok(s.nextStep === null || s.nextStep <= MAX_EMAILS);
    }
  });
});

describe("ladder: the bell's subject key", () => {
  const id = "0f2794d3-58f6-4cc3-9149-d7db1ae5747d";
  for (const step of [1, 2, 3]) {
    test(`step ${step} round-trips`, () => {
      assert.deepEqual(parseFollowUpSubject(followUpSubjectKey(id, step)), { contactId: id, step });
    });
  }
  const junk = [
    `ladder:${id}:12`,
    `ladder:${id}:`,
    `ladder:${id}:2:extra`,
    `ladder:${id.slice(1)}:2`,
    `thanks:${id}`,
    `quiz:investment_banking`,
  ];
  for (const key of junk) {
    test(`"${key.slice(0, 30)}…" is not a follow-up subject`, () => {
      assert.equal(parseFollowUpSubject(key), null);
    });
  }
});

// =====================================================================
// 2. Copy-to-send
// =====================================================================

const BODY = [
  "Hi Dana,",
  "",
  "I'm a sophomore at Penn studying finance, and I came across your profile while researching Evercore's",
  "restructuring group. I'd love to hear how you found the move from Big Four into banking.",
  "",
  "Would you have 15 minutes for a quick call in the next couple of weeks?",
  "",
  "Best,",
  "Kai",
].join("\n");
const SUBJECT = "Penn sophomore - quick question about Evercore restructuring";
const at80 = Math.ceil(BODY.length * SEND_COPY_SHARE);
/** A slice of exactly `len` characters, starting at or after `from`, that does
 *  not begin or end on whitespace - so trimming cannot shorten it. */
function windowOf(len: number, from: number): string {
  for (let s = from; s + len <= BODY.length; s++) {
    const w = BODY.slice(s, s + len);
    if (w === w.trim()) return w;
  }
  throw new Error(`no ${len}-character window from ${from}`);
}

describe("copy-send: what counts as sending", () => {
  const rows: [string, string, string, boolean][] = [
    ["the whole body", BODY, BODY, true],
    ["the whole body with trailing newlines and spaces", `${BODY}\n\n   `, BODY, true],
    ["the whole body with leading whitespace", `\n\t ${BODY}`, BODY, true],
    ["the body copied with CRLF, saved with LF", BODY.replace(/\n/g, "\r\n"), BODY, true],
    ["the body copied with LF, saved with CRLF", BODY, BODY.replace(/\n/g, "\r\n"), true],
    ["old-Mac CR line endings", BODY.replace(/\n/g, "\r"), BODY, true],
    ["exactly the threshold, near the start", windowOf(at80, 0), BODY, true],
    ["one character under the threshold", windowOf(at80 - 1, 0), BODY, false],
    ["exactly the threshold, missing the greeting", windowOf(at80, BODY.length - at80 - 5), BODY, true],
    ["missing only the sign-off", BODY.slice(0, BODY.indexOf("Best,")), BODY, true],
    ["exactly the threshold, from the middle", windowOf(at80, Math.floor((BODY.length - at80) / 2)), BODY, true],
    ["one sentence", "Would you have 15 minutes for a quick call in the next couple of weeks?", BODY, false],
    ["the subject line alone", SUBJECT, BODY, false],
    ["subject and body together (not the body)", `${SUBJECT}\n\n${BODY}`, BODY, false],
    ["the body plus a signature the composer never had", `${BODY}\n--\nSent from my iPhone`, BODY, false],
    ["two separate halves glued together", BODY.slice(0, 120) + BODY.slice(200), BODY, false],
    ["an empty selection", "", BODY, false],
    ["a whitespace-only selection", " \n\t ", BODY, false],
    ["an empty body", "anything", "", false],
    ["a whitespace-only body", " ", "  \n ", false],
    ["different case", BODY.toUpperCase(), BODY, false],
    ["a five-character body, four copied", "Hi D", "Hi Da", true],
    ["a five-character body, three copied", "Hi ", "Hi Da", false],
    ["a one-character body", "a", "a", true],
    ["a repeated line is not the whole", "Thanks!", "Thanks!\nThanks!", false],
  ];
  for (const [label, selected, body, want] of rows) {
    test(label, () => assert.equal(copyCountsAsSend(selected, body), want));
  }

  test("every body length 1..400: ceil(80%) counts, one less does not", () => {
    const misses: number[] = [];
    for (let n = 1; n <= 400; n++) {
      const body = "x".repeat(n);
      const k = Math.ceil(n * SEND_COPY_SHARE - 1e-9);
      if (!copyCountsAsSend("x".repeat(k), body)) misses.push(n);
      if (k > 1 && copyCountsAsSend("x".repeat(k - 1), body)) misses.push(-n);
    }
    assert.deepEqual(misses, []);
  });

  test("emoji and accents are measured the same on both sides", () => {
    const body = "Merci beaucoup 🙏🏽 — à bientôt, Zoë 🎉".repeat(3);
    assert.equal(copyCountsAsSend(body, body), true);
    assert.equal(copyCountsAsSend(body.slice(0, Math.ceil(body.length * 0.8)), body), true);
  });

  test("a 2 MB body copied whole is a send, and 79% of it is not - both in well under a second", () => {
    const body = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n".repeat(36_000);
    const t = Date.now();
    assert.equal(copyCountsAsSend(body, body), true);
    assert.equal(copyCountsAsSend(body.slice(0, Math.floor(body.length * 0.79)), body), false);
    assert.ok(Date.now() - t < 1000);
  });
});

// =====================================================================
// 3. Interview detection - a corpus of real titles not tested elsewhere
// =====================================================================

describe("interview detection: real interview titles", () => {
  const titles = [
    "Superday (virtual) - Houlihan Lokey",
    "Zoom interview w/ Blackstone",
    "Goldman Sachs: Summer Analyst Interview",
    "Guggenheim Securities – Final Round",
    "Lazard 2nd-round",
    "Round 3 Moelis",
    "R3 PJT",
    "Second Rd Jefferies",
    "Behavioral interview",
    "Video interview - Barclays",
    "IB intvw",
    "Interview w GS 2pm",
    "MS S&T superday",
    "Wells Fargo 1st rd",
    "Final interview - Centerview",
    "MD interview - PJT",
    "Numerical test - Deloitte",
    "Assessment center - EY",
  ];
  for (const t of titles) test(`"${t}" is an interview`, () => assert.equal(looksLikeInterview(t), true));
});

describe("interview detection: a student's ordinary week is not an interview", () => {
  // Already correct - kept so a widened pattern cannot quietly break them.
  const guards = [
    "Team offsite",
    "Supervisor meeting",
    "Superbowl party",
    "Final exam",
    "Round-robin tournament",
    "Onsite interview prep",
    "Mock superday",
    "Superday debrief notes",
    "Interview practice w/ Jake",
  ];
  for (const t of guards) test(`"${t}" is not an interview`, () => assert.equal(looksLikeInterview(t), false));

  // BUG: coursework. "case study", "online exam" and "written exam" are a
  // business student's homework; a course code says so. The thank-you rules
  // already veto course codes (COURSE_CODE in thank-you.ts); the detector the
  // prep prompt uses does not, so these open a technicals countdown.
  const coursework = [
    "Case study due - FIN 3200",
    "ACCT 201 case study group",
    "STAT 110 online exam",
    "SPAN 201 written exam",
  ];
  for (const t of coursework) test(`coursework "${t}" is not an interview`, () => assert.equal(looksLikeInterview(t), false));

  // BUG: a screen and a site that are not an interview's.
  const places = ["Phone screen repair - Apple Store", "Onsite career fair", "Goldman Sachs on-site info session"];
  for (const t of places) test(`"${t}" is not an interview`, () => assert.equal(looksLikeInterview(t), false));
});

// =====================================================================
// 4. Prep <-> thank-you: the same entry, before and after
// =====================================================================

type PrepEvent = Parameters<typeof selectInterviewPrep>[0]["events"][number];

function prepFor(e: PrepEvent, now: Date, timeZone = NY) {
  return selectInterviewPrep({ events: [e], now, timeZone });
}
function thanksFor(e: PrepEvent, now: Date, timeZone = NY) {
  const ce: ChatEvent = {
    sourceKey: `offerly:${e.id}`,
    title: e.title,
    type: e.type,
    startsAt: e.eventDate,
    endsAt: (e as PrepEvent & { endDate?: Date | null }).endDate ?? null,
    notes: e.notes,
  };
  return selectThankYous({ events: [ce], contacts: [], done: new Set(), thanked: [], now, timeZone });
}

describe("prep and thank-you never speak about one entry at once", () => {
  const cases: [string, string, string, number][] = [
    ["Evercore superday", "interview", NY, 60],
    ["PJT R2", "meeting", NY, 45],
    ["Moelis phone screen", "meeting", "Europe/London", 30],
    ["Lazard 2pm", "interview", "Asia/Kolkata", 60],
    ["Centerview final round", "interview", "Australia/Sydney", 240],
    ["Houlihan Lokey 2nd rd", "meeting", "Pacific/Kiritimati", 60],
  ];
  for (const [title, type, zone, minutes] of cases) {
    test(`"${title}" (${type}, ${zone}): prep strictly before, thank-you from end+2h, neither in between`, () => {
      const start = zonedTime(2026, 10, 20, 10, 0, zone);
      const end = plus(start, minutes * MIN);
      const e = { id: "e1", title, notes: null, type, eventDate: start, completed: false, endDate: end } as PrepEvent;
      const problems: string[] = [];
      let sawPrep = false;
      let sawThanks = false;
      for (let t = start.getTime() - 8 * DAY; t <= end.getTime() + 15 * DAY; t += 30 * MIN) {
        const now = new Date(t);
        const p = prepFor(e, now, zone).length > 0;
        const ty = thanksFor(e, now, zone).length > 0;
        sawPrep ||= p;
        sawThanks ||= ty;
        if (p && ty) problems.push(`both at ${now.toISOString()}`);
        // At the very instant it starts it is still "today, refresher" (day 0,
        // by design); a moment later it is over.
        if (p && t > start.getTime()) problems.push(`prep after start at ${now.toISOString()}`);
        if (ty && t < end.getTime() + 2 * HOUR) problems.push(`thanks before end+2h at ${now.toISOString()}`);
      }
      assert.deepEqual(problems.slice(0, 3), []);
      assert.ok(sawPrep, "prepped for at some point");
      assert.ok(sawThanks, "thanked at some point");
    });
  }

  test("the entry that was prepped for is thanked as an INTERVIEW, not a chat", () => {
    const start = et(2026, 10, 20, 14);
    const titles: [string, string][] = [
      ["Evercore superday", "meeting"],
      ["PJT R2", "meeting"],
      ["Lazard 2pm", "interview"],
      ["Moelis phone screen", "interview"],
    ];
    for (const [title, type] of titles) {
      const e = { id: "e1", title, notes: null, type, eventDate: start, completed: false } as PrepEvent;
      assert.equal(prepFor(e, plus(start, -2 * DAY)).length, 1, title);
      const owed = thanksFor(e, plus(start, 5 * HOUR));
      assert.equal(owed.length, 1, title);
      assert.equal(owed[0].occasion, "interview", title);
    }
  });

  test("a recorded round is prepped for and never thanked (nobody was in the room)", () => {
    const start = et(2026, 10, 20, 14);
    const e = { id: "e1", title: "Goldman HireVue", notes: null, type: "meeting", eventDate: start, completed: false } as PrepEvent;
    assert.equal(prepFor(e, plus(start, -2 * DAY)).length, 1);
    assert.equal(thanksFor(e, plus(start, 5 * HOUR)).length, 0);
  });

  // BUG: the prep side ignores what the student filed the entry as, and has no
  // "names a conversation" override. The thank-you side has both
  // (isInterviewEvent: "Filed as something else on purpose - a deadline, an
  // info session, a chat"), so the two disagree about the same entry - and
  // getInterviewPrepNudges then rewrites its type to "interview", which turns
  // the chat's thank-you into an interview thank-you too.
  const notInterviews: [string, string][] = [
    ["Coffee chat with Dana re: interview process", "coffee_chat"],
    ["Coffee chat re: interview process", "meeting"],
    ["Evercore info session: interview process", "info_session"],
    ["Evercore superday RSVP deadline", "deadline"],
    ["Superday travel - flight to NYC", "personal"],
  ];
  for (const [title, type] of notInterviews) {
    test(`"${title}" filed as ${type} gets no prep countdown`, () => {
      const start = et(2026, 10, 20, 14);
      const e = { id: "e1", title, notes: null, type, eventDate: start, completed: false } as PrepEvent;
      assert.equal(prepFor(e, plus(start, -2 * DAY)).length, 0);
    });
  }
});

// =====================================================================
// 5. Refresher timing in zones the other suites do not cover
// =====================================================================

describe("refresher: 11:59 / 12:00 / midnight starts, several zones and DST days", () => {
  // [zone, y, m, d] - several of these are that zone's own DST-change day.
  const days: [string, number, number, number][] = [
    ["America/Los_Angeles", 2026, 11, 1],
    ["Pacific/Honolulu", 2026, 10, 14],
    ["Pacific/Auckland", 2026, 9, 27],
    ["Asia/Tokyo", 2026, 10, 14],
    ["Pacific/Chatham", 2026, 9, 27],
    ["Asia/Kathmandu", 2026, 10, 1],
    ["Australia/Lord_Howe", 2026, 10, 4],
  ];
  for (const [zone, y, m, d] of days) {
    for (const [h, min] of [[11, 59], [12, 0], [0, 0]] as const) {
      test(`${zone} ${y}-${m}-${d} ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`, () => {
        const start = zonedTime(y, m, d, h, min, zone);
        const r = refresherAt(start, zone);
        const p = localParts(r, zone);
        const morning = h < MORNING_ENDS_HOUR;
        const want = new Date(Date.UTC(y, m - 1, d - (morning ? 1 : 0)));
        assert.deepEqual(
          [p.year, p.month, p.day, p.hour, p.minute],
          [want.getUTCFullYear(), want.getUTCMonth() + 1, want.getUTCDate(), morning ? NIGHT_BEFORE_HOUR : MORNING_OF_HOUR, 0],
        );
        assert.ok(r.getTime() < start.getTime());
        // The phase flips at exactly that instant, and the chip says the day right.
        const e = { id: "e1", title: "Evercore superday", notes: null, type: "interview", eventDate: start, completed: false } as PrepEvent;
        const before = prepFor(e, plus(r, -1), zone)[0];
        const after = prepFor(e, r, zone)[0];
        assert.equal(before?.phase, "prep");
        assert.equal(after?.phase, "refresh");
        assert.equal(after.dayLabel, morning ? "tomorrow" : "today");
      });
    }
  }
});

// =====================================================================
// 6. Time zones and the completed history
// =====================================================================

describe("time zones: the student's calendar day at odd offsets", () => {
  const rows: [string, string, string, string][] = [
    ["Chatham +13:45 after DST", "2026-09-27T10:15:00Z", "Pacific/Chatham", "2026-09-28"],
    ["Chatham one minute earlier", "2026-09-27T10:14:00Z", "Pacific/Chatham", "2026-09-27"],
    ["Kathmandu +5:45", "2026-09-30T18:15:00Z", "Asia/Kathmandu", "2026-10-01"],
    ["Kathmandu one minute earlier", "2026-09-30T18:14:00Z", "Asia/Kathmandu", "2026-09-30"],
    ["Lord Howe +11 after its half-hour change", "2026-10-04T13:00:00Z", "Australia/Lord_Howe", "2026-10-05"],
    ["Honolulu -10", "2026-10-01T09:59:00Z", "Pacific/Honolulu", "2026-09-30"],
  ];
  for (const [label, instant, zone, want] of rows) {
    test(label, () => assert.equal(localDateString(new Date(instant), zone), want));
  }
});

describe("completed history: 'Yesterday' on the student's calendar", () => {
  const done = (iso: string): CompletedTask => ({
    id: iso,
    kind: "draft",
    title: "Send: x",
    detail: "",
    href: "/",
    score: 0,
    completedAt: new Date(iso),
    source: "manual",
  });
  // BUG: groupByDay reads "yesterday" as the day 24 hours ago. On the 25-hour
  // fall-back day, from 11pm, 24 hours ago is still TODAY, so yesterday's work
  // loses its "Yesterday" label and is shown as "Saturday, October 31".
  test("late on the fall-back day, the day before is still 'Yesterday' (NY)", () => {
    const now = et(2026, 11, 1, 23, 30);
    const days = groupByDay([done(et(2026, 10, 31, 12).toISOString())], NY, now);
    assert.equal(days[0].day, "2026-10-31");
    assert.equal(days[0].label, "Yesterday");
  });
  test("late on the spring-forward day, the day before is 'Yesterday' (NY)", () => {
    const now = et(2027, 3, 14, 23, 30);
    const days = groupByDay([done(et(2027, 3, 13, 12).toISOString())], NY, now);
    assert.equal(days[0].label, "Yesterday");
  });
  test("just after midnight, the evening before is 'Yesterday' (Sydney)", () => {
    const now = zonedTime(2026, 10, 4, 0, 5, "Australia/Sydney");
    const days = groupByDay([done(zonedTime(2026, 10, 3, 22, 0, "Australia/Sydney").toISOString())], "Australia/Sydney", now);
    assert.equal(days[0].label, "Yesterday");
  });
});

// =====================================================================
// 7. The bell's pure parts
// =====================================================================

function nrow(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "n1",
    userId: "u1",
    kind: "follow_up",
    dedupeKey: "follow_up:x:2",
    subjectKey: null,
    title: "t",
    body: "b",
    href: "/",
    expiresAt: null,
    createdAt: T0,
    bumpedAt: T0,
    readAt: null,
    doneAt: null,
    doneSource: null,
    ...over,
  } as NotificationRow;
}

describe("bell: which jobs close themselves", () => {
  const id = "0f2794d3-58f6-4cc3-9149-d7db1ae5747d";
  const subj = followUpSubjectKey(id, 2);
  test("a follow-up has no expiry: open years later while the rung is unsent", () => {
    assert.deepEqual(autoCloseable([nrow({ subjectKey: subj })], new Map([[subj, 1]]), at(3650)), []);
  });
  test("the rung sent closes it as done, not expired", () => {
    assert.deepEqual(autoCloseable([nrow({ subjectKey: subj })], new Map([[subj, 0]]), at(1)), [{ id: "n1", source: "auto" }]);
  });
  test("finished beats expired on an interview job whose interview has started", () => {
    const r = nrow({ kind: "interview_prep", subjectKey: "quiz:investment_banking", expiresAt: at(0) });
    assert.deepEqual(autoCloseable([r], new Map([["quiz:investment_banking", 0]]), at(1)), [{ id: "n1", source: "auto" }]);
  });
  test("an interview job expires at the interview's start to the millisecond", () => {
    const r = nrow({ kind: "interview_prep", expiresAt: at(0) });
    assert.deepEqual(autoCloseable([r], new Map(), plus(at(0), -1)), []);
    assert.deepEqual(autoCloseable([r], new Map(), at(0)), [{ id: "n1", source: "expired" }]);
  });
  test("a subject we could not measure never closes a job early", () => {
    assert.deepEqual(autoCloseable([nrow({ subjectKey: subj })], new Map(), at(1)), []);
  });
  test("a closed job is not closed again", () => {
    assert.deepEqual(autoCloseable([nrow({ subjectKey: subj, doneAt: at(0) })], new Map([[subj, 0]]), at(1)), []);
  });
  test("the list shows open jobs only, newest firing first, and counts unread among them", () => {
    const list = toNotificationList([
      nrow({ id: "old", bumpedAt: at(0) }),
      nrow({ id: "done", bumpedAt: at(5), doneAt: at(5) }),
      nrow({ id: "new", bumpedAt: at(2), readAt: at(2) }),
    ]);
    assert.deepEqual(list.open.map((i) => i.id), ["new", "old"]);
    assert.equal(list.openCount, 2);
    assert.equal(list.unreadCount, 1);
  });
  test("a follow-up's progress reads 0 of 1, then vanishes once closed", () => {
    const list = toNotificationList([nrow({ subjectKey: subj })], new Map([[subj, { remaining: 1, total: 1 }]]));
    assert.deepEqual(list.open[0].progress, { done: 0, total: 1 });
  });
});

// =====================================================================
// Database-backed workflows
// =====================================================================

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

type User = typeof users.$inferSelect;
let seq = 0;

async function mkUser(): Promise<User> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `workflows-${seq}-${process.pid}@example.edu`,
      passwordHash: "x",
      name: `Student ${seq}`,
      gradYear: 2032,
      preferredCategories: ["investment_banking"],
    })
    .returning();
  return u;
}

/** A tracked firm whose application opens at `opensAt`, and people there the
 *  student has never written to. */
async function mkOpening(userId: string, firmName: string, opensAt: Date, people: string[] = ["Opal Nguyen"]) {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `wf-firm-${seq}-${process.pid}`,
      name: firmName,
      headquarters: "New York",
      keyOffices: "New York",
      website: `firm${seq}.example.com`,
      description: "x",
    })
    .returning();
  await h.db.insert(userTopFirms).values({ userId, firmId: f.id });
  await h.db.insert(internshipPostings).values({
    firmId: f.id,
    categories: ["investment_banking"],
    roleTitle: "Investment Banking Summer Analyst",
    programYear: 2031,
    eligibleGradYears: [],
    descriptionFull: "A real posting.",
    opensAt,
    applicationUrl: `https://firm${seq}.example.com/apply`,
    sourceUrl: `https://firm${seq}.example.com/apply`,
    isActive: true,
  } as typeof internshipPostings.$inferInsert);
  for (const name of people) {
    await h.db.insert(contacts).values({
      userId,
      name,
      firm: firmName,
      relationshipStatus: "not_contacted",
      createdAt: plus(opensAt, -60 * DAY),
    });
  }
  return f;
}

/** A tracked firm with nobody at it. */
async function mkTrackedFirm(userId: string, firmName: string) {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `wf-firm-${seq}-${process.pid}`,
      name: firmName,
      headquarters: "New York",
      keyOffices: "New York",
      website: `firm${seq}.example.com`,
      description: "x",
    })
    .returning();
  await h.db.insert(userTopFirms).values({ userId, firmId: f.id });
}

/** Someone written to on each of `sentAt`, rung 1 first. */
async function mkLadder(
  userId: string,
  name: string,
  sentAt: Date[],
  opts: { status?: "reached_out" | "in_conversation" | "cold"; firm?: string } = {},
): Promise<string> {
  const last = sentAt[sentAt.length - 1];
  const [c] = await h.db
    .insert(contacts)
    .values({
      userId,
      name,
      firm: opts.firm ?? "Lazard",
      relationshipStatus: opts.status ?? "reached_out",
      lastContactDate: last ? localDateString(last, NY) : null,
      createdAt: plus(sentAt[0] ?? new Date(), -DAY),
    })
    .returning({ id: contacts.id });
  for (let i = 0; i < sentAt.length; i++) {
    await h.db.insert(outreachSends).values({ userId, contactId: c.id, step: i + 1, sentAt: sentAt[i], source: "copy" });
  }
  return c.id;
}

/** A coffee chat with a contact the student is talking to. */
async function mkChat(userId: string, name: string, start: Date, minutes = 30) {
  const [c] = await h.db
    .insert(contacts)
    .values({
      userId,
      name,
      firm: "Alumni",
      relationshipStatus: "in_conversation",
      lastContactDate: localDateString(start, NY),
      createdAt: plus(start, -DAY),
    })
    .returning({ id: contacts.id });
  await h.db.insert(events).values({
    userId,
    type: "coffee_chat",
    title: `Coffee chat with ${name}`,
    contactId: c.id,
    eventDate: start,
    endDate: plus(start, minutes * MIN),
  });
  return c.id;
}

async function mkEvent(
  userId: string,
  title: string,
  start: Date,
  type: "interview" | "meeting" | "coffee_chat" | "deadline" | "info_session" | "personal" = "interview",
  end: Date | null = null,
) {
  const [e] = await h.db
    .insert(events)
    .values({ userId, type, title, eventDate: start, endDate: end })
    .returning({ id: events.id });
  return e.id;
}

async function mkDraft(userId: string, subject: string, sent = false) {
  await h.db.insert(emailDrafts).values({
    userId,
    kind: "cold_outreach",
    subject,
    body: "Hello",
    sentAt: sent ? new Date("2030-01-01T00:00:00Z") : null,
  } as typeof emailDrafts.$inferInsert);
}

/** One page load: the banner, recorded as shown (markPromptFlashSeen's half). */
async function see(u: User, now: Date): Promise<PendingFlash | null> {
  const p = await getPendingFlash(u as never, now);
  if (p) await markFlashShown(u.id, p.flashKey);
  return p;
}

/** Page loads at one moment until the banner goes quiet. */
async function drain(u: User, now: Date, max = 40): Promise<PendingFlash[]> {
  const out: PendingFlash[] = [];
  for (let i = 0; i < max; i++) {
    const p = await see(u, now);
    if (!p) break;
    out.push(p);
  }
  return out;
}

function kindOf(p: PendingFlash): string {
  if (p.flashKey.startsWith("interview:")) return p.flashKey.endsWith(":refresh") ? "refresher" : "interview";
  if (p.flashKey.startsWith("thank_you:")) return "thank_you";
  if (p.flashKey.startsWith("follow_up:")) return "follow_up";
  return "outreach";
}

const cmpFlash = (a: PendingFlash, b: PendingFlash) =>
  a.daysUntil - b.daysUntil || (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0) || a.subject.localeCompare(b.subject);

// =====================================================================
// 8. The banner: who speaks first, and what follows
// =====================================================================

describe("banner: an interview tomorrow, a thank-you owed, three follow-ups due, an opening 10 days out", () => {
  // Tuesday 8 Oct 2030, 10am in New York.
  const now = et(2030, 10, 8, 10, 0);
  let u: User;

  before(async () => {
    u = await mkUser();
    // A 9:30am interview tomorrow: 23.5 hours away, so 1 day on either count.
    await mkEvent(u.id, "Centerview superday", et(2030, 10, 9, 9, 30));
    // A coffee chat that ended at 7am: owed since 9am.
    await mkChat(u.id, "Dana Reed", et(2030, 10, 8, 6, 30));
    // Three follow-ups due: two today, one a day late.
    await mkLadder(u.id, "Ava Stone", [plus(now, -7 * DAY)]);
    await mkLadder(u.id, "Ben Cole", [plus(now, -7 * DAY - HOUR)]);
    await mkLadder(u.id, "Cara Diaz", [plus(now, -8 * DAY)]);
    await mkOpening(u.id, "Guggenheim", plus(now, 10 * DAY));
  });

  test("first page load: the thank-you speaks first", async () => {
    const p = await see(u, now);
    assert.equal(p && kindOf(p), "thank_you");
    assert.equal(p?.subject, "Dana Reed");
  });

  test("then the interview, then ONE bubble for all three follow-ups, then the opening, then silence", async () => {
    const rest = await drain(u, now);
    assert.deepEqual(
      rest.map((p) => [kindOf(p), p.subject]),
      [
        ["interview", "Centerview superday"],
        ["follow_up", "3 people"],
        ["outreach", "Guggenheim"],
      ],
    );
    assert.equal(rest[1].notifications.length, 3);
  });

  test("later that afternoon: nothing new to say", async () => {
    assert.equal(await see(u, et(2030, 10, 8, 17, 59)), null);
  });

  test("6pm the evening before a morning interview: the refresher jumps the queue, once", async () => {
    const p = await see(u, et(2030, 10, 8, 18, 0));
    assert.equal(p && kindOf(p), "refresher");
    assert.equal(p?.chip, "interview tomorrow");
    assert.equal(await see(u, et(2030, 10, 8, 18, 1)), null);
  });

  test("next morning: the still-owed thank-you speaks again first, the interview never again", async () => {
    const shown = await drain(u, et(2030, 10, 9, 8, 0));
    assert.equal(shown.length > 0 && kindOf(shown[0]), "thank_you");
    assert.equal(shown.filter((p) => kindOf(p).startsWith("inter") || kindOf(p) === "refresher").length, 0);
    assert.equal(shown.filter((p) => kindOf(p) === "thank_you").length, 1);
  });
});

describe("banner: the follow-up bubble's rhythm and who it names", () => {
  test("every other day by the STUDENT's calendar: not twice in one New York evening", async () => {
    // Find an evening where 7:30pm and 8:30pm New York sit either side of an
    // even UTC midnight - the moment a UTC-day rhythm starts a new stretch.
    let day = 1;
    for (; day < 30; day++) {
      const a = Math.floor(et(2030, 10, day, 19, 30).getTime() / DAY);
      const b = Math.floor(et(2030, 10, day, 20, 30).getTime() / DAY);
      if (a % 2 === 1 && b % 2 === 0) break;
    }
    const u = await mkUser();
    await mkLadder(u.id, "Ava Stone", [plus(et(2030, 10, day, 12, 0), -7 * DAY - 2 * DAY)]);
    const first = await see(u, et(2030, 10, day, 19, 30));
    assert.equal(first && kindOf(first), "follow_up");
    // BUG: the bubble's round is floor(UTC day / 2), so its stretch turns over
    // at 8pm New York (10am in Sydney), not at the student's midnight - and the
    // same bubble drops again an hour later. followUpFlash in prompt-flash.ts.
    assert.equal(await see(u, et(2030, 10, day, 20, 30)), null);
  });

  test("sending one of two follow-ups does not re-announce the other the same stretch", async () => {
    const now = et(2030, 10, 14, 10, 0);
    const u = await mkUser();
    const ava = await mkLadder(u.id, "Ava Stone", [plus(now, -8 * DAY)]);
    await mkLadder(u.id, "Ben Cole", [plus(now, -8 * DAY)]);
    const first = await see(u, now);
    assert.equal(first?.subject, "2 people");
    const sent = await recordOutreachSend({ userId: u.id, contactId: ava, source: "manual", now: plus(now, 5 * MIN) });
    assert.equal(sent?.step, 2);
    // BUG: the key carries who is due, so removing Ava makes a new key naming
    // only Ben - and Ben, announced ten minutes ago, is announced again.
    assert.equal(await see(u, plus(now, 10 * MIN)), null);
  });

  test("someone newly due the same day DOES speak up (the reason the key carries who)", async () => {
    const now = et(2030, 10, 14, 10, 0);
    const u = await mkUser();
    await mkLadder(u.id, "Ava Stone", [plus(now, -8 * DAY)]);
    await mkLadder(u.id, "Ben Cole", [plus(now, -7 * DAY + 5 * HOUR)]);
    assert.equal((await see(u, now))?.subject, "Ava Stone");
    const later = await see(u, plus(now, 6 * HOUR));
    assert.equal(later?.subject, "2 people");
  });

  test("a reply silences the bubble and the list at once", async () => {
    const now = et(2030, 10, 14, 10, 0);
    const u = await mkUser();
    const c = await mkLadder(u.id, "Ava Stone", [plus(now, -15 * DAY), plus(now, -8 * DAY)]);
    assert.equal((await getDueLadderFollowUps(u.id, now))[0]?.step, 3);
    await h.db.update(contacts).set({ relationshipStatus: "in_conversation" }).where(eq(contacts.id, c));
    assert.equal(await see(u, now), null);
    assert.deepEqual(await getDueLadderFollowUps(u.id, now), []);
  });

  test("a follow-up sent early moves the next one a week after IT", async () => {
    const now = et(2030, 10, 14, 10, 0);
    const u = await mkUser();
    await mkLadder(u.id, "Ava Stone", [plus(now, -10 * DAY), plus(now, -2 * DAY)]);
    assert.equal(await see(u, now), null);
    assert.equal(await see(u, plus(now, 5 * DAY - MIN)), null);
    const p = await see(u, plus(now, 5 * DAY));
    assert.equal(p?.chip, "3rd email due");
  });

  test("a legacy 'reached out' date is due at the student's midnight, not UTC's", async () => {
    // Ticked "reached out" on 1 Oct (a date column, the student's day). A week
    // later is the student's 8 Oct - at 9pm on 7 Oct in New York it is not yet.
    const u = await mkUser();
    await h.db.insert(contacts).values({
      userId: u.id,
      name: "Legacy Lee",
      firm: "Lazard",
      relationshipStatus: "reached_out",
      lastContactDate: "2030-10-01",
      createdAt: et(2030, 9, 1, 12),
    });
    // BUG: ladderState parses the date as SERVER-local midnight (UTC in
    // production), which is 8pm the evening before in New York.
    assert.deepEqual(await getDueLadderFollowUps(u.id, et(2030, 10, 7, 21, 0)), []);
    assert.equal((await getDueLadderFollowUps(u.id, et(2030, 10, 8, 0, 30))).length, 1);
  });
});

describe("interview prep: the type the student chose", () => {
  // BUG: getInterviewPrepNudges auto-tags every entry the detector recognises,
  // and says it "never overwrites a type the student chose themselves" and
  // that "a student who re-filed one as a meeting is not overruled on every
  // page load". Neither holds: selectInterviewPrep does not read the type.
  test("a coffee chat about the interview process stays a coffee chat", async () => {
    const now = et(2030, 10, 14, 10, 0);
    const u = await mkUser();
    const id = await mkEvent(u.id, "Coffee chat with Dana re: interview process", plus(now, 2 * DAY), "coffee_chat");
    const nudges = await getInterviewPrepNudges(u as never, now);
    assert.equal(nudges.length, 0);
    const row = await h.db.query.events.findFirst({ where: eq(events.id, id) });
    assert.equal(row?.type, "coffee_chat");
  });

  test("an entry re-filed as a meeting is not re-tagged on the next load", async () => {
    const now = et(2030, 10, 14, 10, 0);
    const u = await mkUser();
    const id = await mkEvent(u.id, "Evercore superday", plus(now, 2 * DAY), "meeting");
    await getInterviewPrepNudges(u as never, now);
    const tagged = await h.db.query.events.findFirst({ where: eq(events.id, id) });
    assert.equal(tagged?.type, "interview");
    // Recorded as the detector's doing, when, and from which words.
    assert.equal(tagged?.typeSource, "detected");
    assert.equal(tagged?.typeDetectedFrom?.toLowerCase(), "superday");
    assert.ok(tagged?.typeDetectedAt);
    // updateEvent, step for step: changing the type is the student's call.
    await h.db.update(events).set({ type: "meeting", typeSource: "student" }).where(eq(events.id, id));
    await getInterviewPrepNudges(u as never, plus(now, MIN));
    assert.equal((await h.db.query.events.findFirst({ where: eq(events.id, id) }))?.type, "meeting");
  });
});

// =====================================================================
// 9. The to-do list: 23 mixed tasks, five at a time
// =====================================================================

describe("to-do: 23 mixed tasks, ordered and batched", () => {
  const now = et(2030, 10, 8, 10, 0);
  let u: User;
  let all: TodayTask[];

  before(async () => {
    u = await mkUser();
    // Deadlines: today 5pm, tomorrow 5pm, two days ago.
    await mkEvent(u.id, "Evercore application deadline", et(2030, 10, 8, 17), "deadline");
    await mkEvent(u.id, "Lazard application deadline", et(2030, 10, 9, 17), "deadline");
    await mkEvent(u.id, "Moelis application deadline", et(2030, 10, 6, 12), "deadline");
    // Meetings ahead.
    await mkEvent(u.id, "Alumni coffee", et(2030, 10, 8, 15), "meeting");
    await mkEvent(u.id, "Finance club meeting", et(2030, 10, 9, 12), "meeting");
    // Interviews: tomorrow morning (prep), and in three days (prep) - each is
    // also on the schedule.
    await mkEvent(u.id, "Centerview superday", et(2030, 10, 9, 9, 30));
    await mkEvent(u.id, "PJT first round", et(2030, 10, 11, 14));
    // Openings in 3 and 10 days; one in 20 is banner-only.
    await mkOpening(u.id, "Guggenheim", plus(now, 3 * DAY));
    await mkOpening(u.id, "Houlihan Lokey", plus(now, 10 * DAY));
    await mkOpening(u.id, "Rothschild", plus(now, 20 * DAY));
    // Tracked, nobody known there.
    await mkTrackedFirm(u.id, "Jefferies");
    await mkTrackedFirm(u.id, "Perella Weinberg");
    // Ladder: 0, 3 and 10 days overdue, and a 3rd email a day overdue.
    await mkLadder(u.id, "Ava Stone", [plus(now, -7 * DAY)]);
    await mkLadder(u.id, "Ben Cole", [plus(now, -10 * DAY)]);
    await mkLadder(u.id, "Cara Diaz", [plus(now, -17 * DAY)]);
    await mkLadder(u.id, "Drew Fox", [plus(now, -16 * DAY), plus(now, -8 * DAY)]);
    // Thank-yous: a chat that ended at 7am, and one yesterday afternoon.
    await mkChat(u.id, "Dana Reed", et(2030, 10, 8, 6, 30));
    await mkChat(u.id, "Eli Park", et(2030, 10, 7, 14, 30));
    // Drafts: two unsent, one sent.
    await mkDraft(u.id, "Intro to Evercore");
    await mkDraft(u.id, "Coffee follow-up");
    await mkDraft(u.id, "Already gone", true);
    // Catch-ups: in conversation 30 days ago, ongoing 60 days ago.
    for (const [name, status, days] of [["Gil Hart", "in_conversation", 30], ["Hana Ito", "ongoing", 60]] as const) {
      await h.db.insert(contacts).values({
        userId: u.id,
        name,
        firm: "Alumni",
        relationshipStatus: status,
        lastContactDate: localDateString(plus(now, -days * DAY), NY),
        createdAt: plus(now, -90 * DAY),
      });
    }
    all = await getAllTasks(u as never, now);
  });

  test("exactly 23 tasks, every id unique", () => {
    assert.equal(all.length, 23, all.map((t) => t.id).join("\n"));
    assert.equal(new Set(all.map((t) => t.id)).size, 23);
  });

  test("ordered by score, then title, and the kinds sit where the rules put them", () => {
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1];
      const b = all[i];
      assert.ok(a.score > b.score || (a.score === b.score && a.title.localeCompare(b.title) <= 0), `${a.title} / ${b.title}`);
    }
    const score = (title: string) => all.find((t) => t.title === title)?.score;
    assert.equal(score("Evercore application deadline"), 100);
    assert.equal(score("Practise for Centerview superday"), 93);
    assert.equal(score("Lazard application deadline"), 96);
    assert.equal(score("Thank Eli Park"), 90);
    assert.equal(score("Follow up with Cara Diaz"), 88);
    assert.equal(score("Email Guggenheim"), 83);
    assert.equal(score("Email Houlihan Lokey"), 62);
    assert.equal(score("Follow up with Ava Stone"), 70);
    assert.equal(all.find((t) => t.title === "Email Rothschild"), undefined);
    assert.deepEqual(all.slice(-2).map((t) => t.kind), ["coverage", "coverage"]);
  });

  test("today's five, crossed out in place, then the next five - to the end of the list", async () => {
    const first = await getTodayList(u as never, now);
    assert.deepEqual(first.items.map((i) => i.id), all.slice(0, 5).map((t) => t.id));
    assert.equal(first.waiting, 18);
    assert.equal(first.total, 23);
    assert.equal(await loadNextBatch(u as never, now), false);

    const offered: string[] = [];
    const batchSizes: number[] = [];
    let current = first;
    let added = false;
    for (let round = 0; round < 10; round++) {
      offered.push(...current.items.map((i) => i.id));
      batchSizes.push(current.items.length);
      // Finish them one by one: each stays in its place, crossed out.
      for (let k = 0; k < current.items.length; k++) {
        await h.db.insert(todoDismissals).values({ userId: u.id, taskId: current.items[k].id });
        const mid = await getTodayList(u as never, now);
        assert.deepEqual(mid.items.map((i) => i.id), current.items.map((i) => i.id));
        assert.deepEqual(mid.items.map((i) => i.done), current.items.map((_, j) => j <= k));
        if (k < current.items.length - 1) assert.equal(await loadNextBatch(u as never, now), false);
      }
      // A task that turns up mid-list waits for the next five.
      if (!added) {
        added = true;
        await mkDraft(u.id, "Late addition");
        const mid = await getTodayList(u as never, now);
        assert.ok(!mid.items.some((i) => i.title === "Send: Late addition"));
      }
      if (!(await loadNextBatch(u as never, now))) break;
      current = await getTodayList(u as never, now);
    }
    assert.deepEqual(batchSizes, [5, 5, 5, 5, 4]);
    // Everything was offered exactly once - the 23, and the late addition.
    assert.equal(offered.length, 24);
    assert.equal(new Set(offered).size, 24);
    assert.ok(all.every((t) => offered.includes(t.id)));
    const history = await getCompletedHistory(u.id, now);
    assert.equal(history.reduce((n, d) => n + d.items.length, 0) >= 23, true);
  });
});

describe("to-do: labels by the student's calendar, not the server's", () => {
  // BUG: today-tasks' daysUntil uses setHours(0,0,0,0) - the SERVER's midnight
  // (UTC in production). Anything after 8pm in New York is "tomorrow".
  test("a deadline at 11pm tonight is due today, scored as today", async () => {
    const u = await mkUser();
    await mkEvent(u.id, "Evercore application deadline", et(2030, 10, 8, 23, 0), "deadline");
    const t = (await getAllTasks(u as never, et(2030, 10, 8, 9, 0))).find((x) => x.kind === "deadline");
    assert.equal(t?.detail, "Application deadline today");
    assert.equal(t?.score, 100);
  });
  test("a networking dinner at 9pm tonight is scheduled today", async () => {
    const u = await mkUser();
    await mkEvent(u.id, "Networking dinner", et(2030, 10, 8, 21, 0), "meeting");
    const t = (await getAllTasks(u as never, et(2030, 10, 8, 9, 0))).find((x) => x.kind === "event");
    assert.equal(t?.detail, "Scheduled today");
  });
  test("a deadline at 10pm last night was yesterday", async () => {
    const u = await mkUser();
    await mkEvent(u.id, "Lazard application deadline", et(2030, 10, 7, 22, 0), "deadline");
    const t = (await getAllTasks(u as never, et(2030, 10, 8, 9, 0))).find((x) => x.kind === "deadline");
    assert.equal(t?.detail, "Application deadline 1d ago");
  });
});

// =====================================================================
// 10. Seeded fuzz: banner priority and to-do order
// =====================================================================

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Spec = {
  now: Date;
  interviews: { title: string; start: Date; type: "interview" | "meeting" }[];
  chats: { name: string; start: Date }[];
  ladders: { name: string; firm: string; sends: Date[]; status: "reached_out" | "in_conversation" | "cold" }[];
  openings: { firm: string; opensAt: Date; people: string[] }[];
};

function makeSpec(rand: () => number): Spec {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const now = et(2030, 10 + int(0, 2), int(1, 28), int(0, 23), int(0, 3) * 15);
  const interviews = Array.from({ length: int(0, 3) }, () => ({
    title: pick(["Evercore superday", "Lazard first round", "PJT R2", "Moelis phone screen", "Centerview final round"]),
    start: plus(now, int(-24, 190) * HOUR + int(0, 3) * 15 * MIN),
    type: rand() < 0.7 ? ("interview" as const) : ("meeting" as const),
  }));
  const chats = Array.from({ length: int(0, 2) }, () => ({
    name: pick(["Dana Reed", "Eli Park", "Fern Ruiz"]),
    start: plus(now, -int(2, 200) * HOUR - int(0, 3) * 15 * MIN),
  }));
  const ladders = Array.from({ length: int(0, 4) }, () => {
    const n = int(1, 3);
    const s: Date[] = [plus(now, -int(0, 30) * DAY - int(0, 23) * HOUR)];
    for (let i = 1; i < n; i++) {
      const next = plus(s[i - 1], int(1, 12) * DAY);
      if (next.getTime() > now.getTime()) break;
      s.push(next);
    }
    const r = rand();
    return {
      name: pick(["Ava Stone", "Ben Cole", "Cara Diaz", "Ava Stone"]),
      firm: pick(["Lazard", "Moelis", "Jefferies"]),
      sends: s,
      status: r < 0.8 ? ("reached_out" as const) : r < 0.9 ? ("in_conversation" as const) : ("cold" as const),
    };
  });
  const firmPool = ["Guggenheim", "Houlihan Lokey", "Rothschild"];
  const openings = Array.from({ length: int(0, 2) }, (_, i) => ({
    firm: firmPool[i],
    opensAt: plus(now, int(1, 35) * DAY + int(0, 23) * HOUR),
    people: int(1, 2) === 1 ? ["Opal Nguyen"] : ["Opal Nguyen", "Pia Quinn"],
  }));
  return { now, interviews, chats, ladders, openings };
}

async function seedSpec(u: User, s: Spec, reversed: boolean) {
  const order = <T,>(xs: T[]) => (reversed ? [...xs].reverse() : xs);
  const jobs: (() => Promise<unknown>)[] = [
    ...s.interviews.map((i) => () => mkEvent(u.id, i.title, i.start, i.type)),
    ...s.chats.map((c) => () => mkChat(u.id, c.name, c.start)),
    ...s.ladders.map((l) => () => mkLadder(u.id, l.name, l.sends, { status: l.status, firm: l.firm })),
    ...s.openings.map((o) => () => mkOpening(u.id, o.firm, o.opensAt, o.people)),
  ];
  for (const job of order(jobs)) await job();
}

const visible = (p: PendingFlash) => `${p.chip}|${p.subject}|${p.detail}|${p.daysUntil}`;
const visibleTask = (t: TodayTask) => `${t.kind}|${t.title}|${t.detail}|${t.score}`;

test("fuzz: 200 seeded scenarios - one bubble at a time, most urgent first, never twice, same whatever the input order; the to-do list likewise", async () => {
  const rand = mulberry32(20260923);
  const failures: string[] = [];
  const fail = (i: number, what: string) => {
    if (failures.length < 25) failures.push(`#${i}: ${what}`);
  };

  for (let i = 0; i < 200; i++) {
    const s = makeSpec(rand);
    const a = await mkUser();
    const b = await mkUser();
    await seedSpec(a, s, false);
    await seedSpec(b, s, true);

    const seqA = await drain(a, s.now);
    const seqB = await drain(b, s.now);

    // Never the same firing twice.
    const keys = seqA.map((p) => p.flashKey);
    if (new Set(keys).size !== keys.length) fail(i, `a key repeated: ${keys.join(", ")}`);

    // Most urgent first, every time: at one moment the bubbles come out in order.
    for (let k = 1; k < seqA.length; k++) {
      if (cmpFlash(seqA[k - 1], seqA[k]) > 0) fail(i, `out of order: ${visible(seqA[k - 1])} before ${visible(seqA[k])}`);
    }

    // One bubble per interview, per thank-you and per opening; one for every follow-up.
    const [iv, ty, fu, on] = await Promise.all([
      getInterviewPrepNudges(a as never, s.now),
      getThankYouPrompts(a.id, s.now),
      getDueLadderFollowUps(a.id, s.now),
      getOutreachNudges(a as never, s.now),
    ]);
    const expected = iv.length + ty.length + (fu.length > 0 ? 1 : 0) + on.length;
    if (seqA.length !== expected) fail(i, `${seqA.length} bubbles for ${expected} prompts`);
    if (seqA.filter((p) => kindOf(p) === "follow_up").length > 1) fail(i, "more than one follow-up bubble");

    // Silence afterwards, at the same moment.
    if (await getPendingFlash(a as never, s.now)) fail(i, "spoke again after everything was shown");

    // Deterministic whatever order the rows went in.
    const va = seqA.map(visible);
    const vb = seqB.map(visible);
    if (va.join("\n") !== vb.join("\n")) fail(i, `input order changed the banner:\n  ${va.join("\n  ")}\nvs\n  ${vb.join("\n  ")}`);

    // The to-do list: sorted, unique, and the same whatever the input order.
    const [ta, tb] = await Promise.all([getAllTasks(a as never, s.now), getAllTasks(b as never, s.now)]);
    if (new Set(ta.map((t) => t.id)).size !== ta.length) fail(i, "a to-do id repeated");
    for (let k = 1; k < ta.length; k++) {
      const x = ta[k - 1];
      const y = ta[k];
      if (x.score < y.score || (x.score === y.score && x.title.localeCompare(y.title) > 0)) {
        fail(i, `to-do out of order: ${visibleTask(x)} before ${visibleTask(y)}`);
      }
    }
    const la = ta.map(visibleTask);
    const lb = tb.map(visibleTask);
    if (la.join("\n") !== lb.join("\n")) fail(i, `input order changed the to-do list:\n  ${la.join("\n  ")}\nvs\n  ${lb.join("\n  ")}`);
  }

  assert.deepEqual(failures, []);
});

// Silence "unused" for constants imported only to document the rules above.
void FOLLOW_UP_AFTER_DAYS;
