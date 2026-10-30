/**
 * Next.js calls this once when the server process starts.
 *
 * Opening the first connection to a remote Postgres costs a TCP handshake, a
 * TLS handshake and a SCRAM auth exchange - several round trips, measured at
 * 1.1-3.6 seconds against a database in another region. Without this, the
 * first person to load a page after a deploy or restart pays all of it.
 *
 * One throwaway query here moves that cost to boot, where nobody is waiting.
 * The pool keeps the connection open afterwards, so every later request finds
 * it ready.
 *
 * Guarded on DATABASE_URL, and that guard is load-bearing rather than tidy.
 * The local PGlite fallback has no handshake to amortise, so there would be
 * nothing to gain - but worse, Next bundles this hook separately from the
 * route and page code, which means the `global.__dbPromise` singleton in
 * db/client.ts is not guaranteed to be the same one they see. Warming PGlite
 * here could therefore open a SECOND engine on ./local-data/pglite inside the
 * one process, and two writers on that directory is exactly what corrupts it.
 * Remote Postgres has no such hazard: a second pool is wasteful, not fatal.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;

  // A real environment (DATABASE_URL is set) must be able to seal OAuth tokens
  // at rest. Warn loudly rather than crash: a missing key should be caught in
  // the boot logs, but it must not take the whole site down - sealToken itself
  // refuses to write plaintext in production, so tokens are never exposed.
  const { hasTokenKey } = await import("@/lib/token-crypto");
  if (!hasTokenKey()) {
    console.warn(
      "[startup] no OAUTH_TOKEN_KEY or EMAIL_ARCHIVE_KEY set; connecting a Google account will fail until one is configured (OAuth tokens are never stored unencrypted in production)",
    );
  }

  try {
    const [{ getDb }, { sql }] = await Promise.all([import("@/db/client"), import("drizzle-orm")]);
    const db = await getDb();
    await db.execute(sql`select 1`);
    // The firm-directory sync used to run here too, costing every boot ~11s.
    // It is now an explicit step, `npm run db:sync-firms` (lib/firm-sync.ts).
  } catch (err) {
    const { databaseHost, describeDatabaseFailure, isTlsFailure } = await import("@/db/tls");
    let host = "the database";
    try {
      host = databaseHost(process.env.DATABASE_URL);
    } catch {
      // Unparseable URL: say nothing about it rather than echo it.
    }

    // A TLS refusal or a missing CA is not a warm-up hiccup: no request could
    // succeed, and continuing would only move the same failure onto users.
    // Stop here, saying why, in a line that names the host and error code and
    // nothing that could carry the password.
    if ((err as Error)?.name === "DatabaseTlsConfigError") {
      console.error(`[db] ${(err as Error).message}`);
      throw err;
    }
    const line = describeDatabaseFailure(err, host);
    console.error(`[db] ${line}`);
    if (isTlsFailure(err)) throw new Error(line);

    // Anything else - a timeout, a pool refusal - stays a warm-up failure.
    // The first real request will do this work itself, the way it always did.
  }
}
