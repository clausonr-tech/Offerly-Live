/**
 * A disposable, REAL PostgreSQL, driven by the production driver.
 *
 * WHY THIS EXISTS
 * ---------------
 * The offline suite ran entirely on PGlite, and PGlite is forgiving in ways
 * the real stack is not. A JS `Date` interpolated into a raw `sql` template
 * was accepted by PGlite and refused by postgres-js, so 4264 tests passed and
 * the first live query threw. Everything in this file therefore uses the exact
 * pair production uses - `postgres` (postgres-js) under
 * `drizzle-orm/postgres-js` - so a serialisation difference fails here
 * instead of in front of a student.
 *
 * NOTHING HERE TOUCHES SUPABASE. It runs `initdb` into a temp directory,
 * starts a private cluster on a loopback port with trust auth, and deletes the
 * whole directory afterwards. DATABASE_URL is never read.
 *
 * SKIPS ONLY IF POSTGRES IS ABSENT, and says so loudly - the one honest skip,
 * because a machine without Postgres binaries genuinely cannot run this, and
 * the PGlite suite still covers the logic. See `postgresAvailability()`.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { createPostgresClient } from "../../../src/db/connection";

import * as schema from "../../../src/db/schema";
import { migrationFiles } from "./test-db";

/** Where a Postgres installation might be. Postgres.app first - it is what
 *  this machine has, and there is no server on PATH. */
const BIN_DIRS = [
  process.env.OFFERLY_PG_BIN,
  path.join(process.env.HOME ?? "", ".local/pg18/bin"),
  "/opt/homebrew/opt/postgresql@17/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/lib/postgresql/17/bin",
  "/usr/lib/postgresql/16/bin",
].filter((d): d is string => !!d);

/**
 * The environment the cluster is started with.
 *
 * LC_ALL is the load-bearing part, and without it PostgreSQL 18 on macOS
 * refuses to start at all:
 *
 *     FATAL:  postmaster became multithreaded during startup
 *     HINT:   Set the LC_ALL environment variable to a valid locale.
 *
 * With no LC_ALL set, macOS's locale lookup spawns a thread during startup,
 * and PG18 added a check that aborts when the postmaster is multithreaded
 * before it forks. PG17 and earlier did not care, which is why this appeared
 * the day a machine moved to 18 rather than when the tests were written.
 *
 * Set only when the caller has not set one, so a developer who deliberately
 * runs the suite under a particular locale keeps it. "C" is the right default
 * for a disposable cluster: it is always present, needs no locale archive,
 * and makes collation identical on every machine that runs these tests.
 */
function clusterEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: process.env.LC_ALL ?? "C",
    LANG: process.env.LANG ?? "C",
  };
}

function findBinDir(): string | null {
  return BIN_DIRS.find((d) => existsSync(path.join(d, "initdb")) && existsSync(path.join(d, "postgres"))) ?? null;
}

