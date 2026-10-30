// The estimated opening dates, and the promise the file makes about them.
//
// These six dates are LATE bounds - the first day the Internet Archive
// happened to capture a posting that was already live - and the UI renders
// them to students as "est." A date that silently drifts by a day, or lands
// in the wrong year, is a student told the wrong week to apply.
//
// The arithmetic is one line, which is exactly why it had no tests and
// exactly why it is worth pinning: a single-line date calculation in local
// time is the classic way to be off by one for half the world.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OBSERVED_OPENINGS,
  estimatedOpening,
  type ObservedOpening,
} from "../../src/lib/monitoring/observed-openings";

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ------------------------------------------------------- the data itself

test("there is at least one observation, or the feature is dead code", () => {
  assert.ok(OBSERVED_OPENINGS.length > 0);
});

for (const o of OBSERVED_OPENINGS) {
  test(`${o.firmSlug}: the record is well formed`, () => {
    assert.match(o.observedAt, /^\d{4}-\d{2}-\d{2}$/, "observedAt must be a plain ISO date");
    assert.ok(Number.isInteger(o.cycleYear), "cycleYear must be a year");
    assert.ok(o.cycleYear >= 2020 && o.cycleYear <= 2100, `implausible cycle ${o.cycleYear}`);
    assert.ok(o.evidence.trim().length > 0, "an unevidenced claim is not checkable");
    assert.match(o.firmSlug, /^[a-z0-9-]+$/, "slug should be a slug");
  });

  test(`${o.firmSlug}: the sighting parses to the date it says`, () => {
    const parsed = new Date(`${o.observedAt}T00:00:00Z`);
    assert.ok(!Number.isNaN(parsed.getTime()));
    assert.equal(iso(parsed), o.observedAt, "a date that does not round-trip is a typo");
  });

  test(`${o.firmSlug}: the sighting is in the past, as a late bound must be`, () => {
    // "Already live on this day" cannot be a date in the future.
    assert.ok(new Date(`${o.observedAt}T00:00:00Z`).getTime() < Date.now(), o.observedAt);
  });

  test(`${o.firmSlug}: the sighting precedes the cycle it is for`, () => {
    // A 2026 programme is recruited during 2025. A sighting dated after the
    // cycle year would mean the record describes something else.
    assert.ok(
      Number(o.observedAt.slice(0, 4)) <= o.cycleYear,
      `${o.observedAt} is not before cycle ${o.cycleYear}`,
    );
  });
}

test("no firm appears twice", () => {
  // The lookup map keeps the LAST entry silently, so a duplicate would
  // override an earlier observation with no warning.
  const slugs = OBSERVED_OPENINGS.map((o) => o.firmSlug);
  assert.equal(new Set(slugs).size, slugs.length, `duplicate slug in ${slugs.join(", ")}`);
});

// -------------------------------------------------------- the arithmetic

const sample: ObservedOpening = OBSERVED_OPENINGS[0];

test("asking for the observed cycle returns the observed date unchanged", () => {
  const got = estimatedOpening(sample.firmSlug, sample.cycleYear);
  assert.ok(got);
  assert.equal(iso(got.date), sample.observedAt);
});

for (const o of OBSERVED_OPENINGS) {
  test(`${o.firmSlug}: the next cycle keeps the same month and day`, () => {
    // The stated rule: same calendar date, moved by however many cycles
    // separate the observation from the question.
    const got = estimatedOpening(o.firmSlug, o.cycleYear + 1);
    assert.ok(got);
    const [, month, day] = o.observedAt.split("-");
    assert.equal(iso(got.date).slice(5), `${month}-${day}`);
    assert.equal(iso(got.date).slice(0, 4), String(Number(o.observedAt.slice(0, 4)) + 1));
  });
}

const offsets = [-3, -2, -1, 0, 1, 2, 3, 5, 10];
for (const n of offsets) {
  test(`shifting by ${n} cycle(s) shifts the year by exactly ${n}`, () => {
    const got = estimatedOpening(sample.firmSlug, sample.cycleYear + n);
    assert.ok(got);
    const expectedYear = Number(sample.observedAt.slice(0, 4)) + n;
    assert.equal(got.date.getUTCFullYear(), expectedYear);
    assert.equal(iso(got.date).slice(5), sample.observedAt.slice(5));
  });
}

