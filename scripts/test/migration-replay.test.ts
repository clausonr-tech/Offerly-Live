/**
 * Every migration the shared database will replay must survive being replayed.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * drizzle/0009 was written as a bare `CREATE UNIQUE INDEX`. The index was
 * already on the table, so `migrate()` raised "relation already exists" - and
 * because drizzle runs the whole outstanding batch in ONE transaction, it did
 * not fail alone. It rolled back 0006, 0007 and 0008 with it. On the shared
 * database that is a deploy that applies nothing and reports failure; here it
 * was five red tests in migration-0008.test.ts, which caught it only
 * incidentally, as collateral damage to a file about a different migration.
 *
 * This is that check stated directly, and stated about ALL of them, so the
 * tenth migration cannot repeat the ninth's mistake and the eleventh cannot
 * repeat the tenth's. It is the property `applyMigrations` was documented as
 * existing for - "Exported so a test can apply them TWICE and prove the new
 * ones are repeatable" - which had never been written down as a test.
 *
 * The replay set is `replayedMigrationFiles()`: 0006 onward, because those are
 * the ones the shared ledger does not record. See the note on
 * FIRST_UNRECORDED_MIGRATION for why the boundary is where it is.
 *
 * In-memory PGlite. No DATABASE_URL, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import "./helpers/no-network";
import { PGlite } from "@electric-sql/pglite";

import { applyMigrations, migrationFiles, replayedMigrationFiles } from "./helpers/test-db";
import { pinUtcClock } from "@/db/utc-clock";

async function migratedClient(): Promise<PGlite> {
  const client = new PGlite();
  await pinUtcClock(client);
  await applyMigrations(client);
  return client;
}

for (const file of replayedMigrationFiles()) {
  const tag = path.basename(file, ".sql");
  test(`${tag} can be applied a second time`, async () => {
    const client = await migratedClient();
    try {
      await assert.doesNotReject(
        applyMigrations(client, [file]),
        `${tag} is not replay-safe. The shared ledger does not record it, so ` +
          `\`drizzle-kit migrate\` will run it again over a database that ` +
          `already has it - and take every migration in the same batch down ` +
          `with it. Guard each statement: IF NOT EXISTS, or a DO $$ block ` +
          `that checks pg_constraint first. See drizzle/0008 for both shapes.`,
      );
    } finally {
      await client.close();
    }
  });
}

test("the whole replayed batch survives, in the order migrate() runs it", async () => {
  // Each file passing alone is not quite the claim. `migrate()` replays them
  // consecutively inside one transaction, so what has to hold is that the
  // sequence is repeatable - which is what a deploy against the real ledger
  // actually does.
  const client = await migratedClient();
  try {
    await assert.doesNotReject(applyMigrations(client, replayedMigrationFiles()));
    await assert.doesNotReject(applyMigrations(client, replayedMigrationFiles()));
  } finally {
    await client.close();
  }
});

test("the replay boundary still names a migration that exists", () => {
  // replayedMigrationFiles() throws if its tag has been renumbered away. This
  // asserts the set is non-empty for the ordinary reason too: a boundary that
  // quietly selected nothing would make every test above vacuous.
  const replayed = replayedMigrationFiles();
  assert.ok(replayed.length > 0, "no migrations are being replay-checked");
  const all = migrationFiles();
  assert.deepEqual(
    replayed,
    all.slice(all.length - replayed.length),
    "the replayed set must be a suffix of the journal - every migration after " +
      "the boundary, with none skipped",
  );
});
