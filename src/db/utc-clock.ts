/**
 * Make the database and the application agree on what time it is.
 *
 * Every timestamp column in this schema is `timestamp` - no time zone. That is
 * fine on its own, but only while ONE clock writes them. Two were:
 *
 *   - Drizzle serialises a JS `Date` into such a column as a UTC wall clock.
 *   - The column defaults (`defaultNow()`, 57 of them) are filled by Postgres
 *     `now()`, which renders in the SESSION time zone.
 *
 * PGlite froze its session zone at initdb time from the host, and on this
 * machine that is `Etc/GMT+5`. Measured on 19 September 2026, same instant,
 * same column:
 *
 *   inserted by now()      -> 2026-09-19 22:21:39
 *   inserted by a JS Date  -> 2026-09-20 03:21:39
 *
 * Five hours apart. On the way back out Drizzle labels whatever it finds as
 * UTC, so a row the default clock wrote is read as five hours older than it is.
 *
 * That is not cosmetic. `decideClosure` closes a listing that has been missing
 * for more than one and a half check cycles - ninety minutes on an hourly
 * source. A newly inserted listing takes `lastConfirmedAt` from the default, so
 * it is BORN three hundred minutes stale and the grace period cannot protect
 * it: the first check that fails to return it closes it. On 19 September that
 * closed 49 live Morgan Stanley postings 62 minutes after they were found, and
 * every one of the 172 closed rows in the database was a row that had never
 * been re-confirmed - a perfect correlation, because a re-confirmed row gets a
 * JS `Date` and a correct timestamp.
 *
 * The fix is to give the default clock the same zone the application uses.
 * With the session in UTC, `now()` and a JS `Date` write the identical wall
 * clock, and reading it back as UTC is then simply true.
 *
 * WHY THIS IS A PER-CONNECTION `SET`
 * ----------------------------------
 * The obvious fix was `ALTER DATABASE ... SET TimeZone TO 'UTC'`, so that all
 * 55 places which open PGlite directly would inherit it without having to know
 * to ask. That was tried, and it does not work. The setting persists correctly
 * - `pg_db_role_setting` reads back `TimeZone=UTC` - and PGlite then ignores
 * it, deriving the session zone from the process environment at boot instead:
 *
 *   fresh connection TimeZone : Etc/GMT+5
 *   pg_db_role_setting        : ["TimeZone=UTC"]
 *
 * So the `SET` below is what actually does the work, and the ALTER is kept
 * only because a real Postgres - Supabase, shortly - does honour it, and the
 * skew must not come back on the way across.
 *
 * Setting `TZ=UTC` in the environment also works, and was measured to
 * (`Etc/GMT0`, `now()` in UTC). It is deliberately not done here: this module
 * is imported by the Next.js app, and changing the process zone would silently
 * move every date a user is shown.
 *
 * THE DURABLE GUARD IS NOT THIS FUNCTION
 * --------------------------------------
 * It is having ONE writer. A column filled by both `now()` and a JS Date is
 * only ever as correct as the zone happens to be, so the decision-critical
 * timestamps are written explicitly - see `lastConfirmedAt` in
 * scripts/monitor-run.ts. This function stops the remaining defaults lying.
 */

type Queryable = { query: (sql: string) => Promise<unknown> };

/**
 * Pin the session - and every future session on this database - to UTC.
 *
 * Idempotent and cheap, so it is safe on every connection. Never throws: a
 * database that refuses the ALTER (a read-only replica, a restricted role) is
 * still a database worth talking to, and the `SET` alone fixes the connection
 * in hand.
 */
export async function pinUtcClock(client: Queryable): Promise<void> {
  // This connection, immediately.
  try {
    await client.query("SET TimeZone TO 'UTC'");
  } catch {
    // Nothing further to try; a wrong zone is a wrong timestamp, not a crash.
    return;
  }

  // Every future connection, persisted in the catalogue. Separate try: the
  // SET above is the one that matters for the work about to happen, and losing
  // the ALTER should not discard it.
  try {
    await client.query("ALTER DATABASE postgres SET TimeZone TO 'UTC'");
  } catch {
    // Not PGlite's default database name, or no privilege to alter it. The
    // SET has already corrected this connection.
  }
}
