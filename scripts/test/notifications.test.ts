// The list behind the bell.
//
// It is a to-do list wearing a notification's clothes, and the two ways it goes
// wrong are both quiet. It can grow a second row for a job it already has -
// which is how a bell ends up reading "7" for two pieces of work - or it can
// keep asking for something the student finished days ago, which teaches them
// the number means nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  autoCloseable,
  outreachNotificationKey,
  toNotificationList,
  type NotificationRow,
} from "../../src/lib/notifications";

const NOW = new Date("2026-09-22T12:00:00Z");
const MIN = 60_000;

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "n1",
    userId: "u1",
    kind: "outreach",
    dedupeKey: "outreach:evercore:2026-10-05",
    subjectKey: "evercore",
    title: "Email Evercore",
    body: "2 contacts still to email · opens 5 Oct",
    href: "/contacts?q=Evercore",
    expiresAt: new Date("2026-10-05T00:00:00Z"),
    createdAt: NOW,
    bumpedAt: NOW,
    readAt: null,
    doneAt: null,
    doneSource: null,
    ...over,
  };
}

// ---------- one job, one row ----------

test("the dedupe key is per firm and per opening", () => {
  assert.equal(outreachNotificationKey("evercore", "2026-10-05"), "outreach:evercore:2026-10-05");
});

test("the same firm's next cycle is a different job", () => {
  assert.notEqual(
    outreachNotificationKey("evercore", "2026-10-05"),
    outreachNotificationKey("evercore", "2027-10-05"),
  );
});

test("two firms opening on the same day are different jobs", () => {
  assert.notEqual(
    outreachNotificationKey("evercore", "2026-10-05"),
    outreachNotificationKey("lazard", "2026-10-05"),
  );
});

// ---------- ordering ----------

test("the newest firing is at the top", () => {
  const list = toNotificationList([
    row({ id: "old", bumpedAt: new Date(NOW.getTime() - 60 * MIN) }),
    row({ id: "new", dedupeKey: "b", bumpedAt: NOW }),
  ]);
  assert.deepEqual(
    list.open.map((i) => i.id),
    ["new", "old"],
  );
});

test("a bumped row moves to the top without becoming a second row", () => {
  // What upsertNotification writes on a repeat firing: same id, later bumpedAt.
  const before = toNotificationList([
    row({ id: "a", bumpedAt: new Date(NOW.getTime() - 60 * MIN) }),
    row({ id: "b", dedupeKey: "b", bumpedAt: new Date(NOW.getTime() - 30 * MIN) }),
  ]);
  assert.deepEqual(before.open.map((i) => i.id), ["b", "a"]);

  const after = toNotificationList([
    row({ id: "a", bumpedAt: NOW }),
    row({ id: "b", dedupeKey: "b", bumpedAt: new Date(NOW.getTime() - 30 * MIN) }),
  ]);
  assert.deepEqual(after.open.map((i) => i.id), ["a", "b"]);
  assert.equal(after.open.length, 2, "still two rows, not three");
});

test("finished work is not listed at all", () => {
  // A to-do list that keeps its own history stops being a to-do list.
  const list = toNotificationList([
    row({ id: "a", doneAt: NOW, doneSource: "manual" }),
    row({ id: "b", dedupeKey: "b", doneAt: NOW, doneSource: "auto" }),
    row({ id: "c", dedupeKey: "c", doneAt: NOW, doneSource: "expired" }),
  ]);
  assert.deepEqual(list.open, []);
  assert.equal(list.openCount, 0);
});

test("finished rows do not crowd out the outstanding ones", () => {
  const rows = [
    ...Array.from({ length: 9 }, (_, i) =>
      row({ id: `d${i}`, dedupeKey: `d${i}`, doneAt: NOW, bumpedAt: new Date(NOW.getTime() - i * MIN) }),
    ),
    row({ id: "live", dedupeKey: "live", bumpedAt: new Date(NOW.getTime() - 99 * MIN) }),
  ];
  assert.deepEqual(toNotificationList(rows).open.map((i) => i.id), ["live"]);
});

test("outstanding work is never capped", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row({ id: `o${i}`, dedupeKey: `o${i}` }));
  assert.equal(toNotificationList(rows).open.length, 12);
});

// ---------- the two counts ----------

test("the badge counts outstanding jobs, not unread ones", () => {
  const list = toNotificationList([
    row({ id: "a", readAt: NOW }),
    row({ id: "b", dedupeKey: "b", readAt: NOW }),
    row({ id: "c", dedupeKey: "c" }),
  ]);
  assert.equal(list.openCount, 3, "all three are still to do");
  assert.equal(list.unreadCount, 1);
});

test("reading everything empties the dot but not the number", () => {
  const list = toNotificationList([row({ readAt: NOW }), row({ dedupeKey: "b", readAt: NOW })]);
  assert.equal(list.unreadCount, 0);
    assert.equal(list.openCount, 2);
});

test("a finished job counts for neither", () => {
  const list = toNotificationList([row({ doneAt: NOW, doneSource: "manual" })]);
  assert.equal(list.openCount, 0);
  assert.equal(list.unreadCount, 0);
});

test("an empty list counts zero rather than throwing", () => {
  const list = toNotificationList([]);
  assert.deepEqual([list.open, list.openCount, list.unreadCount], [[], 0, 0]);
});

for (const source of ["manual", "auto", "expired"] as const) {
  test(`a row closed as "${source}" leaves the list`, () => {
    assert.deepEqual(toNotificationList([row({ doneAt: NOW, doneSource: source })]).open, []);
  });
}

