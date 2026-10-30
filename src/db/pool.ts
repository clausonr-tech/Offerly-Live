/**
 * Which Supabase pooler to talk to, and why it is not the one in .env.local.
 *
 * WHAT BROKE. On 21 September 2026 the hourly crawl lost fifteen firms -
 * PIMCO, Nomura, Boston Partners, Capula and eleven more - not to a bad board
 * or a timeout but to this:
 *
 *   (EMAXCONNSESSION) max clients reached in session mode
 *   - max clients are limited to pool_size: 15
 *
 * DATABASE_URL points at `aws-0-us-east-1.pooler.supabase.com:5432`. Port 5432
 * on a pooler host is Supavisor's SESSION mode, where one client holds one
 * Postgres connection for as long as it stays open, and the project is capped
 * at fifteen clients IN TOTAL - across every process, not per process.
 *
 * Fifteen goes nowhere. The Next.js dev server alone took ten of them, because
 * `postgres(url)` with no `max` defaults to ten. The crawl asked for twelve.
 * Two background sweeps held more. Everything after the fifteenth was refused,
 * and a refused connection meant a firm went uncrawled that hour.
 *
 * THE FIX. Port 6543 on the same host, with the same credentials, is
 * TRANSACTION mode: a connection is borrowed for one transaction and handed
 * back, so client connections multiplex onto far fewer Postgres ones and the
 * fifteen-client ceiling does not apply. Measured against this project on
 * 21 September 2026: 40 concurrent clients, 40 succeeded, where session mode
 * fails at 16.
 *
 * `prepare: false` IS NOT OPTIONAL. Transaction mode gives consecutive
 * statements different backend connections, so a statement prepared on one is
 * missing on the next. It fails as `prepared statement "s1" does not exist`,
 * intermittently, only under concurrency - the worst shape of bug to find
 * later. A single query will appear to work with prepares on; that proves
 * nothing, so this module does not offer the choice.
 *
 * WHAT TRANSACTION MODE COSTS. Nothing that lives longer than a transaction:
 * no LISTEN/NOTIFY, no session-scoped advisory locks, no `SET` that outlives
 * the statement. Checked across every .ts and .tsx in src/ and scripts/ before
 * switching - this codebase uses none of them, and `exclusive-db.ts` guards a
 * PGlite lock FILE rather than a Postgres session. If any of those are ever
 * needed, that code has to keep its own session-mode handle.
 *
 * Set OFFERLY_DB_SESSION_MODE=1 to opt out and use DATABASE_URL verbatim.
 */

/**
 * The host:port of a Supabase pooler on the session-mode port.
 *
 * Deliberately a string edit rather than `new URL(...).toString()`. A Postgres
 * password is arbitrary bytes, and round-tripping the URL through the WHATWG
 * parser re-encodes it - which silently changes the password and turns this
 * into an authentication failure nobody would connect back to a port change.
 * `[^@/?#]*` cannot cross into the credentials, so only the host and port move.
 */
const SESSION_MODE_POOLER = /(@[^@/?#]*\.pooler\.supabase\.com):5432(?=[/?]|$)/;

export type PoolMode = "transaction" | "session" | "direct";

export type PoolChoice = {
  /** The URL to hand to postgres-js. */
  url: string;
  /** Options that MUST accompany that URL. */
  options: { prepare: boolean };
  mode: PoolMode;
  /** One line for a script to print, so the mode in use is never a guess. */
  note: string;
};

export function poolFor(databaseUrl: string): PoolChoice {
  if (process.env.OFFERLY_DB_SESSION_MODE === "1") {
    return {
      url: databaseUrl,
      options: { prepare: true },
      mode: "session",
      note: "session mode (OFFERLY_DB_SESSION_MODE=1) - capped at 15 clients for the whole project",
    };
  }

  const switched = databaseUrl.replace(SESSION_MODE_POOLER, "$1:6543");
  if (switched !== databaseUrl) {
    return {
      url: switched,
      options: { prepare: false },
      mode: "transaction",
      note: "transaction mode (pooler port 6543, prepares off)",
    };
  }

  // Not a Supabase session-mode pooler: a direct database host, a local
  // Postgres, or already on 6543. Left exactly as configured - guessing at a
  // port for a host we know nothing about would break it.
  return {
    url: databaseUrl,
    options: { prepare: true },
    mode: "direct",
    note: "as configured (not a Supabase session-mode pooler)",
  };
}

/**
 * Was this the pool refusing a client, rather than the query being wrong?
 *
 * Worth separating because the two want opposite responses: a bad query should
 * fail loudly and stay failed, while a refused connection is transient and the
 * work should be retried rather than dropped. Before transaction mode, the
 * crawl treated the second as the first and lost the firm.
 */
export function isPoolExhausted(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e && hops < 5; hops += 1) {
    const candidate = e as { code?: string; message?: string; cause?: unknown };
    if (candidate.code === "EMAXCONNSESSION") return true;
    if (typeof candidate.message === "string" && candidate.message.includes("EMAXCONNSESSION")) {
      return true;
    }
    e = candidate.cause;
  }
  return false;
}
