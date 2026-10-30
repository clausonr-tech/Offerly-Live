// Brings the local PGlite database up to the schema that arrived with
// origin/main - two tables and four columns.
//
// Hand-written DDL rather than `drizzle-kit push` for the reason push has
// caused trouble here before: it compares the whole schema and prompts
// interactively when it cannot tell a rename from a drop, which can hang a
// non-interactive run. Every statement below is additive and IF NOT EXISTS,
// so it is safe to re-run and cannot drop anything.
//
// Stop the dev server first: PGlite is a single in-process connection.
//   npx tsx --conditions=react-server scripts/apply-upstream-schema.ts
import { PGlite } from "@electric-sql/pglite";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS email_archive (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     draft_id uuid REFERENCES email_drafts(id) ON DELETE SET NULL,
     email_type text NOT NULL,
     generated_ciphertext text,
     final_ciphertext text,
     resume_attached boolean NOT NULL DEFAULT false,
     push_count integer NOT NULL DEFAULT 0,
     key_version integer NOT NULL DEFAULT 1,
     created_at timestamp NOT NULL DEFAULT now(),
     pushed_at timestamp
   );`,
  `CREATE INDEX IF NOT EXISTS email_archive_draft_idx ON email_archive (draft_id);`,

  `CREATE TABLE IF NOT EXISTS submitted_people (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     email text NOT NULL,
     name text NOT NULL,
     firm text NOT NULL,
     role text,
     "group" text,
     school text,
     linkedin_url text,
     background text,
     submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
     created_at timestamp NOT NULL DEFAULT now()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS submitted_people_email_idx ON submitted_people (email);`,

  `ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS offerly_calendar_id text;`,
  `ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS inputs jsonb;`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS google_calendar_id text;`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS google_meet_url text;`,

  // Profile photos. Null is the normal state - the school crest is the
  // default picture and this column only ever holds an override.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_storage_path text;`,

  // The address a school-verification code was sent to, while unconfirmed.
  // Separate from school_email so asking for a code cannot cost a student the
  // verification they already have.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_school_email text;`,
];

async function main() {
  const db = new PGlite("./local-data/pglite");
  try {
    for (const sql of STATEMENTS) {
      await db.exec(sql);
      console.log("ok:", sql.split("\n")[0].trim().slice(0, 62));
    }
  } finally {
    await db.close();
  }
}
main();
