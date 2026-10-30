/**
 * The database a script should be writing to, opened the same way every time.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/db/open.ts` was written on 21 September 2026 to end exactly one bug:
 * a script that constructs `new PGlite(...)` itself ignores DATABASE_URL, so
 * pointing the app at Supabase moved the READS and left the WRITES behind.
 * Its own header says it: "Two databases, both live, diverging hourly, with
 * no error anywhere."
 *
 * The abstraction landed and the migration stopped. `monitor-run.ts` and four
 * others were converted; forty-three scripts were not. So on 11 October 2026
 * the crawler was writing 28,597 check runs into Supabase while every tool
 * that judges it - `crawl-status.ts`, `crawl-inspect.ts`, `classifier-report.ts`,
 * `verify-classifier-corpus.ts`, every `audit-*.ts` - read `local-data/pglite`,
 * last written on 21 September. Twenty days stale, reported as current.
 *
 * `adjudicate-rejections.ts` was worse than stale: it WRITES, so its verdicts
 * went into the dead directory.
 *
 * `crawl-status.ts` had already argued the point in its own header - "a status
 * script that reports zero activity on a system that is working is worse than
 * no status script, because it gets believed" - about a different bug, in the
 * file that then went on to read the wrong database for three weeks.
 *
 * WHAT THIS ADDS OVER CALLING openDb() DIRECTLY
 * ---------------------------------------------
 * Two things every one of those scripts had hand-rolled:
 *
 *  1. `assertExclusiveDbAccess()`, which each one called itself, and which a
 *     new script could forget. It is a no-op once DATABASE_URL is set.
 *
 *  2. Closing the connection. A PGlite script could simply end - it left a
 *     stale `postmaster.pid` and nothing else. postgres-js holds the event
 *     loop open, so the same script now hangs forever instead of exiting.
 *     `beforeExit` closes the pool for scripts that fall off the end, and
 *     scripts that call `process.exit()` are unaffected either way.
 *
 * scripts/test/script-db-guard.test.ts fails the suite if a script constructs
 * PGlite directly again.
 */
import { openDb } from "../src/db/open";
import type { Db } from "../src/db/types";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";

type Opened = Awaited<ReturnType<typeof openDb>>;

let opened: Opened | null = null;

/**
 * Open it once per process.
 *
 * Cached because several scripts open the database from more than one place -
 * a `main()` and a helper - and two pools against a Supabase pooler is how
 * this repository lost fifteen firms on 21 September. See src/db/pool.ts.
 */
export async function openScriptDb(): Promise<{
  db: Db;
  close: () => Promise<void>;
  backend: Opened["backend"];
}> {
  if (!opened) {
    // `viaOpenDb` suppresses exclusive-db.ts's "this script writes to the
    // wrong database" warning, which is correct for a direct PGlite caller
    // and wrong for this one. That warning is also the detector that had been
    // firing on all 43 unported scripts, on every run, for three weeks.
    await assertExclusiveDbAccess({ viaOpenDb: true });
    opened = await openDb();
    // Not `process.on`: beforeExit fires again after an async handler settles,
    // and closing a closed pool throws.
    process.once("beforeExit", () => {
      void closeScriptDb();
    });
  }
  return { db: opened.db, close: closeScriptDb, backend: opened.backend };
}

/**
 * Close it, at most once.
 *
 * Swallows its own failure deliberately: this runs on the way out, and a
 * socket that will not shut down cleanly must not turn a successful script
 * into a failed one.
 */
export async function closeScriptDb(): Promise<void> {
  const it = opened;
  opened = null;
  if (!it) return;
  try {
    await it.close();
  } catch {
    // Nothing useful left to do with it; the process is leaving.
  }
}

/**
 * The rows out of a `db.execute()`, whichever driver answered.
 *
 * This is the one place the two drivers are not interchangeable: PGlite's
 * drizzle returns `{ rows: [...] }` and postgres-js returns the array itself.
 * Reading `.rows` was correct while a script only ever opened PGlite; it is
 * `undefined` against Supabase, which would have a schema check report every
 * column as missing from a database that has them all.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