test("the answer carries the observation it was derived from", () => {
  // So a student-facing estimate can always be traced to a checkable record.
  const got = estimatedOpening(sample.firmSlug, sample.cycleYear + 1);
  assert.ok(got);
  assert.equal(got.basedOn.firmSlug, sample.firmSlug);
  assert.ok(got.basedOn.evidence.length > 0);
});

// ------------------------------------------------------------ time zones

test("the date is built in UTC, so it does not move with the reader", () => {
  // THE reason this file is tested. `new Date(y, m, d)` would place midnight
  // in the server's zone, and rendering it anywhere west of it shows the
  // previous day - an estimate a day early, every time, for some students.
  const got = estimatedOpening(sample.firmSlug, sample.cycleYear);
  assert.ok(got);
  assert.equal(got.date.getUTCHours(), 0);
  assert.equal(got.date.getUTCMinutes(), 0);
  assert.equal(got.date.getUTCSeconds(), 0);
  assert.equal(got.date.getUTCMilliseconds(), 0);
});

test("every estimate lands on UTC midnight", () => {
  for (const o of OBSERVED_OPENINGS) {
    for (const n of [0, 1, 2]) {
      const got = estimatedOpening(o.firmSlug, o.cycleYear + n);
      assert.ok(got);
      assert.equal(got.date.getTime() % 86_400_000, 0, `${o.firmSlug}+${n} is not a whole day`);
    }
  }
});

// ---------------------------------------------------------- not knowing

const unknown = ["", "not-a-firm", "MORGAN-STANLEY", "morgan stanley", "goldman-sachs"];
for (const slug of unknown) {
  test(`an unobserved firm returns null, not a guess: ${JSON.stringify(slug)}`, () => {
    assert.equal(estimatedOpening(slug, 2027), null);
  });
}

test("slugs are matched exactly, not loosely", () => {
  // Case-insensitive or fuzzy matching here would attribute one firm's
  // observed date to another firm's students.
  assert.equal(estimatedOpening(sample.firmSlug.toUpperCase(), 2027), null);
  assert.equal(estimatedOpening(` ${sample.firmSlug}`, 2027), null);
});

for (const bad of [null, undefined]) {
  test(`a missing target cycle returns null rather than today: ${bad}`, () => {
    assert.equal(estimatedOpening(sample.firmSlug, bad), null);
  });
}

test("estimatedOpening never throws", () => {
  const inputs: (number | null | undefined)[] = [0, -1, 1, 9999, 2027, null, undefined, NaN];
  for (const slug of [...unknown, ...OBSERVED_OPENINGS.map((o) => o.firmSlug)]) {
    for (const year of inputs) {
      assert.doesNotThrow(() => estimatedOpening(slug, year), `${slug} / ${year}`);
    }
  }
});

test("a NaN cycle year yields null rather than an Invalid Date", () => {
  // Returning a Date whose getTime() is NaN would render as "Invalid Date"
  // in the UI rather than simply being absent.
  const got = estimatedOpening(sample.firmSlug, NaN);
  assert.ok(got === null || !Number.isNaN(got.date.getTime()));
});

test("an absurd cycle year does not produce a silently wrong date", () => {
  for (const year of [-5000, 500000]) {
    const got = estimatedOpening(sample.firmSlug, year);
    assert.ok(got === null || !Number.isNaN(got.date.getTime()), `year ${year}`);
  }
});

// ---------------------------------------------------------- consistency

test("every observation can be turned into an estimate", () => {
  // A record the lookup cannot reach is a record that does nothing.
  for (const o of OBSERVED_OPENINGS) {
    assert.ok(estimatedOpening(o.firmSlug, o.cycleYear), o.firmSlug);
  }
});

test("estimates move forward in time as the cycle does", () => {
  for (const o of OBSERVED_OPENINGS) {
    let previous = -Infinity;
    for (const n of [0, 1, 2, 3]) {
      const got = estimatedOpening(o.firmSlug, o.cycleYear + n);
      assert.ok(got);
      assert.ok(got.date.getTime() > previous, `${o.firmSlug} cycle +${n} went backwards`);
      previous = got.date.getTime();
    }
  }
});

test("the same question twice gives the same answer", () => {
  // No hidden dependence on the current date.
  for (const o of OBSERVED_OPENINGS) {
    const a = estimatedOpening(o.firmSlug, o.cycleYear + 1);
    const b = estimatedOpening(o.firmSlug, o.cycleYear + 1);
    assert.equal(a!.date.getTime(), b!.date.getTime());
  }
});
