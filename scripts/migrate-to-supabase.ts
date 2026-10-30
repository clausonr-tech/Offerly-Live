// Move the whole local database into Postgres (Supabase).
//
// PGlite has no pg_dump - it is Postgres compiled to WebAssembly, with no
// client protocol and no server to dump from - so the transfer is a read of
// every table here and an insert of every row there.
//
// THE SOURCE IS DAMAGED, AND THAT SHAPES EVERY CHOICE HERE
// --------------------------------------------------------
// This database has physical corruption, found while trying to migrate it.
// Two distinct faults, both unrepairable in place:
//
//   1. A TOAST chunk in `detected_listings` is inconsistent, so a whole-table
//      scan fails outright:
//        unexpected chunk size 1572 (expected 551) in chunk 1 of 2
//        for toast value 204909 in pg_toast_16755
//      VACUUM does not clear it. REINDEX cannot rebuild the TOAST index.
//
//   2. At least one primary-key index MISSES ROWS, silently. Measured on
//      opening_signals, which holds 68:
//        select * from opening_signals              -> 68
//        select * from opening_signals order by id  -> 65
//      No error. Three rows simply absent.
//
// So: read by ctid (physical position), never through an index, because the
// indexes give wrong answers without saying so. Page in small batches, and on
// a batch that fails drop to one row at a time. On a row that fails, blank the
// damaged column rather than lose the row - a missing description is refetched
// by the crawler on its next pass, a missing listing is not.
//
// Then prove it: every table's row count is checked BEFORE anything is
// written, and a short read refuses to continue. A partial copy that reports
// success is the one outcome worse than a failure.
//
// That makes the migration the repair. Supabase gets the live data; the
// damaged file stays behind.
//
// ORDER
// -----
// Tables are inserted parents-first, in an order derived from the foreign keys
// actually present in the source, not from a hand-written list that would rot
// the first time a table is added.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/migrate-to-supabase.ts
//   ... --apply
//
// Needs DATABASE_URL set to the Supabase SESSION pooler URI (port 5432).
// Stop the dev server first - PGlite is single-writer.
import { PGlite } from "@electric-sql/pglite";
import { createPostgresClient } from "../src/db/connection";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { pinUtcClock } from "../src/db/utc-clock";

const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.find((a) => a.startsWith("--table="))?.split("=")[1] ?? null;
const BATCH = 200;

type Column = { name: string; type: string; nullable: boolean };

/**
 * Timestamp columns are read as TEXT and re-parsed as UTC.
 *
 * PGlite's own client parses `timestamp without time zone` as LOCAL time, so
 * a value stored as `2026-09-18 16:55:28` came back as the instant
 * 20:55:28Z on a UTC-4 host. Drizzle's pglite driver reads the identical value
 * as UTC. Both cannot be right, and the writers decide it: every timestamp
 * this project stores is written by Drizzle or by `now()` with the session
 * pinned to UTC (src/db/utc-clock.ts), so the stored wall clock IS UTC.
 *
 * Handing those mis-parsed Dates to postgres-js shifted every timestamp in
 * the first migration forward by four hours - correctly serialised, from a
 * wrong instant. Reading the text and appending the zone removes the guess.
 */
export const TIMESTAMP_TYPES = new Set([
  "timestamp without time zone",
  "timestamp with time zone",
]);

export function selectExpression(c: Column): string {
  return TIMESTAMP_TYPES.has(c.type) ? `${c.name}::text as ${c.name}` : c.name;
}

