// The cold-email ladder: first email, a follow-up a week later, one more a week
// after that, then stop - and stop early the moment they reply.
//
// The failures worth guarding against are the ones a student would feel: a
// follow-up prompted before a week has passed, a fourth email, a prompt to
// chase someone who already replied, and a contact ticked "reached out" before
// the ladder existed being treated as never written to.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FOLLOW_UP_AFTER_DAYS,
  MAX_EMAILS,
  REPEAT_EVERY_DAYS,
  daysOverdue,
  followUpHref,
  followUpSubjectKey,
  ladderState,
  ordinal,
  parseFollowUpSubject,
  repeatRound,
} from "../../src/lib/outreach-ladder";

const DAY = 86_400_000;
const NOW = new Date("2026-09-22T15:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const fresh = { relationshipStatus: "not_contacted", lastContactDate: null };
const reached = { relationshipStatus: "reached_out", lastContactDate: null };
const sent = (step: number, daysAgo: number, source = "copy") => ({
  step,
  sentAt: ago(daysAgo),
  source,
});

// ---------- the numbers ----------

test("a follow-up comes due after a week", () => {
  assert.equal(FOLLOW_UP_AFTER_DAYS, 7);
});

test("three emails, then stop", () => {
  assert.equal(MAX_EMAILS, 3);
});

test("prompts repeat every other day", () => {
  assert.equal(REPEAT_EVERY_DAYS, 2);
});

// ---------- where a contact stands ----------

test("never written to is not contacted, and the next email is the first", () => {
  const s = ladderState(fresh, [], NOW);
  assert.equal(s.stage, "not_contacted");
  assert.equal(s.nextStep, 1);
  assert.equal(s.dueAt, null);
});

for (const days of [0, 1, 3, 6]) {
  test(`one email ${days} days ago is still waiting`, () => {
    const s = ladderState(reached, [sent(1, days)], NOW);
    assert.equal(s.stage, "waiting");
    assert.equal(s.nextStep, 2);
  });
}

for (const days of [7, 8, 12, 30]) {
  test(`one email ${days} days ago with no reply makes the 2nd email due`, () => {
    const s = ladderState(reached, [sent(1, days)], NOW);
    assert.equal(s.stage, "due");
    assert.equal(s.nextStep, 2);
  });
}

test("the clock runs from the LATEST email, not the first", () => {
  const s = ladderState(reached, [sent(1, 20), sent(2, 3)], NOW);
  assert.equal(s.stage, "waiting");
  assert.equal(s.nextStep, 3);
  assert.equal(s.dueAt?.getTime(), ago(3).getTime() + 7 * DAY);
});

test("the third email due a week after the second", () => {
  const s = ladderState(reached, [sent(1, 20), sent(2, 9)], NOW);
  assert.equal(s.stage, "due");
  assert.equal(s.nextStep, 3);
});

test("after three emails the ladder is finished - there is no fourth", () => {
  const s = ladderState(reached, [sent(1, 40), sent(2, 30), sent(3, 20)], NOW);
  assert.equal(s.stage, "finished");
  assert.equal(s.nextStep, null);
  assert.equal(s.dueAt, null);
});

test("a reply stops everything, however overdue the next email was", () => {
  const s = ladderState(
    { relationshipStatus: "in_conversation", lastContactDate: null },
    [sent(1, 30)],
    NOW,
  );
  assert.equal(s.stage, "replied");
  assert.equal(s.nextStep, null);
});

test("an ongoing relationship counts as replied too", () => {
  assert.equal(
    ladderState({ relationshipStatus: "ongoing", lastContactDate: null }, [sent(1, 30)], NOW).stage,
    "replied",
  );
});

test("a contact the student marked cold is finished, not due", () => {
  assert.equal(
    ladderState({ relationshipStatus: "cold", lastContactDate: null }, [sent(1, 30)], NOW).stage,
    "finished",
  );
});

test("emails are read in rung order whatever order they arrive in", () => {
  const s = ladderState(reached, [sent(2, 2), sent(1, 12)], NOW);
  assert.deepEqual(
    s.sends.map((x) => x.step),
    [1, 2],
  );
  assert.equal(s.nextStep, 3);
});

test("a rung outside 1-3 is ignored rather than trusted", () => {
  const s = ladderState(reached, [sent(1, 10), sent(9, 1)], NOW);
  assert.equal(s.stage, "due");
  assert.equal(s.nextStep, 2);
});

// ---------- contacts from before the ladder ----------

test("ticked 'reached out' with no recorded email reads as email 1 on that date", () => {
  const s = ladderState({ relationshipStatus: "reached_out", lastContactDate: "2026-09-01" }, [], NOW);
  assert.equal(s.sends.length, 1);
  assert.equal(s.sends[0].source, "legacy");
  assert.equal(s.stage, "due", "three weeks ago, so a follow-up is owed");
});

test("a legacy contact with no date falls back to when the row last changed", () => {
  const s = ladderState(
    { relationshipStatus: "reached_out", lastContactDate: null, updatedAt: ago(2) },
    [],
    NOW,
  );
  assert.equal(s.stage, "waiting");
});

test("a legacy contact with nothing to date from is not invented a send", () => {
  const s = ladderState({ relationshipStatus: "reached_out", lastContactDate: null }, [], NOW);
  assert.equal(s.stage, "not_contacted");
});

test("recorded emails win over the legacy reading", () => {
  const s = ladderState(
    { relationshipStatus: "reached_out", lastContactDate: "2026-08-01" },
    [sent(1, 2)],
    NOW,
  );
  assert.equal(s.sends.length, 1);
  assert.equal(s.sends[0].source, "copy");
  assert.equal(s.stage, "waiting");
});

// ---------- how often it speaks ----------

test("a new stretch starts every two days", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(repeatRound),
    [0, 0, 1, 1, 2, 2],
  );
});

test("a negative count is the first stretch, never an earlier one", () => {
  assert.equal(repeatRound(-3), 0);
});

test("overdue is whole days and never negative", () => {
  assert.equal(daysOverdue(ago(0.5), NOW), 0);
  assert.equal(daysOverdue(ago(3.2), NOW), 3);
  assert.equal(daysOverdue(new Date(NOW.getTime() + DAY), NOW), 0);
});

// ---------- where the prompts point ----------

test("the 2nd email opens the first follow-up", () => {
  assert.equal(
    followUpHref("abc", 2),
    "/outreach?contact=abc&occasion=follow_up&box=follow.first",
  );
});

test("the 3rd email opens the final follow-up", () => {
  assert.equal(
    followUpHref("abc", 3),
    "/outreach?contact=abc&occasion=follow_up&box=follow.final",
  );
});

test("a follow-up's bell subject round-trips", () => {
  const id = "0f8b1c3e-1111-4222-8333-444455556666";
  assert.deepEqual(parseFollowUpSubject(followUpSubjectKey(id, 2)), { contactId: id, step: 2 });
});

test("other subjects are not mistaken for a follow-up", () => {
  assert.equal(parseFollowUpSubject("evercore"), null);
  assert.equal(parseFollowUpSubject("quiz:investment_banking"), null);
});

test("ordinals read the way the table says them", () => {
  assert.deepEqual([1, 2, 3].map(ordinal), ["1st", "2nd", "3rd"]);
});
