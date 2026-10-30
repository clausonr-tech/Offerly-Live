import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import tls from "node:tls";

import { createPostgresClient } from "@/db/connection";
import {
  DatabaseTlsConfigError,
  LOCAL_TEST_PLAINTEXT,
  assertCaCertificate,
  databaseTls,
  describeDatabaseFailure,
} from "@/db/tls";

/**
 * Verified TLS for every database connection, proven against the real
 * postgres-js client and a stand-in server - no real database, no network
 * beyond 127.0.0.1.
 *
 * The certificates are minted per run with the system `openssl`, so nothing
 * here is a fixture that could drift or be mistaken for a real key.
 */

const PASSWORD = "not-a-real-password-7f3a";
let dir: string;
let trustedCa: string;
let goodServer: { cert: string; key: string };
let wrongHostServer: { cert: string; key: string };
let untrustedServer: { cert: string; key: string };

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
}

function mintCa(name: string): string {
  writeFileSync(path.join(dir, `${name}.ext`), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", `${name}.key`, "-out", `${name}.crt`, "-subj", `/CN=${name}`,
    "-extensions", "v3_ca", "-config", writeReqConfig(name));
  return readFileSync(path.join(dir, `${name}.crt`), "utf8");
}

function writeReqConfig(name: string): string {
  const file = path.join(dir, `${name}.cnf`);
  writeFileSync(file, [
    "[req]", "distinguished_name=dn", "[dn]",
    "[v3_ca]", "basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign",
  ].join("\n"));
  return file;
}

function mintLeaf(name: string, ca: string, dnsName: string): { cert: string; key: string } {
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${dnsName}`);
  writeFileSync(path.join(dir, `${name}.ext`), `basicConstraints=CA:FALSE\nsubjectAltName=DNS:${dnsName}\nextendedKeyUsage=serverAuth\n`);
  openssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.crt`, "-CAkey", `${ca}.key`, "-CAcreateserial",
    "-days", "2", "-out", `${name}.crt`, "-extfile", `${name}.ext`);
  return {
    cert: readFileSync(path.join(dir, `${name}.crt`), "utf8"),
    key: readFileSync(path.join(dir, `${name}.key`), "utf8"),
  };
}

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "offerly-db-tls-"));
  trustedCa = mintCa("trusted-ca");
  mintCa("untrusted-ca"); // only signs the untrusted leaf; never trusted
  goodServer = mintLeaf("good", "trusted-ca", "localhost");
  wrongHostServer = mintLeaf("wrong-host", "trusted-ca", "db.wrong-host.test");
  untrustedServer = mintLeaf("untrusted", "untrusted-ca", "localhost");
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** Env overrides for one test, restored afterwards whatever happens. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const SSL_REQUEST = 80877103;
const PROTOCOL_3 = 196608;

/**
 * Just enough of a Postgres server: answers the SSLRequest, and once TLS is
 * up replies to the startup packet with an ErrorResponse naming itself - so
 * a client error saying "fake-server-reached" proves the handshake verified.
 * With `acceptSsl: false` it declines TLS and records whatever the client
 * sends next, which is how plaintext fallback would show up.
 */
