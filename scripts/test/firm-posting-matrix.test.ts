// The portal's two forms, field by field and limit by limit. No database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanUrl,
  composeDescription,
  eventLanguageFields,
  LIMITS,
  originalDescription,
  parseEventForm,
  parseLocalDateTime,
  parsePostingForm,
  postingLanguageFields,
  POSTING_CATEGORIES,
  programYearChoices,
} from "../../src/lib/firm-posting-rules";

const NOW = new Date("2026-09-23T12:00:00Z");

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}
const set = (base: [string, string][], key: string, value: string | null): [string, string][] => {
  const without = base.filter(([k]) => k !== key);
  return value === null ? without : [...without, [key, value]];
};

const POSTING: [string, string][] = [
  ["roleTitle", "2027 IB Summer Analyst"],
  ["categories", "investment_banking"],
  ["programYear", "2027"],
  ["deadlineMode", "rolling"],
  ["applicationUrl", "https://example.com/apply"],
  ["description", "x".repeat(LIMITS.descriptionMin)],
  ["tzOffset", "0"],
];

describe("posting: every required field", () => {
  const required: [string, RegExp][] = [
    ["roleTitle", /role title/i],
    ["categories", /sector/i],
    ["programYear", /summer/i],
    ["description", /at least/i],
  ];
  for (const [key, message] of required) {
    test(`missing ${key} is refused with a message that says what to add`, () => {
      const r = parsePostingForm(form(set(POSTING, key, null)), NOW);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, message);
    });
    test(`${key} of only spaces counts as missing`, () => {
      assert.equal(parsePostingForm(form(set(POSTING, key, "   ")), NOW).ok, false);
    });
  }
});

describe("posting: limits, at the edge and one past it", () => {
  const limits: [string, number][] = [
    ["roleTitle", LIMITS.title],
    ["location", LIMITS.location],
    ["description", LIMITS.description],
    ["requirements", LIMITS.requirements],
    ["recruiterName", LIMITS.name],
    ["recruiterTitle", LIMITS.name],
  ];
  for (const [key, max] of limits) {
    test(`${key}: ${max} characters is fine`, () => {
      assert.equal(parsePostingForm(form(set(POSTING, key, "a".repeat(max))), NOW).ok, true);
    });
    test(`${key}: ${max + 1} characters is refused`, () => {
      assert.equal(parsePostingForm(form(set(POSTING, key, "a".repeat(max + 1))), NOW).ok, false);
    });
  }
  test(`description: ${LIMITS.descriptionMin - 1} characters is too short`, () => {
    assert.equal(parsePostingForm(form(set(POSTING, "description", "a".repeat(LIMITS.descriptionMin - 1))), NOW).ok, false);
  });
});

describe("posting: sectors", () => {
  for (const c of POSTING_CATEGORIES) {
    test(`${c} is a valid sector`, () => {
      const r = parsePostingForm(form(set(POSTING, "categories", c)), NOW);
      assert.ok(r.ok);
      assert.deepEqual(r.value.categories, [c]);
    });
  }
  test("duplicates collapse and unknown values are dropped", () => {
    const r = parsePostingForm(
      form([...set(POSTING, "categories", null), ["categories", "hedge_fund"], ["categories", "hedge_fund"], ["categories", "crypto"]]),
      NOW,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.value.categories, ["hedge_fund"]);
  });
});

describe("posting: which summer, and who may apply", () => {
  for (const y of programYearChoices(NOW)) {
    test(`Summer ${y} can be posted`, () => {
      assert.equal(parsePostingForm(form(set(POSTING, "programYear", String(y))), NOW).ok, true);
    });
  }
  for (const y of ["2025", "2031", "abc", "2027.5", ""]) {
    test(`Summer "${y}" is refused`, () => {
      assert.equal(parsePostingForm(form(set(POSTING, "programYear", y)), NOW).ok, false);
    });
  }
  test("class years outside the plausible range are dropped, the rest kept in order", () => {
    const r = parsePostingForm(
      form([...POSTING, ["eligibleGradYears", "2029"], ["eligibleGradYears", "2028"], ["eligibleGradYears", "1999"], ["eligibleGradYears", "x"]]),
      NOW,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.value.eligibleGradYears, [2028, 2029]);
  });
});

