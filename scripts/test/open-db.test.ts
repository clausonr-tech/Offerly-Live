// Which database a script actually opens.
//
// This is the piece that decides whether the crawler writes to Supabase or to
// a local file nothing serves. Before it existed, all 55 scripts constructed
// PGlite directly and ignored DATABASE_URL entirely - so moving the app to
// Postgres would have produced two live databases diverging every hour, with
// no error anywhere.
//
// It also refuses to default to `./local-data/pglite`, which is the directory
// this repository corrupted on 18 September 2026 and which is still on disk.
// A script run without its env file used to open that, abort inside
// WebAssembly, and look like a broken script rather than a missing variable.

import { after, before, test } from "node:test";
import { rootCertificates } from "node:tls";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/open";

// openDb now builds verified TLS for any Postgres URL, which needs a CA. These
// tests never connect, so any current CA certificate stands in for Supabase's
// - trust itself is db-tls.test.ts's job.
const savedCa = process.env.DATABASE_CA_CERT;
before(() => {
  process.env.DATABASE_CA_CERT = rootCertificates[0];
});
after(() => {
  if (savedCa === undefined) delete process.env.DATABASE_CA_CERT;
  else process.env.DATABASE_CA_CERT = savedCa;
});

/**
 * Set env vars for the duration of an ASYNC call.
 *
 * Awaiting inside matters: `openDb` reads DATABASE_URL synchronously but
 * reads PGLITE_DATA_DIR only after two dynamic imports. A helper that
 * restored the environment as soon as `fn()` returned its promise would put
 * the variables back before the function under test ever looked at them -
 * and every local-database test would fail for a reason that has nothing to
 * do with the code being tested.
 */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ------------------------------------------------------- refusing to guess

test("neither variable set is an error, not a silent fallback", async () => {
  await withEnv({ DATABASE_URL: undefined, PGLITE_DATA_DIR: undefined }, async () => {
    await assert.rejects(() => openDb());
  });
});

test("the refusal explains itself", async () => {
  await withEnv({ DATABASE_URL: undefined, PGLITE_DATA_DIR: undefined }, async () => {
    const error = await openDb().then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(error);
    // The message has to name both variables and say why defaulting is
    // dangerous, because the symptom otherwise is an unreadable WASM abort.
    assert.match(error.message, /DATABASE_URL/);
    assert.match(error.message, /PGLITE_DATA_DIR/);
    assert.match(error.message, /local-data\/pglite/);
  });
});

test("it never silently opens the known-corrupt default directory", async () => {
  await withEnv({ DATABASE_URL: undefined, PGLITE_DATA_DIR: undefined }, async () => {
    await assert.rejects(
      () => openDb(),
      (e: Error) => !/^Cannot|undefined/.test(e.message),
      "should be a deliberate error, not a crash from opening something",
    );
  });
});

// ---------------------------------------------------------- choosing Postgres

test("DATABASE_URL selects Postgres", async () => {
  // postgres-js connects lazily, so this makes no network call.
  const opened = await withEnv(
    { DATABASE_URL: "postgresql://user:pass@example.invalid:5432/postgres" },
    () => openDb(),
  );
  try {
    assert.equal(opened.backend, "postgres");
    assert.ok(opened.db);
    assert.equal(typeof opened.close, "function");
  } finally {
    await opened.close().catch(() => {});
  }
});

test("DATABASE_URL wins even when a local directory is also configured", async () => {
  // The whole point. With both set, the local file must not be touched -
  // otherwise the migration produces a fork rather than a move.
  const dir = mkdtempSync(join(tmpdir(), "offerly-open-"));
  try {
    const opened = await withEnv(
      {
        DATABASE_URL: "postgresql://user:pass@example.invalid:5432/postgres",
        PGLITE_DATA_DIR: dir,
      },
      () => openDb(),
    );
    assert.equal(opened.backend, "postgres");
    await opened.close().catch(() => {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const urls = [
  "postgresql://u:p@host.invalid:5432/postgres",
  "postgres://u:p@host.invalid:5432/postgres",
  "postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
];
for (const url of urls) {
  test(`a ${url.split(":")[0]} URL selects Postgres`, async () => {
    const opened = await withEnv({ DATABASE_URL: url }, () => openDb());
    try {
      assert.equal(opened.backend, "postgres");
    } finally {
      await opened.close().catch(() => {});
    }
  });
}

test("closing a Postgres connection resolves rather than hanging", async () => {
  const opened = await withEnv(
    { DATABASE_URL: "postgresql://u:p@example.invalid:5432/postgres" },
    () => openDb(),
  );
  await assert.doesNotReject(() => opened.close());
});

// ------------------------------------------------------------ choosing PGlite

test("PGLITE_DATA_DIR alone selects the local database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "offerly-open-"));
  try {
    const opened = await withEnv({ DATABASE_URL: undefined, PGLITE_DATA_DIR: dir }, () => openDb());
    try {
      assert.equal(opened.backend, "pglite");
      assert.ok(opened.db);
    } finally {
      await opened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the local database is opened with its clock already pinned to UTC", async () => {
  // Otherwise the column defaults and the application disagree by five hours
  // and every new listing is born stale. See src/db/utc-clock.ts.
  const dir = mkdtempSync(join(tmpdir(), "offerly-open-"));
  try {
    const opened = await withEnv({ DATABASE_URL: undefined, PGLITE_DATA_DIR: dir }, () => openDb());
    try {
      const rows = await opened.db.execute("select current_setting('TimeZone') as tz");
      const tz = (rows as unknown as { rows?: { tz: string }[] }).rows?.[0]?.tz
        ?? (rows as unknown as { tz: string }[])[0]?.tz;
      assert.equal(tz, "UTC");
    } finally {
      await opened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing the local database releases it, so a second open succeeds", async () => {
  // PGlite is single-writer. A close that does not actually close leaves the
  // directory locked and the next script dies inside WebAssembly.
  const dir = mkdtempSync(join(tmpdir(), "offerly-open-"));
  try {
    for (let i = 0; i < 2; i++) {
      const opened = await withEnv({ DATABASE_URL: undefined, PGLITE_DATA_DIR: dir }, () => openDb());
      await opened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the shape

test("every opened database reports the same three things", async () => {
  const dir = mkdtempSync(join(tmpdir(), "offerly-open-"));
  try {
    const cases = [
      await withEnv({ DATABASE_URL: "postgresql://u:p@example.invalid:5432/postgres" }, () => openDb()),
      await withEnv({ DATABASE_URL: undefined, PGLITE_DATA_DIR: dir }, () => openDb()),
    ];
    for (const opened of cases) {
      assert.ok(opened.db, "db missing");
      assert.equal(typeof opened.close, "function", "close missing");
      assert.ok(["postgres", "pglite"].includes(opened.backend), opened.backend);
      await opened.close().catch(() => {});
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty DATABASE_URL is treated as unset, not as a valid target", async () => {
  // An empty string is falsy, so it must fall through to the local database
  // rather than being handed to the driver as a connection string.
  const dir = mkdtempSync(join(tmpdir(), "offerly-open-"));
  try {
    const opened = await withEnv({ DATABASE_URL: "", PGLITE_DATA_DIR: dir }, () => openDb());
    try {
      assert.equal(opened.backend, "pglite");
    } finally {
      await opened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
