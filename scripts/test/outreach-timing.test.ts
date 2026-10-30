// When each of the two outreach surfaces speaks.
//
// They do different jobs and the difference is the whole design. The FLASH
// interrupts - a bubble across the top of the page - so it speaks at most once
// every two days, and only while there is still someone at that firm to write
// to. The TO-DO ROW does not interrupt, so it stands on the Opportunities list
// from two weeks out for as long as the work is outstanding. The failures to
// guard against are a flash that fires on every page, and a to-do row that
// disappears while there is still time to act.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FLASH_WINDOW_DAYS,
  TODO_WINDOW_DAYS,
  REPEAT_EVERY_DAYS,
  dayFlashKey,
  dayKey,
  flashDueToday,
  flashKey,
  flashPrefix,
  nextFlash,
  selectOutreachNudges,
  todoNudges,
  type OutreachNudge,
} from "../../src/lib/application-outreach";
import { outreachTaskScore } from "../../src/lib/today-tasks";
import { NOW, daysOut, nudgesFor, opening, person } from "./outreach-fixtures";

// NOW on the student's clock (the default zone, New York): 08:00 on the 22nd.
const TODAY = "2026-09-22";

/** An opening as it is stored: a calendar date at midnight UTC. */
function openingDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** Nothing flashed yet. */
const NONE: ReadonlyMap<string, string> = new Map();

// ---------- the two windows ----------

test("the flash looks a month ahead", () => {
  assert.equal(FLASH_WINDOW_DAYS, 30);
});

test("the to-do row looks two weeks ahead", () => {
  assert.equal(TODO_WINDOW_DAYS, 14);
});

test("the flash window is the wider of the two, so the heads-up comes first", () => {
  assert.ok(FLASH_WINDOW_DAYS > TODO_WINDOW_DAYS);
});

for (let days = 1; days <= 30; days++) {
  test(`${days} days out is inside the selection window`, () => {
    assert.equal(nudgesFor([opening({ date: daysOut(days) })], [person()]).length, 1);
  });
}

for (const days of [31, 32, 45, 60, 90, 365]) {
  test(`${days} days out is too far ahead to say anything`, () => {
    assert.deepEqual(nudgesFor([opening({ date: daysOut(days) })], [person()]), []);
  });
}

for (const days of [-1, -2, -7, -30, -365]) {
  test(`an opening ${Math.abs(days)} days in the past is over, not "today"`, () => {
    assert.deepEqual(nudgesFor([opening({ date: daysOut(days) })], [person()]), []);
  });
}

test("the day it opens is not inside the window: writing ahead of it is over", () => {
  assert.deepEqual(nudgesFor([opening({ date: daysOut(0) })], [person()]), []);
});

// The window's edges are calendar days on the student's clock, whatever the
// hour: 23:30 in New York is already the next day in UTC.
const LATE_EVENING = new Date("2026-09-23T03:30:00Z"); // 23:30 on the 22nd in New York

test("31 calendar days out is outside the window, even late in the evening", () => {
  assert.deepEqual(
    nudgesFor([opening({ date: openingDate("2026-10-23") })], [person()], LATE_EVENING),
    [],
  );
});

test("30 calendar days out is inside it, even late in the evening", () => {
  const nudges = nudgesFor([opening({ date: openingDate("2026-10-22") })], [person()], LATE_EVENING);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].daysUntilOpen, 30);
});

test("an opening tomorrow still counts at 23:59 the evening before", () => {
  // Stored at midnight UTC, which is already behind 23:59 in New York as an
  // instant: counted as an instant it vanished at 8pm the evening before.
  const nudges = nudgesFor(
    [opening({ date: openingDate("2026-09-23") })],
    [person()],
    new Date("2026-09-23T03:59:00Z"),
  );
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].daysUntilOpen, 1, "one calendar day, never zero");
});

test("an opening one minute ago is gone", () => {
  assert.deepEqual(
    nudgesFor([opening({ date: new Date(NOW.getTime() - 60_000) })], [person()]),
    [],
  );
});

for (let days = 1; days <= 30; days++) {
  test(`the prompt at ${days} days reports ${days} days left`, () => {
    assert.equal(
      nudgesFor([opening({ date: daysOut(days) })], [person()])[0].daysUntilOpen,
      days,
    );
  });
}

test("the countdown is whole calendar days, by the opening's date", () => {
  const nudges = nudgesFor(
    [opening({ date: new Date(NOW.getTime() + 13.5 * 86_400_000) })],
    [person()],
  );
  assert.equal(nudges[0].daysUntilOpen, 14);
});

