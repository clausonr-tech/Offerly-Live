/**
 * Brings the local database up to date before the dev server or `next start`.
 *
 * Without this a fresh clone serves a 500 on its first page load: nothing
 * migrates on boot, so the very first query hits a database with no tables and
 * fails with `relation "users" does not exist`. Running the migrations from
 * `predev` / `prestart` is what makes `npm install && npm run dev` work on a
 * machine that has never seen this project.
 *
 * It only ever touches the EMBEDDED database. With DATABASE_URL set you are
 * pointed at a real Postgres, and silently migrating that because somebody
 * typed `npm run dev` is not a thing this should do - so it says what to run
 * and gets out of the way.
 *
 * drizzle-kit keeps its own journal, so on every run after the first this is a
 * no-op that costs about a second.
 */
import { spawnSync } from "node:child_process";

if (process.env.DATABASE_URL) {
  console.log(
    "[setup-db] DATABASE_URL is set, so this is a real database and migrations are yours to run:\n" +
      "           npx drizzle-kit migrate",
  );
  process.exit(0);
}

const result = spawnSync("npx", ["drizzle-kit", "migrate"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  console.error(
    "\n[setup-db] The migrations did not apply, so the app would serve errors.\n" +
      "           PGlite takes a single writer: if a dev server or a script is\n" +
      "           already open on ./local-data, stop it and try again.",
  );
  process.exit(result.status ?? 1);
}
