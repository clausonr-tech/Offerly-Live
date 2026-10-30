// Compare src/db/schema.ts against the live database, column by column.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/schema-drift.ts [--apply]
//
// WHY THIS EXISTS
// ---------------
// There is no drizzle/ migrations directory, so every schema change has been
// applied with `drizzle-kit push` and the database's shape is whatever a
// sequence of pushes left behind. On 18 September 2026 that caught up with us
// twice in one session: push refused to run at all, stopping on
// `promptColumnsConflicts` because it had found column-level differences it
// could not resolve without asking a human whether one was a rename; and
// pulling main added `users.avatar_storage_path` to the schema file, which
// nothing had added to the database, so every authenticated page died on
// `column "avatar_storage_path" does not exist`.
//
// Answering push's prompt blind can DROP a column and its data. This asks the
// same question in a form where the answer is visible first:
//
//   MISSING IN DB  - declared in schema.ts, absent from the database. Additive
//                    and safe, and --apply adds them.
//   EXTRA IN DB    - present in the database, not declared. Reported and never
//                    touched: from here a dropped column and a RENAMED one look
//                    identical, and dropping a rename destroys the data. If the
//                    lists below pair up suspiciously, that pair is the rename
//                    push wanted to ask about.
//
// Types are compared loosely. The goal is to catch the difference that stops a
// query - a column that is not there - not to police every default and
// precision, which push already handles and which would bury the real finding.
import { openScriptDb, rowsOf } from "./_db";
import { getTableColumns, getTableName, sql, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";

const apply = process.argv.includes("--apply");

type DbColumn = { table_name: string; column_name: string; data_type: string; is_nullable: string };


async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const live = await db.execute<DbColumn>(sql`
      select table_name, column_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'public'
    `);
    const liveByTable = new Map<string, Map<string, DbColumn>>();
    for (const row of rowsOf<DbColumn>(live)) {
      if (!liveByTable.has(row.table_name)) liveByTable.set(row.table_name, new Map());
      liveByTable.get(row.table_name)!.set(row.column_name, row);
    }

    const missingTables: string[] = [];
    const missingColumns: { table: string; column: string; sqlType: string; notNull: boolean; hasDefault: boolean }[] = [];
    const extraColumns: { table: string; column: string; type: string }[] = [];

    const declaredTables = new Set<string>();

    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const tableName = getTableName(value);
      declaredTables.add(tableName);

      const liveCols = liveByTable.get(tableName);
      if (!liveCols) {
        missingTables.push(tableName);
        continue;
      }

      const declaredCols = getTableColumns(value);
      const declaredNames = new Set<string>();

      for (const col of Object.values(declaredCols)) {
        declaredNames.add(col.name);
        if (!liveCols.has(col.name)) {
          missingColumns.push({
            table: tableName,
            column: col.name,
            sqlType: col.getSQLType(),
            notNull: col.notNull,
            hasDefault: col.hasDefault,
          });
        }
      }

      for (const [name, row] of liveCols) {
        if (!declaredNames.has(name)) extraColumns.push({ table: tableName, column: name, type: row.data_type });
      }
    }

    const extraTables = [...liveByTable.keys()].filter(
      (t) => !declaredTables.has(t) && !t.startsWith("__drizzle"),
    );

    console.log(`${declaredTables.size} tables declared in schema.ts, ${liveByTable.size} in the database.\n`);

    console.log(`MISSING IN DB - tables: ${missingTables.length}`);
    for (const t of missingTables) console.log(`   ${t}`);

    console.log(`\nMISSING IN DB - columns: ${missingColumns.length}   (additive; --apply adds these)`);
    for (const c of missingColumns) {
      console.log(`   ${c.table}.${c.column}  ${c.sqlType}${c.notNull ? " NOT NULL" : ""}${c.hasDefault ? " (has default)" : ""}`);
    }

    console.log(`\nEXTRA IN DB - columns: ${extraColumns.length}   (never touched - a drop and a rename look the same here)`);
    for (const c of extraColumns) console.log(`   ${c.table}.${c.column}  ${c.type}`);

    console.log(`\nEXTRA IN DB - tables: ${extraTables.length}   (never touched)`);
    for (const t of extraTables) console.log(`   ${t}`);

    if (!apply) {
      console.log(`\nDry run - pass --apply to add the ${missingColumns.length} missing column(s). Nothing else is ever written.`);
      return;
    }

    let added = 0;
    for (const c of missingColumns) {
      /**
       * NOT NULL without a default cannot be added to a table with rows, and
       * forcing one would mean inventing a value for every existing row. Added
       * nullable instead, and reported: the column then exists, queries stop
       * failing, and the constraint is a decision someone makes with the data
       * in front of them.
       */
      const needsRelax = c.notNull && !c.hasDefault;
      const type = c.sqlType;

      /**
       * Validate the identifiers before interpolating them into raw SQL.
       *
       * These come from drizzle's own metadata for schema.ts, so they are our
       * code rather than user input and cannot currently carry anything
       * hostile. That is a fact about today's call site, not a property of the
       * function - `sql.raw` with a template hole is the shape of a SQL
       * injection whoever reads it next has to reason about, and the check
       * costs one comparison.
       */
      const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
      const SAFE_TYPE = /^[A-Za-z0-9_ ()",]+$/;
      if (!SAFE_IDENT.test(c.table) || !SAFE_IDENT.test(c.column) || !SAFE_TYPE.test(type)) {
        console.log(`   REFUSED ${c.table}.${c.column}: identifier or type is not a plain SQL name`);
        continue;
      }
      try {
        await db.execute(
          sql.raw(`alter table "${c.table}" add column if not exists "${c.column}" ${type}${needsRelax ? "" : c.notNull ? " not null" : ""}`),
        );
        console.log(`   added  ${c.table}.${c.column}${needsRelax ? "  (as NULLABLE - declared NOT NULL with no default)" : ""}`);
        added++;
      } catch (err) {
        console.log(`   FAILED ${c.table}.${c.column}: ${(err as Error).message}`);
      }
    }
    console.log(`\n${added} column(s) added. Tables and extra columns were not touched.`);
  } finally {
    await closeDb();
  }
}

main();
