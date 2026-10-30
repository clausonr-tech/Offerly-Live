import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generatedDetail,
  generatedFlashKey,
  generatedNotificationKey,
  generatedTitle,
  peopleLine,
  unreachedByFirm,
  type ContactRow,
} from "@/lib/generated-reminders";
import { normalizeFirmName } from "@/lib/firm-name";

const now = new Date("2026-09-24T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const resolve = (raw: string) => normalizeFirmName(raw);

function row(over: Partial<ContactRow> & { name: string }): ContactRow {
  return { id: `id-${over.name}`, firm: "PJT Partners", enrichedAt: daysAgo(4), relationshipStatus: "not_contacted", ...over };
}

test("nothing before three days", () => {
  assert.deepEqual(unreachedByFirm([row({ name: "Jane Doe", enrichedAt: daysAgo(2) })], resolve, now), []);
});

test("three days on, the firm's reminder names the firm and lists who is left, first found first", () => {
  const [f] = unreachedByFirm(
    [
      row({ name: "Sam Lee", enrichedAt: daysAgo(3) }),
      row({ name: "Jane Doe", enrichedAt: daysAgo(5) }),
      // Saved by hand, never emailed: counted among the others, never the lead.
      row({ name: "Pat Kim", enrichedAt: null }),
    ],
    resolve,
    now,
  );
  assert.equal(f.lead.name, "Jane Doe");
  assert.equal(f.others, 2);
  assert.equal(f.stage, 1);
  assert.deepEqual(f.people, ["Jane Doe", "Sam Lee", "Pat Kim"], "the lead, the rest found, then anyone saved by hand");
  assert.equal(generatedTitle(f), "Email 3 people at PJT Partners");
  assert.equal(generatedDetail(f), "Jane Doe, Sam Lee and Pat Kim");
});

test("seven days is the second and last stage, with its own bubble but the same job", () => {
  const [early] = unreachedByFirm([row({ name: "Jane Doe", enrichedAt: daysAgo(4) })], resolve, now);
  const [late] = unreachedByFirm([row({ name: "Jane Doe", enrichedAt: daysAgo(9) })], resolve, now);
  assert.equal(late.stage, 2);
  assert.notEqual(generatedFlashKey(early), generatedFlashKey(late));
  assert.equal(generatedNotificationKey(early.firmKey), generatedNotificationKey(late.firmKey));
  assert.equal(generatedTitle(late), "Email Jane Doe at PJT Partners", "one person left: named, with the firm");
  assert.equal(generatedDetail(late), "You found them 9 days ago");
});

test("written to - on either saved copy of the same person - means no reminder", () => {
  assert.deepEqual(
    unreachedByFirm([row({ name: "Jane Doe", relationshipStatus: "reached_out" })], resolve, now),
    [],
  );
  assert.deepEqual(
    unreachedByFirm(
      [row({ name: "Jane Doe" }), row({ id: "copy", name: "jane doe ", enrichedAt: null, relationshipStatus: "replied" })],
      resolve,
      now,
    ),
    [],
  );
});

test("one reminder per firm, oldest wait first", () => {
  const out = unreachedByFirm(
    [row({ name: "Jane Doe", enrichedAt: daysAgo(4) }), row({ name: "Ann Park", firm: "Evercore", enrichedAt: daysAgo(6) })],
    resolve,
    now,
  );
  assert.deepEqual(out.map((f) => f.firmName), ["Evercore", "PJT Partners"]);
});

test("a long list names four people and counts the rest", () => {
  assert.equal(peopleLine(["A One", "B Two"]), "A One and B Two");
  assert.equal(peopleLine(["A One", "B Two", "C Three", "D Four", "E Five", "F Six"]), "A One, B Two, C Three, D Four and 2 more");
  assert.equal(peopleLine(["A One", "B Two", "C Three", "D Four"]), "A One, B Two, C Three and D Four");
});

test("the same person saved twice is listed once", () => {
  const [f] = unreachedByFirm(
    [row({ name: "Jane Doe", enrichedAt: daysAgo(5) }), row({ id: "copy", name: "jane doe ", enrichedAt: null }), row({ name: "Sam Lee" })],
    resolve,
    now,
  );
  assert.deepEqual(f.people, ["Jane Doe", "Sam Lee"]);
  assert.equal(f.others, 1);
});
