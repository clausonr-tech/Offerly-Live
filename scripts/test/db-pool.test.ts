// Which pooler the app talks to, and what must never change along the way.
//
// This module exists because of a real outage: session mode caps the WHOLE
// Supabase project at 15 clients, the dev server quietly held 10 of them, and
// the hourly crawl of 21 September 2026 lost PIMCO, Nomura, Boston Partners
// and twelve more firms to `EMAXCONNSESSION` - logged as UNCAUGHT, with
// nothing anywhere saying a listing had been missed.
//
// The dangerous part of the fix is that it edits a connection string that has
// a password in it. Get that wrong and it is an authentication failure nobody
// would trace back to a port number, so the credential-preservation cases
// below matter more than the port ones.
//
// No network, no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFor, isPoolExhausted } from "../../src/db/pool";

const SESSION = "postgresql://postgres.abcdefgh:s3cr3t@aws-0-us-east-1.pooler.supabase.com:5432/postgres";

function withoutSessionOverride<T>(fn: () => T): T {
  const had = process.env.OFFERLY_DB_SESSION_MODE;
  delete process.env.OFFERLY_DB_SESSION_MODE;
  try {
    return fn();
  } finally {
    if (had !== undefined) process.env.OFFERLY_DB_SESSION_MODE = had;
  }
}

// ------------------------------------------------------------ the port move

test("a Supabase session-mode pooler is moved to the transaction port", () => {
  withoutSessionOverride(() => {
    const p = poolFor(SESSION);
    assert.equal(p.mode, "transaction");
    assert.ok(p.url.includes(":6543/"), p.url);
    assert.ok(!p.url.includes(":5432"), p.url);
  });
});

test("transaction mode turns prepared statements OFF", () => {
  // Not cosmetic. Transaction mode hands consecutive statements different
  // backend connections, so a prepare made on one is missing on the next and
  // fails intermittently under concurrency only.
  withoutSessionOverride(() => {
    assert.equal(poolFor(SESSION).options.prepare, false);
  });
});

test("a URL already on 6543 is left alone", () => {
  withoutSessionOverride(() => {
    const already = SESSION.replace(":5432/", ":6543/");
    assert.equal(poolFor(already).url, already);
  });
});

// --------------------------------------------------- credentials must survive

test("the password is preserved byte for byte", () => {
  // A Postgres password is arbitrary bytes. Round-tripping the URL through the
  // WHATWG URL parser re-encodes it, which changes the password silently.
  withoutSessionOverride(() => {
    for (const password of [
      "s3cr3t",
      "p@ss:word",
      "has/slash",
      "has%20percent",
      "has+plus",
      "UPPER-lower_123",
      "tricky?query",
      "hash#mark",
    ]) {
      const url = `postgresql://postgres.abcd:${password}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
      const out = poolFor(url).url;
      assert.equal(
        out,
        url.replace(":5432/", ":6543/"),
        `password ${JSON.stringify(password)} was altered: ${out}`,
      );
    }
  });
});

test("only the port changes - user, host and database are identical", () => {
  withoutSessionOverride(() => {
    assert.equal(poolFor(SESSION).url, SESSION.replace(":5432/", ":6543/"));
  });
});

// ------------------------------------------------------- hosts left untouched

test("a non-Supabase host is never re-pointed", () => {
  // Guessing a port for a host we know nothing about breaks it outright.
  withoutSessionOverride(() => {
    for (const url of [
      "postgresql://u:p@localhost:5432/offerly",
      "postgresql://u:p@db.internal.example.com:5432/offerly",
      "postgres://u:p@127.0.0.1:5432/postgres",
    ]) {
      const p = poolFor(url);
      assert.equal(p.url, url, url);
      assert.equal(p.mode, "direct");
    }
  });
});

test("a lookalike host does not get the Supabase treatment", () => {
  withoutSessionOverride(() => {
    for (const url of [
      "postgresql://u:p@aws-0.pooler.supabase.com.attacker.net:5432/postgres",
      "postgresql://u:p@notpooler.supabase.com:5432/postgres",
      "postgresql://u:p@pooler.supabase.com.evil:5432/postgres",
    ]) {
      assert.equal(poolFor(url).url, url, url);
    }
  });
});

test("a direct Supabase host (not the pooler) is left as configured", () => {
  withoutSessionOverride(() => {
    const direct = "postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres";
    assert.equal(poolFor(direct).url, direct);
  });
});

// ------------------------------------------------------------------- opt out

test("OFFERLY_DB_SESSION_MODE=1 keeps the URL exactly as configured", () => {
  const had = process.env.OFFERLY_DB_SESSION_MODE;
  process.env.OFFERLY_DB_SESSION_MODE = "1";
  try {
    const p = poolFor(SESSION);
    assert.equal(p.url, SESSION);
    assert.equal(p.mode, "session");
    assert.equal(p.options.prepare, true);
  } finally {
    if (had === undefined) delete process.env.OFFERLY_DB_SESSION_MODE;
    else process.env.OFFERLY_DB_SESSION_MODE = had;
  }
});

test("every mode explains itself", () => {
  // A script prints this, so the mode in use is never something to infer.
  withoutSessionOverride(() => {
    for (const url of [SESSION, "postgresql://u:p@localhost:5432/x"]) {
      assert.ok(poolFor(url).note.length > 10, url);
    }
  });
});

// ------------------------------------------------- telling the two apart

test("a refused connection is recognised however it is wrapped", () => {
  // postgres-js reports this as a `cause` under a drizzle "Failed query"
  // error, which is how it reached the crawl's catch in the first place.
  assert.equal(isPoolExhausted({ code: "EMAXCONNSESSION" }), true);
  assert.equal(
    isPoolExhausted(new Error("max clients reached in session mode (EMAXCONNSESSION)")),
    true,
  );
  assert.equal(
    isPoolExhausted(
      Object.assign(new Error("Failed query: insert into monitoring_check_runs"), {
        cause: Object.assign(new Error("max clients reached in session mode"), {
          code: "EMAXCONNSESSION",
        }),
      }),
    ),
    true,
  );
});

test("an ordinary failure is NOT treated as a refused connection", () => {
  // Retrying a genuinely broken query would just run it twice and hide it.
  for (const err of [
    new Error("relation \"firms\" does not exist"),
    Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    { code: "23505", message: "duplicate key value" },
    null,
    undefined,
    "a string",
  ]) {
    assert.equal(isPoolExhausted(err), false, String(err));
  }
});

test("a self-referencing cause chain terminates", () => {
  const err = new Error("boom") as Error & { cause?: unknown };
  err.cause = err;
  assert.equal(isPoolExhausted(err), false);
});
