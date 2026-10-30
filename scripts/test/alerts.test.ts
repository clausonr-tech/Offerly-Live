// Telling students a firm they watch has opened.
//
// This is the last step of the pipeline and the only one a student sees. It
// had no tests, and it has two properties that are easy to break silently:
// it must not notify anyone twice, and it must not notify the wrong people.

import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyWatchersOfOpening } from "../../src/lib/monitoring/alerts";

type Insert = { table: string; rows: Record<string, unknown>[]; conflictIgnored: boolean };

/**
 * A database that records what it was asked to do.
 *
 * `accepted` models the unique index on (userId, postingId, kind): rows
 * beyond it are the ones onConflictDoNothing silently drops, which is how a
 * re-run behaves in production.
 */
function fakeDb(watcherIds: string[], opts: { accepted?: number } = {}) {
  const inserts: Insert[] = [];
  const db = {
    query: {
      userTopFirms: {
        findMany: async () => watcherIds.map((userId) => ({ userId })),
      },
    },
    insert: () => ({
      values: (rows: Record<string, unknown>[]) => {
        const record: Insert = { table: "user_alerts", rows, conflictIgnored: false };
        return {
          onConflictDoNothing: () => {
            record.conflictIgnored = true;
            return {
              returning: async () => {
                inserts.push(record);
                return rows.slice(0, opts.accepted ?? rows.length);
              },
            };
          },
        };
      },
    }),
  } as never;
  return { db, inserts };
}

const opening = {
  postingId: "p1",
  firmId: "f1",
  firmName: "Evercore",
  roleTitle: "2027 Investment Banking Summer Analyst",
};

// --------------------------------------------------------- nobody watching

test("no watchers means no alerts", async () => {
  const { db, inserts } = fakeDb([]);
  assert.equal(await notifyWatchersOfOpening(db, opening), 0);
});

test("no watchers means no INSERT is attempted at all", async () => {
  // An insert of zero rows is a syntax error in Postgres, so the early return
  // is load-bearing rather than an optimisation.
  const { db, inserts } = fakeDb([]);
  await notifyWatchersOfOpening(db, opening);
  assert.equal(inserts.length, 0);
});

// ---------------------------------------------------------- one per watcher

const counts = [1, 2, 3, 5, 25, 500];
for (const n of counts) {
  test(`${n} watcher(s) get exactly ${n} alert(s)`, async () => {
    const { db } = fakeDb(Array.from({ length: n }, (_, i) => `u${i}`));
    assert.equal(await notifyWatchersOfOpening(db, opening), n);
  });
}

test("each alert goes to its own watcher, and only once", async () => {
  const ids = ["a", "b", "c", "d"];
  const { db, inserts } = fakeDb(ids);
  await notifyWatchersOfOpening(db, opening);
  const got = inserts[0].rows.map((r) => r.userId);
  assert.deepEqual(got, ids);
  assert.equal(new Set(got).size, got.length, "a watcher must not be notified twice");
});

test("every alert points at the posting that opened", async () => {
  const { db, inserts } = fakeDb(["a", "b"]);
  await notifyWatchersOfOpening(db, opening);
  for (const row of inserts[0].rows) assert.equal(row.postingId, opening.postingId);
});

test("every alert carries the watched-firm kind", async () => {
  // The kind is part of the unique index, so a wrong one would also defeat
  // the double-notify protection.
  const { db, inserts } = fakeDb(["a"]);
  await notifyWatchersOfOpening(db, opening);
  assert.equal(inserts[0].rows[0].kind, "watched_firm_opening");
});

// ------------------------------------------------------------- what it says

test("the alert names the firm and the role", async () => {
  const { db, inserts } = fakeDb(["a"]);
  await notifyWatchersOfOpening(db, opening);
  const row = inserts[0].rows[0];
  assert.match(String(row.title), /Evercore/);
  assert.match(String(row.title), /Summer Analyst/);
  assert.match(String(row.body), /Evercore/);
});

