// Put back the timestamps the merge moved.
//
// WHAT WENT WRONG
// ---------------
// scripts/merge-into-recruit.ts briefly passed timestamps to the target as
// raw text instead of reviving them through reviveUtc, to get around crawler
// dates a JS Date cannot serialise (year 249718 and friends). That silently
// shifted every row it inserted forward by four hours. Measured afterwards on
// monitoring_check_runs: 110 of 200 sampled rows off by exactly +4.00h, the
// remaining 90 exact - the split falling precisely on the run where the
// change landed.
//
// It matters. `decideClosure` closes a listing that has not been confirmed
// for more than one and a half check cycles, so a `last_confirmed_at` four
// hours ahead makes a live posting look stale - the same failure
// src/db/utc-clock.ts records closing 49 live Morgan Stanley postings.
//
// WHY THIS IS A RE-SYNC AND NOT AN ARITHMETIC FIX
// -----------------------------------------------
// Subtracting four hours from everything would be a guess dressed as a fix:
// it would corrupt the rows that are already correct, and it assumes every
// affected value moved by the same amount. Every merged row still exists in
// the source under the SAME uuid, so the true value can simply be read and
// written back. Rows that already agree are left alone and counted, so the
// output says how much was actually wrong.
//
// Only rows the merge itself created are touched: an id present in both
// databases. The target's own rows are never matched and never written.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/repair-merged-timestamps.ts
//   ... --apply
//
// DATABASE_URL is the target being repaired; SOURCE_DATABASE_URL is the
// database the rows came from. Both SESSION pooler URIs (port 5432).
import type postgres from "postgres";
import { createPostgresClient } from "../src/db/connection";
import { pinUtcClock } from "../src/db/utc-clock";

const APPLY = process.argv.includes("--apply");
const BATCH = 200;
const ONLY = process.argv.find((a) => a.startsWith("--table="))?.split("=")[1] ?? null;

const TABLES = [
  "firm_monitoring_sources",
  "internship_postings",
  "monitoring_check_runs",
  "detected_listings",
  "firm_recruiting_events",
  "opening_signals",
  "user_top_firms",
  "user_alerts",
  "applications",
  "contacts",
  "email_drafts",
  "events",
  "email_archive",
];

function die(lines: string[]): never {
  console.error(["", ...lines, ""].join("\n"));
  process.exit(1);
}

/**
 * A timestamp the driver cannot reinterpret.
 *
 * postgres-js parses a string bound to a timestamp parameter into a JS Date
 * using the LOCAL zone, then sends it as UTC. Measured on this machine
 * (UTC-4): writing "2026-09-21 11:11:11.111111" stored
 * "2026-09-21 15:11:11.111" - four hours on, microseconds gone. That is the
 * skew this whole script exists to undo, so passing the value back as a bound
 * parameter would simply re-apply it.
 *
 * Inlining it as a literal removes the client from the conversation
 * entirely: Postgres parses the text it is given. The pattern is strict
 * enough that nothing but a timestamp can reach the query - digits and the
 * punctuation a timestamp uses, nothing else, no quotes, and a hard length
 * cap - and every value here was printed by Postgres itself moments earlier.
 */
const TIMESTAMP_TEXT = /^\d{1,6}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?)?$/;

function sqlLiteral(value: string | null): string {
  if (value === null) return "null";
  if (value.length > 40 || !TIMESTAMP_TEXT.test(value)) {
    die([`Refusing to write a value that is not a plain timestamp: ${JSON.stringify(value)}`]);
  }
  return `'${value}'::timestamp`;
}

