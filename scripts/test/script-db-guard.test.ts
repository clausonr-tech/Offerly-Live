import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Keeps every script opening the database through scripts/_db.ts.
 *
 * THE FAILURE THIS PREVENTS HAS ALREADY HAPPENED, TWICE
 * -----------------------------------------------------
 * `src/db/open.ts` was written to end it: a script that calls
 * `new PGlite(...)` itself ignores DATABASE_URL, so pointing the app at
 * Supabase moves the reads and leaves the writes behind. Its header says it -
 * "Two databases, both live, diverging hourly, with no error anywhere."
 *
 * The opener landed and the migration stopped at five files. On 11 October
 * 2026 the crawler had written 28,597 check runs into Supabase while
 * `crawl-status.ts`, `crawl-inspect.ts`, `classifier-report.ts`,
 * `verify-classifier-corpus.ts` and every `audit-*.ts` still read
 * `local-data/pglite`, last written on 21 September - twenty days stale and
 * reported as current. `adjudicate-rejections.ts` WROTE its verdicts there.
 *
 * A comment at the top of each file was the previous safeguard. This is a
 * check instead, because a one-line construction is easy to copy out of a
 * neighbouring script and nothing about it looks wrong.
 */

const ROOT = process.cwd();

/**
 * Files allowed to construct PGlite, each for a stated reason.
 *
 * Every entry is a tool whose SUBJECT is a PGlite directory - a migration out
 * of one, a probe of one, a repair of rows one wrote. Pointing them at
 * Supabase would not fix anything; it would make them meaningless. Anything
 * that merely wants "the database" does not belong here.
 */
const ALLOWED = new Map<string, string>([
  [path.join("src", "db", "client.ts"), "the app's own driver switch"],
  [path.join("src", "db", "open.ts"), "the script driver switch this guard points at"],
  [
    path.join("scripts", "migrate-to-supabase.ts"),
    "PGlite is the SOURCE of the migration; there is no pg_dump for WASM",
  ],
  [
    path.join("scripts", "pgprobe.ts"),
    "answers whether a given PGlite directory can still be read at all",
  ],
  [
    path.join("scripts", "recover-firms.ts"),
    "reads a named PGlite backup directory and writes to Supabase",
  ],
  [
    path.join("scripts", "repair-clock-skew.ts"),
    "repairs the rows PGlite's own clock wrote; see src/db/utc-clock.ts",
  ],
  [
    path.join("scripts", "apply-upstream-schema.ts"),
    "one-off DDL against the local database, superseded by drizzle/ migrations",
  ],
  [
    path.join("scripts", "add-activity-post-kind.ts"),
    "one-off DDL against the local database, superseded by drizzle/ migrations",
  ],
  [
    path.join("scripts", "create-classifier-feedback-table.ts"),
    "one-off DDL against the local database, superseded by drizzle/ migrations",
  ],
]);

/**
 * Scripts that roll their own copy of the DATABASE_URL switch.
 *
 * These are not the bug this guard is about - they do read DATABASE_URL, so
 * they write where the app writes. They are the duplication that LET the bug
 * spread, because a hand-rolled switch is what gets copied into the next
 * script and then trimmed down to the PGlite half.
 *
 * Left alone deliberately: each passes `pooling: "as-configured"` to hold a
 * session rather than a transaction, and `openDb()` does not. Consolidating
 * them means deciding that none of them needs a session, which is a question
 * about those scripts and not about this one.
 */
const OWN_DRIVER_SWITCH = new Set([
  path.join("scripts", "seed-schools.ts"),
  path.join("scripts", "seed-interview-questions.ts"),
  path.join("scripts", "import-postings-csv.ts"),
]);

function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return codeFiles(full);
    return /\.(ts|tsx|mts|mjs|cjs)$/.test(name) ? [full] : [];
  });
}

/** Source with comments removed, so prose ABOUT the bug is not a hit. */
function code(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const FILES = [
  ...codeFiles(path.join(ROOT, "src")),
  ...codeFiles(path.join(ROOT, "scripts")),
]
  .map((f) => path.relative(ROOT, f))
  // Tests open a disposable local database on purpose - that is the point of
  // scripts/test/helpers/test-db.ts.
  .filter((f) => !f.startsWith(path.join("scripts", "test")));

test("no script constructs PGlite directly", () => {
  const offenders = FILES.filter(
    (f) =>
      !ALLOWED.has(f) &&
      !OWN_DRIVER_SWITCH.has(f) &&
      /new\s+PGlite\s*\(/.test(code(f)),
  );

  assert.deepEqual(
    offenders,
    [],
    `These files open PGlite directly, so they ignore DATABASE_URL and read a database\n` +
      `the app stopped writing to:\n\n` +
      offenders.map((f) => `  ${f}`).join("\n") +
      `\n\nUse \`const { db } = await openScriptDb()\` from scripts/_db.ts. If the file's\n` +
      `subject genuinely IS a PGlite directory, add it to ALLOWED with the reason.`,
  );
});

test("every allowed file exists and still constructs PGlite", () => {
  // An allowance for a file that no longer needs one is a rule that has
  // quietly stopped applying to anything.
  for (const [file, reason] of ALLOWED) {
    assert.ok(reason.length > 20, `${file}: give a real reason, not "${reason}"`);
    assert.ok(
      /new\s+PGlite\s*\(/.test(code(file)),
      `${file} is on the PGlite allowlist but no longer opens PGlite - remove the entry.`,
    );
  }
});

test("scripts that open the database go through _db.ts", () => {
  // The other half of the same rule: having removed `new PGlite`, a script
  // must not reach past the opener to postgres-js either. That is
  // db-connection-guard.test.ts's job for TLS; this one is about the TARGET.
  const reachingPast = FILES.filter((f) => {
    if (!f.startsWith("scripts") || ALLOWED.has(f) || OWN_DRIVER_SWITCH.has(f)) return false;
    const src = code(f);
    return /drizzle-orm\/pglite/.test(src);
  });

  assert.deepEqual(
    reachingPast,
    [],
    `These scripts import drizzle's PGlite driver without constructing PGlite:\n` +
      reachingPast.map((f) => `  ${f}`).join("\n"),
  );
});