// ---------- what reaches the to-do list ----------

for (let days = 1; days <= 30; days++) {
  const onList = days <= TODO_WINDOW_DAYS;
  test(`${days} days out ${onList ? "is" : "is not"} on the to-do list`, () => {
    const nudges = nudgesFor([opening({ date: daysOut(days) })], [person()]);
    assert.equal(todoNudges(nudges).length, onList ? 1 : 0);
  });
}

test("a firm between the two windows flashes but does not join the list yet", () => {
  const nudges = nudgesFor([opening({ date: daysOut(27) })], [person()]);
  assert.equal(nudges.length, 1, "it is selected");
  assert.deepEqual(todoNudges(nudges), [], "but it is not work for this fortnight");
  assert.ok(nextFlash(nudges, NONE, TODAY), "it is worth a heads-up");
});

test("a firm inside two weeks is both on the list and flashable", () => {
  const nudges = nudgesFor([opening({ date: daysOut(9) })], [person()]);
  assert.equal(todoNudges(nudges).length, 1);
  assert.ok(nextFlash(nudges, NONE, TODAY));
});

test("the to-do row survives right up to the day it opens", () => {
  const nudges = nudgesFor([opening({ date: daysOut(1) })], [person()]);
  assert.equal(todoNudges(nudges).length, 1);
  // ...through the last minute of the evening before, on the student's clock.
  const lastMinute = nudgesFor(
    [opening({ date: openingDate("2026-09-23") })],
    [person()],
    new Date("2026-09-23T03:59:00Z"),
  );
  assert.equal(todoNudges(lastMinute).length, 1);
  // On the day itself it is open, and the row has done its job.
  assert.deepEqual(todoNudges(nudgesFor([opening({ date: daysOut(0) })], [person()])), []);
});

test("the to-do list keeps every firm inside two weeks, not just the first", () => {
  const nudges = nudgesFor(
    [
      opening({ firmName: "Evercore", date: daysOut(4) }),
      opening({ firmName: "Lazard", date: daysOut(11) }),
      opening({ firmName: "Moelis", date: daysOut(13) }),
      opening({ firmName: "Centerview", date: daysOut(26) }),
    ],
    [
      person({ id: "a", firm: "Evercore" }),
      person({ id: "b", firm: "Lazard" }),
      person({ id: "c", firm: "Moelis" }),
      person({ id: "d", firm: "Centerview" }),
    ],
  );
  assert.deepEqual(
    todoNudges(nudges).map((n) => n.firmName),
    ["Evercore", "Lazard", "Moelis"],
  );
});

test("the to-do list does not reorder what the selector already sorted", () => {
  const nudges = nudgesFor(
    [
      opening({ firmName: "Lazard", date: daysOut(11) }),
      opening({ firmName: "Evercore", date: daysOut(4) }),
    ],
    [person({ id: "a", firm: "Evercore" }), person({ id: "b", firm: "Lazard" })],
  );
  assert.deepEqual(
    todoNudges(nudges).map((n) => n.daysUntilOpen),
    [4, 11],
  );
});

// ---------- the flash repeats every other day ----------

function nudge(over: Partial<OutreachNudge> = {}): OutreachNudge {
  return {
    firmKey: "evercore",
    firmName: "Evercore",
    contactFirmQuery: "Evercore",
    firmSlug: "evercore",
    firmWebsite: "evercore.com",
    cycleLabel: "Summer 2028",
    opensOn: daysOut(27),
    daysUntilOpen: 27,
    contacts: [{ id: "c1", name: "Dana Reed", role: "Analyst" }],
    ...over,
  };
}

/** When each opening last flashed, as prompt-flash reads it back. */
function shownOn(...entries: [firmKey: string, opensOn: Date, day: string][]): ReadonlyMap<string, string> {
  return new Map(entries.map(([firm, opensOn, day]) => [flashPrefix(firm, opensOn), day]));
}

test("a firm never flashed before flashes", () => {
  assert.equal(nextFlash([nudge()], NONE, TODAY)?.firmName, "Evercore");
});

test("a firm already flashed today does not flash again today", () => {
  const seen = shownOn(["evercore", daysOut(27), TODAY]);
  assert.equal(nextFlash([nudge()], seen, TODAY), null);
});

test("a firm flashed yesterday does not flash again today", () => {
  const seen = shownOn(["evercore", daysOut(27), "2026-09-21"]);
  assert.equal(nextFlash([nudge()], seen, TODAY), null);
});