describe("posting: how to apply", () => {
  const urls: [string, boolean][] = [
    ["https://example.com/apply", true],
    ["http://example.com/apply", true],
    ["javascript:alert(1)", false],
    ["JAVASCRIPT:alert(1)", false],
    ["data:text/html;base64,PHNjcmlwdD4=", false],
    ["ftp://example.com/x", false],
    ["//example.com/x", false],
    ["/relative/path", false],
    ["example.com", false],
    ["mailto:a@b.com", false],
  ];
  for (const [url, ok] of urls) {
    test(`application link ${url} is ${ok ? "accepted" : "refused"}`, () => {
      assert.equal(parsePostingForm(form(set(POSTING, "applicationUrl", url)), NOW).ok, ok);
      assert.equal(cleanUrl(url) !== null, ok);
    });
  }
  const emails: [string, boolean][] = [
    ["campus@example.com", true],
    ["first.last@bank.co.uk", true],
    ["not an email", false],
    ["a@b", false],
    ["@example.com", false],
  ];
  for (const [email, ok] of emails) {
    test(`contact email ${email} alone is ${ok ? "enough" : "refused"}`, () => {
      const f = set(set(POSTING, "applicationUrl", null), "recruiterEmail", email);
      assert.equal(parsePostingForm(form(f), NOW).ok, ok);
    });
  }
});

describe("posting: deadlines", () => {
  const dated = (d: string, tz = "0") => set(set(set(POSTING, "deadlineMode", "date"), "deadlineDate", d), "tzOffset", tz);
  test("a set deadline needs a date", () => {
    assert.equal(parsePostingForm(form(set(POSTING, "deadlineMode", "date")), NOW).ok, false);
  });
  test("rolling needs none", () => {
    const r = parsePostingForm(form(POSTING), NOW);
    assert.ok(r.ok);
    assert.equal(r.value.deadlineStatus, "rolling");
    assert.equal(r.value.deadlineDate, null);
  });
  test("not set yet is tbd", () => {
    const r = parsePostingForm(form(set(POSTING, "deadlineMode", "tbd")), NOW);
    assert.ok(r.ok);
    assert.equal(r.value.deadlineStatus, "tbd");
  });
  test("an unknown mode is tbd, never a guess", () => {
    const r = parsePostingForm(form(set(POSTING, "deadlineMode", "whenever")), NOW);
    assert.ok(r.ok);
    assert.equal(r.value.deadlineStatus, "tbd");
  });
  for (const bad of ["2026-02-31", "2026-13-01", "2026-00-10", "2026-04-31", "26-11-15", "2026/11/15"]) {
    test(`an impossible or malformed date (${bad}) is refused, not rolled over`, () => {
      assert.equal(parsePostingForm(form(dated(bad)), NOW).ok, false);
    });
  }
  test("a leap day in a leap year is fine", () => {
    assert.equal(parsePostingForm(form(dated("2028-02-29")), NOW).ok, true);
  });
  const zones: [string, string][] = [
    ["0", "2026-11-15T23:59:00.000Z"],
    ["240", "2026-11-16T03:59:00.000Z"], // New York, daylight time
    ["-60", "2026-11-15T22:59:00.000Z"], // Central Europe
    ["-330", "2026-11-15T18:29:00.000Z"], // India
  ];
  for (const [tz, iso] of zones) {
    test(`a deadline of 15 Nov means 23:59 in the poster's zone (offset ${tz})`, () => {
      const r = parsePostingForm(form(dated("2026-11-15", tz)), NOW);
      assert.ok(r.ok);
      assert.equal(r.value.deadlineDate?.toISOString(), iso);
    });
  }
  for (const tz of ["abc", "99999", "-99999", ""]) {
    test(`a nonsense time-zone offset (${tz || "empty"}) cannot move the date by more than a day`, () => {
      const r = parsePostingForm(form(dated("2026-11-15", tz)), NOW);
      assert.ok(r.ok);
      const drift = Math.abs(r.value.deadlineDate!.getTime() - Date.parse("2026-11-15T23:59:00Z"));
      assert.ok(drift <= 14 * 60 * 60 * 1000, `moved ${drift / 3_600_000}h`);
    });
  }
});

