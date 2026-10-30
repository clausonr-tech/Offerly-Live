// The two decisions the Supabase migration cannot get wrong.
//
// ORDER. Rows go in parents-first, derived from the foreign keys actually
// present in the source rather than a hand-written list that would rot the
// first time a table is added. Get it wrong and the insert fails on a
// constraint halfway through a 52,000-row copy.
//
// TIME. PGlite's own client parses `timestamp without time zone` as LOCAL
// time, so a stored `2026-09-18 16:55:28` came back as 20:55:28Z on a UTC-4
// host. The first migration ran with that bug and moved every timestamp in
// the database forward by four hours - correctly serialised, from a wrong
// instant. This is the parser that replaced it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  topologicalOrder,
  reviveUtc,
  selectExpression,
  TIMESTAMP_TYPES,
} from "../migrate-to-supabase";

type Edge = { child: string; parent: string };
const before = (order: string[], a: string, b: string) => order.indexOf(a) < order.indexOf(b);

// ------------------------------------------------------------------ order

test("no foreign keys means every table still comes out", () => {
  const tables = ["a", "b", "c"];
  assert.deepEqual([...topologicalOrder(tables, [])].sort(), [...tables].sort());
});

test("a parent is inserted before its child", () => {
  const order = topologicalOrder(["listings", "firms"], [{ child: "listings", parent: "firms" }]);
  assert.ok(before(order, "firms", "listings"));
});

test("a chain is ordered end to end", () => {
  const edges: Edge[] = [
    { child: "listings", parent: "sources" },
    { child: "sources", parent: "firms" },
  ];
  const order = topologicalOrder(["listings", "sources", "firms"], edges);
  assert.ok(before(order, "firms", "sources"));
  assert.ok(before(order, "sources", "listings"));
});

test("a diamond resolves with the root first and the join last", () => {
  const edges: Edge[] = [
    { child: "left", parent: "root" },
    { child: "right", parent: "root" },
    { child: "join", parent: "left" },
    { child: "join", parent: "right" },
  ];
  const order = topologicalOrder(["join", "left", "right", "root"], edges);
  assert.ok(before(order, "root", "left"));
  assert.ok(before(order, "root", "right"));
  assert.ok(before(order, "left", "join"));
  assert.ok(before(order, "right", "join"));
});

test("a table with many parents comes after all of them", () => {
  const parents = ["p1", "p2", "p3", "p4", "p5"];
  const edges = parents.map((p) => ({ child: "child", parent: p }));
  const order = topologicalOrder([...parents, "child"], edges);
  for (const p of parents) assert.ok(before(order, p, "child"), p);
});

test("a self-reference is ignored rather than deadlocking the sort", () => {
  // A threaded comment, a firm that owns a firm. Treating it as a cycle
  // would stall the whole ordering for no gain.
  const order = topologicalOrder(["firms"], [{ child: "firms", parent: "firms" }]);
  assert.deepEqual(order, ["firms"]);
});

test("a genuine cycle still emits every table", () => {
  // Better to emit them and let the insert fail loudly on a constraint than
  // to silently drop tables from the migration.
  const edges: Edge[] = [
    { child: "a", parent: "b" },
    { child: "b", parent: "a" },
  ];
  const order = topologicalOrder(["a", "b"], edges);
  assert.equal(order.length, 2);
  assert.deepEqual([...order].sort(), ["a", "b"]);
});

test("a cycle among some tables does not lose the others", () => {
  const edges: Edge[] = [
    { child: "a", parent: "b" },
    { child: "b", parent: "a" },
    { child: "c", parent: "root" },
  ];
  const order = topologicalOrder(["a", "b", "c", "root"], edges);
  assert.equal(new Set(order).size, 4);
  assert.ok(before(order, "root", "c"));
});

test("an edge naming a table that is not being migrated is ignored", () => {
  // --table= restricts the set, and a dangling parent must not wedge it.
  const order = topologicalOrder(["listings"], [{ child: "listings", parent: "firms" }]);
  assert.deepEqual(order, ["listings"]);
});

test("every table appears exactly once", () => {
  const tables = ["a", "b", "c", "d", "e"];
  const edges: Edge[] = [
    { child: "b", parent: "a" },
    { child: "c", parent: "a" },
    { child: "d", parent: "b" },
    { child: "e", parent: "d" },
    { child: "e", parent: "c" },
  ];
  const order = topologicalOrder(tables, edges);
  assert.equal(order.length, tables.length);
  assert.equal(new Set(order).size, tables.length);
});

test("the order is stable across runs", () => {
  const tables = ["z", "y", "x", "w"];
  const edges: Edge[] = [{ child: "z", parent: "w" }, { child: "y", parent: "x" }];
  const first = topologicalOrder(tables, edges);
  for (let i = 0; i < 5; i++) assert.deepEqual(topologicalOrder(tables, edges), first);
});

