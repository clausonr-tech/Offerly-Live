// One clock, not two.
//
// Every timestamp column here is `timestamp` without a zone, and two different
// writers filled them: Drizzle serialises a JS Date as a UTC wall clock, while
// the 57 `defaultNow()` columns are filled by Postgres `now()` in the session
// zone. PGlite froze that zone from the host at initdb time - `Etc/GMT+5` on
// this machine - so the same instant landed in the same column five hours
// apart depending on which half of the code wrote it.
//
// Read back, Drizzle calls whatever it finds UTC. So a row written by the
// default was five hours older than it really was, every listing was BORN
// three hundred minutes stale, and `decideClosure`'s ninety-minute grace
// period could never protect one. That closed 49 live Morgan Stanley postings
// 62 minutes after finding them.
//
// These tests run against a throwaway in-memory database, so they are offline
// and cost nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pinUtcClock } from "../../src/db/utc-clock";

/** A fresh in-memory database, inheriting the host's zone exactly as a real one does. */
async function freshDb() {
  const client = new PGlite();
  await client.query("create table t (id serial primary key, by_default timestamp default now(), by_js timestamp)");
  return client;
}

const zoneOf = async (c: PGlite) =>
  ((await c.query("select current_setting('TimeZone') as t")).rows[0] as { t: string }).t;

/**
 * The session's offset from UTC, in seconds - which is the fact, not the name.
 *
 * "Is this host UTC" was asked as `zone === "UTC"`, and a zone with a zero
 * offset has many spellings: Etc/UTC, Etc/GMT0, GMT, UCT, Zulu, Universal.
 * A container reporting `Etc/GMT0` is in UTC by every measure that matters and
 * matched none of them, so the skew test below took its non-UTC branch,
 * demanded a skew that cannot exist at zero offset, and failed - announcing
 * that it "can no longer detect the bug" when nothing was wrong with it or
 * with the fix it guards.
 *
 * Postgres is asked directly, so this cannot rot the next time a host spells
 * zero a new way.
 */
const offsetSecondsOf = async (c: PGlite) =>
  Number(
    ((await c.query("select extract(timezone from now())::int as o")).rows[0] as { o: number | string }).o,
  );

// ------------------------------------------------------------- the setting

test("pinning leaves the session in UTC", async () => {
  const c = await freshDb();
  try {
    await pinUtcClock(c);
    assert.equal(await zoneOf(c), "UTC");
  } finally {
    await c.close();
  }
});

test("pinning is idempotent", async () => {
  // It runs on every connection, so running twice must be the same as once.
  const c = await freshDb();
  try {
    await pinUtcClock(c);
    await pinUtcClock(c);
    assert.equal(await zoneOf(c), "UTC");
  } finally {
    await c.close();
  }
});

test("pinning never throws, whatever the database refuses", async () => {
  // A restricted role cannot ALTER DATABASE. That must not take the process
  // down, and must not lose the SET that already worked.
  const refuses = {
    query: async (sql: string) => {
      if (sql.startsWith("ALTER")) throw new Error("permission denied");
      return {};
    },
  };
  await assert.doesNotReject(() => pinUtcClock(refuses));

  const refusesEverything = {
    query: async () => {
      throw new Error("read-only");
    },
  };
  await assert.doesNotReject(() => pinUtcClock(refusesEverything));
});

// -------------------------------------------------- the thing that matters

test("the default clock and a JS Date write the same instant", async () => {
  // THE bug, stated as an assertion. Both columns are filled in one statement,
  // so any difference between them is the two clocks disagreeing and nothing
  // else.
  const c = await freshDb();
  try {
    await pinUtcClock(c);
    await c.query("insert into t (by_js) values ($1)", [new Date()]);
    const row = (await c.query("select by_default::text as d, by_js::text as j from t")).rows[0] as {
      d: string;
      j: string;
    };
    const skewMs = Math.abs(Date.parse(row.d + "Z") - Date.parse(row.j + "Z"));
    assert.ok(
      skewMs < 5_000,
      `the two clocks are ${Math.round(skewMs / 3_600_000)}h apart: default wrote ${row.d}, JS wrote ${row.j}`,
    );
  } finally {
    await c.close();
  }
});

test("a defaulted timestamp reads back as the present, not as hours ago", async () => {
  // The consequence the crawler actually depends on: a row inserted now must
  // be zero minutes old, because decideClosure measures exactly this.
  const c = await freshDb();
  try {
    await pinUtcClock(c);
    await c.query("insert into t (by_js) values (null)");
    const stored = ((await c.query("select by_default::text as d from t")).rows[0] as { d: string }).d;
    const ageMin = (Date.now() - Date.parse(stored + "Z")) / 60_000;
    assert.ok(
      Math.abs(ageMin) < 1,
      `a row inserted this instant reads as ${Math.round(ageMin)} minutes old`,
    );
  } finally {
    await c.close();
  }
});

test("without pinning, the skew is real on a non-UTC host", async () => {
  // Guards against the fix becoming a no-op that nobody notices. On a host
  // already in UTC there is nothing to catch, so this asserts only where the
  // bug can exist - which is where it did.
  const c = await freshDb();
  try {
    const zone = await zoneOf(c);
    // By offset, not by name - see offsetSecondsOf.
    const offset = await offsetSecondsOf(c);
    await c.query("insert into t (by_js) values ($1)", [new Date()]);
    const row = (await c.query("select by_default::text as d, by_js::text as j from t")).rows[0] as {
      d: string;
      j: string;
    };
    const skewMs = Math.abs(Date.parse(row.d + "Z") - Date.parse(row.j + "Z"));
    if (offset === 0) {
      assert.ok(skewMs < 5_000, `a zero-offset session (${zone}) should never skew`);
    } else {
      // The skew IS the offset, so compare against it rather than a flat
      // minute: a host at +00:30 would otherwise slip through.
      assert.ok(
        Math.abs(skewMs - Math.abs(offset) * 1_000) < 5_000,
        `session zone ${zone} is ${offset}s from UTC, so the unpinned clocks should differ by that much - they differed by ${Math.round(skewMs / 1_000)}s, which means this test can no longer detect the bug`,
      );
    }
  } finally {
    await c.close();
  }
});
