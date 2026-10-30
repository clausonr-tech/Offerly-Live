import { Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Refuse to open the local database while the dev server has it.
 *
 * PGlite is single-writer. Two processes holding the same directory corrupts it
 * beyond repair - the engine then aborts on every query, including `select 1`,
 * and there is no repair tool in WASM. src/db/client.ts has said so since it
 * was written.
 *
 * Saying so was not enough. On 18 September 2026 this repository lost its
 * working database exactly that way: a dev server left running alongside a
 * `drizzle-kit push` and a crawl. Every script carried the warning in a comment
 * at the top, and the warning depends on a person reading it and remembering,
 * every time, forever. That is not a safeguard, it is a hope.
 *
 * So: a check that cannot be forgotten. If something is listening on the dev
 * port, the script stops before opening the database and says what to do.
 *
 * This is a guard rail, not a lock - it detects the common cause rather than
 * every possible one. The actual fix is a real Postgres, which has none of this
 * problem; until then, this removes the failure that has actually happened.
 */

/**
 * Which ports to treat as "the dev server might be here".
 *
 * This was a single hardcoded 3000, and on 18 September 2026 the dev script
 * moved to `next dev --port 3001` for an unrelated OAuth-redirect reason. The
 * guard went on watching 3000 and would have waved through the exact scenario
 * it exists to stop - silently, across all 35 scripts, with no error to notice.
 *
 * So it reads the port out of the dev script itself rather than repeating the
 * number. A `--port` flag there is the single source of truth: change it and
 * the guard follows, which is the only version of this that stays correct.
 *
 * 3000 stays in the set regardless. It is Next's default, so a bare `next dev`
 * lands there, and checking a port nothing uses costs nothing - scripts are
 * meant to run with the server stopped either way.
 */
export function devPorts(): number[] {
  const ports = new Set<number>([3000]);

  if (process.env.PORT) ports.add(Number(process.env.PORT));

  try {
    const pkg = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const dev = (JSON.parse(pkg).scripts?.dev ?? "") as string;
    const flag = /--port[= ](\d+)/.exec(dev);
    if (flag) ports.add(Number(flag[1]));
  } catch {
    // Read from a different cwd, or an unreadable package.json. Fall back to
    // the defaults above rather than failing the script outright: a guard that
    // blocks work when it cannot introspect is a guard people switch off.
  }

  return [...ports].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

/**
 * Ask the port whether anyone answers, by connecting to it.
 *
 * This used to try to BIND 127.0.0.1:port and read EADDRINUSE, and that never
 * worked. `next dev` binds the wildcard address 0.0.0.0, and on macOS binding
 * the specific address 127.0.0.1 while another socket holds the wildcard
 * SUCCEEDS - so the check reported "free" with the dev server plainly running
 * and every script sailed through. Measured on 18 September 2026, with the
 * server up: bind 0.0.0.0:3001 gives EADDRINUSE, bind 127.0.0.1:3001 gives a
 * listening socket.
 *
 * Which means the safeguard written after losing a database had, until now,
 * never once fired. Nothing about it looked wrong; it simply asked the wrong
 * question. Connecting asks the right one - a successful TCP connection means
 * something is listening, whatever address it bound and whatever it is.
 *
 * Both loopback families are tried: a server on ::1 alone is invisible to a
 * probe of 127.0.0.1, and being wrong in that direction is the expensive one.
 */
function portInUse(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = new Socket();
      const done = (answer: boolean) => {
        socket.destroy();
        resolve(answer);
      };
      // Loopback answers in microseconds; anything slower is not a dev server.
      socket.setTimeout(500);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
      socket.connect(port, host);
    });

  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((r) => r.some(Boolean));
}

/**
 * The lock file PGlite leaves behind, and whether anything still holds it.
 *
 * The port check above catches a RUNNING dev server. It cannot catch the other
 * way this directory becomes unopenable: a killed process leaves its
 * `postmaster.pid` behind, and PGlite then refuses to start - not with an
 * error anyone can act on, but with
 *
 *   RuntimeError: Aborted(). Build with -sASSERTIONS for more info.
 *   at wasm://wasm/0267b22e:wasm-function[13296]
 *
 * after several screens of blank output. That is what a person sees, and it
 * tells them nothing. It is also why the scheduled crawl logs FAILED rather
 * than anything readable: monitor-run dies the same way.
 *
 * PGlite writes `-42` as its pid, which is not a process id at all - so a
 * `-42` file is stale by definition. A positive pid is checked against the
 * process table, because that one might be a real second writer.
 *
 * Detected, never deleted. The repo's own guard hook blocks deletes under
 * local-data/ and is right to: this file is the only thing standing between a
 * crash and two writers on one directory. Handing over the exact command is
 * the job.
 */
