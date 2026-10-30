// Which firms the pre-application outreach prompt speaks up about.
//
// Both surfaces - the flash across the top of the page and the standing row on
// the Opportunities to-do list - are cut from this one selection, so the two
// ways it can be wrong are both expensive. It can nag, about firms with nobody
// to write to or about openings that are only a guess, or it can stay silent
// through the one month it existed for. Everything below is one of those two
// failures.

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectOutreachNudges } from "../../src/lib/application-outreach";
import {
  NOW,
  daysOut,
  nudgesFor,
  opening,
  person,
  type Application,
  type ContactRow,
} from "./outreach-fixtures";

// ---------- it speaks when it should ----------

test("prompts for a firm with a dated opening and someone to write to", () => {
  const nudges = nudgesFor([opening()], [person()]);
  assert.equal(nudges.length, 1);
});

test("the prompt names the firm as the posting names it", () => {
  assert.equal(nudgesFor([opening({ firmName: "Evercore" })], [person()])[0].firmName, "Evercore");
});

test("the prompt carries the firm's slug", () => {
  assert.equal(nudgesFor([opening()], [person()])[0].firmSlug, "evercore");
});

test("the prompt carries the firm's website", () => {
  assert.equal(nudgesFor([opening()], [person()])[0].firmWebsite, "evercore.com");
});

test("the prompt carries the intake, so a student knows which cycle it is", () => {
  assert.equal(nudgesFor([opening()], [person()])[0].cycleLabel, "Summer 2028");
});

test("the prompt carries the opening date it counted down from", () => {
  assert.equal(nudgesFor([opening()], [person()])[0].opensOn.getTime(), daysOut(14).getTime());
});

test("the prompt carries the normalised firm key", () => {
  assert.equal(nudgesFor([opening()], [person()])[0].firmKey, "evercore");
});

test("the prompt lists the person to write to", () => {
  assert.deepEqual(nudgesFor([opening()], [person()])[0].contacts, [
    { id: "c1", name: "Dana Reed", role: "Analyst" },
  ]);
});

test("a contact's role may be missing without dropping them", () => {
  const nudges = nudgesFor([opening()], [person({ role: null })]);
  assert.equal(nudges[0].contacts[0].role, null);
});

test("an address is not required to be worth writing to", () => {
  // The drafter takes someone whose address is still being chased - that is a
  // deliberate decision in the picker, and dropping them here would quietly
  // overrule it.
  const nudges = nudgesFor([opening()], [person({ email: null })]);
  assert.equal(nudges[0].contacts.length, 1);
});

// ---------- and stays quiet when it should ----------

test("says nothing when the student knows nobody at that firm", () => {
  assert.deepEqual(nudgesFor([opening()], [person({ firm: "Lazard" })]), []);
});

test("says nothing with no contacts at all", () => {
  assert.deepEqual(nudgesFor([opening()], []), []);
});

test("says nothing with no upcoming applications", () => {
  assert.deepEqual(nudgesFor([], [person()]), []);
});

test("says nothing about a firm where everyone has been written to", () => {
  assert.deepEqual(nudgesFor([opening()], [person({ relationshipStatus: "reached_out" })]), []);
});

for (const status of ["reached_out", "in_conversation", "ongoing", "cold"]) {
  test(`a contact who is "${status}" is not someone to cold-email`, () => {
    assert.deepEqual(nudgesFor([opening()], [person({ relationshipStatus: status })]), []);
  });
}

test('only "not_contacted" counts as never written to', () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "a", relationshipStatus: "reached_out" }),
      person({ id: "b", name: "Sam Ito", relationshipStatus: "not_contacted" }),
      person({ id: "c", name: "Ada Vance", relationshipStatus: "ongoing" }),
    ],
  );
  assert.deepEqual(
    nudges[0].contacts.map((c) => c.id),
    ["b"],
  );
});

