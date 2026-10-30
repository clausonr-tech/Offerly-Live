/**
 * Every public table has row-level security on.
 *
 * RLS was added per-migration from 0026 onward, which left the 58 tables
 * created before it - users, sessions, firm_login_codes, email_archive,
 * stored_files, messages, contacts, applications - with none at all. The app
 * connects as a role that bypasses RLS, so this is invisible to the app and
 * decisive for the Supabase Data API: a table with RLS on and no policy is a
 * table PostgREST cannot read.
 *
 * Migration 0044 back-fills it for all of them, as a loop over pg_class so it
 * cannot drift. This test is the gate that keeps it true: a new table that
 * ships without RLS fails here, the same way the content-limits coverage test
 * catches an unchecked action.
 *
 * The real migrations are replayed into PGlite, so this reads the actual
 * resulting catalog rather than a parse of the SQL.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTestDb } from "./helpers/test-db";

test("no public table is left without row-level security", async () => {
  const h = await createTestDb();
  try {
    const rows = (await h.client.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    )).rows;

    assert.ok(rows.length > 50, `expected the full schema, saw ${rows.length} tables`);
    const without = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    assert.deepEqual(
      without,
      [],
      `these tables have no row-level security (add it in a migration, as 0044 does):\n  ${without.join("\n  ")}`,
    );
  } finally {
    await h.close();
  }
});

test("row-level security is not FORCEd, which would cut the app off from its own data", async () => {
  // The app's role owns these tables and relies on the owner's RLS bypass.
  // FORCE binds the owner too, so it must stay off.
  const h = await createTestDb();
  try {
    const rows = (await h.client.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity = true`,
    )).rows;
    assert.deepEqual(rows.map((r) => r.relname), [], "no table should FORCE row-level security");
  } finally {
    await h.close();
  }
});