export function postgresAvailability(): { ok: true; bin: string; version: string } | { ok: false; why: string } {
  const bin = findBinDir();
  if (!bin) {
    return {
      ok: false,
      why:
        "no PostgreSQL server binaries found (looked for initdb + postgres in " +
        `${BIN_DIRS.join(", ")}). Set OFFERLY_PG_BIN to a bin directory, or install Postgres.app.`,
    };
  }
  /**
   * Root cannot run this, and that is Postgres's rule, not ours.
   *
   * `initdb` refuses outright as root - "cannot be run as root" - because the
   * server drops privileges and will not own a data directory it could be
   * tricked into writing anywhere. There is no flag to override it.
   *
   * Binaries present but unusable is the same situation as binaries absent,
   * and it is the situation in every container that runs as root, which is
   * most CI and every cloud session. Without this check `postgresAvailability`
   * said ok, all 21 tests in the parity suite ran, and all 21 failed with
   * `Command failed: /usr/lib/postgresql/16/bin/initdb` - a wall of red that
   * reads like a driver regression and is an environment fact. Worse, it is
   * indistinguishable at a glance from the parity suite genuinely catching
   * something, which is the one thing this suite exists to tell you.
   *
   * So: the same honest skip, with the reason named and the remedy with it.
   * `geteuid` is absent on Windows, where no such rule applies.
   */
  if (process.getuid?.() === 0) {
    return {
      ok: false,
      why:
        "running as root, and initdb refuses to run as root (no override exists). " +
        "Re-run as an unprivileged user - e.g. `useradd -m pg && su pg -c 'npm test'` - " +
        "or in a container that does not default to root. The PGlite suite still " +
        "covers the logic; only real-driver parity is unchecked.",
    };
  }
  const version = execFileSync(path.join(bin, "postgres"), ["--version"], { encoding: "utf8" }).trim();
  return { ok: true, bin, version };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export type RealPostgres = {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sql: postgres.Sql;
  url: string;
  version: string;
  stop: () => Promise<void>;
};

/**
 * Start a cluster, migrate it, hand back a Drizzle instance on postgres-js.
 *
 * `--auth=trust` and a loopback-only listener: the cluster is reachable only
 * from this machine, lives for the length of one test file, and holds nothing
 * but synthetic rows.
 */
export async function startRealPostgres(): Promise<RealPostgres> {
  const availability = postgresAvailability();
  if (!availability.ok) throw new Error(availability.why);
  const { bin } = availability;

  const dir = mkdtempSync(path.join(tmpdir(), "offerly-pg-"));
  const dataDir = path.join(dir, "data");
  const port = await freePort();

  /**
   * initdb's own stderr, kept for the same reason the postmaster's is.
   *
   * `stdio: "ignore"` here produced `Command failed: /opt/homebrew/bin/initdb
   * -D /var/folders/.../data ...` and nothing else - the argv echoed back,
   * with the one sentence explaining the failure discarded. A bad locale
   * fails at this step rather than at the postmaster, so this is the message
   * a developer actually hits first.
   */
  try {
    execFileSync(path.join(bin, "initdb"), ["-D", dataDir, "-U", "postgres", "--auth=trust", "--no-sync"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: clusterEnv(),
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const detail = stderr ? String(stderr).trim() : "";
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `initdb failed (LC_ALL=${clusterEnv().LC_ALL})` + (detail ? `\n${detail.split("\n").map((l) => `  ${l}`).join("\n")}` : ""),
    );
  }

  /**
   * The postmaster's own output, kept rather than discarded.
   *
   * This was `stdio: "ignore"`, and that is what made the locale failure above
   * cost an afternoon. When the cluster refuses to start, the only symptom is
   * the 30-second connection loop below timing out with a generic ECONNREFUSED
   * - while the postmaster has already written the exact reason, and the
   *   exact fix, to a stream nobody was reading. Twenty-six tests failed for
   *   twelve minutes with no clue between them.
   *
   * Written to a file inside the temp directory, so it is deleted with
   * everything else, and read back into the thrown error on failure.
   */
  const logPath = path.join(dir, "postmaster.log");
  const logFd = openSync(logPath, "a");
  let server: ChildProcess | null = spawn(
    path.join(bin, "postgres"),
    ["-D", dataDir, "-p", String(port), "-h", "127.0.0.1", "-k", dir, "-c", "fsync=off", "-c", "full_page_writes=off"],
    { stdio: ["ignore", logFd, logFd], env: clusterEnv() },
  );

  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  // The one sanctioned plaintext connection: a throwaway cluster this process
  // just started on 127.0.0.1. tls.ts refuses the same flag for any other host
  // and under NODE_ENV=production.
  const local = { pooling: "as-configured", allowLocalTestPlaintext: true, onnotice: () => {} } as const;
  const { sql } = createPostgresClient(url, { ...local, max: 1, idleTimeout: 5, connectTimeout: 10 });

  const cleanup = async () => {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // already closed
    }
    if (server) {
      server.kill("SIGQUIT"); // immediate shutdown; nothing here is worth flushing
      server = null;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    // Wait for the postmaster to accept connections.
    //
    // Give up early if it has already exited: a cluster that refused to start
    // is never going to answer, and burning the full 30 seconds per test file
    // to re-learn that is most of why a broken suite took twelve minutes.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await sql`select 1`;
        break;
      } catch (error) {
        const dead = !server || server.exitCode !== null || server.signalCode !== null;
        if (dead || Date.now() > deadline) {
          throw new Error(
            `${dead ? "the postmaster exited during startup" : "timed out waiting for the postmaster"}\n` +
              `${postmasterLog(logPath)}\n` +
              `(original error: ${error instanceof Error ? error.message : String(error)})`,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    /**
     * The session zone, pinned - the same thing src/db/utc-clock.ts does for
     * PGlite and the same reason. `created_at` columns are `timestamp without
     * time zone` holding a UTC wall clock, and a cluster initdb'd on a
     * US-Pacific host would otherwise fill its defaults seven hours out.
     */
    await sql`alter database postgres set timezone to 'UTC'`;
    await sql.end({ timeout: 5 });
  } catch (error) {
    await cleanup();
    throw error;
  }

  // Reconnect so the pinned timezone applies, and keep enough connections for
  // the concurrency tests to genuinely overlap.
  const { sql: live } = createPostgresClient(url, { ...local, max: 5, idleTimeout: 20, connectTimeout: 10 });
  const db = drizzle(live, { schema });

  try {
    for (const file of migrationFiles()) {
      for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) await live.unsafe(trimmed);
      }
    }
  } catch (error) {
    await live.end({ timeout: 5 });
    await cleanup();
    throw error;
  }

  const [{ version }] = await live<{ version: string }[]>`select version()`;

  return {
    db,
    sql: live,
    url,
    version: version.split(" on ")[0],
    stop: async () => {
      try {
        await live.end({ timeout: 5 });
      } catch {
        // already closed
      }
      await cleanup();
    },
  };
}

/**
 * What the postmaster said, for an error message a person can act on.
 *
 * FATAL lines first when there are any - they carry the reason and usually a
 * HINT with the fix - and the tail otherwise.
 */
function postmasterLog(logPath: string): string {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8").trim();
  } catch {
    return "postmaster log: (unreadable)";
  }
  if (!text) return "postmaster log: (empty - it may not have started at all)";
  const lines = text.split("\n");
  const fatal = lines.filter((l) => /\b(FATAL|PANIC|HINT)\b/.test(l));
  const shown = (fatal.length ? fatal : lines.slice(-8)).map((l) => `  ${l}`).join("\n");
  return `postmaster log:\n${shown}`;
}