test("an unrecognised relationship status is treated as already contacted", () => {
  // Fail closed: a status this code does not know is not a licence to prompt.
  assert.deepEqual(nudgesFor([opening()], [person({ relationshipStatus: "archived" })]), []);
});

for (const firm of [null, "", "   ", "\t", "\n"]) {
  test(`a contact whose firm is ${JSON.stringify(firm)} matches nothing`, () => {
    assert.deepEqual(nudgesFor([opening()], [person({ firm })]), []);
  });
}

test("a contact with no firm does not join the firm of the one before it", () => {
  const nudges = nudgesFor(
    [opening()],
    [person({ id: "a" }), person({ id: "b", name: "Nobody", firm: null })],
  );
  assert.deepEqual(
    nudges[0].contacts.map((c) => c.id),
    ["a"],
  );
});

// ---------- what counts as a date worth counting down from ----------

// "estimate" was a fourth value here until the Upcoming panel stopped
// producing estimates at all - see the provenance union in
// lib/upcoming-applications.ts. It is gone from the type, so a test that names
// it no longer compiles; the guarantee it stood for is asserted below through
// "tracked", the remaining provenance that carries no published date.
const PROVENANCES = ["posting", "signal", "tracked"] as const;
const KINDS = ["opens", "due", "undated"] as const;

for (const provenance of PROVENANCES) {
  for (const kind of KINDS) {
    const shouldPrompt = kind === "opens" && (provenance === "posting" || provenance === "signal");
    test(`${kind}/${provenance} ${shouldPrompt ? "prompts" : "stays silent"}`, () => {
      const nudges = nudgesFor(
        [opening({ kind, provenance, date: kind === "undated" ? null : daysOut(14) })],
        [person()],
      );
      assert.equal(nudges.length, shouldPrompt ? 1 : 0);
    });
  }
}

test("a deadline is not an opening, however close it is", () => {
  assert.deepEqual(nudgesFor([opening({ kind: "due", date: daysOut(1) })], [person()]), []);
});

test("a row tracked without any date never produces a countdown", () => {
  // This used to be two tests, the other one covering an "estimate" - a date
  // derived from when a firm's last cycle was seen live rather than from
  // anything the firm published. Estimates no longer reach this code: they
  // were removed from the Upcoming panel outright, because a labelled guess
  // sits in the same list, at the same size, as a real date.
  //
  // The rule they shared is the one that matters and it still holds here: a
  // student who writes to three people because of a date nobody published was
  // misled by us, not by the firm. Only "posting" and "signal" prompt.
  assert.deepEqual(nudgesFor([opening({ provenance: "tracked" })], [person()]), []);
});

test("an opening kind with a null date is skipped rather than throwing", () => {
  assert.doesNotThrow(() => nudgesFor([opening({ date: null })], [person()]));
  assert.deepEqual(nudgesFor([opening({ date: null })], [person()]), []);
});

test("one usable opening still prompts when the others are undated", () => {
  const nudges = nudgesFor(
    [
      opening({ firmName: "Lazard", provenance: "tracked", date: daysOut(2) }),
      opening({ firmName: "Evercore", date: daysOut(10) }),
    ],
    [person(), person({ id: "c2", firm: "Lazard" })],
  );
  assert.deepEqual(
    nudges.map((n) => n.firmName),
    ["Evercore"],
  );
});

// ---------- the window ----------

for (const days of [1, 2, 3, 4, 7, 8, 13, 14, 15, 20, 21, 25, 29, 30]) {
  test(`${days} days before the opening is inside the window`, () => {
    assert.equal(nudgesFor([opening({ date: daysOut(days) })], [person()]).length, 1);
  });
}

test("the day the opening arrives is not inside the window: it is open, and writing ahead is over", () => {
  assert.deepEqual(nudgesFor([opening({ date: daysOut(0) })], [person()]), []);
});