async function fakePostgres(opts: { cert?: string; key?: string; acceptSsl: boolean }) {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", (first) => {
      if (first.length < 8 || first.readInt32BE(4) !== SSL_REQUEST) {
        received.push(first);
        sock.destroy();
        return;
      }
      if (!opts.acceptSsl) {
        sock.write("N");
        sock.once("data", (next) => {
          received.push(next);
          sock.destroy();
        });
        return;
      }
      sock.write("S");
      const secure = new tls.TLSSocket(sock, { isServer: true, cert: opts.cert, key: opts.key });
      secure.on("error", () => {});
      secure.once("data", () => {
        const fields = Buffer.from("SFATAL\0VFATAL\0C28000\0Mfake-server-reached\0\0", "utf8");
        const len = Buffer.alloc(4);
        len.writeInt32BE(fields.length + 4);
        secure.end(Buffer.concat([Buffer.from("E"), len, fields]));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `postgres://offerly:${PASSWORD}@localhost:${port}/offerly`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function firstQueryError(url: string, ca: string): Promise<{ code?: string; message: string }> {
  return withEnv({ DATABASE_CA_CERT: ca, DATABASE_CA_CERT_FILE: undefined, OFFERLY_DB_TLS: undefined }, async () => {
    const { sql } = createPostgresClient(url, { max: 1, connectTimeout: 5, pooling: "as-configured" });
    try {
      await sql`select 1`;
      return { message: "query unexpectedly succeeded" };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code, message: String(e.message) };
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });
}

// ---- the client against a TLS server --------------------------------------

test("succeeds with the expected CA and hostname", async () => {
  const srv = await fakePostgres({ ...goodServer, acceptSsl: true });
  try {
    const err = await firstQueryError(srv.url, trustedCa);
    // The server's own ErrorResponse: TLS verified and the protocol was reached.
    assert.match(err.message, /fake-server-reached/);
  } finally {
    await srv.close();
  }
});

test("refuses a certificate from an untrusted CA", async () => {
  const srv = await fakePostgres({ ...untrustedServer, acceptSsl: true });
  try {
    const err = await firstQueryError(srv.url, trustedCa);
    assert.doesNotMatch(err.message, /fake-server-reached/);
    assert.ok(
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(err.code ?? ""),
      `expected a trust failure, got ${err.code}`,
    );
  } finally {
    await srv.close();
  }
});

test("refuses a certificate for a different hostname", async () => {
  const srv = await fakePostgres({ ...wrongHostServer, acceptSsl: true });
  try {
    const err = await firstQueryError(srv.url, trustedCa);
    assert.doesNotMatch(err.message, /fake-server-reached/);
    assert.equal(err.code, "ERR_TLS_CERT_ALTNAME_INVALID");
  } finally {
    await srv.close();
  }
});

test("refuses plaintext when the server declines TLS - no startup packet is ever sent in the clear", async () => {
  const srv = await fakePostgres({ acceptSsl: false });
  try {
    const err = await firstQueryError(srv.url, trustedCa);
    assert.doesNotMatch(err.message, /fake-server-reached/);
    for (const chunk of srv.received) {
      const isStartup = chunk.length >= 8 && chunk.readInt32BE(4) === PROTOCOL_3;
      assert.equal(isStartup, false, "the client sent a plaintext startup packet");
      assert.equal(chunk.includes(Buffer.from(PASSWORD)), false, "the password crossed in the clear");
    }
  } finally {
    await srv.close();
  }
});

// ---- the policy ------------------------------------------------------------

const CA_ENV = () => ({ DATABASE_CA_CERT: trustedCa, DATABASE_CA_CERT_FILE: undefined, OFFERLY_DB_TLS: undefined, NODE_ENV: undefined, VERCEL: undefined });

test("the default for any host is verify-full: CA pinned, hostname checked, never unauthorized", async () => {
  await withEnv(CA_ENV(), () => {
    const t = databaseTls(`postgres://u:${PASSWORD}@aws-0-us-east-2.pooler.supabase.com:6543/postgres`);
    assert.equal(t.mode, "verify-full");
    assert.ok(t.ssl);
    assert.equal(t.ssl.rejectUnauthorized, true);
    assert.equal(t.ssl.servername, "aws-0-us-east-2.pooler.supabase.com");
    assert.equal(String(t.ssl.ca).trim(), trustedCa.trim());
  });
});

test("?sslmode=disable in the URL cannot downgrade a client built here", async () => {
  await withEnv(CA_ENV(), async () => {
    const { sql } = createPostgresClient(`postgres://u:${PASSWORD}@db.example.com:5432/x?sslmode=disable`, { max: 1, pooling: "as-configured" });
    try {
      const ssl = sql.options.ssl as tls.ConnectionOptions;
      assert.equal(typeof ssl, "object");
      assert.equal(ssl.rejectUnauthorized, true);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

test("plaintext is allowed only for a loopback test database, outside production", async () => {
  await withEnv(CA_ENV(), () => {
    assert.equal(databaseTls("postgres://postgres@127.0.0.1:5999/postgres", { allowLocalTestPlaintext: true }).mode, "plaintext-local-test");
    assert.throws(() => databaseTls("postgres://u:p@db.example.com/x", { allowLocalTestPlaintext: true }), DatabaseTlsConfigError);
  });
  await withEnv({ ...CA_ENV(), OFFERLY_DB_TLS: LOCAL_TEST_PLAINTEXT }, () => {
    assert.throws(() => databaseTls("postgres://u:p@aws-0-us-east-2.pooler.supabase.com:6543/x"), DatabaseTlsConfigError);
  });
});

test("the local test mode cannot be selected in production, by option or by env", async () => {
  for (const prod of [{ NODE_ENV: "production" }, { VERCEL: "1" }]) {
    await withEnv({ ...CA_ENV(), ...prod }, () => {
      assert.throws(() => databaseTls("postgres://postgres@127.0.0.1:5999/postgres", { allowLocalTestPlaintext: true }), DatabaseTlsConfigError);
    });
    await withEnv({ ...CA_ENV(), ...prod, OFFERLY_DB_TLS: LOCAL_TEST_PLAINTEXT }, () => {
      assert.throws(() => databaseTls("postgres://postgres@127.0.0.1:5999/postgres"), DatabaseTlsConfigError);
    });
  }
});

test("an unknown OFFERLY_DB_TLS value is refused rather than guessed at", async () => {
  for (const value of ["require", "prefer", "disable", "false", "off"]) {
    await withEnv({ ...CA_ENV(), OFFERLY_DB_TLS: value }, () => {
      assert.throws(() => databaseTls("postgres://u:p@db.example.com/x"), DatabaseTlsConfigError, value);
    });
  }
});

test("the CA slot accepts only a current CA certificate", () => {
  assert.doesNotThrow(() => assertCaCertificate(trustedCa, "test"));
  assert.throws(() => assertCaCertificate(goodServer.cert, "test"), /not a CA/);
  assert.throws(() => assertCaCertificate(`${trustedCa}\n${goodServer.key}`, "test"), /private key/);
  assert.throws(() => assertCaCertificate("", "test"), /does not contain a PEM certificate/);
  assert.throws(() => assertCaCertificate("-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----", "test"), /could not be parsed/);
});

test("with no CA configured anywhere, connecting fails closed", async () => {
  await withEnv({ DATABASE_CA_CERT: undefined, DATABASE_CA_CERT_FILE: path.join(os.tmpdir(), "no-such-ca.crt") }, () => {
    assert.throws(() => databaseTls("postgres://u:p@db.example.com/x"), DatabaseTlsConfigError);
  });
});

// ---- nothing leaks ---------------------------------------------------------

test("configuration errors never echo the URL or password", async () => {
  const bad = `postgres://offerly:${PASSWORD}@exa mple.com:bad/x`;
  await withEnv(CA_ENV(), () => {
    try {
      databaseTls(bad);
      assert.fail("expected a parse failure");
    } catch (err) {
      assert.ok(err instanceof DatabaseTlsConfigError);
      assert.equal(String(err).includes(PASSWORD), false);
      assert.equal(JSON.stringify(err).includes(PASSWORD), false);
      assert.equal((err as Error).cause, undefined);
    }
  });
});

test("connection failures and their log line never carry the password", async () => {
  // A port nothing listens on: the client errors before any TLS happens.
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as net.AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));

  const err = await firstQueryError(`postgres://offerly:${PASSWORD}@localhost:${port}/offerly`, trustedCa);
  assert.equal(err.message.includes(PASSWORD), false);
  const line = describeDatabaseFailure(err, "localhost");
  assert.equal(line.includes(PASSWORD), false);
  assert.match(line, /localhost/);
});
