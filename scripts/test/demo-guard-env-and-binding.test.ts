/**
 * `npm run demo` cannot serve the live database, and cannot serve the LAN.
 *
 * The guard checked `process.env.DATABASE_URL` in the invoking shell and
 * stopped there, which covered only the first half of the chain. drizzle-kit
 * and the two tsx seed scripts do not load .env.local, which is the premise
 * the check rested on - but the last step is `next dev`, and Next DOES load
 * .env.local. On any working copy whose .env.local defines DATABASE_URL, the
 * guard passed, the seeds went to local PGlite, and the server that actually
 * took traffic pointed at the live database. The script also omitted
 * `-H 127.0.0.1`, so `next dev` bound every interface - while under `next dev`
 * contact-credit and monthly-quota metering are off by design, a design whose
 * own comment says it is safe BECAUSE the server is on loopback. The sibling
 * `demo:network` script had both controls all along (security review, 10
 * October 2026).
 *
 * The guard is run here as a real child process, which is the only way to
 * test an exit code. .env.local IS NEVER READ by this test, and the guard only
 * ever asks it a key-name question.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "./helpers/no-network";

const ROOT = process.cwd();
const GUARD = path.join(ROOT, "scripts/demo-guard.mjs");

/**
 * The guard, run against a scratch directory holding only a package.json with
 * the scripts under test. Running it in a copy rather than in the repo is what
 * lets a BAD script be tested without editing the real one.
 */
function runGuard(scripts: Record<string, string>, opts: { scriptName?: string; databaseUrl?: string; envLocal?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-guard-test-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts }, null, 1));
    if (opts.envLocal !== undefined) fs.writeFileSync(path.join(dir, ".env.local"), opts.envLocal, { mode: 0o600 });
    // A deliberately bare environment: no DATABASE_URL unless this call asks
    // for one, which is the whole point of the first test below.
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      npm_lifecycle_event: opts.scriptName ?? "demo",
    };
    if (opts.databaseUrl) env.DATABASE_URL = opts.databaseUrl;
    const out = spawnSync(process.execPath, [GUARD], { cwd: dir, env, encoding: "utf8" });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD_DEMO =
  "node scripts/demo-guard.mjs && drizzle-kit migrate && DATABASE_URL= next dev -H 127.0.0.1 --port 3001";

describe("the guard", () => {
  test("a DATABASE_URL in the shell still refuses, as it always did", () => {
    const r = runGuard({ demo: GOOD_DEMO }, { databaseUrl: "postgresql://user@db.example.com/prod" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refuses to run with DATABASE_URL set/);
    // Never echo the connection string back.
    assert.equal(r.stderr.includes("db.example.com"), false);
  });

  test("a demo script that does not blank DATABASE_URL refuses", () => {
    const r = runGuard({
      demo: "node scripts/demo-guard.mjs && drizzle-kit migrate && next dev -H 127.0.0.1 --port 3001",
    });
    assert.equal(r.status, 1, "the old, live-database-capable demo script was allowed");
    assert.match(r.stderr, /does not blank DATABASE_URL/);
  });

  test("a demo script that binds every interface refuses", () => {
    const r = runGuard({
      demo: "node scripts/demo-guard.mjs && drizzle-kit migrate && DATABASE_URL= next dev --port 3001",
    });
    assert.equal(r.status, 1, "a LAN-reachable dev server was allowed");
    assert.match(r.stderr, /-H 127\.0\.0\.1/);
  });

  test("the script as it was before the fix refuses on both counts", () => {
    const r = runGuard({
      demo: "node scripts/demo-guard.mjs && mkdir -p local-data && drizzle-kit migrate && next dev --port 3001",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not blank DATABASE_URL/);
    assert.match(r.stderr, /-H 127\.0\.0\.1/);
  });

  test("a correct demo script passes", () => {
    const r = runGuard({ demo: GOOD_DEMO });
    assert.equal(r.status, 0, r.stderr);
  });

  test("a step with no server in it is not held to the server rules", () => {
    // A guard that refused every script without `next dev` would break any
    // future seed-only variant.
    const r = runGuard({ demo: "node scripts/demo-guard.mjs && drizzle-kit migrate" });
    assert.equal(r.status, 0, r.stderr);
  });

  test("a caller naming a script that does not exist has nothing to check", () => {
    const r = runGuard({ demo: "next dev --port 3001" }, { scriptName: "something-else" });
    // There is no command by that name, so there is nothing to refuse; the
    // shell check still ran. The protection that matters for a mis-named
    // caller is the DEMO script blanking DATABASE_URL itself, which the
    // package.json tests below assert.
    assert.equal(r.status, 0, r.stderr);
  });

  test("with no script name at all, the demo rules apply", () => {
    // npm always sets npm_lifecycle_event; a bare `node scripts/demo-guard.mjs`
    // does not, and must not be the way round the check.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-guard-test-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { demo: "next dev --port 3001" } }, null, 1),
      );
      const bare: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "" };
      const out = spawnSync(process.execPath, [GUARD], { cwd: dir, env: bare, encoding: "utf8" });
      assert.equal(out.status, 1, "a bare invocation skipped the server-step check");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it reports that .env.local assigns DATABASE_URL, without reading the value", () => {
    const r = runGuard({ demo: GOOD_DEMO }, { envLocal: "DATABASE_URL=postgresql://user@db.example.com/prod\n" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\.env\.local assigns DATABASE_URL/);
    assert.equal(r.stdout.includes("db.example.com"), false, "the guard printed a value out of .env.local");
    assert.equal(r.stderr.includes("db.example.com"), false);
  });

  test("an .env.local with no DATABASE_URL says nothing", () => {
    const r = runGuard({ demo: GOOD_DEMO }, { envLocal: "ANTHROPIC_API_KEY=x\n" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(/assigns DATABASE_URL/.test(r.stdout), false);
  });
});

describe("the real package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  for (const name of ["demo", "demo:network"]) {
    test(`${name} blanks DATABASE_URL and binds loopback`, () => {
      const cmd = pkg.scripts[name];
      assert.ok(cmd, `${name} is gone`);
      assert.match(cmd, /(^|\s)DATABASE_URL=(\s|$)/, `${name} would let next dev load .env.local`);
      assert.match(cmd, /-H\s+127\.0\.0\.1\b/, `${name} would bind every interface`);
      assert.match(cmd, /demo-guard\.mjs/, `${name} no longer runs the guard`);
    });
  }

  test("npm run dev is still on loopback too", () => {
    assert.match(pkg.scripts.dev, /-H\s+127\.0\.0\.1\b/);
  });

  test("the guard the real demo script runs accepts it", () => {
    const r = runGuard({ demo: pkg.scripts.demo });
    assert.equal(r.status, 0, r.stderr);
  });
});
