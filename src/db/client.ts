import * as schema from "./schema";

// Local dev (no DATABASE_URL set): embedded WASM Postgres via PGlite, persisted
// to ./local-data/pglite on disk. No Docker/server/admin access required.
//
// Production (DATABASE_URL set, e.g. a Supabase connection string): real
// Postgres over the network via postgres-js. The schema is identical either
// way, so switching is a one-line env change, not a rewrite.

// Where the embedded Postgres keeps its files. Overridable because a PGlite
// directory can be corrupted beyond repair - it is a single-writer store, and
// two processes opening it at once (a dev server plus a `drizzle-kit push`, say)
// is enough to do it. When that happens the engine aborts on every query,
// including `select 1`, and there is no repair tool in WASM. Pointing this at a
// new directory is the recovery path, and it leaves the old one in place to
// inspect rather than demanding it be deleted first.
function pgliteDataDir() {
  return process.env.PGLITE_DATA_DIR || "./local-data/pglite";
}

async function createDb() {
  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { createPostgresClient } = await import("./connection");
    /**
     * Transaction mode, verified TLS, and an explicit connection count.
     *
     * `postgres(url)` with no `max` defaults to TEN. On the session-mode
     * pooler the whole project gets fifteen, so the dev server sitting idle
     * held two thirds of them and the hourly crawl was refused - see pool.ts.
     * The number is spelled out here because a default that large should not
     * be invisible. TLS is not optional and not configurable here - see tls.ts.
     */
    const { sql } = createPostgresClient(process.env.DATABASE_URL, {
      max: Number(process.env.OFFERLY_WEB_DB_POOL ?? 8),
    });
    return drizzle(sql, { schema });
  }

  const { drizzle } = await import("drizzle-orm/pglite");
  const { PGlite } = await import("@electric-sql/pglite");
  const { pinUtcClock } = await import("./utc-clock");
  const client = new PGlite(pgliteDataDir());
  // Before the first query: the column defaults and the application have to
  // mean the same thing by a timestamp. See utc-clock.ts - they did not, and
  // it silently closed live job postings.
  await pinUtcClock(client);
  return drizzle(client, { schema });
}

// Cache the singleton across hot reloads in dev.
declare global {
  // eslint-disable-next-line no-var
  var __dbPromise: ReturnType<typeof createDb> | undefined;
}

export function getDb() {
  if (!global.__dbPromise) {
    global.__dbPromise = createDb();
  }
  return global.__dbPromise;
}