export function reviveUtc(value: unknown): unknown {
  if (typeof value !== "string") return value;

  // "2026-09-18 16:55:28.31" -> the same wall clock, read as UTC.
  let iso = value.includes("T") ? value : value.replace(" ", "T");

  /**
   * Postgres writes a zone as `+00`; ISO 8601 wants `+00:00`.
   *
   * Without this, `new Date("2026-09-20T03:49:52.727+00")` is Invalid Date,
   * the value falls through as a string, and the string is what shifted every
   * timestamp by four hours in the first place. Anchored behind the TIME part
   * so the `-20` ending a bare date is never mistaken for an offset.
   */
  iso = iso.replace(/(T[\d:.]+)([+-]\d\d)$/, "$1$2:00");

  const statesItsZone = /(?:Z|[+-]\d\d:?\d\d)$/.test(iso);
  const d = new Date(statesItsZone ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? value : d;
}

/**
 * Parents before children.
 *
 * Kahn's algorithm over the source's own foreign keys. Self-references are
 * ignored rather than treated as a cycle: a table whose parent is itself (a
 * threaded comment, a firm that owns a firm) inserts fine in one pass as long
 * as the rows arrive in an order the constraint allows, and deferring the
 * whole table would deadlock the sort for no gain.
 */
export function topologicalOrder(tables: string[], edges: { child: string; parent: string }[]): string[] {
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of edges) {
    if (child === parent) continue;
    if (deps.has(child) && deps.has(parent)) deps.get(child)!.add(parent);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter((t) => !placed.has(t) && [...deps.get(t)!].every((d) => placed.has(d)));
    if (!ready.length) {
      // A genuine cycle. Emit the rest in name order and let the insert fail
      // loudly rather than silently dropping tables.
      for (const t of tables) if (!placed.has(t)) ordered.push(t), placed.add(t);
      break;
    }
    for (const t of ready) ordered.push(t), placed.add(t);
  }
  return ordered;
}

/**
 * Read a row whose damaged column is not yet known, by blanking one wide
 * column at a time until it comes back.
 *
 * Only text-ish columns are candidates: TOAST is where large values go, and a
 * uuid or an integer is stored inline and cannot be the cause. A NOT NULL
 * column is blanked to an empty string rather than null so the insert still
 * satisfies the constraint - and an empty description is what
 * `isThinDescription` already treats as "go and fetch this again", so the
 * crawler repairs it on its next pass without being told to.
 */
let readDegraded: (
  table: string,
  cols: Column[],
  orderBy: string,
  offset: number,
) => Promise<{ row: Record<string, unknown>; column: string } | null>;

