import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { rootCertificates } from "node:tls";

import { migrationCredentials } from "@/db/connection";

/**
 * Keeps every database connection going through src/db/connection.ts, where
 * TLS is verified and cannot be switched off.
 *
 * The failure this prevents already happened once: sixteen files each called
 * postgres-js themselves, none passed `ssl`, and postgres-js defaults to
 * plaintext. A seventeenth would have done the same.
 */

const ROOT = process.cwd();
const THE_ONE_CONSTRUCTOR = path.join("src", "db", "connection.ts");
const THIS_FILE = path.join("scripts", "test", "db-connection-guard.test.ts");

function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return codeFiles(full);
    return /\.(ts|tsx|mts|mjs|cjs|js)$/.test(name) ? [full] : [];
  });
}

const FILES = [
  ...codeFiles(path.join(ROOT, "src")),
  ...codeFiles(path.join(ROOT, "scripts")),
  path.join(ROOT, "drizzle.config.ts"),
].map((f) => path.relative(ROOT, f));

/** Source with comments removed, so prose about postgres-js is not a hit. */
function code(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("postgres-js is constructed in exactly one place", () => {
  const valueImport = /import\s+(?!type\b)[^;]*?from\s+["']postgres["']|import\(\s*["']postgres["']\s*\)|require\(\s*["']postgres["']\s*\)/;
  const offenders = FILES.filter((f) => f !== THE_ONE_CONSTRUCTOR && valueImport.test(code(f)));
  assert.deepEqual(offenders, [], `import createPostgresClient from src/db/connection instead: ${offenders.join(", ")}`);
});

test("nothing disables certificate verification or asks for unverified TLS", () => {
  const disabled = new RegExp("rejectUnauthorized\\s*:\\s*false");
  const weakMode = new RegExp("ssl\\s*:\\s*(false|[\"'](require|prefer|allow|disable)[\"'])");
  // tls.ts is the policy itself: its one `ssl: false` is the loopback-only
  // test branch that db-tls.test.ts proves cannot be reached in production.
  const POLICY = path.join("src", "db", "tls.ts");
  const offenders = FILES.filter((f) => f !== THIS_FILE).filter((f) => {
    const src = code(f);
    return disabled.test(src) || (f !== POLICY && weakMode.test(src));
  });
  assert.deepEqual(offenders, [], `unverified TLS configured in: ${offenders.join(", ")}`);
});

test("migrations connect through the TLS-carrying credential form, not { url }", () => {
  const config = code("drizzle.config.ts");
  assert.match(config, /migrationCredentials\(/);
  assert.doesNotMatch(config, /dbCredentials:\s*\{\s*url\s*\}/);
});

test("migration credentials decode a password exactly as postgres-js does", () => {
  const prev = process.env.DATABASE_CA_CERT;
  // Any current CA certificate will do for building the options; the tests in
  // db-tls.test.ts cover trust itself. Borrow Node's bundled roots.
  process.env.DATABASE_CA_CERT = rootCertificates[0];
  try {
    const creds = migrationCredentials("postgres://postgres.abcd:p%40ss%23w%25rd@aws-0-us-east-2.pooler.supabase.com:5432/postgres");
    assert.equal(creds.user, "postgres.abcd");
    assert.equal(creds.password, "p@ss#w%rd");
    assert.equal(creds.host, "aws-0-us-east-2.pooler.supabase.com");
    assert.equal(creds.port, 5432);
    assert.equal(creds.database, "postgres");
    assert.ok(creds.ssl && creds.ssl.rejectUnauthorized === true);
  } finally {
    if (prev === undefined) delete process.env.DATABASE_CA_CERT;
    else process.env.DATABASE_CA_CERT = prev;
  }
});
