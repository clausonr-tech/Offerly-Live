/**
 * No raw JS values in hand-written SQL that the live driver will refuse.
 *
 * A guard against a bug that got all the way to production: the monthly
 * credit sum interpolated a JS `Date` into a `sql` template, which bypasses
 * Drizzle's column-aware serializer. PGlite accepted it, so 4264 offline
 * tests passed; postgres-js - the driver Supabase actually uses - threw
 * "The 'string' argument must be of type string ... Received an instance of
 * Date" on the first live call.
 *
 * The offline suite runs only PGlite, so this class of bug is invisible to
 * it. Checking the BOUND PARAMETERS of the expression catches it without
 * needing a second driver.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { MONTHLY_CREDITS_USED } from "@/lib/contact-credits";
import { PENDING_STALE_MS } from "@/lib/sourcing-run-policy";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

test("the monthly credit sum binds no Date, and no object the driver cannot serialise", () => {
  const { params, sql } = dialect.sqlToQuery(MONTHLY_CREDITS_USED);

  for (const [i, p] of params.entries()) {
    assert.ok(!(p instanceof Date), `parameter ${i} is a Date: postgres-js will refuse it`);
    const kind = typeof p;
    assert.ok(
      p === null || kind === "string" || kind === "number" || kind === "boolean",
      `parameter ${i} is a ${kind} (${String(p)}) - only primitives are safe in a raw template`,
    );
  }

  // The staleness window is a number of milliseconds, multiplied by an
  // interval inside the database. That is the shape that made it portable.
  assert.deepEqual(params, [PENDING_STALE_MS]);
  assert.match(sql, /now\(\) at time zone 'utc'/, "the cutoff must not come from the session clock");
  assert.ok(!/\$\d+::timestamp/.test(sql));
});

test("the expression still computes what it is supposed to", async () => {
  // Cheap end-to-end check that the rewrite did not change the answer: a
  // fresh pending run counts one, a stale one counts nothing, and a settled
  // run counts its own credits.
  const { createTestDb } = await import("./helpers/test-db");
  const { contactSourcingRuns, firms, users } = await import("@/db/schema");
  const { getContactCredits } = await import("@/lib/contact-credits");
  const { installAsAppDb } = await import("./helpers/test-db");

  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    const userId = "55555555-5555-4555-8555-555555555555";
    const firmId = "66666666-6666-4666-8666-666666666666";
    await h.db.insert(users).values({
      id: userId, email: "sum@example.edu", passwordHash: "x", name: "Sum", plan: "pro",
    });
    await h.db.insert(firms).values({
      id: firmId, slug: "f", name: "F", headquarters: "NY", keyOffices: "NY",
      description: "d", website: "https://f.example",
    });

    const base = { userId, firmId, contactsRequested: 5 };
    // settled, charged
    await h.db.insert(contactSourcingRuns).values({ ...base, status: "succeeded", creditsSpent: 1, contactsCreated: 5 });
    // settled, empty, uncharged
    await h.db.insert(contactSourcingRuns).values({ ...base, status: "succeeded", creditsSpent: 0, contactsCreated: 0 });
    // failed - excluded entirely
    await h.db.insert(contactSourcingRuns).values({ ...base, status: "failed", creditsSpent: 0, contactsCreated: 0 });
    // in flight - counts one provisionally
    await h.db.insert(contactSourcingRuns).values({ ...base, status: "pending", creditsSpent: 0, contactsCreated: 0 });
    // abandoned - counts nothing
    await h.db.insert(contactSourcingRuns).values({
      ...base, status: "pending", creditsSpent: 0, contactsCreated: 0,
      createdAt: new Date(Date.now() - PENDING_STALE_MS - 60_000),
    });

    assert.equal((await getContactCredits(userId)).used, 2, "1 settled credit + 1 in-flight");
  } finally {
    restore();
    await h.close();
  }
});
