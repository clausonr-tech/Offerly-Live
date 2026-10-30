// "Other event" asks what kind; that answer is the event's type everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventKindLabel, eventLanguageFields, parseEventForm } from "../../src/lib/firm-posting-rules";

function form(fields: Record<string, string>) {
  const f = new FormData();
  const base = {
    title: "Life on a deal team",
    openToAll: "on",
    startsAt: "2030-10-07T18:30",
    tzOffset: "0",
    format: "in_person",
    location: "Campus career center",
    description: "Two analysts on what a summer on a deal team is really like.",
  };
  for (const [k, v] of Object.entries({ ...base, ...fields })) f.set(k, v);
  return f;
}

test("Other event needs its kind, and keeps it", () => {
  const missing = parseEventForm(form({ kind: "other" }));
  assert.equal(missing.ok, false);
  const ok = parseEventForm(form({ kind: "other", kindLabel: "  Case competition " }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.kindLabel, "Case competition");
});

test("a standard kind ignores any stray kind label", () => {
  const r = parseEventForm(form({ kind: "info_session", kindLabel: "Something" }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.kindLabel, null);
});

test("the typed kind is shown in place of the generic label", () => {
  assert.equal(eventKindLabel("other", "Case competition"), "Case competition");
  assert.equal(eventKindLabel("other", "  "), "Other event");
  assert.equal(eventKindLabel("info_session", "ignored"), "Info session");
});

test("the typed kind goes through the language check", () => {
  const r = parseEventForm(form({ kind: "other", kindLabel: "Case competition" }));
  assert.ok(r.ok && eventLanguageFields(r.value).some(([label]) => label === "Kind of event"));
});
