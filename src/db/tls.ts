import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";

/**
 * TLS for every Postgres connection - the one place that decides it.
 *
 * WHY NOT `ssl: "require"`. In postgres-js 3.4.9, "require", "allow" and
 * "prefer" all set `rejectUnauthorized = false` (connection.js:283): the link
 * is encrypted but the server is never authenticated, so anyone on the path
 * can present their own certificate and read everything. Verification only
 * happens when `ssl` is an OBJECT, which postgres-js merges into
 * `tls.connect` - so that is what this builds: the CA pinned, the hostname
 * checked, and no parameter that switches either off.
 *
 * An explicit `ssl` option also outranks `?sslmode=` in the URL and the PGSSL
 * environment variable (index.js parseOptions), so a stray `sslmode=disable`
 * cannot downgrade a connection built here.
 *
 * WHY THE CA IS PINNED. Supabase's pooler presents a certificate chained to
 * Supabase's own root, not a public one - verified 2026-09-23 against Node's
 * default trust store, which refuses it with SELF_SIGNED_CERT_IN_CHAIN.
 *
 * WHY IT COMES FROM THE ENVIRONMENT, NOT THE REPO. So a CA rotation is an
 * environment change and a restart, never a release. The value may hold
 * several certificates: during a rotation, trust old and new together, then
 * drop the old one once the server has moved.
 *
 * Deliberately no "server-only" import: drizzle.config.ts loads this under
 * drizzle-kit, which does not resolve the react-server condition.
 */

export class DatabaseTlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTlsConfigError";
  }
}

/** The only value that disables TLS, and only for a loopback test database. */
export const LOCAL_TEST_PLAINTEXT = "insecure-local-test";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type DatabaseTls =
  | { mode: "verify-full"; host: string; ssl: ConnectionOptions }
  | { mode: "plaintext-local-test"; host: string; ssl: false };

/**
 * The host a connection URL points at.
 *
 * Errors never echo the input: a connection URL carries the password, and
 * Node's own `Invalid URL` TypeError keeps it on `err.input`.
 */
export function databaseHost(databaseUrl: string): string {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new DatabaseTlsConfigError("The database URL could not be parsed.");
  }
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new DatabaseTlsConfigError("The database URL has no host.");
  return host;
}

/**
 * Refuses anything that is not a current CA certificate.
 *
 * A private key in this slot means someone pasted the wrong file - and a
 * server key sitting in an app environment variable is its own incident.
 */
export function assertCaCertificate(pem: string, source: string): void {
  if (/PRIVATE KEY/.test(pem)) {
    throw new DatabaseTlsConfigError(`${source} contains a private key; it must hold only the CA certificate.`);
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks?.length) {
    throw new DatabaseTlsConfigError(`${source} does not contain a PEM certificate.`);
  }
  for (const block of blocks) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      throw new DatabaseTlsConfigError(`${source} contains a certificate that could not be parsed.`);
    }
    if (!cert.ca) throw new DatabaseTlsConfigError(`${source} is not a CA certificate.`);
    if (new Date(cert.validTo).getTime() < Date.now()) {
      throw new DatabaseTlsConfigError(`${source} expired on ${cert.validTo}.`);
    }
  }
}

/**
 * The CA to trust: an inline PEM (Vercel, where the env store is the only file
 * system) or a file path (a machine with a disk - local dev, the crawler).
 * Fails closed - with neither set, nothing connects.
 */
function loadDatabaseCa(env: NodeJS.ProcessEnv = process.env): string {
  const inline = env.DATABASE_CA_CERT?.trim();
  const file = env.DATABASE_CA_CERT_FILE?.trim();

  let pem: string;
  let source: string;
  if (inline) {
    // Single-line env stores commonly carry the newlines escaped.
    pem = inline.replace(/\\n/g, "\n");
    source = "DATABASE_CA_CERT";
  } else if (file) {
    try {
      pem = readFileSync(file, "utf8");
    } catch {
      throw new DatabaseTlsConfigError("DATABASE_CA_CERT_FILE could not be read.");
    }
    source = "DATABASE_CA_CERT_FILE";
  } else {
    throw new DatabaseTlsConfigError(
      "No database CA is configured. Set DATABASE_CA_CERT (the PEM) or DATABASE_CA_CERT_FILE (a path) - " +
        "the Supabase root CA from Project Settings -> Database -> SSL Configuration.",
    );
  }

  assertCaCertificate(pem, source);
  return pem;
}

/**
 * The TLS settings for one connection URL.
 *
 * Plaintext exists for exactly one case - the disposable Postgres the test
 * suite starts on 127.0.0.1 - and is refused for any other host, under
 * NODE_ENV=production, and anywhere on Vercel, whichever way it was asked for.
 */
export function databaseTls(
  databaseUrl: string,
  opts: { allowLocalTestPlaintext?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): DatabaseTls {
  const host = databaseHost(databaseUrl);
  const requested = env.OFFERLY_DB_TLS?.trim();

  if (requested && requested !== "verify-full" && requested !== LOCAL_TEST_PLAINTEXT) {
    throw new DatabaseTlsConfigError(`OFFERLY_DB_TLS must be "verify-full" or "${LOCAL_TEST_PLAINTEXT}".`);
  }

  if (opts.allowLocalTestPlaintext === true || requested === LOCAL_TEST_PLAINTEXT) {
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new DatabaseTlsConfigError(
        "Plaintext database connections are only permitted to a loopback test database.",
      );
    }
    if (env.NODE_ENV === "production" || env.VERCEL) {
      throw new DatabaseTlsConfigError("Plaintext database connections are never permitted in production.");
    }
    return { mode: "plaintext-local-test", host, ssl: false };
  }

  return {
    mode: "verify-full",
    host,
    ssl: {
      ca: loadDatabaseCa(env),
      rejectUnauthorized: true,
      // Node checks the certificate against this name. postgres-js passes the
      // same value, but setting it here keeps the check independent of that.
      servername: isIP(host) ? undefined : host,
      minVersion: "TLSv1.2",
    },
  };
}

/** TLS failure codes worth naming at startup, so a refusal reads as TLS. */
const TLS_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "EPROTO",
]);

/** Whether a connection error was the TLS layer refusing the server. */
export function isTlsFailure(err: unknown): boolean {
  return TLS_ERROR_CODES.has((err as { code?: string } | null)?.code ?? "");
}

/**
 * A one-line description of a connection failure that is safe to log: the
 * host and the error code, never the URL, the user or the password.
 */
export function describeDatabaseFailure(err: unknown, host: string): string {
  const code = (err as { code?: string } | null)?.code ?? "UNKNOWN";
  return isTlsFailure(err)
    ? `verified TLS to ${host} could not be established (${code}); refusing to connect without it`
    : `database connection to ${host} failed (${code})`;
}
