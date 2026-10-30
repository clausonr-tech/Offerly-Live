// Creates the news pipeline's tables (drizzle/0029_news_pipeline.sql) in
// whichever database DATABASE_URL names - Supabase when it is set, the local
// PGlite otherwise - and says which one before touching it.
//
// Applied directly rather than through `drizzle-kit migrate`, like
// apply-upstream-schema.ts: the migrator only runs journal entries newer than
// the last one it logged, and on 29 September 2026 the live log already held a
// migration newer than this file's timestamp, so the migrator would have
// skipped it as done. Every statement is additive and re-runnable, so running
// this twice is harmless and it cannot drop anything.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/apply-news-schema.ts
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { openDb } from "../src/db/open";

// Three database connections, not the default twelve. The Supabase pooler
// allows fifteen for the whole project, the dev server holds eight and the
// crawl wants its own - on 21 September 2026 that collision lost fifteen firms
// from a crawl. This job's queries are small and sequential enough for three.
process.env.OFFERLY_DB_POOL ??= "3";

// Every news migration, in order. Each is additive and re-runnable, so running
// the whole list again is how a database catches up to the newest one.
const NEWS_MIGRATIONS = ["drizzle/0033_news_pipeline.sql", "drizzle/0034_news_photos_briefing.sql", "drizzle/0035_news_story_summaries.sql"];

async function main() {
  const opened = await openDb();
  const db = opened.db as unknown as { execute: (q: ReturnType<typeof sql.raw>) => Promise<unknown> };
  console.log(`database: ${opened.backend}${opened.backend === "postgres" ? " (DATABASE_URL - the live database)" : " (local PGlite)"}`);
  try {
    const statements = NEWS_MIGRATIONS.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
        .filter(Boolean),
    );
    for (const s of statements) await db.execute(sql.raw(s));
    console.log(`applied ${statements.length} statements`);
    const result = (await db.execute(
      sql.raw(`select table_name from information_schema.tables where table_schema = 'public' and (table_name like 'news_%' or table_name = 'ai_job_usage') order by 1`),
    )) as { rows?: { table_name: string }[] } | { table_name: string }[];
    const rows = Array.isArray(result) ? result : result.rows ?? [];
    console.log(`news tables now present: ${rows.map((r) => r.table_name).join(", ")}`);
  } finally {
    await opened.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