async function main() {
  const TARGET = process.env.DATABASE_URL;
  const SOURCE = process.env.SOURCE_DATABASE_URL;
  if (!TARGET) die(["DATABASE_URL is not set - there is nothing to repair."]);
  if (!SOURCE) {
    die([
      "SOURCE_DATABASE_URL is not set - there is nothing to read the true values from.",
      "",
      "It is the database the rows were merged FROM (Offerly 1):",
      "  SOURCE_DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres",
    ]);
  }
  if (SOURCE === TARGET) die(["SOURCE_DATABASE_URL and DATABASE_URL are the same database."]);

  const src = createPostgresClient(SOURCE, { pooling: "as-configured", max: 2, onnotice: () => {} }).sql;
  const dst = createPostgresClient(TARGET, { pooling: "as-configured", max: 2, onnotice: () => {} }).sql;
  await pinUtcClock({ query: (s: string) => src.unsafe(s) });
  await pinUtcClock({ query: (s: string) => dst.unsafe(s) });

  console.log(APPLY ? "Repairing.\n" : "DRY RUN - nothing will be written.\n");

  let totalRows = 0;
  let totalCells = 0;

  try {
    for (const table of TABLES.filter((t) => !ONLY || t === ONLY)) {
      // Timestamp columns both sides share. Compared AS TEXT, so the check is
      // on the stored wall clock itself and no client-side date handling -
      // the very thing that caused this - can sit in the middle of it.
      const cols = (
        await src<{ c: string }[]>`
          select column_name as c from information_schema.columns
          where table_schema = 'public' and table_name = ${table}
            and data_type in ('timestamp without time zone', 'timestamp with time zone')
          order by ordinal_position`
      ).map((r) => r.c);
      if (!cols.length) continue;

      const targetCols = new Set(
        (
          await dst<{ c: string }[]>`
            select column_name as c from information_schema.columns
            where table_schema = 'public' and table_name = ${table}`
        ).map((r) => r.c),
      );
      const shared = cols.filter((c) => targetCols.has(c));
      if (!shared.length) continue;

      const projection = ["id::text as id", ...shared.map((c) => `${c}::text as ${c}`)].join(", ");
      const read = async (sql: postgres.Sql) => {
        const out = new Map<string, Record<string, string | null>>();
        for (const r of (await sql.unsafe(`select ${projection} from "${table}"`)) as Record<string, string | null>[]) {
          out.set(String(r.id), r);
        }
        return out;
      };

      const [s, d] = await Promise.all([read(src), read(dst)]);

      const fixes: { id: string; values: Record<string, string | null> }[] = [];
      let cells = 0;
      for (const [id, srcRow] of s) {
        const dstRow = d.get(id);
        if (!dstRow) continue; // never merged, or the target's own row
        const differing: Record<string, string | null> = {};
        for (const c of shared) {
          if (srcRow[c] !== dstRow[c]) {
            differing[c] = srcRow[c];
            cells++;
          }
        }
        if (Object.keys(differing).length) fixes.push({ id, values: differing });
      }

      /**
       * Counted from what the database SAYS it changed, never from what this
       * script meant to change.
       *
       * The first version of this reported `fixes.length` as the number
       * repaired. It printed "4727 row(s) repaired" for a run that altered
       * nothing at all, and only a re-read caught it. An update that matches
       * no row is not an error, so the affected count is the only thing that
       * can tell the difference.
       */
      let affected = 0;
      if (fixes.length && APPLY) {
        for (let i = 0; i < fixes.length; i += BATCH) {
          const slice = fixes.slice(i, i + BATCH);
          await dst.begin(async (tx) => {
            for (const f of slice) {
              const sets = Object.entries(f.values)
                .map(([c, v]) => `"${c}" = ${sqlLiteral(v)}`)
                .join(", ");
              const res = await tx.unsafe(`update "${table}" set ${sets} where id = $1::uuid`, [f.id]);
              affected += res.count ?? 0;
            }
          });
        }
        if (affected !== fixes.length) {
          console.log(`  ! ${table}: meant to change ${fixes.length} row(s), the database changed ${affected}`);
        }
      }

      totalRows += APPLY ? affected : fixes.length;
      totalCells += cells;
      console.log(
        `${table.padEnd(26)} ${String(APPLY ? affected : fixes.length).padStart(6)} row(s) ${APPLY ? "repaired" : "to repair"}` +
          `  ${String(cells).padStart(6)} timestamp(s)  of ${String(d.size).padStart(6)} in the target`,
      );
    }

    console.log(
      `\n${totalRows} row(s), ${totalCells} timestamp(s) ${APPLY ? "put back." : "would be put back. Re-run with --apply."}`,
    );
  } finally {
    await src.end({ timeout: 5 });
    await dst.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
