// Create the classifier_feedback table.
//
// Written by hand rather than through drizzle-kit, deliberately.
// drizzle.config.ts falls back to ./local-data/pglite when PGLITE_DATA_DIR is
// unset, and that is the directory this repo has already lost a database to -
// a migration tool pointed at the wrong data directory is exactly the failure
// the handoff warns about. scripts/schema-drift.ts, the safe tool, only adds
// missing COLUMNS and says so.
//
// So: one explicit statement, against the configured database, idempotent.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/create-classifier-feedback-table.ts [--apply]
//
// Stop the dev server first - PGlite is single-writer.
import { PGlite } from "@electric-sql/pglite";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";

const APPLY = process.argv.includes("--apply");

const SQL = `
CREATE TABLE IF NOT EXISTS classifier_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES detected_listings(id) ON DELETE CASCADE,
  title text NOT NULL,
  machine_relevant boolean NOT NULL,
  machine_confidence double precision,
  machine_reason text,
  machine_evidence jsonb,
  human_verdict listing_review_status NOT NULL,
  reviewed_by uuid REFERENCES users(id),
  disagreed boolean NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS classifier_feedback_disagreed_idx ON classifier_feedback (disagreed);
CREATE INDEX IF NOT EXISTS classifier_feedback_listing_idx ON classifier_feedback (listing_id);
`;

async function main() {
  await assertExclusiveDbAccess();
  const dir = process.env.PGLITE_DATA_DIR || "./local-data/pglite";
  console.log(`database: ${dir}`);
  const client = new PGlite(dir);
  try {
    const before = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'classifier_feedback'",
    );
    const exists = (before.rows[0]?.count ?? 0) > 0;
    console.log(exists ? "classifier_feedback already exists." : "classifier_feedback is missing.");

    if (!APPLY) {
      console.log("\nDry run - pass --apply to create it.");
      return;
    }
    if (exists) return;

    await client.exec(SQL);
    const after = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'classifier_feedback'",
    );
    console.log(
      (after.rows[0]?.count ?? 0) > 0 ? "created classifier_feedback." : "creation reported no error but the table is absent",
    );
  } finally {
    await client.close();
  }
}

main();
