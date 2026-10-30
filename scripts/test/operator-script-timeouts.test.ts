/**
 * An operator script gets no statement or lock ceiling.
 *
 * This branch gave the request path a statement_timeout of 30 seconds and a
 * lock_timeout of 3 seconds, so a pathological query releases its pool
 * connection instead of holding it forever. The comment said the change could
 * not break a migration because `pooling: "as-configured"` opts out - but no
 * script passes that. Scripts open their connection through src/db/open.ts,
 * which passed neither the escape hatch nor any values of its own, so all 22 of
 * them inherited the request path's ceilings.
 *
 * The one that matters most is scripts/apply-news-schema.ts: it runs the raw
 * statements of three migration files through `sql.raw`, and CREATE TABLE and
 * ALTER TABLE take ACCESS EXCLUSIVE, which against a live app waits. At a
 * three-second lock_timeout that applier dies part-way through its list - a
 * half-applied migration, the one outcome every migration in this repo is
 * written to avoid. The backfills have the same shape with statement_timeout:
 * a table-wide UPDATE over thousands of rows is one statement.
 *
 * So this test reads the source rather than the database: what is being pinned
 * is a decision about which path gets a ceiling, and the decision is visible in
 * one call. Opening a real connection would need DATABASE_URL, which these
 * tests must never read.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const openSource = readFileSync("src/db/open.ts", "utf8");
const connectionSource = readFileSync("src/db/connection.ts", "utf8");

test("openDb names its own timeouts, so a script does not inherit the request path's", () => {
  assert.match(
    openSource,
    /statementTimeoutMs:\s*0/,
    "openDb does not set statementTimeoutMs: a backfill's one long statement will be cancelled at 30s",
  );
  assert.match(
    openSource,
    /lockTimeoutMs:\s*0/,
    "openDb does not set lockTimeoutMs: the DDL applier will die at 3s part-way through a migration",
  );
});

test("zero really means no limit - the parameter is left out rather than sent as 0", () => {
  // Postgres reads statement_timeout = 0 as "no limit", but sending it claims
  // to have set something. connection.ts omits the parameter instead, which is
  // what makes openDb's 0 equivalent to the state before the ceilings existed.
  assert.match(connectionSource, /statement > 0 \? \{ statement_timeout/);
  assert.match(connectionSource, /lock > 0 \? \{ lock_timeout/);
});

test("an explicit value still wins over the pooled default", () => {
  // The whole fix depends on `options.statementTimeoutMs ?? pooledDefault`
  // treating an explicit 0 as a value rather than as absent. `||` here would
  // silently restore the 30 seconds, and nothing else would look different.
  assert.match(connectionSource, /options\.statementTimeoutMs \?\? \(pooled \?/);
  assert.match(connectionSource, /options\.lockTimeoutMs \?\? \(pooled \?/);
  assert.doesNotMatch(connectionSource, /options\.statementTimeoutMs \|\|/);
  assert.doesNotMatch(connectionSource, /options\.lockTimeoutMs \|\|/);
});

test("the request path still has its ceilings - this is not a blanket removal", () => {
  assert.match(connectionSource, /POOLED_TIMEOUTS = \{ statementTimeoutMs: 30_000, lockTimeoutMs: 3_000 \}/);
  const clientSource = readFileSync("src/db/client.ts", "utf8");
  assert.doesNotMatch(
    clientSource,
    /statementTimeoutMs|lockTimeoutMs|pooling:\s*"as-configured"/,
    "the app's own client must keep the pooled defaults",
  );
});