async function main() {
  // Only writing needs a target. A dry run reads the source and reports what
  // would move, which is worth being able to do before any credential exists -
  // and is how the damaged-row handling below gets exercised.
  if (APPLY && !process.env.DATABASE_URL) {
    console.error(
      [
        "",
        "DATABASE_URL is not set, so there is nowhere to migrate to.",
        "",
        "Add your Supabase connection string to .env.local:",
        "  DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres",
        "",
        "Use the SESSION pooler URI (port 5432), not the transaction pooler (6543):",
        "drizzle-kit push needs a real session, and the transaction pooler does not give one.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  // DATABASE_URL is set by definition here, and the source is still PGlite -
  // so the single-writer check has to be asked for explicitly.
  await assertExclusiveDbAccess({ evenWithDatabaseUrl: true });
  const src = new PGlite(process.env.PGLITE_DATA_DIR || "./local-data/pglite");
  await pinUtcClock(src);
  // Never dialled on a dry run; postgres-js connects lazily. The TLS settings
  // are still built up front, so a missing CA fails here rather than mid-copy.
  const sql = createPostgresClient(process.env.DATABASE_URL!, {
    pooling: "as-configured",
    max: 4,
    onnotice: () => {},
  }).sql;
  const q = async (s: string) => (await src.query(s)).rows as Record<string, unknown>[];

  /**
   * Take the planner's shortcuts away.
   *
   * `count(*)` is happy to answer from an index-only scan, and an index here
   * can miss rows - so the count that decides whether the copy is complete was
   * itself being undercounted. Measured on detected_listings: count(*) said
   * 3693 while a heap read returned 3800. With these off, every count and
   * every read goes to the heap, which is the only structure in this database
   * still telling the truth.
   */
  await src.exec(
    "set enable_indexscan=off; set enable_indexonlyscan=off; set enable_bitmapscan=off;",
  );

  try {
    const tables = (
      await q(`select c.relname as t from pg_class c join pg_namespace n on n.oid=c.relnamespace
               where n.nspname='public' and c.relkind='r' order by 1`)
    ).map((r) => String(r.t));

    const edges = (
      await q(`select con.conrelid::regclass::text as child, con.confrelid::regclass::text as parent
               from pg_constraint con where con.contype='f'`)
    ).map((r) => ({ child: String(r.child), parent: String(r.parent) }));

    const order = topologicalOrder(tables, edges).filter((t) => !ONLY || t === ONLY);
    console.log(`${tables.length} tables in the source; migrating ${order.length}.\n`);

    /**
     * What the TARGET actually has.
     *
     * drizzle-kit push builds Supabase from src/db/schema.ts, and the local
     * database has drifted from that file - it carries columns the schema no
     * longer declares (users.networking_comfort was the first). Inserting a
     * column the target lacks fails the whole table, so the copy is restricted
     * to the columns both sides share.
     *
     * Restricted, and REPORTED. A column left behind is data loss, and data
     * loss that scrolls past in a log is data loss nobody knows about - so
     * each one is counted for non-null values and listed at the end.
     */
    const targetColumns = new Map<string, Set<string>>();
    for (const r of await sql<{ t: string; c: string }[]>`
      select table_name as t, column_name as c from information_schema.columns
      where table_schema = 'public'`) {
      if (!targetColumns.has(r.t)) targetColumns.set(r.t, new Set());
      targetColumns.get(r.t)!.add(r.c);
    }

    if (APPLY && process.argv.includes("--truncate")) {
      // Reverse dependency order, so children go before parents.
      const reversed = [...order].reverse().filter((t) => targetColumns.has(t));
      console.log(`emptying ${reversed.length} target table(s) before reloading...`);
      await sql.unsafe(`truncate table ${reversed.map((t) => `"${t}"`).join(", ")} cascade`);
    }

    const droppedColumns: string[] = [];
    let grandTotal = 0;
    const unreadable: string[] = [];
    const degraded: string[] = [];
    const shortReads: string[] = [];
    const summary: string[] = [];

    readDegraded = async (table, cols, orderBy, offset) => {
      const wide = cols.filter((c) =>
        ["text", "character varying", "jsonb", "json"].includes(c.type),
      );
      for (const suspect of wide) {
        const blank = suspect.nullable ? "null" : suspect.type.startsWith("json") ? `'{}'::${suspect.type}` : `''`;
        const list = cols
          .map((c) => (c.name === suspect.name ? `${blank} as ${c.name}` : selectExpression(c)))
          .join(",");
        try {
          const r = await q(`select ctid::text as __ctid, ${list} from ${table} order by ${orderBy} limit 1 offset ${offset}`);
          if (r.length) return { row: r[0], column: suspect.name };
        } catch {
          // Not this column - or not only this column. Try the next.
        }
      }

      /**
       * More than one damaged column in the same row.
       *
       * Blanking all of them keeps the row's identity - its id, its source,
       * its external job id, its URL - which is what lets the next crawl
       * recognise the posting and fill it back in. Dropping the row instead
       * would make the same posting arrive as NEW later, with a new id, and
       * anything already pointing at the old one would dangle.
       */
      const wideNames = new Set(wide.map((c) => c.name));
      const list = cols
        .map((c) => {
          if (!wideNames.has(c.name)) return selectExpression(c);
          const blank = c.nullable ? "null" : c.type.startsWith("json") ? `'{}'::${c.type}` : `''`;
          return `${blank} as ${c.name}`;
        })
        .join(",");
      try {
        const r = await q(`select ctid::text as __ctid, ${list} from ${table} order by ${orderBy} limit 1 offset ${offset}`);
        if (r.length) return { row: r[0], column: `${wide.length} wide columns` };
      } catch {
        // Genuinely unreadable: the damage is not in a TOASTable column.
      }
      return null;
    };

    for (const table of order) {
      const cols: Column[] = (
        await q(`select column_name as name, data_type as type, is_nullable as nullable
                 from information_schema.columns
                 where table_schema='public' and table_name='${table}' order by ordinal_position`)
      ).map((r) => ({ name: String(r.name), type: String(r.type), nullable: r.nullable === "YES" }));
      if (!cols.length) continue;

      const onTarget = targetColumns.get(table);
      if (!onTarget) {
        summary.push(`  ${table.padEnd(30)} NOT ON TARGET - skipped`);
        droppedColumns.push(`${table} (whole table absent from the schema)`);
        continue;
      }

      const missing = cols.filter((c) => !onTarget.has(c.name));
      for (const c of missing) {
        const n = Number((await q(`select count(${c.name}) as n from ${table}`))[0].n);
        droppedColumns.push(`${table}.${c.name} - ${n} non-null value(s)`);
      }

      const cols2 = cols.filter((c) => onTarget.has(c.name));
      const names = cols2.map((c) => c.name);
      const total = Number((await q(`select count(*) as n from ${table}`))[0].n);
      if (total === 0) {
        summary.push(`  ${table.padEnd(30)} empty`);
        continue;
      }

      /**
       * Paged by ctid - physical position - and never by primary key.
       *
       * Ordering by the key uses the key's index, and an index here can be
       * wrong. Measured on opening_signals: the heap holds 68 rows, and
       *
       *   select * from opening_signals order by id limit 200   -> 65 rows
       *
       * Three rows silently absent, no error. `REINDEX DATABASE` cannot fix
       * it either - it fails on pg_toast_16755_index, the damaged TOAST index
       * - so the indexes cannot be trusted and the heap is the only honest
       * source. ctid is also stable here because this is the single writer.
       */

      const rows: Record<string, unknown>[] = [];
      const seenCtids = new Set<string>();
      let skipped = 0;

      // ctid comes back with every row so a row cannot be counted twice when a
      // failed batch is re-read one row at a time. It is stripped before the
      // insert - it is a physical address, not data.
      const push = (r: Record<string, unknown>) => {
        const ctid = String(r.__ctid);
        if (seenCtids.has(ctid)) return;
        seenCtids.add(ctid);
        delete r.__ctid;
        rows.push(r);
      };

      const readBatch = async (offset: number): Promise<Record<string, unknown>[]> => {
        return q(`select ctid::text as __ctid, ${cols2.map(selectExpression).join(",")} from ${table} order by ctid limit ${BATCH} offset ${offset}`);
      };

      for (let offset = 0; offset < total; offset += BATCH) {
        try {
          for (const r of await readBatch(offset)) push(r);
        } catch {
          // A damaged value somewhere in this batch. Narrow to the row, so one
          // bad description does not cost 200 good listings.
          const orderBy = "ctid";
          for (let i = offset; i < Math.min(offset + BATCH, total); i++) {
            try {
              const one = await q(
                `select ctid::text as __ctid, ${cols2.map(selectExpression).join(",")} from ${table} order by ${orderBy} limit 1 offset ${i}`,
              );
              for (const r of one) push(r);
            } catch {
              /**
               * One column is damaged, not the row.
               *
               * Dropping the whole row would lose a real internship over an
               * unreadable description - and the description is the one part
               * the crawler can simply fetch again. So each wide column is
               * blanked in turn until the row reads, which both rescues it and
               * names the column that was broken.
               */
              const recovered = await readDegraded(table, cols2, orderBy, i);
              if (recovered) {
                push(recovered.row);
                degraded.push(`${table}.${recovered.column} (row ${i})`);
              } else {
                skipped += 1;
                unreadable.push(`${table} row ${i}`);
              }
            }
          }
        }
      }

      /**
       * A silent short read is the failure mode this migration must not have.
       * Row counts are compared before a single insert, because "we moved the
       * database" and "we moved most of the database" look identical
       * afterwards.
       */
      if (rows.length + skipped !== total) {
        shortReads.push(
          `${table}: read ${rows.length} + ${skipped} skipped, but count(*) says ${total}` +
            (rows.length + skipped > total
              ? " - the heap holds MORE than the count, so the count came from a damaged index"
              : ""),
        );
      }

      const note = skipped ? `  (${skipped} UNREADABLE, skipped)` : "";
      summary.push(`  ${table.padEnd(30)} ${String(rows.length).padStart(6)} of ${total}${note}`);
      grandTotal += rows.length;

      if (!APPLY || !rows.length) continue;

      // jsonb/json must be handed to the driver as JSON, or an object is
      // stringified as "[object Object]" and a string is double-encoded.
      const jsonCols = new Set(cols2.filter((c) => c.type === "jsonb" || c.type === "json").map((c) => c.name));
      // Only the columns actually declared as timestamps are re-parsed. Applied
      // to every string it would convert ordinary text that merely looks like a
      // date - a title of "2027", a description opening with a date - into a
      // Date, which Postgres then rejects for the wrong column type.
      const tsCols = new Set(cols2.filter((c) => TIMESTAMP_TYPES.has(c.type)).map((c) => c.name));
      const prepared = rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const n of names) {
          if (jsonCols.has(n) && r[n] !== null) out[n] = sql.json(r[n] as never);
          else if (tsCols.has(n)) out[n] = reviveUtc(r[n]);
          else out[n] = r[n];
        }
        return out;
      });

      for (let i = 0; i < prepared.length; i += BATCH) {
        const chunk = prepared.slice(i, i + BATCH);
        // Re-runnable: a row already there is left alone rather than failing
        // the whole migration partway through.
        await sql`insert into ${sql(table)} ${sql(chunk, ...names)} on conflict do nothing`;
      }
      process.stdout.write(`  wrote ${table} (${prepared.length})\n`);
    }

    console.log("\nsource rows read:");
    for (const line of summary) console.log(line);
    console.log(`\n${grandTotal} rows total.`);
    if (droppedColumns.length) {
      console.log(`\n! ${droppedColumns.length} column(s) exist locally but not in src/db/schema.ts, so they did NOT move:`);
      for (const d of droppedColumns) console.log(`    ${d}`);
      console.log("  Any with a non-zero count is real data left behind. Add the column to");
      console.log("  src/db/schema.ts, re-run drizzle-kit push, then re-run this - it is re-runnable.");
    }
    if (degraded.length) {
      console.log(`\n${degraded.length} row(s) rescued with one damaged column blanked:`);
      for (const d of degraded.slice(0, 10)) console.log(`  ${d}`);
      if (degraded.length > 10) console.log(`  ... and ${degraded.length - 10} more`);
      console.log("  (a blanked description is re-fetched by the crawler's own enrichment pass)");
    }
    if (unreadable.length) {
      console.log(`\n${unreadable.length} unreadable row(s) left behind:`);
      for (const u of unreadable.slice(0, 20)) console.log(`  ${u}`);
    }

    if (shortReads.length) {
      console.log(`\n! ${shortReads.length} table(s) read fewer rows than they contain:`);
      for (const s2 of shortReads) console.log(`    ${s2}`);
      console.log("  Refusing to continue: a partial copy that reports success is worse than a failure.");
      process.exitCode = 1;
      return;
    }

    if (!APPLY) {
      console.log("\nDry run - nothing was written. Re-run with --apply.");
      return;
    }

    // ------------------------------------------------------------- verify
    console.log("\nverifying row counts on the target:");
    let mismatched = 0;
    for (const table of order) {
      const here = Number((await q(`select count(*) as n from ${table}`))[0].n);
      const there = Number((await sql`select count(*)::int as n from ${sql(table)}`)[0].n);
      const ok = there >= here;
      if (!ok) mismatched += 1;
      if (!ok || here !== there) {
        console.log(`  ${ok ? " " : "!"} ${table.padEnd(30)} local ${here} -> remote ${there}`);
      }
    }
    console.log(mismatched ? `\n${mismatched} table(s) short - re-run to fill them.` : "\nEvery table matched.");
  } finally {
    await src.close();
    await sql.end({ timeout: 5 });
  }
}

/**
 * Run only when invoked as a script.
 *
 * Without this guard, importing the file to test `topologicalOrder` or
 * `reviveUtc` would start a migration - which is not a thing a test run
 * should be able to do by accident.
 */
if (require.main === module) main();
