// The deadline a posting states in its own words.
//
// The bug: 117 active postings carried a sentence like "Application
// Deadline:15 Nov 2026 11:55 PM EST" in their description, and every one was
// filed deadlineStatus "tbd". The Top applications panel parsed that sentence
// and rendered a countdown; the Internships tab read the column and said
// "Deadline TBD". Same posting, two screens, two answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deadlineFromPostingText,
  deadlineColumnsFromText,
} from "../../src/lib/posting-deadline";

const iso = (d: Date) => d.toISOString().slice(0, 10);

test("the Evercore sentence, exactly as stored", () => {
  const d = deadlineFromPostingText(
    "Title:2028 Strategic Advisory: Mergers & Acquisitions Summer Analyst Program – Menlo Park Healthcare Application Deadline:15 Nov 2026 11:55 PM EST Job description",
  );
  assert.ok(d);
  assert.equal(iso(d.date), "2026-11-15");
  assert.equal(d.timeText, "11:55 PM EST");
});

test("a weekday prefix and a full month name are read", () => {
  // PJT Partners' wording, which the old TalentLink-only regex missed.
  const d = deadlineFromPostingText("Application Deadline: Sunday 4 October 2026");
  assert.ok(d);
  assert.equal(iso(d.date), "2026-10-04");
  assert.equal(d.timeText, null);
});

test("a date with no year is refused rather than guessed", () => {
  // Inferring the year from the recruiting cycle is exactly the kind of
  // derived date this codebase keeps taking out.
  assert.equal(deadlineFromPostingText("Application Deadline: Sunday 4 October"), null);
});

test("a per-region list of deadlines is not a deadline", () => {
  assert.equal(
    deadlineFromPostingText(
      "Application Deadlines (by school regions): Sunday 20 September 2026 (France) Sunday 27 September 2026 (UK)",
    ),
    null,
  );
});

test("two different stated deadlines is refused", () => {
  assert.equal(
    deadlineFromPostingText(
      "Application Deadline: 4 October 2026 ... elsewhere ... Application Deadline: 11 October 2026",
    ),
    null,
  );
});

test("the same date stated twice is fine - TalentLink prints it in the title and the body", () => {
  const d = deadlineFromPostingText(
    "Application Deadline:15 Nov 2026 Job description ... Application Deadline:15 Nov 2026 11:55 PM EST",
  );
  assert.ok(d);
  assert.equal(iso(d.date), "2026-11-15");
  // The occurrence carrying a time wins, whichever order they appear in.
  assert.equal(d.timeText, "11:55 PM EST");
});

test("a posting that states nothing stays silent", () => {
  assert.equal(deadlineFromPostingText("Ten weeks in the New York office."), null);
  assert.equal(deadlineFromPostingText(null), null);
  assert.equal(deadlineFromPostingText(""), null);
});

test("a deadline still ahead is confirmed; one that has passed is closed", () => {
  const text = "Application Deadline:15 Nov 2026 11:55 PM EST";
  const before = deadlineColumnsFromText(text, new Date("2026-09-22T00:00:00Z"));
  assert.equal(before?.deadlineStatus, "confirmed");
  const after = deadlineColumnsFromText(text, new Date("2027-01-01T00:00:00Z"));
  assert.equal(after?.deadlineStatus, "closed");
});

test("the deadline's own day is not treated as already gone", () => {
  // Midnight UTC on the 15th is the STORED value; a student reading it at
  // lunchtime on the 15th still has until 11:55 that evening.
  const onTheDay = deadlineColumnsFromText(
    "Application Deadline:15 Nov 2026 11:55 PM EST",
    new Date("2026-11-15T12:00:00Z"),
  );
  assert.equal(onTheDay?.deadlineStatus, "confirmed");
});

test("the stored date stays midnight UTC", () => {
  // Every consumer of a deadline in this codebase assumes it; a true instant
  // would shift the rendered day for anyone west of UTC.
  const d = deadlineFromPostingText("Application Deadline:15 Nov 2026 11:55 PM EST");
  assert.equal(d?.date.toISOString(), "2026-11-15T00:00:00.000Z");
});
