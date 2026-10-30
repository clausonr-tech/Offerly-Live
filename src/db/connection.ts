import postgres from "postgres";
import { poolFor, type PoolMode } from "./pool";
import { DatabaseTlsConfigError, databaseTls, type DatabaseTls } from "./tls";

/**
 * The only place in this repository allowed to call `postgres()`.
 *
 * Before this, every connection chose its own options: the app, the script
 * opener and thirteen scripts each called postgres-js directly, none of them
 * passed `ssl`, and postgres-js defaults to plaintext - so the superuser
 * password crossed the internet in the clear from every one of them. One
 * constructor means TLS cannot be forgotten by the next script;
 * scripts/test/db-connection-guard.test.ts fails the suite if anything else
 * calls postgres-js directly.
 */

export type PostgresClientOptions = {
  max: number;
  /** Seconds. postgres-js's own default is 30. */
  connectTimeout?: number;
  idleTimeout?: number;
  onnotice?: (notice: postgres.Notice) => void;
  /**
   * "auto" moves a Supabase session-mode pooler URL to transaction mode (see
   * pool.ts). "as-configured" uses the URL untouched - for migrations and
   * other work that needs a session.
   */
  pooling?: "auto" | "as-configured";
  /** Only for the disposable Postgres the tests start on 127.0.0.1. */
  allowLocalTestPlaintext?: boolean;
  /**
   * Milliseconds a single statement may run, and milliseconds a single lock
   * wait may take, before Postgres cancels it. Both default to a ceiling on the
   * pooled path and to the server's own setting under
   * `pooling: "as-configured"`; 0 means no limit. See POOLED_TIMEOUTS.
   */
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
};

export type PostgresClient = {
  sql: postgres.Sql;
  poolMode: PoolMode;
  poolNote: string;
  tls: DatabaseTls["mode"];
  host: string;
};

/**
 * Never write a query onto a connection that is still busy with another.
 *
 * WHAT BROKE. On 24 September 2026 the dev server wedged: /dashboard took
 * from 15 seconds to over ten minutes, and pg_stat_activity showed the
 * server's backends `active` with wait_event ClientRead for up to ten
 * minutes on one-row selects - Postgres waiting on the client, forever.
 * A restart was the only cure.
 *
 * postgres-js defaults max_pipeline to 100: once all `max` connections
 * are busy, the next query is written straight onto one of them behind
 * the query already running, instead of waiting its turn. Supavisor's
 * transaction mode cannot take that. The query behind is left half-sent
 * on a backend that waits for the rest of it, the driver waits for an
 * answer that never comes, and that connection is gone for good. Eight
 * of those and every page waits on a pool with nothing left in it.
 *
 * It needs nothing unusual. A connection only accepts a pipelined query
 * after one with no parameters - drizzle sends those as simple queries -
 * and ordinary pages send them: /discovery's facet counts, the schools
 * list. Loading the app's pages one at a time against a Postgres behind
 * 25ms of latency pipelined 8 of 1018 queries. Bursts of
 * refreshes, each aborting the last, only make a full pool likelier.
 *
 * NO TIMEOUT RESCUES IT. A backend waiting mid-query for the client
 * ignores statement_timeout, idle_session_timeout and
 * idle_in_transaction_session_timeout alike (checked against Postgres 18:
 * still `active`/ClientRead with all three at one second), and postgres-js
 * idle_timeout and max_lifetime both wait for the running query to finish
 * first. The only fix is not to pipeline.
 *
 * 0, not 1: the running query is not counted, so 1 still stacks one
 * behind it. And 0 needs patches/postgres+3.4.9.patch - without it
 * postgres-js skips the step where sql.begin reserves its connection and
 * every transaction throws UNSAFE_TRANSACTION. Every client, not just the
 * transaction-mode ones: the crawl and the scripts reach the same pooler,
 * and the whole cost is that a query arriving at a full pool waits its
 * turn. See scripts/test/postgres-pipelining.test.ts.
 *
 * A constant spread into the options because postgres-js reads max_pipeline
 * at runtime but its types leave it out.
 */
const NO_PIPELINING = { max_pipeline: 0 };