for (const days of [31, 32, 45, 90, 365]) {
  test(`${days} days out is too far to be worth saying`, () => {
    assert.deepEqual(nudgesFor([opening({ date: daysOut(days) })], [person()]), []);
  });
}

for (const days of [-1, -2, -7, -30, -365]) {
  test(`an opening ${Math.abs(days)} days in the past is over, not "today"`, () => {
    // daysUntil() floors at zero elsewhere in the app, which would turn every
    // opening that has already happened into "opens today" forever.
    assert.deepEqual(nudgesFor([opening({ date: daysOut(days) })], [person()]), []);
  });
}

test("an opening tomorrow still prompts one minute before midnight on the student's clock", () => {
  // Openings are calendar dates stored at midnight UTC - by 23:59 in New York
  // that instant is already behind us, but the opening is still tomorrow.
  const nudges = nudgesFor(
    [opening({ date: new Date("2026-09-23T00:00:00Z") })],
    [person()],
    new Date("2026-09-23T03:59:00Z"), // 23:59 on the 22nd in New York
  );
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].daysUntilOpen, 1, "one calendar day, never zero days left");
});

test("an opening one minute ago is gone", () => {
  assert.deepEqual(
    nudgesFor([opening({ date: new Date(NOW.getTime() - 60_000) })], [person()]),
    [],
  );
});

test("the countdown is whole calendar days, by the opening's date", () => {
  const nudges = nudgesFor(
    [opening({ date: new Date(NOW.getTime() + 13.5 * 86_400_000) })],
    [person()],
  );
  assert.equal(nudges[0].daysUntilOpen, 14);
});

test("the day the to-do window starts is still inside the selection window", () => {
  // Selection runs to a month; the to-do list takes the nearer three weeks of
  // it. See outreach-timing.test.ts for the split.
  assert.equal(
    nudgesFor([opening({ date: new Date(NOW.getTime() + 21 * 86_400_000) })], [person()]).length,
    1,
  );
});

// ---------- one prompt per firm ----------

test("two postings at one firm are one prompt", () => {
  const nudges = nudgesFor(
    [opening({ date: daysOut(18) }), opening({ date: daysOut(6) })],
    [person()],
  );
  assert.equal(nudges.length, 1);
});

test("the prompt is built from the soonest of them", () => {
  const nudges = nudgesFor(
    [
      opening({ date: daysOut(18), cycleLabel: "Summer 2028" }),
      opening({ date: daysOut(6), cycleLabel: "Off-cycle 2027" }),
    ],
    [person()],
  );
  assert.equal(nudges[0].daysUntilOpen, 6);
  assert.equal(nudges[0].cycleLabel, "Off-cycle 2027");
});

test("the soonest wins whichever order the postings arrive in", () => {
  const a = opening({ date: daysOut(6), cycleLabel: "Off-cycle 2027" });
  const b = opening({ date: daysOut(18), cycleLabel: "Summer 2028" });
  assert.equal(nudgesFor([a, b], [person()])[0].cycleLabel, "Off-cycle 2027");
  assert.equal(nudgesFor([b, a], [person()])[0].cycleLabel, "Off-cycle 2027");
});

test("two postings opening on the same day settle on one prompt", () => {
  const nudges = nudgesFor(
    [opening({ cycleLabel: "A" }), opening({ cycleLabel: "B" })],
    [person()],
  );
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].cycleLabel, "A", "first one wins rather than flickering between them");
});

test("every un-written-to contact at the firm is on the one row", () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "a", name: "Ada Vance" }),
      person({ id: "b", name: "Sam Ito" }),
      person({ id: "c", name: "Dana Reed" }),
    ],
  );
  assert.equal(nudges[0].contacts.length, 3);
});

test("different firms get their own prompts", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Evercore" }), opening({ firmName: "Lazard", date: daysOut(9) })],
    [person(), person({ id: "c2", firm: "Lazard", email: null })],
  );
  assert.equal(nudges.length, 2);
});