// ---------- progress, for the full page ----------

test("a watched job carries how far through it the student is", () => {
  const [item] = toNotificationList(
    [row()],
    new Map([["evercore", { remaining: 2, total: 5 }]]),
  ).open;
  assert.deepEqual(item.progress, { done: 3, total: 5 });
});

test("nothing done yet reads as zero, not as no progress", () => {
  const [item] = toNotificationList(
    [row()],
    new Map([["evercore", { remaining: 5, total: 5 }]]),
  ).open;
  assert.deepEqual(item.progress, { done: 0, total: 5 });
});

test("a job with no progress to show says so, rather than showing zero of zero", () => {
  // An empty contact list is not progress, and "0 of 0 emailed" reads as a bug.
  const [item] = toNotificationList(
    [row()],
    new Map([["evercore", { remaining: 0, total: 0 }]]),
  ).open;
  assert.equal(item.progress, null);
});

test("a job watching nothing has no progress", () => {
  const [item] = toNotificationList([row({ subjectKey: null })]).open;
  assert.equal(item.progress, null);
});

test("a job whose subject was not counted has no progress", () => {
  const [item] = toNotificationList([row()], new Map()).open;
  assert.equal(item.progress, null);
});

test("progress is read per job, not shared between them", () => {
  const list = toNotificationList(
    [row({ id: "a", subjectKey: "evercore" }), row({ id: "b", dedupeKey: "b", subjectKey: "lazard" })],
    new Map([
      ["evercore", { remaining: 1, total: 4 }],
      ["lazard", { remaining: 4, total: 4 }],
    ]),
  );
  assert.deepEqual(
    list.open.map((i) => i.progress),
    [
      { done: 3, total: 4 },
      { done: 0, total: 4 },
    ],
  );
});

// ---------- the app closing things itself ----------

test("nobody left to email closes the row, and says the app saw it", () => {
  const closed = autoCloseable([row()], new Map([["evercore", 0]]), NOW);
  assert.deepEqual(closed, [{ id: "n1", source: "auto" }]);
});

test("people still to email leaves it open", () => {
  assert.deepEqual(autoCloseable([row()], new Map([["evercore", 2]]), NOW), []);
});

test("one person left is still work", () => {
  assert.deepEqual(autoCloseable([row()], new Map([["evercore", 1]]), NOW), []);
});

test("a subject we could not count is never closed on a guess", () => {
  // An absent key means "we do not know", which is not the same as zero.
  assert.deepEqual(autoCloseable([row()], new Map(), NOW), []);
});

test("a row watching nothing is never auto-closed", () => {
  assert.deepEqual(autoCloseable([row({ subjectKey: null })], new Map([["evercore", 0]]), NOW), []);
});

test("an already-closed row is not closed twice", () => {
  assert.deepEqual(
    autoCloseable([row({ doneAt: NOW, doneSource: "manual" })], new Map([["evercore", 0]]), NOW),
    [],
  );
});

test("the moment passing closes the row, but never calls it done", () => {
  const past = new Date("2026-10-06T00:00:00Z");
  assert.deepEqual(autoCloseable([row()], new Map([["evercore", 2]]), past), [
    { id: "n1", source: "expired" },
  ]);
});

test("expiry is not early: the day before, it is still work", () => {
  const dayBefore = new Date("2026-10-04T12:00:00Z");
  assert.deepEqual(autoCloseable([row()], new Map([["evercore", 2]]), dayBefore), []);
});

test("expiry lands exactly on the opening instant", () => {
  const atOpen = new Date("2026-10-05T00:00:00Z");
  assert.deepEqual(autoCloseable([row()], new Map([["evercore", 2]]), atOpen), [
    { id: "n1", source: "expired" },
  ]);
});

test("finishing beats expiring, even in the last hour", () => {
  // Someone who emailed everyone the night before the application opened did
  // the work, and the row has to say so rather than "no longer needed".
  const past = new Date("2026-10-06T00:00:00Z");
  assert.deepEqual(autoCloseable([row()], new Map([["evercore", 0]]), past), [
    { id: "n1", source: "auto" },
  ]);
});

test("a row with no expiry waits indefinitely for the work", () => {
  assert.deepEqual(
    autoCloseable([row({ expiresAt: null })], new Map([["evercore", 3]]), new Date("2030-01-01")),
    [],
  );
});

test("each row is judged on its own subject", () => {
  const closed = autoCloseable(
    [
      row({ id: "done", subjectKey: "evercore" }),
      row({ id: "busy", dedupeKey: "b", subjectKey: "lazard" }),
      row({ id: "unknown", dedupeKey: "c", subjectKey: "moelis" }),
    ],
    new Map([
      ["evercore", 0],
      ["lazard", 4],
    ]),
    NOW,
  );
  assert.deepEqual(closed, [{ id: "done", source: "auto" }]);
});

test("closing writes nothing when there is nothing to close", () => {
  assert.deepEqual(autoCloseable([], new Map(), NOW), []);
});

test("the list after an auto-close is empty, not merely re-labelled", () => {
  const closed = autoCloseable([row()], new Map([["evercore", 0]]), NOW);
  assert.equal(closed[0].source, "auto");
  const list = toNotificationList([row({ doneAt: NOW, doneSource: closed[0].source })]);
  assert.deepEqual(list.open, []);
  assert.equal(list.openCount, 0);
});
