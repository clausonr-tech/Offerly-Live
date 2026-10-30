/**
 * A recovery point for one table, before a migration touches it.
 *
 * Two independent artifacts, because a backup you cannot restore is not a
 * backup and each of these fails differently:
 *
 *   .sql   pg_dump --data-only --column-inserts. Restores with psql.
 *   .json  a plain SELECT through the app's own driver. Survives a pg_dump
 *          version mismatch, and is readable without any Postgres binary.
 *
 * Both are verified against the live row count before this exits. READ ONLY
 * against the database - the only writes are to ./backups, which is
 * gitignored because these hold real student rows.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/backup-table.ts contact_sourcing_runs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPostgresClient, migrationCredentials } from "../src/db/connection";

/** Postgres.app's binaries. The system has no pg_dump on PATH. */
const PG_DUMP_CANDIDATES = [
  path.join(process.env.HOME ?? "", ".local/pg18/bin/pg_dump"),
  "/usr/local/bin/pg_dump",
  "/opt/homebrew/bin/pg_dump",
];

function findPgDump(): string | null {
  return PG_DUMP_CANDIDATES.find((p) => p && existsSync(p)) ?? null;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

async function main() {
  const table = process.argv[2];
  if (!table || !IDENTIFIER.test(table)) {
    throw new Error(`Usage: backup-table.ts <table_name>  (got ${JSON.stringify(table)})`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set - refusing to guess a target.");

  const redacted = url.replace(/:[^:@/]+@/, ":***@").replace(/\?.*$/, "");
  console.log(`table:  ${table}`);
  console.log(`target: ${redacted}`);

  mkdirSync("backups", { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const base = path.join("backups", `${table}_${stamp}`);

  const sql = createPostgresClient(url, { pooling: "as-configured", max: 1, idleTimeout: 5, connectTimeout: 15 }).sql;
  let live: number;
  try {
    const [version] = await sql<{ v: string }[]>`select version() as v`;
    console.log(`server: ${version.v.split(" on ")[0]}`);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    live = n;
    console.log(`rows:   ${live}`);

    const rows = await sql<Record<string, unknown>[]>`select * from ${sql(table)}`;
    writeFileSync(
      `${base}.json`,
      JSON.stringify({ table, target: redacted, takenAt: new Date().toISOString(), rows }, null, 2),
    );
    console.log(`wrote   ${base}.json (${rows.length} rows, ${statSync(`${base}.json`).size} bytes)`);
    if (rows.length !== live) throw new Error(`JSON export has ${rows.length} rows, table has ${live}`);
  } finally {
    await sql.end();
  }

  const pgDump = findPgDump();
  if (!pgDump) {
    console.log("pg_dump not found - the JSON export stands alone as the recovery point.");
    return;
  }
  // libpq, not postgres-js, so TLS is set here separately - the same
  // verify-full, with the same CA. The connection goes in as PG* env vars
  // rather than a URL argument: argv is visible to every process on the
  // machine (`ps`), and the URL carries the password.
  const creds = migrationCredentials(url);
  if (!creds.ssl) throw new Error("pg_dump is only run against a TLS-verified database.");
  const caDir = mkdtempSync(path.join(tmpdir(), "offerly-pgdump-"));
  const caFile = path.join(caDir, "ca.crt");
  writeFileSync(caFile, String(creds.ssl.ca), { mode: 0o600 });
  try {
    execFileSync(
      pgDump,
      ["--table", `public.${table}`, "--data-only", "--column-inserts", "--no-owner", "--file", `${base}.sql`],
      {
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          PGHOST: creds.host,
          PGPORT: String(creds.port),
          PGUSER: creds.user,
          PGPASSWORD: creds.password,
          PGDATABASE: creds.database,
          PGSSLMODE: "verify-full",
          PGSSLROOTCERT: caFile,
        },
      },
    );
  } finally {
    rmSync(caDir, { recursive: true, force: true });
  }

  // Trust nothing: count the INSERTs that actually landed in the file.
  const dumped = execFileSync("grep", ["-c", `^INSERT INTO public.${table} `, `${base}.sql`], {
    encoding: "utf8",
  }).trim();
  console.log(`wrote   ${base}.sql (${dumped} INSERT statements, ${statSync(`${base}.sql`).size} bytes)`);
  if (Number(dumped) !== live) {
    throw new Error(`pg_dump wrote ${dumped} INSERTs but the table has ${live} rows`);
  }

  console.log(`\nrecovery point verified: ${live} rows in both artifacts`);
  console.log(`restore with:  PGSSLMODE=verify-full PGSSLROOTCERT=<Supabase CA file> psql "$DATABASE_URL" -f ${base}.sql`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`BACKUP FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