test("two days later the same firm flashes again", () => {
  const seen = shownOn(["evercore", daysOut(27), TODAY]);
  const later = nudge({ daysUntilOpen: 25 });
  assert.equal(nextFlash([later], seen, "2026-09-24")?.firmName, "Evercore");
});

test("the day after, it is not due: a day apart is never enough to fire twice", () => {
  assert.equal(REPEAT_EVERY_DAYS, 2);
  assert.equal(flashDueToday(TODAY, TODAY), false);
  assert.equal(flashDueToday("2026-09-21", TODAY), false);
  assert.equal(flashDueToday("2026-09-20", TODAY), true);
  assert.equal(flashDueToday("2026-09-01", TODAY), true);
});

test("the rhythm counts from the last firing, not from a grid 30 days out", () => {
  // A firm that first appears 29 days out fires that day, and next two days
  // later - never 28 days out, the day after.
  assert.equal(flashDueToday(undefined, "2026-09-23"), true, "first seen: fires that day");
  assert.equal(flashDueToday("2026-09-23", "2026-09-24"), false, "not the next day");
  assert.equal(flashDueToday("2026-09-23", "2026-09-25"), true, "two days later");
});

test("the gap is calendar days, across a month and a year end", () => {
  assert.equal(flashDueToday("2026-09-30", "2026-10-01"), false);
  assert.equal(flashDueToday("2026-09-30", "2026-10-02"), true);
  assert.equal(flashDueToday("2026-12-31", "2027-01-01"), false);
  assert.equal(flashDueToday("2026-12-31", "2027-01-02"), true);
});

test("nothing to say means no flash", () => {
  assert.equal(nextFlash([], NONE, TODAY), null);
});

test("one flash at a time, the most urgent first", () => {
  const flash = nextFlash(
    [nudge({ firmKey: "lazard", firmName: "Lazard", daysUntilOpen: 5 }), nudge()],
    NONE,
    TODAY,
  );
  assert.equal(flash?.firmName, "Lazard");
});

test("the second firm waits its turn rather than stacking", () => {
  const first = nextFlash(
    [nudge({ firmKey: "lazard", firmName: "Lazard", daysUntilOpen: 5 }), nudge()],
    NONE,
    TODAY,
  )!;
  const afterFirst = nextFlash(
    [nudge({ firmKey: "lazard", firmName: "Lazard", daysUntilOpen: 5 }), nudge()],
    shownOn([first.firmKey, first.opensOn, TODAY]),
    TODAY,
  );
  assert.equal(afterFirst?.firmName, "Evercore");
});

test("a flash seen for one firm does not silence another", () => {
  const seen = shownOn(["lazard", daysOut(27), TODAY]);
  assert.equal(nextFlash([nudge()], seen, TODAY)?.firmName, "Evercore");
});

test("a flash seen for a different opening at the same firm does not silence this one", () => {
  // Next year's application is a new thing to be told about.
  const seen = shownOn(["evercore", daysOut(400), TODAY]);
  assert.equal(nextFlash([nudge()], seen, TODAY)?.firmName, "Evercore");
});

test("the record is per firm, per opening AND per day it fired", () => {
  assert.notEqual(dayFlashKey("evercore", "2026-10-01", TODAY), dayFlashKey("evercore", "2027-10-01", TODAY));
  assert.notEqual(dayFlashKey("evercore", "2026-10-01", TODAY), dayFlashKey("lazard", "2026-10-01", TODAY));
  assert.notEqual(dayFlashKey("evercore", "2026-10-01", TODAY), dayFlashKey("evercore", "2026-10-01", "2026-09-24"));
});

test("the older round keys, still read back from past rows, are per firm, per opening and per stretch", () => {
  assert.notEqual(flashKey("evercore", "2026-10-01", 1), flashKey("evercore", "2027-10-01", 1));
  assert.notEqual(flashKey("evercore", "2026-10-01", 1), flashKey("lazard", "2026-10-01", 1));
  assert.notEqual(flashKey("evercore", "2026-10-01", 1), flashKey("evercore", "2026-10-01", 2));
  assert.ok(flashKey("evercore", "2026-10-01", 1).startsWith(flashPrefix("evercore", "2026-10-01")));
});

test("every firing of one opening shares its prefix, and no other opening's", () => {
  const key = dayFlashKey("evercore", "2026-10-01", TODAY);
  assert.equal(key, `${flashPrefix("evercore", "2026-10-01")}d${TODAY}`);
  assert.ok(!key.startsWith(flashPrefix("evercore", "2027-10-01")));
  assert.ok(!key.startsWith(flashPrefix("lazard", "2026-10-01")));
});