test("soonest firm first", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Evercore", date: daysOut(20) }), opening({ firmName: "Lazard", date: daysOut(4) })],
    [person(), person({ id: "c2", firm: "Lazard" })],
  );
  assert.deepEqual(
    nudges.map((n) => n.firmName),
    ["Lazard", "Evercore"],
  );
});

test("firms opening on the same day are ordered by name, not by luck", () => {
  const nudges = nudgesFor(
    [
      opening({ firmName: "Moelis", firmSlug: "moelis" }),
      opening({ firmName: "Centerview", firmSlug: "centerview" }),
      opening({ firmName: "Lazard", firmSlug: "lazard" }),
    ],
    [
      person({ id: "a", firm: "Moelis" }),
      person({ id: "b", firm: "Centerview" }),
      person({ id: "c", firm: "Lazard" }),
    ],
  );
  assert.deepEqual(
    nudges.map((n) => n.firmName),
    ["Centerview", "Lazard", "Moelis"],
  );
});

test("the same input twice gives the same answer", () => {
  const apps = [opening(), opening({ firmName: "Lazard", date: daysOut(5) })];
  const people = [person(), person({ id: "c2", firm: "Lazard" })];
  assert.deepEqual(nudgesFor(apps, people), nudgesFor(apps, people));
});

test("neither input is mutated", () => {
  const apps: Application[] = [opening(), opening({ firmName: "Lazard", date: daysOut(5) })];
  const people: ContactRow[] = [person(), person({ id: "c2", firm: "Lazard" })];
  const appsBefore = JSON.stringify(apps);
  const peopleBefore = JSON.stringify(people);
  nudgesFor(apps, people);
  assert.equal(JSON.stringify(apps), appsBefore);
  assert.equal(JSON.stringify(people), peopleBefore);
});

test("the contacts on a nudge are a copy, not the caller's objects", () => {
  const rows = [person()];
  const nudges = nudgesFor([opening()], rows);
  nudges[0].contacts[0].name = "Changed";
  assert.equal(rows[0].name, "Dana Reed");
});

test("now defaults to the real clock rather than throwing", () => {
  assert.doesNotThrow(() =>
    selectOutreachNudges({ applications: [opening()], contactRows: [person()] }),
  );
});

// ---------- scale ----------

test("a thousand contacts across fifty firms is still one prompt per firm", () => {
  const apps: Application[] = [];
  const rows: ContactRow[] = [];
  for (let f = 0; f < 50; f++) {
    apps.push(opening({ firmName: `Firm ${f}`, date: daysOut((f % 21) + 1) }));
    for (let c = 0; c < 20; c++) {
      rows.push(person({ id: `f${f}-c${c}`, name: `Person ${f}-${c}`, firm: `Firm ${f}` }));
    }
  }
  const nudges = nudgesFor(apps, rows);
  assert.equal(nudges.length, 50);
  for (const n of nudges) assert.equal(n.contacts.length, 20);
});

test("a firm with one usable opening among many unusable ones still prompts", () => {
  const apps = [
    opening({ provenance: "tracked", date: daysOut(3) }),
    opening({ kind: "due", date: daysOut(4) }),
    opening({ kind: "undated", date: null }),
    opening({ date: daysOut(12) }),
  ];
  const nudges = nudgesFor(apps, [person()]);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].daysUntilOpen, 12, "the undated row's sooner date is not borrowed");
});

test("sorting is stable across a large tie", () => {
  const apps: Application[] = [];
  const rows: ContactRow[] = [];
  for (const name of ["Zeta", "Alpha", "Mu", "Beta"]) {
    apps.push(opening({ firmName: name }));
    rows.push(person({ id: name, firm: name }));
  }
  assert.deepEqual(
    nudgesFor(apps, rows).map((n) => n.firmName),
    ["Alpha", "Beta", "Mu", "Zeta"],
  );
});
