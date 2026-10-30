// Put back the text the merge turned into timestamps.
//
// WHAT WENT WRONG
// ---------------
// scripts/merge-into-recruit.ts ran every value of every copied row through
// safeTimestamp, not just the timestamp columns, and a JS Date parses nearly
// anything with a number in it. So on 21 September text columns received
// timestamps: posting titles ("Summer Analyst, Investment Banking, BDO Capital
// Advisors - Summer 2028 (Richmond)" -> "2028-01-01 00:00:00+00"), apply links,
// error messages ("HTTP 403" -> "0403-01-01 ..."), and the crawler's own
// external job ids ("9874" -> "9874-01-01 ..."), which is what it matches
// listings by. Measured before this ran: 1,001 cells across six tables. The
// merge script is fixed; this repairs what it already wrote.
//
// HOW
// ---
// Same approach as scripts/repair-merged-timestamps.ts: every merged row still
// exists in the source under the SAME uuid, so the true value is read and
// written back - no guessing. A cell is repaired only when all three hold:
//   - it is a text column holding a timestamp-shaped value in the target,
//   - the same row exists in the source,
//   - the source value differs.
// Anything else is left alone and counted.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/repair-merged-text.ts
//   ... --apply
//
// DATABASE_URL is the target being repaired; SOURCE_DATABASE_URL is the
// database the rows came from (Offerly 1). Both SESSION pooler URIs (port 5432).
import { createPostgresClient } from "../src/db/connection";

const APPLY = process.argv.includes("--apply");

// The merge's copied tables (DEFAULT_SCOPE in merge-into-recruit.ts).
const TABLES = [
  "firm_monitoring_sources",
  "internship_postings",
  "monitoring_check_runs",
  "detected_listings",
  "firm_recruiting_events",
  "opening_signals",
  "user_top_firms",
  "user_alerts",
  "email_drafts",
  "email_archive",
  "applications",
  "contacts",
  "events",
];

// What Postgres prints for a timestamptz, which is what the merge stored.
const TIMESTAMP_SHAPED =
  "^[0-9]{1,6}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?[+-][0-9]{2}(:[0-9]{2})?$";

function die(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

async function main() {
  const targetUrl = process.env.DATABASE_URL;
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!targetUrl) die("DATABASE_URL (the target) is not set.");
  if (!sourceUrl) die("SOURCE_DATABASE_URL (Offerly 1, where the rows came from) is not set.");
  if (new URL(targetUrl).username === new URL(sourceUrl).username) {
    die("DATABASE_URL and SOURCE_DATABASE_URL name the same project.");
  }

  // Through the one constructor, which enforces verified TLS (src/db/connection).
  const target = createPostgresClient(targetUrl, { pooling: "as-configured", max: 1, onnotice: () => {} }).sql;
  const source = createPostgresClient(sourceUrl, { pooling: "as-configured", max: 1, onnotice: () => {} }).sql;
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - target ${new URL(targetUrl).username}, source ${new URL(sourceUrl).username}\n`);

  let repaired = 0;
  const staleDuplicates: string[] = [];
  for (const table of TABLES) {
    const cols = await target<{ name: string }[]>`
      select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = ${table}
        and data_type in ('text', 'character varying')`;
    for (const { name } of cols) {
      const bad = await target.unsafe<{ id: string; v: string }[]>(
        `select id::text, "${name}" as v from "${table}" where "${name}" ~ $1`,
        [TIMESTAMP_SHAPED],
      );
      if (!bad.length) continue;
      const src = await source.unsafe<{ id: string; v: string | null }[]>(
        `select id::text, "${name}" as v from "${table}" where id = any($1::uuid[])`,
        [bad.map((b) => b.id)],
      );
      const truth = new Map(src.map((r) => [r.id, r.v]));
      const fixes = bad.filter((b) => truth.has(b.id) && truth.get(b.id) !== b.v);
      const skipped = bad.length - fixes.length;
      console.log(
        `${`${table}.${name}`.padEnd(42)} ${String(fixes.length).padStart(5)} to repair` +
          (skipped ? `, ${skipped} left (not in source or already equal)` : ""),
      );
      for (const f of fixes.slice(0, 2)) {
        console.log(`    ${JSON.stringify(f.v)} -> ${JSON.stringify(String(truth.get(f.id)).slice(0, 90))}`);
      }
      if (APPLY) {
        let collided = 0;
        for (const f of fixes) {
          try {
            // Guarded on the corrupted value, so a row the crawler has
            // rewritten since the scan is never overwritten with older text.
            await target.unsafe(`update "${table}" set "${name}" = $1 where id = $2::uuid and "${name}" = $3`, [
              truth.get(f.id) ?? null,
              f.id,
              f.v,
            ]);
            repaired++;
          } catch (e) {
            // The crawler re-found this listing after the merge and saved it
            // again under its real title, so restoring the title here would
            // duplicate that live row. This one is the stale copy: left as is
            // (isRealPosting already keeps an unnamed row off every student
            // surface) and reported, not deleted.
            if ((e as { code?: string }).code !== "23505") throw e;
            collided++;
            staleDuplicates.push(`${table} ${f.id}`);
          }
        }
        if (collided) console.log(`    ${collided} skipped: a correct copy of that row already exists`);
      } else {
        repaired += fixes.length;
      }
    }
  }

  console.log(`\n${APPLY ? "Repaired" : "Would repair"} ${repaired} cell(s).${APPLY ? "" : " Re-run with --apply to write."}`);
  if (staleDuplicates.length) {
    console.log(`Left ${staleDuplicates.length} stale duplicate row(s) untouched (a correct copy exists):`);
    for (const d of staleDuplicates) console.log(`  ${d}`);
  }
  await target.end();
  await source.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
