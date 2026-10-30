// Prompting a student to practise before an interview.
//
// This one reads a string somebody else wrote - a calendar invitation - and
// acts on it without asking. That makes the detector the whole risk: too eager
// and it interrupts people about coffee chats and prep sessions, too shy and it
// says nothing before the one meeting that decides their summer.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PREP_INTERVALS,
  calendarDaysBetween,
  looksLikeInterview,
  PREP_HREF,
  prepHref,
  prepIntervalFor,
  refresherAt,
  selectInterviewPrep,
  type TrackedFirms,
} from "../../src/lib/interview-prep";

const NOW = new Date("2026-09-22T12:00:00Z");
const DAY = 86_400_000;

function at(days: number): Date {
  return new Date(NOW.getTime() + days * DAY);
}

function event(over: Partial<Parameters<typeof selectInterviewPrep>[0]["events"][number]> = {}) {
  return {
    id: "e1",
    title: "Evercore first round interview",
    notes: null,
    type: "meeting",
    eventDate: at(3),
    completed: false,
    ...over,
  };
}

function prep(
  events: Parameters<typeof selectInterviewPrep>[0]["events"],
  trackedFirms: TrackedFirms = new Map(),
  now: Date = NOW,
) {
  return selectInterviewPrep({
    events,
    trackedFirms,
    now,
  });
}

// ---------- what a calendar entry has to say ----------

const IS_AN_INTERVIEW = [
  "Evercore interview",
  "Superday - Goldman Sachs",
  "Super Day, Morgan Stanley",
  "Assessment centre",
  "Assessment Center - Barclays",
  "HireVue due",
  "Lazard case study",
  "First round - Moelis",
  "1st round, Jefferies",
  "Second round with PJT",
  "2nd Round Interview",
  "Final round",
  "Final stage - Centerview",
  "Phone screen with Evercore",
  "Technical screen",
  "Onsite - Blackstone",
  "On-site interview",
  // How people actually type them.
  "Interviews at Evercore",
  "Interviewing with Lazard",
  "GS intvw",
  "Moelis intv 2pm",
  "Superdays - Centerview",
  "Super-day MS",
  "Assessment day, Barclays",
  "One-way video - Citi",
  "Hire Vue for JPM",
  "Final rd - PJT",
  "3rd round Guggenheim",
  "Last stage - Houlihan",
  "Round 2 - Jefferies",
  "Rd 1 Perella",
  "Evercore R1",
  "HR screen - Wells Fargo",
  "Recruiter screening - BofA",
  "Screening call with Rothschild",
  "Tech screen, Citadel",
  "Fit call - Lazard",
  "Case interview, Bain",
  "Paper LBO - KKR",
  "Modeling test - Blackstone",
  "Modelling assessment (Apollo)",
  "Technical test - Evercore",
  "Online assessment Goldman",
];

for (const title of IS_AN_INTERVIEW) {
  test(`"${title}" is an interview`, () => {
    assert.ok(looksLikeInterview(title));
  });
}

const IS_NOT_AN_INTERVIEW = [
  "Coffee chat with Dana",
  "Call with Sam",
  "Evercore info session",
  "Networking night",
  "Lunch",
  "Office hours",
  "Study group",
  "Flight to New York",
  "Club meeting",
  "1:1 with mentor",
  // Words that sit near interview words without being one.
  "Screen time limit",
  "Round of golf with Dad",
  "R&D reading",
  "Stage crew",
  "Test drive",
  "Online class",
];

for (const title of IS_NOT_AN_INTERVIEW) {
  test(`"${title}" is not an interview`, () => {
    assert.ok(!looksLikeInterview(title));
  });
}

const IS_PREPARATION = [
  "Interview prep with Dan",
  "Mock interview",
  "Superday practice",
  "Interview coaching",
  "Technicals workshop",
  "Interview debrief",
  "Case study practise",
  "Interview feedback session",
  "Superday dry run",
  "Interview rehearsal",
  "Interview tips webinar",
  "Prepping for Goldman interview",
  "Case study practicing",
  "Superday recap",
];

