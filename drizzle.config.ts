import { defineConfig } from "drizzle-kit";
import { migrationCredentials } from "./src/db/connection";

/**
 * WHICH DATABASE THIS TOUCHES, SAID OUT LOUD.
 *
 * The branch below is the same one src/db/client.ts makes: a DATABASE_URL
 * means the real Postgres, its absence means the embedded PGlite in
 * ./local-data. What was missing is that drizzle-kit does not load
 * `.env.local` the way Next.js does, and the npm scripts did not either - so
 * `npm run db:migrate` read no DATABASE_URL, took the PGlite branch, and
 * migrated a local file while appearing to migrate production.
 *
 * It fails loudly only by luck. On 22 September 2026 it aborted, because the
 * default ./local-data/pglite is the corrupted directory `.env.local` moved
 * off (PGLITE_DATA_DIR=./local-data/pglite-v3) - and the corruption is what
 * surfaced the problem. With a healthy local database it would have reported
 * a clean, successful migration of entirely the wrong thing, and the
 * production table would have been left without the constraint anyone reading
 * the output would believe it had.
 *
 * The scripts now pass --env-file-if-exists=.env.local. This line says which
 * side of the branch that landed on, every run, so a wrong answer is visible
 * before the migration rather than after.
 */
const url = process.env.DATABASE_URL;
const pgliteDir = process.env.PGLITE_DATA_DIR || "./local-data/pglite";

console.log(
  url
    ? // Host only. A pooler connection string carries the password.
      `[drizzle] remote Postgres — ${new URL(url).host}`
    : `[drizzle] LOCAL PGlite — ${pgliteDir} (no DATABASE_URL in the environment)`,
);

export default defineConfig(
  url
    ? {
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dialect: "postgresql",
        // Not `{ url }`: drizzle-kit connects that form without TLS. This
        // form carries verified TLS through - see migrationCredentials().
        dbCredentials: migrationCredentials(url),
      }
    : {
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dialect: "postgresql",
        driver: "pglite",
        // Kept in step with src/db/client.ts - see pgliteDataDir() there for
        // why this is overridable.
        dbCredentials: { url: pgliteDir },
      },
);
