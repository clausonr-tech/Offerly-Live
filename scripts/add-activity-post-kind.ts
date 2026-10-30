// Adds what the feed needs to carry student-written posts:
//   activity_kind gains 'post', activity_events gains `body`.
//
// Written as explicit DDL rather than `drizzle-kit push` on purpose. push
// compares the whole schema and prompts interactively when it cannot tell a
// rename from a drop - which, against a PGlite database with no migration
// history, is a prompt that can hang a non-interactive run. Two idempotent
// statements are easier to reason about and safe to re-run.
//
// Stop the dev server first: PGlite is a single in-process connection.
//   npx tsx --conditions=react-server scripts/add-activity-post-kind.ts
import { PGlite } from "@electric-sql/pglite";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";

async function main() {
  await assertExclusiveDbAccess();
  const db = new PGlite("./local-data/pglite");
  try {
    // ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so it is
    // issued on its own rather than batched with the column add.
    await db.exec(`ALTER TYPE activity_kind ADD VALUE IF NOT EXISTS 'post';`);
    await db.exec(`ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS body text;`);

    const kinds = await db.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'activity_kind' ORDER BY e.enumsortorder;`,
    );
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'activity_events' ORDER BY ordinal_position;`,
    );
    console.log("activity_kind:", kinds.rows.map((r) => r.enumlabel).join(", "));
    console.log("activity_events:", cols.rows.map((r) => r.column_name).join(", "));
  } finally {
    await db.close();
  }
}
main();