for (const title of IS_PREPARATION) {
  test(`"${title}" is preparation, not an interview`, () => {
    // Prompting somebody to prepare for their preparation is how a prompt
    // teaches people to ignore prompts.
    assert.ok(!looksLikeInterview(title));
  });
}

test("the notes are read too, when the title says nothing", () => {
  assert.ok(looksLikeInterview("Evercore", "Final round with the team"));
});

test("a title that rules it out rules it out, whatever the notes say", () => {
  assert.ok(!looksLikeInterview("Mock interview", "Superday format, full technicals"));
});

test("notes that rule it out rule it out too", () => {
  assert.ok(!looksLikeInterview("Evercore interview", "This is a practice run"));
});

test("matching is case-insensitive", () => {
  assert.ok(looksLikeInterview("EVERCORE SUPERDAY"));
  assert.ok(looksLikeInterview("evercore superday"));
});

test("an interview word inside a longer word does not count", () => {
  assert.ok(!looksLikeInterview("Interviewing skills reading"), "interviewing is not an interview");
  assert.ok(!looksLikeInterview("Interstate travel"));
});

test("an empty title says nothing", () => {
  assert.ok(!looksLikeInterview(""));
  assert.ok(!looksLikeInterview("", null));
});

// ---------- the intervals ----------

test("the intervals are the three agreed days, widest first", () => {
  assert.deepEqual([...PREP_INTERVALS], [7, 3, 1]);
});

function expectedInterval(days: number): number | null {
  if (days < 0 || days > 7) return null;
  if (days <= 1) return 1;
  if (days <= 3) return 3;
  return 7;
}

for (let days = -2; days <= 10; days++) {
  test(`${days} days out sits in prep interval ${expectedInterval(days) ?? "none"}`, () => {
    assert.equal(prepIntervalFor(days), expectedInterval(days));
  });
}

test("a day between two thresholds keeps the wider one", () => {
  assert.equal(prepIntervalFor(5), 7);
  assert.equal(prepIntervalFor(2), 3);
});

for (const days of [0, 1, 2, 3, 5, 7]) {
  test(`an interview ${days} days out is prompted, at interval ${expectedInterval(days)}`, () => {
    const [nudge] = prep([event({ eventDate: at(days) })]);
    assert.ok(nudge, "should prompt");
    assert.equal(nudge.interval, expectedInterval(days));
    assert.equal(nudge.daysUntil, days);
  });
}

for (const days of [8, 9, 14, 30]) {
  test(`an interview ${days} days out is too far ahead to prompt`, () => {
    assert.deepEqual(prep([event({ eventDate: at(days) })]), []);
  });
}

test("an interview that has already happened is not prompted", () => {
  assert.deepEqual(prep([event({ eventDate: at(-1) })]), []);
});

test("an interview later today still counts", () => {
  const [nudge] = prep([event({ eventDate: new Date(NOW.getTime() + 3 * 3_600_000) })]);
  assert.ok(nudge);
  assert.equal(nudge.daysUntil, 1, "rounded up, so it never reads as zero days left");
});

// ---------- which events qualify ----------

test("an event the student filed as an interview counts whatever it is called", () => {
  const [nudge] = prep([event({ title: "Chat with the team", type: "interview" })]);
  assert.ok(nudge, "their own filing beats the detector");
});

test("a completed event is behind them", () => {
  assert.deepEqual(prep([event({ completed: true })]), []);
});

test("an ordinary meeting is left alone", () => {
  assert.deepEqual(prep([event({ title: "Coffee chat with Dana" })]), []);
});

test("several interviews come back soonest first", () => {
  const nudges = prep([
    event({ id: "late", title: "Lazard final round", eventDate: at(6) }),
    event({ id: "soon", title: "Evercore superday", eventDate: at(1) }),
  ]);
  assert.deepEqual(
    nudges.map((n) => n.eventId),
    ["soon", "late"],
  );
});