/**
 * No single statement, and no single lock wait, may hold a pool slot forever.
 *
 * WHY THIS IS HERE. The note above is about a query that can never finish; this
 * is about one that simply takes too long. Eight connections per instance that
 * do not pipeline means eight slow statements are the whole pool, and a request
 * that waits on a lock with no timeout waits for as long as the holder lives.
 * The Help assistant's gate found the sharp edge of that: it took one advisory
 * lock shared by every student and every recruiter and summed the day's chat
 * rows inside it, so a handful of simultaneous questions could queue the whole
 * pool behind one lock. The blast radius is not the feature that did it -
 * lib/rate-limit catches ANY database error and falls back to a per-process
 * memory counter, so a pool with nothing left in it quietly drops every rate
 * limiter in the app to its weak fallback.
 *
 * WHY THESE VALUES ARE SAFE.
 *
 * lock_timeout 3s. Every lock this codebase takes is an advisory lock around a
 * count, a sum and an insert - lib/help-gate, lib/ai-runner's reserveQuota,
 * lib/plan-quotas, lib/practice-session, the training-consent writes - and each
 * one is held for milliseconds and never across a model call or an HTTP
 * request. Row locks are held for a single statement. So the longest honest
 * wait is a few milliseconds behind another request's critical section, three
 * orders of magnitude inside this, while an unbounded wait is now impossible.
 * A request that trips it fails loudly with 55P03 instead of sitting on a
 * connection.
 *
 * statement_timeout 30s. Deliberately generous, because this constructor is
 * also every operator script's connection: the slowest work any of them does is
 * a table-wide backfill or a CREATE INDEX over tables of thousands of rows, and
 * the one script that ever named a limit for itself chose 30s
 * (scripts/audit-sourcing-runs.ts, for an aggregate over every sourcing run) -
 * so nothing in the repository asks for more than this. No page query is within
 * an order of magnitude of it; a browser gives up long before. It is not a
 * performance target, it is a ceiling: what it buys is that a pathological
 * statement releases its connection in half a minute rather than never.
 *
 * ONLY ON THE POOLED PATH. `pooling: "as-configured"` is the escape hatch an
 * operator already uses for work that needs a session of its own - backups, the
 * cross-project merges, the throwaway test cluster - and a long statement there
 * holds nobody's request queue. Those keep the server's own defaults; both
 * values can also be overridden per client below.
 *
 * That was first written as "so this change cannot break a migration", which
 * was not true: operator scripts do not open their connection here directly,
 * they open it through src/db/open.ts, and openDb passed neither the escape
 * hatch nor its own values - so all 22 of them inherited the request path's
 * ceilings, including the one that applies raw DDL. openDb now passes 0 for
 * both and says why. A script that wants a ceiling should name it there.
 *
 * Sent as STARTUP PARAMETERS rather than as `SET`, because the app's pool is
 * Supavisor's transaction mode, where a `SET` does not outlive the statement
 * (see pool.ts) - the startup packet is the only place a connection-wide
 * setting can go. postgres-js already sends application_name through the same
 * field on every connection today. If a pooler is ever found to refuse them,
 * OFFERLY_DB_NO_TIMEOUTS=1 takes them back off without a deploy.
 */
const POOLED_TIMEOUTS = { statementTimeoutMs: 30_000, lockTimeoutMs: 3_000 } as const;

function timeoutParameters(options: PostgresClientOptions): Record<string, string> {
  if (process.env.OFFERLY_DB_NO_TIMEOUTS === "1") return {};
  const pooled = options.pooling !== "as-configured";
  const statement = options.statementTimeoutMs ?? (pooled ? POOLED_TIMEOUTS.statementTimeoutMs : 0);
  const lock = options.lockTimeoutMs ?? (pooled ? POOLED_TIMEOUTS.lockTimeoutMs : 0);
  // 0 is Postgres's own "no limit", and leaving the parameter out says the same
  // thing without claiming to have set it.
  return {
    ...(statement > 0 ? { statement_timeout: String(Math.round(statement)) } : {}),
    ...(lock > 0 ? { lock_timeout: String(Math.round(lock)) } : {}),
  };
}

export function createPostgresClient(databaseUrl: string, options: PostgresClientOptions): PostgresClient {
  const pool =
    options.pooling === "as-configured"
      ? { url: databaseUrl, options: { prepare: true }, mode: "direct" as const, note: "as configured" }
      : poolFor(databaseUrl);

  const tls = databaseTls(pool.url, { allowLocalTestPlaintext: options.allowLocalTestPlaintext });

  const sql = postgres(pool.url, {
    max: options.max,
    prepare: pool.options.prepare,
    ...NO_PIPELINING,
    connect_timeout: options.connectTimeout ?? 15,
    idle_timeout: options.idleTimeout,
    onnotice: options.onnotice,
    ssl: tls.ssl,
    connection: timeoutParameters(options),
  });

  return { sql, poolMode: pool.mode, poolNote: pool.note, tls: tls.mode, host: tls.host };
}

/**
 * drizzle-kit's credentials for a URL, with verified TLS attached.
 *
 * Given `{ url }`, drizzle-kit 0.31 builds `postgres(url, { max: 1 })` - no
 * `ssl` at all, so every migration went out in plaintext. Given this object
 * form it spreads the fields, `ssl` included, into postgres-js. Decoded
 * exactly as postgres-js decodes a URL itself (parseUrl in its index.js), so
 * a password with `%`, `@` or `#` in it authenticates the same either way.
 * Never pooled: migrations need a session - see pool.ts.
 */
export function migrationCredentials(databaseUrl: string) {
  const tls = databaseTls(databaseUrl);
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new DatabaseTlsConfigError("The database URL could not be parsed.");
  }
  return {
    host: tls.host,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    ssl: tls.ssl,
  };
}