describe("posting: the firm's own details", () => {
  const pairs = (n: number): [string, string][] =>
    Array.from({ length: n }, (_, i) => [
      ["extraLabel", `Label ${i}`],
      ["extraValue", `Value ${i}`],
    ]).flat() as [string, string][];
  test(`${LIMITS.extraFields} details are fine`, () => {
    const r = parsePostingForm(form([...POSTING, ...pairs(LIMITS.extraFields)]), NOW);
    assert.ok(r.ok);
    assert.equal(r.value.extraFields.length, LIMITS.extraFields);
  });
  test(`${LIMITS.extraFields + 1} are too many`, () => {
    assert.equal(parsePostingForm(form([...POSTING, ...pairs(LIMITS.extraFields + 1)]), NOW).ok, false);
  });
  test("an empty row is skipped, not refused", () => {
    const r = parsePostingForm(form([...POSTING, ["extraLabel", ""], ["extraValue", ""]]), NOW);
    assert.ok(r.ok);
    assert.deepEqual(r.value.extraFields, []);
  });
  for (const [label, value] of [
    ["Pay", ""],
    ["", "$100k"],
  ]) {
    test(`half a detail ("${label}" / "${value}") is refused`, () => {
      assert.equal(parsePostingForm(form([...POSTING, ["extraLabel", label], ["extraValue", value]]), NOW).ok, false);
    });
  }
  test(`a label over ${LIMITS.extraLabel} or a value over ${LIMITS.extraValue} characters is refused`, () => {
    assert.equal(parsePostingForm(form([...POSTING, ["extraLabel", "a".repeat(LIMITS.extraLabel + 1)], ["extraValue", "v"]]), NOW).ok, false);
    assert.equal(parsePostingForm(form([...POSTING, ["extraLabel", "L"], ["extraValue", "a".repeat(LIMITS.extraValue + 1)]]), NOW).ok, false);
  });
  test("round trip: what the edit form shows is what the firm wrote", () => {
    for (const extra of [[], [{ label: "Seats", value: "12" }], [{ label: "A", value: "1" }, { label: "B", value: "two\nlines" }]]) {
      const desc = "The role, in the firm's words.\n\nWith a second paragraph.";
      assert.equal(originalDescription(composeDescription(desc, extra), extra), desc);
    }
  });
  test("every typed word reaches the language check, detail labels included", () => {
    const r = parsePostingForm(
      form([
        ...set(POSTING, "location", "Midtown"),
        ["requirements", "Reqs"],
        ["recruiterName", "Pat"],
        ["recruiterTitle", "Campus lead"],
        ["extraLabel", "Perk"],
        ["extraValue", "Lunch"],
      ]),
      NOW,
    );
    assert.ok(r.ok);
    const values = postingLanguageFields(r.value).map(([, v]) => v);
    for (const w of ["2027 IB Summer Analyst", "Midtown", "Reqs", "Pat", "Campus lead", "Perk", "Lunch"]) assert.ok(values.includes(w), w);
  });
});

const EVENT: [string, string][] = [
  ["kind", "info_session"],
  ["title", "Meet the team"],
  ["schoolIds", "00000000-0000-4000-8000-000000000001"],
  ["startsAt", "2026-10-14T18:30"],
  ["format", "in_person"],
  ["location", "Room 1"],
  ["description", "An hour with the team."],
  ["tzOffset", "0"],
];