test("two interviews on the same day are ordered by title, not by luck", () => {
  const nudges = prep([
    event({ id: "z", title: "Zeta interview", eventDate: at(2) }),
    event({ id: "a", title: "Alpha interview", eventDate: at(2) }),
  ]);
  assert.deepEqual(
    nudges.map((n) => n.eventId),
    ["a", "z"],
  );
});

// ---------- which firm it names ----------
//
// Only for the wording ("Practise for Blackstone"). The firm no longer picks a
// question bank: the prompt opens the practice page with no sector chosen.

const FIRMS: TrackedFirms = new Map([
  ["evercore", { name: "Evercore" }],
  ["blackstone", { name: "Blackstone" }],
  ["bank of america", { name: "Bank of America" }],
]);

test("the firm named in the title is the one the prompt names", () => {
  const [nudge] = prep([event({ title: "Blackstone final round" })], FIRMS);
  assert.equal(nudge.firmName, "Blackstone");
});

test("a firm written differently still resolves", () => {
  const [nudge] = prep([event({ title: "BAML superday - NYC" })], FIRMS);
  assert.equal(nudge.firmName, "Bank of America");
});

test("a firm the student does not track still gets a prompt, without a name", () => {
  const [nudge] = prep([event({ title: "Rothschild interview" })], FIRMS);
  assert.equal(nudge.firmName, null);
});

test("the prompt picks no sector, whatever firm it names", () => {
  const [nudge] = prep([event({ title: "Blackstone final round" })], FIRMS);
  assert.ok(!("quizCategory" in nudge), "a sector guess is exactly what this removed");
});

test("a firm name inside a longer word is not a match", () => {
  const firms: TrackedFirms = new Map([["citi", { name: "Citi" }]]);
  const [nudge] = prep([event({ title: "Citadel interview" })], firms);
  assert.equal(nudge.firmName, null);
});

test("the longer firm name wins when one contains the other", () => {
  // Deliberately not BAML vs Bank of America: the firm normaliser treats those
  // as one employer on purpose, so they can never be two keys here.
  const firms: TrackedFirms = new Map([
    ["evercore", { name: "Evercore" }],
    ["evercore wealth management", { name: "Evercore Wealth Management" }],
  ]);
  const [nudge] = prep([event({ title: "Evercore Wealth Management final round" })], firms);
  assert.equal(nudge.firmName, "Evercore Wealth Management");
});

test("the prompt carries the calendar's own words", () => {
  const [nudge] = prep([event({ title: "Evercore | Superday - Round 2" })], FIRMS);
  assert.equal(nudge.title, "Evercore | Superday - Round 2");
});

test("the prompt carries the date it is counting down to", () => {
  const [nudge] = prep([event({ eventDate: at(3) })]);
  assert.equal(nudge.startsAt.getTime(), at(3).getTime());
});

// ---------- where it sends them ----------

test("the link opens the practice page with no sector chosen", () => {
  assert.equal(prepHref(), "/learn");
  assert.equal(PREP_HREF, "/learn");
  assert.ok(!prepHref().includes("?"), "no ?category=, so nothing is preselected");
});

// ---------- practice quiets the countdown ----------


function prepWith(
  events: Parameters<typeof selectInterviewPrep>[0]["events"],
  practice: { at: Date }[],
  now: Date = NOW,
  timeZone = "America/New_York",
) {
  return selectInterviewPrep({
    events,
    practice,
    timeZone,
    now,
  });
}

test("a round inside the week quiets the countdown", () => {
  const out = prepWith([event({ eventDate: at(3) })], [{ at: at(-1) }]);
  assert.deepEqual(out, []);
});

test("a round in any sector counts - the student chose it, not us", () => {
  // Rounds carry no sector here at all: which desk they practised is theirs to
  // decide, so any round is the job done.
  const out = prepWith([event({ eventDate: at(3) })], [{ at: at(-1) }]);
  assert.deepEqual(out, []);
});

test("a round from before the interview came within a week does not count", () => {
  const out = prepWith([event({ eventDate: at(3) })], [{ at: at(-5) }]);
  assert.equal(out.length, 1, "practice ten days before the interview is not prep for it");
});

// ---------- the refresher ----------

