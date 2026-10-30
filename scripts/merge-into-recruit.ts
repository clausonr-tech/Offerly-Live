// Merge Offerly 1's crawler data into Offerly_Recruit, by identity not by id.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// The two databases were seeded independently. They hold the same things
// under different primary keys: both have 22,574 firms with the same names
// and slugs, and NOT ONE shared uuid. Both hold the same two user accounts,
// same emails, different ids.
//
// So a plain row copy cannot work. Inserting a source firm hits the unique
// index on `slug` and is skipped - correct - but then every child row still
// points at the SOURCE firm's uuid, which does not exist here, and every one
// fails its foreign key. Measured: all 24,796 firm_programs, all 4,913
// monitoring sources, all 4,663 detected listings.
//
// The fix is to translate. For each table, a row is matched to the target's
// own row by NATURAL KEY - a firm by slug, a user by email, a posting by
// (firm, role, year) - and every foreign key is rewritten from the source's
// id space into the target's before the insert. A row whose parent has no
// counterpart is skipped and counted, never inserted with a dangling key.
//
// WHERE THE NATURAL KEYS COME FROM
// --------------------------------
// Mostly the catalog: a unique index that is not the primary key IS the
// natural key, so firms/slug, users/email and five more are discovered rather
// than declared. Two tables need saying out loud (see NATURAL_KEYS below),
// and one - monitoring_check_runs - genuinely has no identity: it is a log of
// crawl attempts, and two runs an hour apart are two facts, not one fact
// twice. Its rows are appended, and the summary says so.
//
// WHAT IT WILL NOT DO
// -------------------
// Insert only. No update, no delete, no drop. On any clash the TARGET's row
// wins and the source's copy is skipped. Nothing already in Offerly_Recruit
// can be changed or lost by this script.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/merge-into-recruit.ts
//   ... --apply
//   ... --table=internship_postings
//
// Both URLs must be SESSION pooler URIs (port 5432). Stop the dev server and
// any crawl first.
import type postgres from "postgres";
import { createPostgresClient } from "../src/db/connection";
import { pinUtcClock } from "../src/db/utc-clock";
import { selectExpression, reviveUtc, topologicalOrder, TIMESTAMP_TYPES } from "./migrate-to-supabase";

const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.find((a) => a.startsWith("--table="))?.split("=")[1] ?? null;
const BATCH = 200;

/**
 * The crawler's monitoring layer - what Offerly 1 has and Offerly_Recruit
 * does not. Firms and users are deliberately absent: both sides already hold
 * all 22,574 firms and both accounts, so those tables are read to build the
 * translation and never written to.
 *
 * Parents-first order is derived from the real foreign keys, not from this
 * list, so the order written here does not matter.
 */
const DEFAULT_SCOPE = [
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

  /**
   * The account's own records, added after the monitoring layer landed.
   *
   * None of these has a unique index, so there is no natural key and nothing
   * to match on: every row inserts under its own uuid and simply joins his.
   * That is right here - your 31 applications and his 300 are different
   * applications, not two versions of the same ones - and it stays idempotent
   * because a second run collides on the primary key and does nothing.
   *
   * events comes last of its own accord: it points at applications AND
   * contacts, so the foreign-key sort places all three in the right order.
   */
  "applications",
  "contacts",
  "events",
];

/**
 * Natural keys the catalog does not know about.
 *
 * Both tables carry a real identity that was simply never indexed as unique:
 * a monitoring source IS a firm's careers page, and a detected listing IS a
 * posting on a source. Without these two, their rows would insert as
 * duplicates of his 104 sources and 2,059 listings instead of matching them.
 *
 * detected_listings lists three columns because the crawler fills whichever
 * the board gives it - an external id on some, only a URL on others - and
 * nulls are compared as equal here (see keyOf), so a pair that is null on
 * both sides still matches.
 */
