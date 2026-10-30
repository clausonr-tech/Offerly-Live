/**
 * A real Postgres, per test file, with the real schema.
 *
 * PGlite - the same WASM Postgres this project used in local development -
 * created in memory and migrated by replaying drizzle/*.sql in order. Not a
 * hand-written subset of the tables: replaying the actual migrations is what
 * makes a unique index, a check constraint or a foreign key behave here the
 * way it will behave on Supabase. A stub that "models" a constraint proves
 * nothing about the constraint.
 *
 * NOTHING HERE TOUCHES PRODUCTION. There is no connection string, no
 * DATABASE_URL read, and no network; a PGlite instance with no data directory
 * lives entirely in memory and is gone when the process exits.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../../../src/db/schema";
import { pinUtcClock } from "../../../src/db/utc-clock";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

/** Every migration, in journal order rather than filename order - the journal
 *  is the record of what ran, and a renamed file would otherwise silently
 *  reorder the replay. */
export function migrationFiles(): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  return journal.entries
    .sort((a, b) => a.idx - b.idx)
    .map((e) => path.join(MIGRATIONS_DIR, `${e.tag}.sql`));
}

/**
 * The migrations `drizzle-kit migrate` will REPLAY against the shared database.
 *
 * Its drizzle ledger records six rows, 0000 to 0005, and stops there: 0006 and
 * 0007 were applied by hand and never recorded (the subject of
 * migration-0008.test.ts, whose PROD_LEDGER is that same audit with the
 * hashes). So everything from 0006 onward is, as far as `migrate()` can tell,
 * outstanding - and gets run again over a database that already has it.
 *
 * Which makes replay-safety a requirement of every migration from here on, not
 * a style preference. Drizzle wraps the batch in ONE transaction, so a
 * statement that cannot survive a second run does not just fail itself; it
 * takes every migration queued behind it down too.
 *
 * Named by tag rather than by index so that renumbering cannot silently move
 * the boundary, and 0000-0005 stay out because they are recorded, will never
 * be replayed, and are written as bare CREATE TABLEs that could not be.
 */
const FIRST_UNRECORDED_MIGRATION = "0006";

export function replayedMigrationFiles(): string[] {
  const from = migrationFiles().findIndex((f) =>
    path.basename(f).startsWith(FIRST_UNRECORDED_MIGRATION),
  );
  if (from === -1) {
    throw new Error(
      `no migration tagged ${FIRST_UNRECORDED_MIGRATION} - the replay boundary is stale`,
    );
  }
  return migrationFiles().slice(from);
}

/** Apply the migrations to a raw client. Exported so a test can apply them
 *  TWICE and prove the new ones are repeatable. */
export async function applyMigrations(
  client: PGlite,
  files: string[] = migrationFiles(),
): Promise<void> {
  for (const file of files) {
    const sql = readFileSync(file, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      try {
        await client.exec(trimmed);
      } catch (error) {
        throw new Error(
          `${path.basename(file)} failed: ${error instanceof Error ? error.message : String(error)}` +
            `\n--- statement ---\n${trimmed.slice(0, 400)}`,
        );
      }
    }
  }
}

export type TestDatabase = { db: TestDb; client: PGlite; close: () => Promise<void> };

export async function createTestDb(): Promise<TestDatabase> {
  const client = new PGlite();
  /**
   * BEFORE the first query, exactly as src/db/client.ts does it.
   *
   * PGlite freezes its session time zone from the host at initdb, so the 57
   * `defaultNow()` columns render in local time while Drizzle writes JS Dates
   * as UTC. Without this a row is BORN hours old - which here made every
   * pending sourcing run look abandoned the moment it was written, and the
   * concurrency tests pass for the wrong reason. See db/utc-clock.ts.
   */
  await pinUtcClock(client);
  await applyMigrations(client);
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}

/**
 * Point the application's own `getDb()` at this database.
 *
 * `src/db/client.ts` memoises its connection on `globalThis.__dbPromise` so it
 * survives hot reloads; that same handle is the seam a test uses to hand the
 * server action a database without mocking a module. Restore it afterwards.
 *
 * Deliberately loose about which Drizzle instance it takes: `getDb()` itself
 * returns a union of the PGlite and postgres-js adapters, and the parity suite
 * installs the latter. Narrowing this to one of them would have made the
 * driver comparison impossible to write.
 */
export function installAsAppDb(db: TestDb | object): () => void {
  const previous = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(db);
  return () => {
    (globalThis as { __dbPromise?: unknown }).__dbPromise = previous;
  };
}