// 22 Sep 2026 is EDT, UTC-4.
const NY = "America/New_York";

test("an afternoon interview is refreshed at 8am that day", () => {
  const starts = new Date("2026-09-25T18:00:00Z"); // 2pm NY
  assert.equal(refresherAt(starts, NY).toISOString(), "2026-09-25T12:00:00.000Z"); // 8am NY
});

test("a morning interview is refreshed at 6pm the evening before", () => {
  const starts = new Date("2026-09-25T13:00:00Z"); // 9am NY
  assert.equal(refresherAt(starts, NY).toISOString(), "2026-09-24T22:00:00.000Z"); // 6pm NY the 24th
});

test("11:59 is still the morning, noon is not", () => {
  assert.equal(
    refresherAt(new Date("2026-09-25T15:59:00Z"), NY).toISOString(),
    "2026-09-24T22:00:00.000Z",
  );
  assert.equal(
    refresherAt(new Date("2026-09-25T16:00:00Z"), NY).toISOString(),
    "2026-09-25T12:00:00.000Z",
  );
});

test("morning is the student's morning, not the server's", () => {
  // 9am in Los Angeles is 4pm UTC - afternoon to a UTC server.
  const starts = new Date("2026-09-25T16:00:00Z");
  assert.equal(refresherAt(starts, "America/Los_Angeles").toISOString(), "2026-09-25T01:00:00.000Z");
});

test("the night before the first of the month lands on the last day of the last one", () => {
  const starts = new Date("2026-10-01T13:00:00Z"); // 9am NY, 1 Oct
  assert.equal(refresherAt(starts, NY).toISOString(), "2026-09-30T22:00:00.000Z");
});

test("the refresher fires even after earlier practice", () => {
  const starts = new Date("2026-09-25T18:00:00Z"); // 2pm NY
  const now = new Date("2026-09-25T13:00:00Z"); // 9am NY, after the 8am refresher
  const out = prepWith([event({ eventDate: starts })], [
    { at: new Date("2026-09-23T15:00:00Z") },
  ], now);
  assert.equal(out.length, 1);
  assert.equal(out[0].phase, "refresh");
  assert.equal(out[0].dayLabel, "today");
});

test("a round after the refresher starts quiets it", () => {
  const starts = new Date("2026-09-25T18:00:00Z");
  const now = new Date("2026-09-25T15:00:00Z");
  const out = prepWith([event({ eventDate: starts })], [
    { at: new Date("2026-09-25T13:30:00Z") },
  ], now);
  assert.deepEqual(out, []);
});

test("before the refresher starts it is still the countdown", () => {
  const starts = new Date("2026-09-25T18:00:00Z"); // 2pm NY
  const now = new Date("2026-09-25T02:00:00Z"); // 10pm NY the night before
  const out = prepWith([event({ eventDate: starts })], [], now);
  assert.equal(out[0].phase, "prep");
  assert.equal(out[0].dayLabel, "tomorrow");
});

test("a morning interview's refresher speaks the evening before, as tomorrow", () => {
  const starts = new Date("2026-09-25T13:00:00Z"); // 9am NY
  const now = new Date("2026-09-24T23:00:00Z"); // 7pm NY the night before
  const out = prepWith([event({ eventDate: starts })], [], now);
  assert.equal(out[0].phase, "refresh");
  assert.equal(out[0].dayLabel, "tomorrow");
});

test("an interview that has started is over, refresher or not", () => {
  const starts = new Date("2026-09-25T18:00:00Z");
  const out = prepWith([event({ eventDate: starts })], [], new Date("2026-09-25T18:01:00Z"));
  assert.deepEqual(out, []);
});

test("calendar days count dates on the student's clock, not 24-hour blocks", () => {
  // 11pm and 1am the next day in NY: one day apart, two hours apart.
  assert.equal(
    calendarDaysBetween(new Date("2026-09-25T03:00:00Z"), new Date("2026-09-25T05:00:00Z"), NY),
    1,
  );
});

test("an informational interview is networking, not an interview", () => {
  assert.ok(!looksLikeInterview("Informational interview with Dana Reed"));
});
