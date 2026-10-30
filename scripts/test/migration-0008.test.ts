/**
 * Deploying drizzle/0008, rehearsed.
 *
 * Not "does the SQL parse" - that is covered wherever the schema is built.
 * This file reproduces the SHARED DATABASE'S ACTUAL LEDGER STATE and runs the
 * repository's own migration mechanism against it, because that state turned
 * out to be the risk:
 *
 *   drizzle.__drizzle_migrations on Supabase records SIX migrations, the last
 *   at 2026-09-22T01:11:36.698Z. Migrations 0006 and 0007 were applied by hand
 *   and never recorded, so `drizzle-kit migrate` sees them as outstanding and
 *   replays them. As originally written they were plain ADD COLUMN, so the
 *   replay would have failed on the first one and 0008 would never have run.
 *
 * Everything here is in-memory PGlite. No DATABASE_URL, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import "./helpers/no-network";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { migrationFiles } from "./helpers/test-db";
import { pinUtcClock } from "@/db/utc-clock";

/** 0008's own journal timestamp - the ledger row the rollback removes. Read
 *  from the journal rather than pasted, so a regenerated migration cannot
 *  leave the rollback silently deleting nothing. */
const JOURNAL = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { tag: string; when: number }[];
};
const MIGRATION_0008_WHEN = JOURNAL.entries.find((e) => e.tag.startsWith("0008"))!.when;

/** The last `created_at` in the shared database's migration ledger. */
const PROD_LAST_CREATED_AT = 1790039496698;

/** The six rows Supabase actually carries, hashes truncated as audited. */
const PROD_LEDGER: [string, number][] = [
  ["d49d7345751e1c37", 1789699268808],
  ["1e76c3760ca0ac35", 1789781711845],
  ["cc78842436ef2738", 1789947316149],
  ["bea181c8a1326edc", 1790018491580],
  ["2347e16ea0bda915", 1790020517224],
  ["f3e2394d9ea7340c", PROD_LAST_CREATED_AT],
];

const USER = "11111111-1111-4111-8111-111111111111";
const FIRM = "22222222-2222-4222-8222-222222222222";

async function applyFiles(client: PGlite, files: string[]): Promise<void> {
  for (const file of files) {
    for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
}

/** A database shaped like production the moment before 0008 is applied. */
async function productionReplica(): Promise<PGlite> {
  const client = new PGlite();
  await pinUtcClock(client);
  await applyFiles(client, migrationFiles().filter((f) => !f.includes("0008")));

  await client.exec(
    `insert into users (id, email, password_hash, name, plan)
     values ('${USER}', 'a@b.edu', 'x', 'A', 'pro')`,
  );
  await client.exec(
    `insert into firms (id, slug, name, headquarters, key_offices, description, website)
     values ('${FIRM}', 'evercore', 'Evercore', 'NY', 'NY', 'd', 'https://evercore.com')`,
  );
  // 26 rows, 20 credits - the audited production shape.
  for (let i = 0; i < 26; i++) {
    await client.exec(
      `insert into contact_sourcing_runs (user_id, firm_id, credits_spent, contacts_requested, contacts_created, status)
       values ('${USER}', '${FIRM}', ${i < 20 ? 1 : 0}, 5, 5, 'succeeded')`,
    );
  }

  await client.exec("create schema if not exists drizzle");
  await client.exec(
    `create table if not exists drizzle."__drizzle_migrations"
     (id serial primary key, hash text not null, created_at bigint)`,
  );
  for (const [hash, when] of PROD_LEDGER) {
    await client.exec(
      `insert into drizzle."__drizzle_migrations" (hash, created_at) values ('${hash}', ${when})`,
    );
  }
  return client;
}

const count = async (client: PGlite, sql: string): Promise<number> =>
  (await client.query<{ n: number }>(sql)).rows[0].n;

test("`db:migrate` against the real ledger state applies 0008 and preserves every row", async () => {
  const client = await productionReplica();
  try {
    const before = await count(client, "select count(*)::int as n from contact_sourcing_runs");
    assert.equal(before, 26);

    await migrate(drizzle(client), { migrationsFolder: "drizzle" });

    assert.equal(
      await count(client, "select count(*)::int as n from contact_sourcing_runs"),
      26,
      "the migration lost or rewrote history",
    );
    assert.equal(
      await count(client, "select coalesce(sum(credits_spent),0)::int as n from contact_sourcing_runs"),
      20,
      "the billing history changed",
    );

    // The ledger heals: the two hand-applied migrations get recorded on the way past.
    //
    // Counted from the journal rather than written as a number, for the same
    // reason MIGRATION_0008_WHEN is read from it above. A literal 9 asserts
    // "nobody has added a migration since this test was written", which is not
    // the property under test and fails on the next person to add one - 0009
    // did exactly that, taking five of this file's seven tests with it.
    assert.equal(
      await count(client, `select count(*)::int as n from drizzle."__drizzle_migrations"`),
      JOURNAL.entries.length,
      "every migration in the journal should be recorded after migrate()",
    );
  } finally {
    await client.close();
  }
});

test("replaying 0006 and 0007 over columns that already exist is a no-op", async () => {
  // The specific failure this file exists to prevent. Without the IF NOT
  // EXISTS guards, `migrate()` aborts here and 0008 never runs.
  const client = await productionReplica();
  try {
    await assert.doesNotReject(
      applyFiles(client, migrationFiles().filter((f) => /000[67]/.test(f))),
    );
  } finally {
    await client.close();
  }
});

test("migrate() is idempotent: a second run changes nothing", async () => {
  const client = await productionReplica();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: "drizzle" });
    const ledger = await count(client, `select count(*)::int as n from drizzle."__drizzle_migrations"`);
    await migrate(db, { migrationsFolder: "drizzle" });
    assert.equal(
      await count(client, `select count(*)::int as n from drizzle."__drizzle_migrations"`),
      ledger,
      "a second migrate() re-recorded migrations",
    );
    assert.equal(await count(client, "select count(*)::int as n from contact_sourcing_runs"), 26);
  } finally {
    await client.close();
  }
});

