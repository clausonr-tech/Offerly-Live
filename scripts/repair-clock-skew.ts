// Correct the timestamps written by the wrong clock, and reopen what it closed.
//
// The cause is in src/db/utc-clock.ts and is fixed there for everything
// written from now on. This is the other half: the rows already on disk.
//
// WHAT IS WRONG WITH THEM
// -----------------------
// `timestamp` columns filled by Postgres `now()` were rendered in PGlite's
// frozen session zone (Etc/GMT+5 here), while everything Drizzle wrote from a
// JS Date was rendered in UTC. Drizzle reads both back as UTC, so the
// now()-written values are exactly five hours behind the truth.
//
// Which values those are is knowable rather than guessable:
//
//   detected_listings.created_at        - never written explicitly anywhere in
//                                         this repository, so always the
//                                         default, so always skewed.
//   detected_listings.last_confirmed_at - the default on INSERT, a JS Date on
//                                         every re-confirmation. A row that has
//                                         never been re-confirmed still carries
//                                         the default, and that is exactly the
//                                         rows where it equals created_at.
//
// The signature is visible in the data and was checked before this was written:
// of the rows that HAVE been re-confirmed, not one has a gap under five hours
// (381 at exactly 5h, 232 at 7h). A genuine gap could be one hour or two. The
// hard floor at five is the skew.
//
// WHY ROWS ARE REOPENED
// ---------------------
// `decideClosure` closes a listing missing for more than 1.5 check cycles. A
// row born five hours stale is past that on its first missed check, so it was
// closed while still live. Reopening is restricted to rows that would NOT have
// been closed once their timestamp is corrected - not every closed row - which
// is the difference between undoing this bug and discarding real closures.
//
// Reopening is also the recoverable direction. A wrongly closed internship is
// invisible to students and nothing ever looks at it again; a wrongly reopened
// one is closed again by the next check that does not find it.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/repair-clock-skew.ts
//   ... --apply
//
// Stop the dev server first - PGlite is single-writer.
import { PGlite } from "@electric-sql/pglite";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { pinUtcClock } from "../src/db/utc-clock";

const APPLY = process.argv.includes("--apply");

/**
 * How far behind the default clock is, measured rather than assumed.
 *
 * Read BEFORE pinning the session to UTC, because pinning is what removes the
 * evidence. A database whose session is already UTC cannot report its own
 * history, so this refuses to guess and asks to be told.
 */
function statedSkew(): number | null {
  const flag = process.argv.find((a) => a.startsWith("--skew-hours="));
  return flag ? Number(flag.split("=")[1]) : null;
}

async function main() {
  await assertExclusiveDbAccess();
  const client = new PGlite(process.env.PGLITE_DATA_DIR || "./local-data/pglite");
  const q = async (sql: string) => (await client.query(sql)).rows as Record<string, unknown>[];

  try {
    // ---------------------------------------------------- measure the skew
    const zone = String((await q("select current_setting('TimeZone') as t"))[0].t);
    const pgNow = String((await q("select now()::timestamp::text as t"))[0].t);
    const measuredMs = Date.now() - Date.parse(pgNow + "Z");
    const measuredHours = Math.round(measuredMs / 3_600_000);

    console.log(`session zone      : ${zone}`);
    console.log(`default clock is  : ${measuredHours}h behind UTC (measured)`);

    const skew = statedSkew() ?? measuredHours;
    if (!Number.isFinite(skew) || skew === 0) {
      console.log(
        "\nNothing to measure: the session is already UTC, so this database cannot report the\n" +
          "skew its old rows were written with. If rows still need correcting, state it:\n" +
          "  --skew-hours=5",
      );
      return;
    }
    console.log(`correcting by     : +${skew}h\n`);

    // Pinned only after the measurement above, and needed for the reopen test
    // below to compare like with like.
    await pinUtcClock(client);

    // ------------------------------------------------------- what is affected
    const counts = (
      await q(`
      select count(*) as total,
             count(*) filter (where last_confirmed_at = created_at) as defaulted,
             count(*) filter (where status = 'closed') as closed
      from detected_listings`)
    )[0];
    console.log(
      `detected_listings : ${counts.total} rows, ${counts.defaulted} still carrying the default ` +
        `confirmation time, ${counts.closed} closed`,
    );

    /**
     * The rows this bug closed, as opposed to the rows that genuinely ended.
     *
     * A closure was wrong if, with the timestamp corrected, the listing had
     * NOT been missing for more than 1.5 check cycles at the moment it was
     * closed. `updated_at` is set from a JS Date when a row is closed, so it
     * is already correct and the two are comparable.
     *
     * The tier interval is joined in rather than assumed, because an hourly
     * source and a daily one disagree about what "too long" means by a factor
     * of twenty-four.
     */
    const reopenable = `
      select l.id
      from detected_listings l
      join firm_monitoring_sources s on s.id = l.source_id
      left join monitoring_tiers t on t.id = s.tier_id
      where l.status = 'closed'
        and l.last_confirmed_at = l.created_at
        and l.updated_at - (l.last_confirmed_at + interval '${skew} hours')
            <= (coalesce(t.check_interval_minutes, 1440) * 1.5) * interval '1 minute'`;

    const toReopen = await q(reopenable);
    console.log(`wrongly closed    : ${toReopen.length} (closed sooner than their own grace period allowed)`);

    if (!APPLY) {
      console.log("\nDry run - re-run with --apply to write these.");
      return;
    }

    // ------------------------------------------------------------- write it
    // One statement, so every right-hand side reads the pre-correction row and
    // the `last_confirmed_at = created_at` test is not broken by its own fix.
    const listings = await q(`
      update detected_listings
      set created_at = created_at + interval '${skew} hours',
          last_confirmed_at = case when last_confirmed_at = created_at
                                   then last_confirmed_at + interval '${skew} hours'
                                   else last_confirmed_at end
      returning id`);
    console.log(`corrected ${listings.length} detected_listings rows`);

    // Same insert-default / update-JS split, same code path in monitor-run.
    const events = await q(`
      update firm_recruiting_events
      set created_at = created_at + interval '${skew} hours',
          last_confirmed_at = case when last_confirmed_at = created_at
                                   then last_confirmed_at + interval '${skew} hours'
                                   else last_confirmed_at end
      returning id`);
    console.log(`corrected ${events.length} firm_recruiting_events rows`);

    if (toReopen.length) {
      const ids = toReopen.map((r) => `'${r.id}'`).join(",");
      // Re-selected after the correction rather than reusing the list above:
      // the ids are the same, but reopening rows the correction did not in
      // fact rescue would be exactly the mistake this script exists to undo.
      await client.query(`update detected_listings set status = 'open' where id in (${ids})`);
      console.log(`reopened ${toReopen.length} listings closed before their grace period expired`);
    }

    const after = (
      await q(`
      select count(*) filter (where status = 'open') as open,
             count(*) filter (where status = 'closed') as closed,
             max(last_confirmed_at)::text as newest
      from detected_listings`)
    )[0];
    console.log(`\nnow: ${after.open} open, ${after.closed} closed, newest confirmation ${after.newest}`);
    console.log(`js now                                        ${new Date().toISOString().replace("T", " ").slice(0, 23)}`);
  } finally {
    await client.close();
  }
}

main();