const NATURAL_KEYS: Record<string, string[]> = {
  firm_monitoring_sources: ["firm_id", "careers_url"],
  detected_listings: ["source_id", "external_job_id", "listing_url"],
};

const NO_IDENTITY = new Set(["monitoring_check_runs"]);

type Column = { name: string; type: string; nullable: boolean };
type Fk = { column: string; parent: string };

function die(lines: string[]): never {
  console.error(["", ...lines, ""].join("\n"));
  process.exit(1);
}

function masked(url: string): string {
  return url.replace(/(postgresql:\/\/[^:]+:)[^@]*@/, "$1****@");
}

/**
 * One key string from several column values.
 *
 * A null is a real part of an identity here, not a missing one - a listing
 * with no external id is identified BY having none - so it is given a
 * sentinel rather than making the whole key null. The separators are
 * characters no url, slug or email contains.
 */
const NULL_SENTINEL = "\u0000";
const KEY_SEPARATOR = "\u0001";

function keyOf(row: Record<string, unknown>, cols: string[]): string {
  return cols
    .map((c) => (row[c] === null || row[c] === undefined ? NULL_SENTINEL : String(row[c])))
    .join(KEY_SEPARATOR);
}

/**
 * reviveUtc, except for the dates that cannot survive a JS Date.
 *
 * Both halves of this were learned the hard way, in that order.
 *
 * First: the crawler parses dates out of job boards and some of what it finds
 * is nonsense - this source holds listings stamped year 42262, 117593 and
 * 249718. Postgres stores those happily, its range running to 294276, but a
 * JS Date serialises them as "+249718-01-01T00:00:00.000Z" and Postgres will
 * not read that back ("time zone displacement out of range"). 727 rows failed
 * on it.
 *
 * So the conversion was dropped and the text passed straight through - and
 * THAT silently moved every timestamp forward by four hours. 110 of 200
 * sampled rows ended up off by exactly +4.00h, the rest exact, the split
 * falling precisely on the run where the change landed.
 *
 * The reason is the driver, not this file. postgres-js binds a STRING to a
 * timestamp parameter by parsing it into a JS Date in the LOCAL zone and
 * sending that as UTC. Proven directly on this machine (UTC-4): writing
 * "2026-09-21 11:11:11.111111" stored "2026-09-21 15:11:11.111". A Date
 * handed to it is already an instant and survives untouched, which is why
 * reviveUtc was right all along.
 *
 * A wrong timestamp is worse than a failed insert, because nothing reports
 * it, and `decideClosure` reads a stale `last_confirmed_at` as a closed
 * listing - the skew src/db/utc-clock.ts records closing 49 live postings.
 *
 * KNOWN LIMIT: the raw-text fallback below still goes through the driver, so
 * the handful of out-of-range values can land shifted by the local offset.
 * They are crawler junk (year 42262, 117593, 249718) where four hours is
 * meaningless, and scripts/repair-merged-timestamps.ts re-syncs every merged
 * row from the source afterwards regardless, writing literals the driver
 * never sees.
 */
function safeTimestamp(value: unknown): unknown {
  const revived = reviveUtc(value);
  if (!(revived instanceof Date)) return revived;
  const year = revived.getUTCFullYear();
  return Number.isNaN(revived.getTime()) || year > 9999 || year < 1 ? value : revived;
}

async function preflight(label: string, url: string, sql: postgres.Sql): Promise<void> {
  try {
    await sql`select 1`;
  } catch (e) {
    const msg = (e as Error).message;
    const hints: string[] = [];
    if (/tenant.*(not found)|tenant\/user/i.test(msg)) {
      hints.push(
        "That project ref does not exist. Copy the URI from Project Settings -> Database -> Connection string -> Session pooler.",
      );
    }
    if (/password authentication failed/i.test(msg)) {
      hints.push(
        "The ref is right and the password is wrong. The dashboard masks it; it resets under Settings -> Database -> Reset database password.",
      );
    }
    if (url.includes(":6543")) {
      hints.push("Port 6543 is the TRANSACTION pooler. This needs the SESSION pooler, on port 5432.");
    }
    die([
      `Cannot connect to the ${label}:`,
      "",
      `  ${masked(url)}`,
      `  ${msg}`,
      ...(hints.length ? ["", ...hints.map((h) => `  - ${h}`)] : []),
    ]);
  }
}