test("no table is ever placed before a parent - checked over many shapes", () => {
  // The property that matters, asserted rather than assumed, across a few
  // hundred generated dependency graphs.
  let seed = 7;
  const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let trial = 0; trial < 200; trial++) {
    const size = 2 + rand(8);
    const tables = Array.from({ length: size }, (_, i) => `t${i}`);
    const edges: Edge[] = [];
    // Only forward edges by index, so the graph is acyclic by construction.
    for (let c = 1; c < size; c++) {
      if (rand(2) === 0) edges.push({ child: `t${c}`, parent: `t${rand(c)}` });
    }
    const order = topologicalOrder(tables, edges);
    assert.equal(new Set(order).size, size, "lost a table");
    for (const e of edges) {
      assert.ok(before(order, e.parent, e.child), `${e.parent} must precede ${e.child}`);
    }
  }
});

test("an empty table list is not an error", () => {
  assert.deepEqual(topologicalOrder([], []), []);
});

// ------------------------------------------------------------------- time

const timestamps: [string, string][] = [
  ["2026-09-18 16:55:28.31", "2026-09-18T16:55:28.310Z"],
  ["2026-09-18 16:55:28", "2026-09-18T16:55:28.000Z"],
  ["2026-09-20 03:49:52.727", "2026-09-20T03:49:52.727Z"],
  ["2026-01-01 00:00:00", "2026-01-01T00:00:00.000Z"],
  ["2026-12-31 23:59:59.999", "2026-12-31T23:59:59.999Z"],
  ["2026-02-29 12:00:00", "2026-03-01T12:00:00.000Z"], // 2026 is not a leap year
];
for (const [stored, expected] of timestamps) {
  test(`a stored wall clock is read as UTC: ${stored}`, () => {
    const got = reviveUtc(stored);
    assert.ok(got instanceof Date, `expected a Date, got ${typeof got}`);
    assert.equal((got as Date).toISOString(), expected);
  });
}

test("Postgres microsecond precision parses without shifting", () => {
  // Postgres renders six fractional digits; JS Dates hold three. Truncation
  // is fine, silently failing to parse is not.
  const got = reviveUtc("2026-09-20 04:34:36.845362");
  assert.ok(got instanceof Date);
  assert.equal((got as Date).toISOString(), "2026-09-20T04:34:36.845Z");
});

test("a value that already states its zone is not given a second one", () => {
  for (const already of [
    "2026-09-20T03:49:52.727Z",
    "2026-09-20 03:49:52.727+00",
    "2026-09-20T03:49:52.727+00:00",
  ]) {
    const got = reviveUtc(already);
    assert.ok(got instanceof Date, already);
    assert.equal((got as Date).toISOString(), "2026-09-20T03:49:52.727Z", already);
  }
});

test("a non-UTC offset is respected rather than overwritten", () => {
  const got = reviveUtc("2026-09-20 03:49:52.727-04:00");
  assert.ok(got instanceof Date);
  assert.equal((got as Date).toISOString(), "2026-09-20T07:49:52.727Z");
});

test("the local zone never influences the result", () => {
  // THE regression. The whole bug was a parser that used the host's zone.
  const got = reviveUtc("2026-06-15 12:00:00") as Date;
  assert.equal(got.getUTCHours(), 12, "midday UTC must stay midday UTC");
  assert.equal(got.getUTCDate(), 15);
});

const passthrough: unknown[] = [null, undefined, 42, 0, true, false, { a: 1 }, ["x"]];
for (const value of passthrough) {
  test(`a non-string is returned untouched: ${JSON.stringify(value) ?? String(value)}`, () => {
    assert.equal(reviveUtc(value), value);
  });
}

test("a Date is returned untouched", () => {
  const d = new Date("2026-09-20T03:49:52.727Z");
  assert.equal(reviveUtc(d), d);
});

const notTimestamps = ["", "  ", "hello", "not a date", "2027", "N/A", "Summer Analyst"];
for (const text of notTimestamps) {
  test(`unparseable text is kept as text: ${JSON.stringify(text)}`, () => {
    // Returning an Invalid Date here would be written to the target as null
    // or rejected outright; keeping the string is the honest fallback.
    const got = reviveUtc(text);
    assert.ok(!(got instanceof Date) || !Number.isNaN(got.getTime()), text);
  });
}

test("reviveUtc never throws", () => {
  for (const v of [...passthrough, ...notTimestamps, "x".repeat(5000), "9999-99-99 99:99:99"]) {
    assert.doesNotThrow(() => reviveUtc(v));
  }
});

// -------------------------------------------------------- the select cast

test("timestamp columns are read as text, so the driver cannot re-parse them", () => {
  for (const type of TIMESTAMP_TYPES) {
    const expr = selectExpression({ name: "created_at", type, nullable: true });
    assert.match(expr, /created_at::text as created_at/, type);
  }
});

const plainColumns = ["text", "uuid", "integer", "boolean", "jsonb", "date", "double precision"];
for (const type of plainColumns) {
  test(`a ${type} column is selected plainly`, () => {
    assert.equal(selectExpression({ name: "col", type, nullable: true }), "col");
  });
}

test("a date column is NOT cast, because it carries no time to misread", () => {
  assert.equal(selectExpression({ name: "d", type: "date", nullable: true }), "d");
});

test("the cast aliases back to the original column name", () => {
  // The insert builds its column list from these names; an unaliased cast
  // would arrive as `?column?` and the row would be dropped.
  const expr = selectExpression({ name: "last_confirmed_at", type: "timestamp without time zone", nullable: false });
  assert.ok(expr.endsWith(" as last_confirmed_at"), expr);
});
