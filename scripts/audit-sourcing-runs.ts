/**
 * READ-ONLY pre-flight audit for drizzle/0008.
 *
 * Answers, against whatever DATABASE_URL points at:
 *
 *   - how many contact_sourcing_runs rows exist
 *   - which of them would violate each NOT VALID constraint
 *   - whether the new columns or indexes are already present
 *   - what drizzle believes it has already applied
 *
 * Every statement here is a SELECT. There is no INSERT, UPDATE, DELETE, ALTER
 * or CREATE in this file, and it opens a single connection with a short
 * statement timeout so it cannot sit on the pooler.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/audit-sourcing-runs.ts
 */

import { createPostgresClient } from "../src/db/connection";

const HEADING = (title: string) => console.log(`\n== ${title} ${"=".repeat(Math.max(0, 62 - title.length))}`);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set - refusing to guess a target.");
  console.log(`target: ${url.replace(/:[^:@/]+@/, ":***@").replace(/\?.*$/, "")}`);

  const sql = createPostgresClient(url, { pooling: "as-configured", max: 1, idleTimeout: 5, connectTimeout: 15 }).sql;
  try {
    await sql`set statement_timeout = '30s'`;

    HEADING("table size");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from contact_sourcing_runs`;
    console.log(`contact_sourcing_runs: ${n} rows`);
    const byStatus = await sql<{ status: string; n: number; credits: number }[]>`
      select status, count(*)::int as n, coalesce(sum(credits_spent), 0)::int as credits
      from contact_sourcing_runs group by status order by 2 desc`;
    for (const r of byStatus) console.log(`  ${r.status.padEnd(12)} ${String(r.n).padStart(5)} rows, ${r.credits} credits`);

    HEADING("would violate contact_sourcing_charge_needs_contacts");
    const charged = await sql<Record<string, unknown>[]>`
      select id, user_id, firm_id, status, credits_spent, contacts_created, created_at
      from contact_sourcing_runs
      where not (credits_spent = 0 or contacts_created > 0)
      order by created_at`;
    console.log(`${charged.length} row(s)`);
    for (const r of charged) console.log(" ", JSON.stringify(r));

    HEADING("would violate contact_sourcing_credits_nonnegative");
    const negative = await sql<Record<string, unknown>[]>`
      select id, user_id, status, credits_spent, contacts_created, created_at
      from contact_sourcing_runs
      where not (credits_spent >= 0 and contacts_created >= 0)
      order by created_at`;
    console.log(`${negative.length} row(s)`);
    for (const r of negative) console.log(" ", JSON.stringify(r));

    HEADING("would violate the unique idempotency index");
    // Only non-null keys can collide; nulls are indexed as distinct.
    const hasKeyColumn = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
      where table_name = 'contact_sourcing_runs' and column_name = 'idempotency_key'`;
    if (!hasKeyColumn[0].n) {
      console.log("0 row(s) - the column does not exist yet, so nothing can collide");
    } else {
      const dupes = await sql<{ idempotency_key: string; n: number }[]>`
        select idempotency_key, count(*)::int as n
        from contact_sourcing_runs
        where idempotency_key is not null
        group by idempotency_key having count(*) > 1 order by 2 desc`;
      console.log(`${dupes.length} duplicated key(s)`);
      for (const r of dupes) console.log(` ${r.idempotency_key} x${r.n}`);
    }

    HEADING("would violate the mode vocabulary (generate | refresh | fill)");
    const hasMode = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
      where table_name = 'contact_sourcing_runs' and column_name = 'mode'`;
    if (!hasMode[0].n) {
      console.log("0 row(s) - the column does not exist yet");
    } else {
      const bad = await sql<{ mode: string; n: number }[]>`
        select mode, count(*)::int as n from contact_sourcing_runs
        where mode not in ('generate', 'refresh', 'fill') group by mode`;
      console.log(`${bad.length} bad mode value(s)`);
      for (const r of bad) console.log(` ${r.mode} x${r.n}`);
    }

    HEADING("other invariants the new code assumes");
    const [{ n: pending }] = await sql<{ n: number }[]>`
      select count(*)::int as n from contact_sourcing_runs where status = 'pending'`;
    console.log(`pending rows (would be treated as in-flight or abandoned): ${pending}`);
    const [{ n: nullCreated }] = await sql<{ n: number }[]>`
      select count(*)::int as n from contact_sourcing_runs where created_at is null`;
    console.log(`rows with a null created_at (staleness cannot be judged): ${nullCreated}`);
    const [{ n: overCharged }] = await sql<{ n: number }[]>`
      select count(*)::int as n from contact_sourcing_runs where credits_spent > 1`;
    console.log(`rows charged more than one credit: ${overCharged}`);

    HEADING("is anything already deployed using the new schema?");
    const cols = await sql<{ column_name: string; data_type: string; column_default: string | null; is_nullable: string }[]>`
      select column_name, data_type, column_default, is_nullable
      from information_schema.columns
      where table_name = 'contact_sourcing_runs'
        and column_name in ('idempotency_key', 'mode', 'refresh_sequence')
      order by column_name`;
    console.log(cols.length ? cols.map((c) => `  ${c.column_name} ${c.data_type} default=${c.column_default} nullable=${c.is_nullable}`).join("\n") : "  none of the three columns exist - the database is pre-0008");
    const idx = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where tablename = 'contact_sourcing_runs' order by indexname`;
    for (const i of idx) console.log(`  index ${i.indexname}: ${i.indexdef}`);
    const con = await sql<{ conname: string; convalidated: boolean; def: string }[]>`
      select conname, convalidated, pg_get_constraintdef(oid) as def
      from pg_constraint where conrelid = 'contact_sourcing_runs'::regclass and contype = 'c'
      order by conname`;
    for (const c of con) console.log(`  check ${c.conname} validated=${c.convalidated}: ${c.def}`);

    HEADING("what drizzle believes it has applied");
    const tracked = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'drizzle' and table_name = '__drizzle_migrations'`;
    if (!tracked[0].n) {
      console.log("  drizzle.__drizzle_migrations DOES NOT EXIST.");
      console.log("  `drizzle-kit migrate` would treat this database as empty and replay 0000 onwards.");
    } else {
      const rows = await sql<{ hash: string; created_at: string }[]>`
        select hash, created_at from drizzle.__drizzle_migrations order by created_at`;
      console.log(`  ${rows.length} migration(s) recorded`);
      for (const r of rows) console.log(`   ${new Date(Number(r.created_at)).toISOString()}  ${r.hash.slice(0, 16)}`);
    }
  } finally {
    await sql.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