async function main() {
  const SOURCE = process.env.DATABASE_URL;
  const TARGET = process.env.RECRUIT_DATABASE_URL;

  if (!SOURCE) die(["DATABASE_URL is not set - there is nothing to merge from."]);
  if (!TARGET) {
    die([
      "RECRUIT_DATABASE_URL is not set - there is nowhere to merge into.",
      "",
      "Add the TARGET project's session pooler URI (port 5432) to .env.local:",
      "  RECRUIT_DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres",
    ]);
  }
  if (SOURCE === TARGET) {
    die(["DATABASE_URL and RECRUIT_DATABASE_URL are the same database. Refusing to merge a database into itself."]);
  }

  for (const [label, url] of [
    ["source (DATABASE_URL)", SOURCE],
    ["target (RECRUIT_DATABASE_URL)", TARGET],
  ] as const) {
    if (/[<>]/.test(url)) {
      die([
        `The ${label} is still a template, not a connection string:`,
        "",
        `  ${masked(url)}`,
        "",
        "Replace the <...> parts with the real values from",
        "Project Settings -> Database -> Connection string -> Session pooler.",
      ]);
    }
  }

  const src = createPostgresClient(SOURCE, { pooling: "as-configured", max: 2, onnotice: () => {} }).sql;
  const dst = createPostgresClient(TARGET, { pooling: "as-configured", max: 2, onnotice: () => {} }).sql;

  await preflight("source (DATABASE_URL)", SOURCE, src);
  await preflight("target (RECRUIT_DATABASE_URL)", TARGET, dst);
  await pinUtcClock({ query: (s: string) => src.unsafe(s) });
  await pinUtcClock({ query: (s: string) => dst.unsafe(s) });

  try {
    const scope = ONLY ? [ONLY] : DEFAULT_SCOPE;

    // Every foreign key in the source. All of them are single-column.
    const fks = new Map<string, Fk[]>();
    for (const r of await src<{ child: string; column: string; parent: string }[]>`
      select con.conrelid::regclass::text as child, a.attname as column, con.confrelid::regclass::text as parent
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      where con.contype = 'f'`) {
      if (!fks.has(r.child)) fks.set(r.child, []);
      fks.get(r.child)!.push({ column: r.column, parent: r.parent });
    }

    // Natural keys from the catalog, then the two declared above.
    const naturalKeys = new Map<string, string[]>();
    for (const r of await src<{ t: string; cols: string[] }[]>`
      select c.relname as t, array(
        select a.attname from unnest(i.indkey) k join pg_attribute a on a.attrelid = c.oid and a.attnum = k
      ) as cols
      from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and i.indisunique and not i.indisprimary`) {
      if (!naturalKeys.has(r.t)) naturalKeys.set(r.t, r.cols);
    }
    for (const [t, cols] of Object.entries(NATURAL_KEYS)) naturalKeys.set(t, cols);

    // Anything the scope points at but does not copy is read-only: it exists
    // on both sides already and is needed only to translate ids.
    const parents = new Set<string>();
    for (const t of scope) {
      for (const fk of fks.get(t) ?? []) if (!scope.includes(fk.parent)) parents.add(fk.parent);
    }

    const all = [...new Set([...parents, ...scope])];
    const edges = [...fks.entries()].flatMap(([child, list]) => list.map((f) => ({ child, parent: f.parent })));
    const order = topologicalOrder(all, edges).filter((t) => all.includes(t));

    console.log(
      `Translating ${parents.size} reference table(s), copying ${scope.length}.` +
        `${APPLY ? "" : "  DRY RUN - nothing will be written."}\n`,
    );

    // source id -> target id, per table. Built as each table is handled, so a
    // child is always rewritten with a map its parent has already filled.
    const maps = new Map<string, Map<string, string>>();

    /**
     * A natural key in the TARGET's id space.
     *
     * Some natural keys are themselves foreign keys - a posting is identified
     * by (firm_id, role, year) - so the source's firm uuid has to be
     * translated before the key means anything here. A key whose parent has
     * no counterpart cannot be matched at all, and says so with null.
     */
    const resolveKey = (row: Record<string, unknown>, table: string, cols: string[]): string | null => {
      const translated: Record<string, unknown> = {};
      for (const c of cols) {
        const fk = (fks.get(table) ?? []).find((f) => f.column === c);
        if (!fk || row[c] === null || row[c] === undefined) {
          translated[c] = row[c];
          continue;
        }
        const mapped = maps.get(fk.parent)?.get(String(row[c]));
        if (!mapped) return null;
        translated[c] = mapped;
      }
      return keyOf(translated, cols);
    };

    for (const table of order) {
      const keyCols = naturalKeys.get(table) ?? null;
      const isParent = parents.has(table);

      // Target rows by natural key, so a source row can find its counterpart.
      const targetByKey = new Map<string, string>();
      if (keyCols) {
        for (const r of await dst.unsafe(`select id, ${keyCols.join(", ")} from "${table}"`)) {
          targetByKey.set(keyOf(r as Record<string, unknown>, keyCols), String((r as Record<string, unknown>).id));
        }
      }

      const map = new Map<string, string>();
      maps.set(table, map);

      if (isParent) {
        // Read-only: match every source row to the target's, and report what
        // cannot be matched, because that is what will cost child rows later.
        if (!keyCols) {
          console.log(`${table.padEnd(26)} no natural key - children referencing it cannot be translated`);
          continue;
        }
        const rows = (await src.unsafe(`select id, ${keyCols.join(", ")} from "${table}"`)) as Record<
          string,
          unknown
        >[];
        let matched = 0;
        for (const r of rows) {
          const k = resolveKey(r, table, keyCols);
          const hit = k === null ? undefined : targetByKey.get(k);
          if (hit) {
            map.set(String(r.id), hit);
            matched++;
          }
        }
        console.log(
          `${table.padEnd(26)} ${String(matched).padStart(6)} of ${String(rows.length).padStart(6)} matched to the target`,
        );
        continue;
      }

      // A copied table. Columns both sides share, so a column one of them
      // lacks cannot fail the whole insert.
      const srcCols = await src<Column[]>`
        select column_name as name, data_type as type, (is_nullable = 'YES') as nullable
        from information_schema.columns where table_schema = 'public' and table_name = ${table}
        order by ordinal_position`;
      const dstColNames = new Set(
        (
          await dst<{ c: string }[]>`
          select column_name as c from information_schema.columns
          where table_schema = 'public' and table_name = ${table}`
        ).map((r) => r.c),
      );
      const dropped = srcCols.filter((c) => !dstColNames.has(c.name)).map((c) => c.name);
      const cols = srcCols.filter((c) => dstColNames.has(c.name));
      if (!cols.length) {
        console.log(`${table.padEnd(26)} not present in the target - skipped`);
        continue;
      }

      const names = cols.map((c) => c.name);
      // Only timestamp columns are revived. This loop used to run EVERY value
      // through safeTimestamp, and a JS Date parses nearly anything with a
      // number in it: "Summer Analyst, Investment Banking, BDO Capital
      // Advisors - Summer 2028 (Richmond)" became 2028-01-01, "HTTP 403"
      // became 0403-01-01, a job id "9874" became 9874-01-01. The 21 September
      // merge wrote 1,001 such cells into text columns - posting titles,
      // apply links, the crawler's own external job ids - which is how a
      // student came to see an internship named "2028-01-01 00:00:00+00".
      const tsCols = new Set(cols.filter((c) => TIMESTAMP_TYPES.has(c.type)).map((c) => c.name));
      const projection = cols.map(selectExpression).join(", ");
      const rows = (await src.unsafe(`select ${projection} from "${table}" order by ctid`)) as Record<
        string,
        unknown
      >[];

      const ready: Record<string, unknown>[] = [];
      const unresolved = new Map<string, number>();
      let alreadyThere = 0;

      for (const raw of rows) {
        const row: Record<string, unknown> = {};
        for (const n of names) row[n] = tsCols.has(n) ? safeTimestamp(raw[n]) : raw[n];

        // Rewrite every foreign key into the target's id space.
        let lost: string | null = null;
        for (const fk of fks.get(table) ?? []) {
          if (!names.includes(fk.column)) continue;
          const v = row[fk.column];
          if (v === null || v === undefined) continue;
          const mapped = maps.get(fk.parent)?.get(String(v));
          if (!mapped) {
            lost = fk.parent;
            break;
          }
          row[fk.column] = mapped;
        }
        if (lost) {
          unresolved.set(lost, (unresolved.get(lost) ?? 0) + 1);
          continue;
        }

        // Does the target already hold this row? Then it keeps its own, and
        // the source id points at it so this table's children still resolve.
        if (keyCols) {
          const hit = targetByKey.get(keyOf(row, keyCols));
          if (hit) {
            map.set(String(raw.id), hit);
            alreadyThere++;
            continue;
          }
        }
        // Inserted as-is: primary keys cannot collide across the two
        // databases, so the source uuid survives and the map is the identity.
        map.set(String(raw.id), String(raw.id));
        ready.push(row);
      }

      let inserted = 0;
      let failed = 0;
      if (APPLY) {
        for (let i = 0; i < ready.length; i += BATCH) {
          const batch = ready.slice(i, i + BATCH);
          try {
            const res = await dst`insert into ${dst(table)} ${dst(batch, ...names)} on conflict do nothing`;
            inserted += res.count;
          } catch {
            // One unsatisfiable row would discard the other 199 with it.
            for (const row of batch) {
              try {
                const res = await dst`insert into ${dst(table)} ${dst(row, ...names)} on conflict do nothing`;
                inserted += res.count;
              } catch (e) {
                failed++;
                if (failed <= 3) console.log(`  ! ${table}: ${(e as Error).message.split("\n")[0]}`);
              }
            }
          }
        }
      }

      /**
       * A row that failed to insert is not in the target, so any mapping
       * claiming it is would rewrite this table's children onto a key that
       * does not exist - trading one failure for a cascade of them. Only the
       * identity mappings can be wrong this way (a matched row was already
       * there), so only those are re-checked.
       */
      if (APPLY && failed) {
        const live = new Set(
          ((await dst.unsafe(`select id from "${table}"`)) as Record<string, unknown>[]).map((r) => String(r.id)),
        );
        for (const [srcId, tgtId] of map) if (srcId === tgtId && !live.has(tgtId)) map.delete(srcId);
      }

      const note = [
        NO_IDENTITY.has(table) ? "appended (log table, no identity)" : "",
        dropped.length ? `columns not in target: ${dropped.join(", ")}` : "",
        ...[...unresolved].map(([p, n]) => `${n} skipped, no matching ${p}`),
        failed ? `${failed} FAILED` : "",
      ].filter(Boolean);

      console.log(
        `${table.padEnd(26)} ${String(APPLY ? inserted : ready.length).padStart(6)} ${APPLY ? "inserted" : "to insert"}  ` +
          `${String(alreadyThere).padStart(6)} already there  ${note.join("; ")}`,
      );
    }

    console.log(APPLY ? "\nDone." : "\nDry run. Re-run with --apply to write.");
  } finally {
    await src.end({ timeout: 5 });
    await dst.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