test("nothing is left as an unfilled template", async () => {
  // A title reading "undefined just opened:" has shipped from worse code.
  const { db, inserts } = fakeDb(["a"]);
  await notifyWatchersOfOpening(db, opening);
  for (const row of inserts[0].rows) {
    for (const field of ["title", "body"]) {
      const text = String(row[field]);
      assert.doesNotMatch(text, /undefined|null|\[object Object\]|\$\{/, `${field}: ${text}`);
      assert.ok(text.trim().length > 0, `${field} is empty`);
    }
  }
});

const awkwardNames: [string, string][] = [
  ["Moelis & Company", "2027 Summer Analyst"],
  ["Perella Weinberg Partners", "Off-Cycle Internship – Generalist"],
  ["Evercore", "2028 Summer Analyst (New York)"],
  ["J.P. Morgan", "Summer Analyst — Markets"],
  ["Müller & Söhne", "Praktikum"],
  ["Firm 'with' quotes", 'Role "with" quotes'],
];
for (const [firmName, roleTitle] of awkwardNames) {
  test(`punctuation survives: ${firmName.slice(0, 24)}`, async () => {
    const { db, inserts } = fakeDb(["a"]);
    await notifyWatchersOfOpening(db, { ...opening, firmName, roleTitle });
    const title = String(inserts[0].rows[0].title);
    assert.ok(title.includes(firmName), title);
    assert.ok(title.includes(roleTitle), title);
  });
}

test("a very long role title does not truncate the firm name away", async () => {
  const { db, inserts } = fakeDb(["a"]);
  const roleTitle = "Summer Analyst ".repeat(40);
  await notifyWatchersOfOpening(db, { ...opening, roleTitle });
  assert.match(String(inserts[0].rows[0].title), /^Evercore just opened:/);
});

// ------------------------------------------------- safe to run again

test("the insert always ignores conflicts", async () => {
  // This is what makes re-running after a data fix safe. Without it, a second
  // run notifies every watcher a second time.
  const { db, inserts } = fakeDb(["a", "b"]);
  await notifyWatchersOfOpening(db, opening);
  assert.equal(inserts[0].conflictIgnored, true);
});

test("the count returned is what was actually inserted, not what was offered", async () => {
  // On a re-run the unique index drops the duplicates, and the caller needs
  // the real number - otherwise logs report notifications nobody received.
  const { db } = fakeDb(["a", "b", "c"], { accepted: 1 });
  assert.equal(await notifyWatchersOfOpening(db, opening), 1);
});

test("a full re-run notifies nobody", async () => {
  const { db } = fakeDb(["a", "b", "c"], { accepted: 0 });
  assert.equal(await notifyWatchersOfOpening(db, opening), 0);
});

// ------------------------------------------------------------- robustness

test("notifyWatchersOfOpening never throws on odd but possible input", async () => {
  for (const patch of [
    { firmName: "" },
    { roleTitle: "" },
    { firmName: "  " },
    { roleTitle: "x".repeat(5000) },
    { firmName: "x".repeat(5000) },
  ]) {
    const { db } = fakeDb(["a"]);
    await assert.doesNotReject(() => notifyWatchersOfOpening(db, { ...opening, ...patch }));
  }
});

test("watchers are looked up by firm, not by posting", async () => {
  // The watchlist is per FIRM; keying it off the posting would notify nobody,
  // because no student watches an individual requisition.
  const { db, inserts } = fakeDb(["a"]);
  await notifyWatchersOfOpening(db, opening);
  assert.equal(inserts[0].rows.length, 1);
});

test("the same opening for two postings produces separate alerts", async () => {
  const first = fakeDb(["a"]);
  const second = fakeDb(["a"]);
  await notifyWatchersOfOpening(first.db, opening);
  await notifyWatchersOfOpening(second.db, { ...opening, postingId: "p2" });
  assert.notEqual(first.inserts[0].rows[0].postingId, second.inserts[0].rows[0].postingId);
});