export function staleLock(): { path: string; pid: number } | null {
  const dir = process.env.PGLITE_DATA_DIR || "./local-data/pglite";
  const path = join(dir, "postmaster.pid");

  let pid: number;
  try {
    pid = Number(readFileSync(path, "utf8").split("\n")[0]?.trim());
  } catch {
    return null; // no lock file: nothing to report
  }
  if (!Number.isFinite(pid)) return { path, pid: NaN };

  // PGlite's own sentinel. Never a real process.
  if (pid < 0) return { path, pid };

  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return null; // a live process holds it - that is a different problem
  } catch {
    return { path, pid };
  }
}

/**
 * Call before opening PGlite in any standalone script.
 *
 * A no-op when DATABASE_URL is set: real Postgres handles concurrent writers,
 * which is the whole reason to move to it.
 */
export async function assertExclusiveDbAccess(
  options: { evenWithDatabaseUrl?: boolean; viaOpenDb?: boolean } = {},
): Promise<void> {
  /**
   * `evenWithDatabaseUrl` exists for the migration.
   *
   * The DATABASE_URL short circuit below is right for every ordinary script -
   * real Postgres handles concurrent writers, so there is nothing to guard.
   * It is exactly wrong for a script that READS PGlite while writing to
   * Postgres: DATABASE_URL is set, so the guard would fall silent at the one
   * moment the single-writer rule still applies. That is not hypothetical -
   * this database was corrupted on 19 September 2026 by a second process
   * opening the directory during a crawl.
   */
  if (process.env.DATABASE_URL && !options.evenWithDatabaseUrl) {
    /**
     * Say so, loudly, when a script is about to write to the wrong database.
     *
     * Every caller of this function opens PGlite immediately afterwards -
     * that is what it is for. So DATABASE_URL being set here means the
     * project has moved to Postgres and THIS script has not: it will read and
     * write the stale local file, successfully, reporting nothing wrong,
     * while the application serves different data. Two live databases
     * diverging in silence is the failure this warning exists to make
     * impossible to miss.
     *
     * Scripts that go through src/db/open.ts pass `viaOpenDb` and are exempt,
     * because they follow DATABASE_URL correctly.
     */
    if (!options.viaOpenDb) {
      console.warn(
        [
          "",
          "! DATABASE_URL is set, but this script opens the LOCAL PGlite database directly.",
          "  Anything it writes will go to the local file, NOT to Postgres, and the two will",
          "  diverge with no error to notice. Port it to openDb() from src/db/open.ts before",
          "  relying on what it reports.",
          "",
        ].join("\n"),
      );
    }
    return;
  }
  if (process.env.ALLOW_CONCURRENT_PGLITE === "1") {
    console.warn("! ALLOW_CONCURRENT_PGLITE=1 - skipping the single-writer check. This is how the database was lost once already.");
    return;
  }

  const ports = devPorts();
  const busy = (await Promise.all(ports.map(async (p) => ((await portInUse(p)) ? p : null)))).filter(
    (p): p is number => p !== null,
  );

  if (busy.length > 0) {
    console.error(
      [
        "",
        `REFUSING TO RUN: something is listening on port ${busy.join(" and ")}, which is almost certainly the dev server.`,
        "",
        "PGlite is single-writer. Two processes on one data directory corrupt it permanently,",
        "and there is no repair tool - this repository has already lost a database this way.",
        "",
        "Stop the dev server, then run this again.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  /**
   * Reported AFTER the port check, and as a WARNING rather than a refusal.
   *
   * This blocked runs it should not have, and the reason is worth recording
   * because the mistake was mine and it was a reasoning error, not a typo.
   *
   * When the database turned out to be unopenable there was also a stale
   * `postmaster.pid` beside it, and I treated the lock as the cause. It was
   * not: an unlocked COPY of that directory still aborted on `select 1`, so
   * the corruption was independent and the lock file was a bystander.
   *
   * The evidence was there all along. monitor-run exits with `process.exit(0)`
   * and never closes PGlite, so EVERY successful crawl leaves this file
   * behind - and the hourly crawls on 19 September ran green one after
   * another with it present. PGlite simply overwrites it.
   *
   * So refusing on it converted a harmless leftover into a dead scheduler.
   * What the check is genuinely good for is the message: when PGlite DOES
   * abort, it does so inside WebAssembly with several screens of minified
   * stack and no explanation, and knowing a stale lock is present is the
   * first thing anyone would want to be told. That is worth saying. It is not
   * worth stopping for.
   */
  const lock = staleLock();
  if (lock) {
    console.warn(
      [
        "",
        `note: ${lock.path} is present and no live process holds it` +
          (lock.pid < 0 ? ` (pid ${lock.pid} is PGlite's own sentinel)` : ` (pid ${lock.pid} is not running)`),
        "      Normal - a run that exits without closing leaves one. Continuing.",
        "      If PGlite now aborts inside WebAssembly, remove it and try again:",
        `        rm ${JSON.stringify(lock.path)}`,
        "",
      ].join("\n"),
    );
  }
}