test("a flash key reads the same from a Date as from the stored string", () => {
  assert.equal(dayFlashKey("evercore", daysOut(27), TODAY), dayFlashKey("evercore", dayKey(daysOut(27)), TODAY));
  assert.equal(flashPrefix("evercore", daysOut(27)), flashPrefix("evercore", dayKey(daysOut(27))));
});

test("every flash carries the count the bar states", () => {
  const flash = nextFlash(
    [nudge({ contacts: [
      { id: "a", name: "Ada Vance", role: null },
      { id: "b", name: "Sam Ito", role: null },
    ] })],
    NONE,
    TODAY,
  );
  assert.equal(flash?.contacts.length, 2);
});

test("a flash carries the filter text its link uses", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "The Goldman Sachs Group, Inc.", date: daysOut(28) })],
    [person({ firm: "Goldman Sachs" })],
  );
  assert.equal(nextFlash(nudges, NONE, TODAY)?.contactFirmQuery, "Goldman Sachs");
});

test("the flash and the to-do row agree about the same firm", () => {
  const nudges = nudgesFor([opening({ date: daysOut(12) })], [person()]);
  const flash = nextFlash(nudges, NONE, TODAY)!;
  const [row] = todoNudges(nudges);
  assert.equal(flash.firmKey, row.firmKey);
  assert.equal(flash.daysUntilOpen, row.daysUntilOpen);
  assert.equal(flash.contacts.length, row.contacts.length);
});

// ---------- dayKey ----------

test("dayKey is the calendar day in UTC", () => {
  assert.equal(dayKey(new Date("2026-09-22T12:00:00Z")), "2026-09-22");
});

test("dayKey holds at the first instant of the day", () => {
  assert.equal(dayKey(new Date("2026-09-22T00:00:00Z")), "2026-09-22");
});

test("dayKey holds at the last instant of the day", () => {
  assert.equal(dayKey(new Date("2026-09-22T23:59:59.999Z")), "2026-09-22");
});

test("dayKey rolls over at midnight UTC and not before", () => {
  assert.equal(dayKey(new Date("2026-09-23T00:00:00Z")), "2026-09-23");
});

test("dayKey survives a leap day", () => {
  assert.equal(dayKey(new Date("2028-02-29T09:00:00Z")), "2028-02-29");
});

test("dayKey survives a year boundary", () => {
  assert.equal(dayKey(new Date("2026-12-31T23:00:00Z")), "2026-12-31");
  assert.equal(dayKey(new Date("2027-01-01T01:00:00Z")), "2027-01-01");
});

test("dayKey is the same string for the same day whatever the time", () => {
  assert.equal(dayKey(new Date("2026-09-22T06:00:00Z")), dayKey(new Date("2026-09-22T21:00:00Z")));
});

test("dayKey round-trips the date the selector counted down from", () => {
  const nudge = nudgesFor([opening({ date: daysOut(10) })], [person()])[0];
  assert.equal(dayKey(nudge.opensOn), dayKey(daysOut(10)));
});

// ---------- how hard the to-do row pushes ----------

for (let days = 0; days <= 14; days++) {
  test(`an opening ${days} days out scores ${50 + (14 - days) * 3}`, () => {
    assert.equal(outreachTaskScore(days), 50 + (14 - days) * 3);
  });
}

test("the score climbs as the opening nears", () => {
  for (let days = 14; days > 0; days--) {
    assert.ok(
      outreachTaskScore(days - 1) > outreachTaskScore(days),
      `score did not climb between ${days} and ${days - 1}`,
    );
  }
});

test("an outreach row never outranks a deadline due today", () => {
  // Deadlines start at 100 and lose 4 a day either side (see getTodayTasks).
  assert.ok(outreachTaskScore(0) < 100);
});

test("an outreach row three days out outranks a written draft waiting to go", () => {
  assert.ok(outreachTaskScore(3) > 55);
});

test("an outreach row two weeks out outranks the coverage suggestions", () => {
  assert.ok(outreachTaskScore(14) > 30);
});

test("an outreach row two weeks out does not outrank a very overdue follow-up", () => {
  assert.ok(outreachTaskScore(14) <= 75);
});

test("the score is clamped rather than running away past the window", () => {
  assert.equal(outreachTaskScore(40), outreachTaskScore(14));
  assert.equal(outreachTaskScore(-5), outreachTaskScore(0));
});
