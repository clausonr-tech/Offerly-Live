/**
 * Two operator scripts that reached further than their jobs.
 *
 * fix-apply-urls.ts repairs the crawler's "Apply" links. Its select covered
 * EVERY active posting with a source_url, firm-authored rows included, and
 * requested each one from the operator's own machine with
 * `fetch(redirect: "follow")` - so a recruiter who typed an internal or
 * loopback URL into the firm portal had that URL fetched from inside the
 * operator's network, in dry-run as well. The update was keyed on id alone, so
 * a firm-authored row on a known ATS host could also have its application_url
 * rewritten, against the standing rule that scripts never change what a firm
 * wrote (retire-off-profession-postings.ts).
 *
 * export-jsonl.mts dumps whole tables - users, sessions, sealed tokens - and
 * read its table list from /tmp/order.txt, interpolated each line into raw SQL
 * inside double quotes with no validation, and wrote every row to a fixed
 * /tmp/pgexport/<table>.jsonl with writeFileSync's default mode, into a
 * directory the operator had to create themselves (normally 0755).
 *
 * Both are asserted at the source, because neither can be run here: one needs
 * the network and a live database, the other needs a live database, and the
 * house rule for this worktree is that no operator script runs. The export's
 * identifier rule and its file modes ARE exercised, by running the same regex
 * and the same write helper that the script uses (security review, 10 October
 * 2026).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "./helpers/no-network";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

/**
 * The same file with its comments removed.
 *
 * These files now EXPLAIN the holes they used to have, in prose that quotes
 * the offending code - `redirect: "follow"`, `/tmp/pgexport`, a plain
 * `fetch(`. An assertion that reads the comments cannot tell the explanation
 * from the thing it describes, so the comments come out before anything is
 * matched. Deliberately crude: these are hand-written source files with no
 * regex literals containing "//" in the places that matter.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
}

describe("fix-apply-urls: crawler rows only", () => {
  const src = code(read("scripts/fix-apply-urls.ts"));

  test("the select is restricted to origin = 'crawler'", () => {
    const select = src.slice(src.indexOf("from internship_postings"), src.indexOf("order by program_year"));
    assert.match(select, /origin\s*=\s*'crawler'/, "the posting select has no origin predicate");
  });

  test("the update is restricted to origin = 'crawler' as well", () => {
    // The update is built for both tables; only internship_postings has an
    // origin column, so the predicate is conditional on the table name.
    const update = src.slice(src.indexOf("update \"${table}\""), src.indexOf("return;", src.indexOf("update \"${table}\"")));
    assert.match(update, /origin = 'crawler'/, "the update has no origin guard");
    assert.match(update, /internship_postings/, "the origin guard is not scoped to the table that has the column");
  });

  test("every probe goes through the guarded fetch, not a plain one", () => {
    assert.match(src, /import \{ safeFetch \} from "\.\.\/src\/lib\/monitoring\/safe-fetch"/);
    const probe = src.slice(src.indexOf("async function probe("), src.indexOf("async function resolves("));
    assert.match(probe, /await safeFetch\(/, "probe does not use safeFetch");
    assert.equal(
      /await fetch\(/.test(probe),
      false,
      "probe still calls the global fetch - a plain fetch from the operator's machine is the finding",
    );
    assert.equal(
      /redirect:\s*"follow"/.test(probe),
      false,
      "redirect: follow defeats the per-hop address check; safeFetch follows redirects itself",
    );
  });

  test("no plain fetch survives anywhere in the script", () => {
    assert.equal(/[^.\w]fetch\(/.test(src.replace(/safeFetch\(/g, "")), false, "a bare fetch( remains");
  });
});

describe("export-jsonl: private paths and validated identifiers", () => {
  const src = code(read("export-jsonl.mts"));

  /** The script's own rule, applied here to the values that matter. */
  const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

  test("the script validates every table name before it reaches SQL", () => {
    assert.match(src, /\^\[a-z_\]\[a-z0-9_\]\*\$/, "the identifier regex is gone");
    const loop = src.slice(src.indexOf("for (const t of tables)"));
    assert.match(loop, /sql\.raw\(/);
    // The validation has to happen before the loop, not inside it.
    assert.ok(src.indexOf("TABLE_NAME.test") < src.indexOf("for (const t of tables)"));
  });

  test("the identifier rule refuses what broke out of the quotes", () => {
    for (const bad of [
      'users" x; drop table users; --',
      'users"',
      "users; select 1",
      "public.users",
      "Users",
      "1users",
      "users ",
      "",
    ]) {
      assert.equal(TABLE_NAME.test(bad), false, `accepted ${JSON.stringify(bad)}`);
    }
    for (const good of ["users", "sessions", "internship_postings", "_counts"]) {
      assert.equal(TABLE_NAME.test(good), true, `rejected ${good}`);
    }
  });

  test("a bad name refuses the whole run rather than being skipped", () => {
    assert.match(src, /Refusing to run/);
    assert.match(src, /process\.exit\(1\)/);
  });

  test("the output directory is created by mkdtemp at 0700 and files at 0600", () => {
    assert.match(src, /mkdtempSync\(/, "the fixed /tmp/pgexport path is back");
    assert.match(src, /chmodSync\(outDir, 0o700\)/);
    assert.match(src, /mode: 0o600/);
    assert.match(src, /flag: "wx"/, "without an exclusive create a planted symlink is still followed");
    assert.equal(/\/tmp\/pgexport/.test(src), false, "a fixed /tmp output path remains");
    assert.equal(/"\/tmp\/order\.txt"/.test(src), false, "the fixed /tmp input path remains");
  });

  test("the same write helper really does produce a 0600 file and refuse a second write", () => {
    // Exercised rather than asserted: the modes are the whole fix.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgexport-test-"));
    fs.chmodSync(dir, 0o700);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

    const file = path.join(dir, "users.jsonl");
    fs.writeFileSync(file, "{}\n", { mode: 0o600, flag: "wx" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => fs.writeFileSync(file, "{}\n", { mode: 0o600, flag: "wx" }), /EEXIST/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("it still says where the dump went, and that it is personal data", () => {
    assert.match(src, /shred it/i);
  });
});
