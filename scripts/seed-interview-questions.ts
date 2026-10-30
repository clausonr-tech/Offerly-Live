/**
 * Imports the authored interview question bank (src/lib/question-bank/data)
 * into the interview_questions table - the video coach's runtime source of
 * truth. Idempotent: an upsert keyed by each question's authored stable id.
 * It never deletes or duplicates a row, and never re-activates a question
 * someone retired (see lib/video-interview/seed.ts).
 *
 *   npm run db:seed-interview-questions                          # local PGlite
 *   npm run db:seed-interview-questions -- --database-host=<host>  # a remote DB
 *
 * WHICH DATABASE, SAID OUT LOUD - the same rule as drizzle.config.ts. With a
 * DATABASE_URL in the environment it refuses to write anywhere until you
 * repeat that database's host on the command line, so a production URL left
 * in .env.local cannot be seeded by accident. Confirm the host is the one you
 * mean first (docs/VIDEO_INTERVIEW_SETUP.md, "Before touching a database").
 */

import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { authoredQuestionRows, seedInterviewQuestions } from "../src/lib/video-interview/seed";

async function connect() {
  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { createPostgresClient } = await import("../src/db/connection");
    const client = createPostgresClient(process.env.DATABASE_URL, { pooling: "as-configured", max: 2 }).sql;
    return { db: drizzle(client, { schema }), close: () => client.end() };
  }
  const { drizzle } = await import("drizzle-orm/pglite");
  const { PGlite } = await import("@electric-sql/pglite");
  const client = new PGlite(process.env.PGLITE_DATA_DIR || "./local-data/pglite");
  return { db: drizzle(client, { schema }), close: () => client.close() };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const host = new URL(url).host;
    const confirmed = process.argv.find((a) => a.startsWith("--database-host="))?.split("=")[1];
    console.log(`[seed] target: remote Postgres — ${host}`);
    if (confirmed !== host) {
      console.error(
        [
          "",
          "  Refusing to seed a remote database without confirmation.",
          "  If - and only if - you have confirmed this is the database you mean, re-run with:",
          "",
          `    npm run db:seed-interview-questions -- --database-host=${host}`,
          "",
        ].join("\n"),
      );
      process.exit(1);
    }
  } else {
    console.log(`[seed] target: LOCAL PGlite — ${process.env.PGLITE_DATA_DIR || "./local-data/pglite"}`);
  }

  const rows = authoredQuestionRows();
  const { db, close } = await connect();
  try {
    const check = (await db.execute(sql`select to_regclass('public.interview_questions') is not null as ok`)) as unknown;
    const ok = Array.isArray(check) ? check[0]?.ok : (check as { rows: { ok: boolean }[] }).rows[0]?.ok;
    if (!ok) {
      console.error("[seed] interview_questions does not exist. Apply migration 0030 first (npm run db:migrate).");
      process.exitCode = 1;
      return;
    }
    const result = await seedInterviewQuestions(db as never, rows);
    const counted = (await db.execute(sql`select count(*)::int as n from interview_questions where source = 'authored'`)) as unknown;
    const n = Array.isArray(counted) ? counted[0]?.n : (counted as { rows: { n: number }[] }).rows[0]?.n;
    console.log(`[seed] ${result.total} authored questions: ${result.inserted} new, ${result.updated} updated in place. Table now holds ${n} authored rows.`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