describe("event form", () => {
  for (const kind of ["info_session", "speaker_event", "coffee_chat", "networking", "other"]) {
    test(`${kind} is a kind of event`, () => {
      // "Other event" also asks what kind it is (the kindLabel box).
      const fields = kind === "other" ? set(set(EVENT, "kind", kind), "kindLabel", "Case competition") : set(EVENT, "kind", kind);
      assert.equal(parseEventForm(form(fields), NOW).ok, true);
    });
  }
  for (const key of ["title", "startsAt", "description", "kind", "format"]) {
    test(`missing ${key} is refused`, () => {
      assert.equal(parseEventForm(form(set(EVENT, key, null)), NOW).ok, false);
    });
  }
  for (const format of ["in_person", "hybrid"]) {
    test(`${format} needs a place`, () => {
      assert.equal(parseEventForm(form(set(set(EVENT, "format", format), "location", null)), NOW).ok, false);
    });
  }
  test("virtual needs none", () => {
    assert.equal(parseEventForm(form(set(set(EVENT, "format", "virtual"), "location", null)), NOW).ok, true);
  });
  test("school ids that are not ids are dropped", () => {
    const r = parseEventForm(form([...EVENT, ["schoolIds", "'; drop table schools; --"], ["schoolIds", "penn"]]), NOW);
    assert.ok(r.ok);
    assert.deepEqual(r.value.schoolIds, ["00000000-0000-4000-8000-000000000001"]);
  });
  test(`${LIMITS.eventSchools} schools are fine, one more is too many`, () => {
    const ids = (n: number): [string, string][] =>
      Array.from({ length: n }, (_, i) => ["schoolIds", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`]);
    assert.equal(parseEventForm(form([...set(EVENT, "schoolIds", null), ...ids(LIMITS.eventSchools)]), NOW).ok, true);
    assert.equal(parseEventForm(form([...set(EVENT, "schoolIds", null), ...ids(LIMITS.eventSchools + 1)]), NOW).ok, false);
  });
  test("a start in the past is refused for a new event", () => {
    assert.equal(parseEventForm(form(set(EVENT, "startsAt", "2026-09-01T10:00")), NOW).ok, false);
  });
  test("a start in the past is fine when editing an event that already happened", () => {
    assert.equal(parseEventForm(form(set(EVENT, "startsAt", "2026-09-01T10:00")), NOW, { editing: true }).ok, true);
  });
  test("an end before or at the start is refused", () => {
    assert.equal(parseEventForm(form([...EVENT, ["endsAt", "2026-10-14T18:30"]]), NOW).ok, false);
    assert.equal(parseEventForm(form([...EVENT, ["endsAt", "2026-10-14T18:00"]]), NOW).ok, false);
    assert.equal(parseEventForm(form([...EVENT, ["endsAt", "2026-10-14T19:30"]]), NOW).ok, true);
  });
  test("an impossible date is refused, not rolled over", () => {
    assert.equal(parseEventForm(form(set(EVENT, "startsAt", "2026-11-31T18:30")), NOW).ok, false);
    assert.equal(parseEventForm(form(set(EVENT, "startsAt", "2026-10-14T25:00")), NOW).ok, false);
  });
  test("RSVP links are http(s) only", () => {
    assert.equal(parseEventForm(form([...EVENT, ["rsvpUrl", "javascript:alert(1)"]]), NOW).ok, false);
    const r = parseEventForm(form([...EVENT, ["rsvpUrl", "https://example.com/rsvp"]]), NOW);
    assert.ok(r.ok);
    assert.equal(r.value.rsvpUrl, "https://example.com/rsvp");
  });
  test(`a description over ${LIMITS.eventDescription} characters is refused`, () => {
    assert.equal(parseEventForm(form(set(EVENT, "description", "a".repeat(LIMITS.eventDescription + 1))), NOW).ok, false);
  });
  test("the language check sees the title, place and description", () => {
    const r = parseEventForm(form(EVENT), NOW);
    assert.ok(r.ok);
    assert.deepEqual(eventLanguageFields(r.value).map(([, v]) => v), ["Meet the team", "Room 1", "An hour with the team."]);
  });
});

describe("local date-time parsing", () => {
  const cases: [string, number, string | null][] = [
    ["2026-10-14T18:30", 0, "2026-10-14T18:30:00.000Z"],
    ["2026-10-14T00:00", 0, "2026-10-14T00:00:00.000Z"],
    ["2026-10-14T23:59", 0, "2026-10-14T23:59:00.000Z"],
    ["2026-10-14", 0, "2026-10-14T12:00:00.000Z"],
    ["2026-12-31T23:30", -60, "2026-12-31T22:30:00.000Z"],
    ["2026-10-14T24:00", 0, null],
    ["2026-10-14T12:60", 0, null],
    ["2026-02-29", 0, null],
    [" 2026-10-14T18:30 ", 0, "2026-10-14T18:30:00.000Z"],
    ["2026-10-14T18:30:00", 0, null],
  ];
  for (const [value, off, expected] of cases) {
    test(`${JSON.stringify(value)} at offset ${off} -> ${expected ?? "refused"}`, () => {
      assert.equal(parseLocalDateTime(value, off)?.toISOString() ?? null, expected);
    });
  }
});
