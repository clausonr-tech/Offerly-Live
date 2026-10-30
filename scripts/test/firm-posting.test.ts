// What a firm may post: the portal's forms, parsed and checked. No database.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanUrl,
  composeDescription,
  originalDescription,
  parseEventForm,
  parseLocalDateTime,
  parsePostingForm,
  postingLanguageFields,
} from "../../src/lib/firm-posting-rules";

const NOW = new Date("2026-09-23T12:00:00Z");

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

const GOOD_POSTING: [string, string][] = [
  ["roleTitle", "2027 IB Summer Analyst"],
  ["categories", "investment_banking"],
  ["categories", "real_estate"],
  ["programYear", "2027"],
  ["eligibleGradYears", "2028"],
  ["deadlineMode", "rolling"],
  ["applicationUrl", "https://careers.example.com/apply"],
  ["description", "Ten weeks on a live deal team in New York, with modeling training in week one."],
  ["extraLabel", "Seats"],
  ["extraValue", "12"],
  ["tzOffset", "240"],
];

test("a complete posting parses, keeping every sector and the firm's own details", () => {
  const r = parsePostingForm(form(GOOD_POSTING), NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.value.categories, ["investment_banking", "real_estate"]);
  assert.equal(r.value.programYear, 2027);
  assert.deepEqual(r.value.eligibleGradYears, [2028]);
  assert.equal(r.value.deadlineStatus, "rolling");
  assert.deepEqual(r.value.extraFields, [{ label: "Seats", value: "12" }]);
});

test("the fields matching depends on are required", () => {
  const without = (key: string) => GOOD_POSTING.filter(([k]) => k !== key);
  for (const key of ["roleTitle", "categories", "programYear", "description"]) {
    const r = parsePostingForm(form(without(key)), NOW);
    assert.equal(r.ok, false, `missing ${key}`);
  }
  // Neither a link nor an email: no way to apply.
  assert.equal(parsePostingForm(form(without("applicationUrl")), NOW).ok, false);
  const emailOnly = [...without("applicationUrl"), ["recruiterEmail", "campus@example.com"] as [string, string]];
  assert.equal(parsePostingForm(form(emailOnly), NOW).ok, true);
});

test("unknown sectors and years outside the window are refused", () => {
  const bad = GOOD_POSTING.map(([k, v]): [string, string] => (k === "categories" ? [k, "astrology"] : [k, v]));
  assert.equal(parsePostingForm(form(bad), NOW).ok, false);
  const year = GOOD_POSTING.map(([k, v]): [string, string] => (k === "programYear" ? [k, "2035"] : [k, v]));
  assert.equal(parsePostingForm(form(year), NOW).ok, false);
});

test("only http(s) links are accepted", () => {
  assert.equal(cleanUrl("javascript:alert(1)"), null);
  assert.equal(cleanUrl("data:text/html,hi"), null);
  assert.equal(cleanUrl("careers.example.com"), null);
  assert.equal(cleanUrl("https://example.com/a"), "https://example.com/a");
  const js = GOOD_POSTING.map(([k, v]): [string, string] => (k === "applicationUrl" ? [k, "javascript:alert(1)"] : [k, v]));
  assert.equal(parsePostingForm(form(js), NOW).ok, false);
});

test("an extra detail needs both halves", () => {
  const half = [...GOOD_POSTING, ["extraLabel", "Pay"] as [string, string], ["extraValue", ""] as [string, string]];
  assert.equal(parsePostingForm(form(half), NOW).ok, false);
});

test("a set deadline is the end of that day in the poster's time zone", () => {
  const dated = GOOD_POSTING.map(([k, v]): [string, string] => (k === "deadlineMode" ? [k, "date"] : [k, v]));
  const r = parsePostingForm(form([...dated, ["deadlineDate", "2026-11-15"]]), NOW);
  assert.ok(r.ok);
  assert.equal(r.value.deadlineStatus, "confirmed");
  // 23:59 in New York (UTC-4, offset 240) is 03:59Z the next day.
  assert.equal(r.value.deadlineDate?.toISOString(), "2026-11-16T03:59:00.000Z");
});

test("local date-times are stored as the instant the poster meant", () => {
  assert.equal(parseLocalDateTime("2026-10-14T18:30", 240)?.toISOString(), "2026-10-14T22:30:00.000Z");
  assert.equal(parseLocalDateTime("2026-10-14T18:30", -60)?.toISOString(), "2026-10-14T17:30:00.000Z");
  assert.equal(parseLocalDateTime("not a date", 0), null);
});

test("the description students read carries the extra details, and the edit form gets the original back", () => {
  const extra = [{ label: "Seats", value: "12" }, { label: "Start", value: "June" }];
  const full = composeDescription("The role.", extra);
  assert.equal(full, "The role.\n\nAdditional details\nSeats: 12\nStart: June");
  assert.equal(originalDescription(full, extra), "The role.");
  assert.equal(originalDescription("Edited by hand.", extra), "Edited by hand.");
  assert.equal(composeDescription("Just this.", []), "Just this.");
});

test("every typed word is handed to the language check, extra details included", () => {
  const r = parsePostingForm(form(GOOD_POSTING), NOW);
  assert.ok(r.ok);
  const values = postingLanguageFields(r.value).map(([, v]) => v);
  assert.ok(values.includes("Seats") && values.includes("12"));
  assert.ok(values.includes(r.value.description));
});

const GOOD_EVENT: [string, string][] = [
  ["kind", "speaker_event"],
  ["title", "Life on a deal team"],
  ["schoolIds", "00000000-0000-4000-8000-000000000001"],
  ["startsAt", "2026-10-14T18:30"],
  ["format", "in_person"],
  ["location", "Huntsman Hall"],
  ["description", "Two analysts on their summer."],
  ["tzOffset", "240"],
];

test("an event is for picked schools, or explicitly open to everyone", () => {
  const r = parseEventForm(form(GOOD_EVENT), NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.value.schoolIds, ["00000000-0000-4000-8000-000000000001"]);
  const none = GOOD_EVENT.filter(([k]) => k !== "schoolIds");
  assert.equal(parseEventForm(form(none), NOW).ok, false);
  const open = parseEventForm(form([...none, ["openToAll", "on"]]), NOW);
  assert.ok(open.ok);
  assert.deepEqual(open.value.schoolIds, []);
  // Open to all wins over any stray picks.
  const both = parseEventForm(form([...GOOD_EVENT, ["openToAll", "on"]]), NOW);
  assert.ok(both.ok);
  assert.deepEqual(both.value.schoolIds, []);
});

test("an event needs a future start, an end after it, and a place unless virtual", () => {
  const set = (key: string, value: string) => GOOD_EVENT.map(([k, v]): [string, string] => (k === key ? [k, value] : [k, v]));
  assert.equal(parseEventForm(form(set("startsAt", "2026-01-01T10:00")), NOW).ok, false);
  assert.equal(parseEventForm(form([...GOOD_EVENT, ["endsAt", "2026-10-14T17:00"]]), NOW).ok, false);
  const noPlace = GOOD_EVENT.filter(([k]) => k !== "location");
  assert.equal(parseEventForm(form(noPlace), NOW).ok, false);
  const virtual = noPlace.map(([k, v]): [string, string] => (k === "format" ? [k, "virtual"] : [k, v]));
  assert.equal(parseEventForm(form(virtual), NOW).ok, true);
  assert.equal(parseEventForm(form(set("kind", "party")), NOW).ok, false);
});
