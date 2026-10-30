// The "Today" list's batches of five: finished tasks cross out in place, and
// the next five only come once all five are done.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BATCH_SIZE,
  DONE_VISIBLE_MS,
  batchFinished,
  groupByDay,
  recentlyDone,
  type CompletedTask,
  nextBatch,
  resolveBatch,
  snapshot,
  type TaskSnapshot,
} from "../../src/lib/todo-batch";

function task(id: string, score = 50, extra: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { id, kind: "event", title: `Task ${id}`, detail: "detail", href: "/schedule", score, ...extra };
}

const FIVE = ["a", "b", "c", "d", "e"].map((id, i) => task(id, 90 - i));

test("five at a time", () => assert.equal(BATCH_SIZE, 5));

test("a task still listed is open", () => {
  const items = resolveBatch(FIVE, new Set(["a", "b", "c", "d", "e"]));
  assert.ok(items.every((i) => !i.done));
});

test("a task the app stopped listing is done - crossed out, not removed", () => {
  const items = resolveBatch(FIVE, new Set(["a", "c", "d", "e"]));
  assert.equal(items.length, 5, "it keeps its place");
  assert.equal(items[1].id, "b");
  assert.equal(items[1].done, true);
  assert.equal(items.filter((i) => i.done).length, 1);
});

test("the order of the five never changes as they are finished", () => {
  const items = resolveBatch(FIVE, new Set(["e"]));
  assert.deepEqual(items.map((i) => i.id), ["a", "b", "c", "d", "e"]);
});

test("a finished task keeps the words it had when it was shown", () => {
  const items = resolveBatch([task("x", 60, { title: "Thank Dana Reed" })], new Set());
  assert.equal(items[0].title, "Thank Dana Reed");
});

test("not finished while any one is open", () => {
  assert.equal(batchFinished(resolveBatch(FIVE, new Set(["c"]))), false);
});

test("finished once all five are done", () => {
  assert.equal(batchFinished(resolveBatch(FIVE, new Set())), true);
});

test("an empty batch is not 'finished' - there was nothing to finish", () => {
  assert.equal(batchFinished([]), false);
});

test("a batch of fewer than five is finished when those are done", () => {
  assert.equal(batchFinished(resolveBatch(FIVE.slice(0, 2), new Set(["z"]))), true);
});

test("the next five are the top five not already shown today", () => {
  const all = ["a", "b", "f", "g", "h", "i", "j", "k"].map((id, i) => task(id, 99 - i));
  const next = nextBatch(all, new Set(["a", "b", "c", "d", "e"]));
  assert.deepEqual(next.map((t) => t.id), ["f", "g", "h", "i", "j"]);
});

test("the next batch keeps the list's order, which is score order", () => {
  const all = [task("hi", 95), task("mid", 70), task("lo", 30)];
  assert.deepEqual(nextBatch(all, new Set()).map((t) => t.id), ["hi", "mid", "lo"]);
});

test("fewer than five left gives fewer than five", () => {
  assert.equal(nextBatch([task("only")], new Set()).length, 1);
});

test("nothing left gives nothing", () => {
  assert.deepEqual(nextBatch(FIVE, new Set(FIVE.map((t) => t.id))), []);
});

test("a custom size is respected", () => {
  assert.equal(nextBatch(FIVE, new Set(), 2).length, 2);
});

test("a snapshot keeps only what drawing the row needs", () => {
  const withExtra = { ...task("s", 40, { doneKey: "thank_you:x" }), stray: "not stored" } as TaskSnapshot;
  assert.deepEqual(Object.keys(snapshot(withExtra)).sort(), ["detail", "doneKey", "href", "id", "kind", "score", "title"]);
});

test("a snapshot without a done key does not store an empty one", () => {
  assert.equal("doneKey" in snapshot(task("n")), false);
});

// ---------- the completed history ----------


const NY = "America/New_York";
// 23 Sep 2026, 10am in New York.
const NOW = new Date("2026-09-23T14:00:00Z");
const H = 3_600_000;

function done(id: string, hoursAgo: number): CompletedTask {
  return { ...task(id), completedAt: new Date(NOW.getTime() - hoursAgo * H), source: "manual" };
}

test("a finished task stays on the to-do page for a day", () => assert.equal(DONE_VISIBLE_MS, 24 * H));

test("finished an hour ago is still shown", () => {
  assert.deepEqual(recentlyDone([done("a", 1)], NOW).map((t) => t.id), ["a"]);
});

test("finished 23 hours ago is still shown", () => {
  assert.equal(recentlyDone([done("a", 23)], NOW).length, 1);
});

test("finished a day ago has moved to the history", () => {
  assert.deepEqual(recentlyDone([done("a", 24)], NOW), []);
});

test("the most recently finished comes first", () => {
  assert.deepEqual(recentlyDone([done("old", 5), done("new", 1)], NOW).map((t) => t.id), ["new", "old"]);
});

test("history groups by the student's day, newest day first", () => {
  const days = groupByDay([done("a", 1), done("b", 30), done("c", 2), done("d", 80)], NY, NOW);
  assert.deepEqual(days.map((d) => d.day), ["2026-09-23", "2026-09-22", "2026-09-20"]);
  assert.deepEqual(days[0].items.map((t) => t.id), ["a", "c"]);
});

test("today and yesterday are named, older days by weekday and date", () => {
  const days = groupByDay([done("a", 1), done("b", 30), done("d", 80)], NY, NOW);
  assert.deepEqual(days.map((d) => d.label), ["Today", "Yesterday", "Sunday, September 20"]);
});

test("the day is the student's, not UTC's", () => {
  // 11:30pm on the 22nd in New York is already the 23rd in UTC.
  const lateNight: CompletedTask = { ...task("late"), completedAt: new Date("2026-09-23T03:30:00Z"), source: "auto" };
  assert.equal(groupByDay([lateNight], NY, NOW)[0].label, "Yesterday");
});

test("no finished tasks, no days", () => {
  assert.deepEqual(groupByDay([], NY, NOW), []);
});