test("a failure part-way through leaves NO partially migrated schema", async () => {
  // drizzle wraps the whole batch in one transaction. Proved rather than
  // trusted: a broken statement appended to the run must take the columns
  // added before it back out with it.
  const client = await productionReplica();
  try {
    const db = drizzle(client);
    await assert.rejects(
      db.transaction(async (tx) => {
        for (const statement of readFileSync(
          migrationFiles().find((f) => f.includes("0008"))!,
          "utf8",
        ).split("--> statement-breakpoint")) {
          const trimmed = statement.trim();
          if (trimmed) await tx.execute(trimmed);
        }
        await tx.execute("ALTER TABLE contact_sourcing_runs ADD COLUMN bad NOT A TYPE");
      }),
    );

    const columns = await count(
      client,
      `select count(*)::int as n from information_schema.columns
       where table_name = 'contact_sourcing_runs'
         and column_name in ('idempotency_key', 'mode', 'refresh_sequence')`,
    );
    assert.equal(columns, 0, "a failed migration left columns behind");
    assert.equal(
      await count(
        client,
        `select count(*)::int as n from pg_constraint
         where conname = 'contact_sourcing_charge_needs_contacts'`,
      ),
      0,
      "a failed migration left a constraint behind",
    );
  } finally {
    await client.close();
  }
});

test("the NOT VALID constraints are added without scanning the table", async () => {
  // NOT VALID is what keeps the lock brief: Postgres skips the full-table
  // verification it would otherwise do. If either were ever added as VALID,
  // it would both fail on historical rows and hold an ACCESS EXCLUSIVE lock
  // for the length of a scan.
  const client = await productionReplica();
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    const rows = await client.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint
       where conrelid = 'contact_sourcing_runs'::regclass and contype = 'c' order by conname`,
    );
    assert.equal(rows.rows.length, 2);
    for (const row of rows.rows) {
      assert.equal(row.convalidated, false, `${row.conname} was added as VALID`);
    }
  } finally {
    await client.close();
  }
});

test("after 0008, the audited production data would still pass VALIDATE CONSTRAINT", async () => {
  // The audit says zero historical violations. This is that claim executed:
  // if it holds, the later VALIDATE step is safe; if a violating row ever
  // appears, this fails and the validation must not be run.
  const client = await productionReplica();
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    await assert.doesNotReject(
      client.exec(
        `ALTER TABLE contact_sourcing_runs VALIDATE CONSTRAINT contact_sourcing_charge_needs_contacts;
         ALTER TABLE contact_sourcing_runs VALIDATE CONSTRAINT contact_sourcing_credits_nonnegative;`,
      ),
    );
  } finally {
    await client.close();
  }
});

test("the rollback SQL returns the table to its pre-0008 shape", async () => {
  const client = await productionReplica();
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    await client.exec(`
      ALTER TABLE contact_sourcing_runs DROP CONSTRAINT IF EXISTS contact_sourcing_charge_needs_contacts;
      ALTER TABLE contact_sourcing_runs DROP CONSTRAINT IF EXISTS contact_sourcing_credits_nonnegative;
      DROP INDEX IF EXISTS contact_sourcing_idempotency_uq;
      DROP INDEX IF EXISTS contact_sourcing_user_firm_status_idx;
      ALTER TABLE contact_sourcing_runs DROP COLUMN IF EXISTS idempotency_key;
      ALTER TABLE contact_sourcing_runs DROP COLUMN IF EXISTS mode;
      ALTER TABLE contact_sourcing_runs DROP COLUMN IF EXISTS refresh_sequence;
      DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = ${MIGRATION_0008_WHEN};
    `);

    assert.equal(
      await count(client, `select count(*)::int as n from drizzle."__drizzle_migrations"`),
      // One fewer than the journal holds: the rollback above deleted exactly
      // 0008's row. Relative for the same reason as the count above.
      JOURNAL.entries.length - 1,
      "the rollback did not remove 0008's ledger row - migrate() would skip it on retry",
    );

    assert.equal(
      await count(
        client,
        `select count(*)::int as n from information_schema.columns
         where table_name = 'contact_sourcing_runs'
           and column_name in ('idempotency_key', 'mode', 'refresh_sequence')`,
      ),
      0,
    );
    assert.equal(
      await count(client, "select count(*)::int as n from contact_sourcing_runs"),
      26,
      "the rollback destroyed data",
    );
    assert.equal(
      await count(client, "select coalesce(sum(credits_spent),0)::int as n from contact_sourcing_runs"),
      20,
      "the rollback changed the billing history",
    );
  } finally {
    await client.close();
  }
});
