/**
 * Open the database a standalone script should be writing to.
 *
 * `src/db/client.ts` has always switched on DATABASE_URL - PGlite when it is
 * unset, real Postgres when it is set - but that only ever governed the Next.js
 * app. All 55 scripts in this repository construct PGlite directly:
 *
 *   const client = new PGlite(process.env.PGLITE_DATA_DIR || "./local-data/pglite");
 *
 * which ignores DATABASE_URL completely. So pointing the app at Supabase would
 * have moved the reads and left every WRITE behind: the crawler would have gone
 * on filling a local file that nothing served, and the migration would have
 * looked like a success while quietly becoming a fork. Two databases, both
 * live, diverging hourly, with no error anywhere.
 *
 * This is the same decision as client.ts, in a form a script can call.
 *
 * THE DEFAULT PATH IS DELIBERATE
 * ------------------------------
 * `./local-data/pglite` is the directory this repository lost on 18 September
 * 2026; the live one is named by PGLITE_DATA_DIR and is currently pglite-v3.
 * The dead directory is still on disk, so a script that runs WITHOUT its env
 * file silently opens a corrupt database and reports it as broken - which has
 * already cost two sessions of misdiagnosis. Rather than repeat the fallback,
 * this says so.
 */
import * as schema from "./schema";
import { pinUtcClock } from "./utc-clock";

export async function openDb() {
  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { createPostgresClient } = await import("./connection");
    /**
     * Connections, sized to the crawl rather than to one script.
     *
     * Four was right when monitor-run processed sources one after another and
     * only ever needed one. It now runs several at once, and every one of them
     * writes - check runs, listings, source health - so four connections
     * became a queue in front of Supabase while the fetch slots sat idle.
     *
     * Raised with the fetch concurrency it has to keep up with, and
     * overridable for the same reason: it is a property of the machine and the
     * database plan, not of anything this code knows.
     */
    // Transaction mode where the URL is a Supabase session-mode pooler: the
    // pool above is worth nothing if the project refuses the sixteenth client.
    // See db/pool.ts - this is what lost fifteen firms on 21 September 2026.
    // Verified TLS always - see db/tls.ts.
    const client = createPostgresClient(process.env.DATABASE_URL, {
      max: Number(process.env.OFFERLY_DB_POOL ?? 12),
      onnotice: () => {},
      // No statement or lock ceiling. The pair that connection.ts applies by
      // default - 30 seconds and 3 seconds - was reasoned about for the request
      // path, where a query nobody is waiting for should not hold a connection
      // and a lock wait is a sign of contention. An operator script is the
      // opposite case on both counts: scripts/apply-news-schema.ts runs raw
      // CREATE TABLE and ALTER TABLE statements, which take ACCESS EXCLUSIVE
      // and will wait behind a live app for longer than three seconds, and the
      // backfills legitimately run a single statement for minutes. With the
      // defaults, the DDL applier died with "canceling statement due to lock
      // timeout" part-way through its list of statements - the migration half
      // applied, which is the one outcome every migration in this repo is
      // written to avoid. Zero is Postgres's own "no limit" and is what every
      // script had before the ceilings were introduced.
      statementTimeoutMs: 0,
      lockTimeoutMs: 0,
    });
    return {
      db: drizzle(client.sql, { schema }),
      poolMode: client.poolMode,
      poolNote: client.poolNote,
      close: async () => {
        await client.sql.end({ timeout: 5 });
      },
      backend: "postgres" as const,
    };
  }

  const { drizzle } = await import("drizzle-orm/pglite");
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DATA_DIR;
  if (!dir) {
    throw new Error(
      "Neither DATABASE_URL nor PGLITE_DATA_DIR is set.\n" +
        "Run this with --env-file=.env.local. Defaulting to ./local-data/pglite would open the\n" +
        "database that was corrupted on 18 September 2026, which aborts inside WebAssembly and\n" +
        "looks exactly like a broken script.",
    );
  }

  const client = new PGlite(dir);
  // The column defaults and the application have to agree on what time it is;
  // see utc-clock.ts for what happened when they did not.
  await pinUtcClock(client);
  return {
    db: drizzle(client, { schema }),
    close: () => client.close(),
    backend: "pglite" as const,
  };
}
