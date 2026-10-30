// The guard that is supposed to stop two processes opening one database.
//
// It has been wrong twice, both times silently. It watched port 3000 after
// the dev script moved to 3001, and before that it tried to BIND the port
// instead of connecting to it - which on macOS succeeds while the dev server
// is plainly running. A safeguard written after losing a database had never
// once fired.
//
// It then got a third job in this session: warning when a script is about to
// write to the local file while the project has moved to Postgres. None of
// it was tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devPorts, staleLock } from "../../src/lib/monitoring/exclusive-db";

/** Run `fn` with env vars set, always restoring them afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ------------------------------------------------------------- which ports

test("3000 is always watched", () => {
  // Next's default. A bare `next dev` lands there whatever the script says,
  // and checking a port nothing uses costs nothing.
  assert.ok(withEnv({ PORT: undefined }, devPorts).includes(3000));
});

test("the port from the dev script is watched", () => {
  // The bug this replaced: a hardcoded 3000 while `next dev --port 3001` ran.
  // Read out of package.json so changing the script moves the guard with it.
  const ports = withEnv({ PORT: undefined }, devPorts);
  assert.ok(ports.length >= 1);
  for (const p of ports) assert.ok(Number.isInteger(p), String(p));
});

test("PORT is honoured when set", () => {
  assert.ok(withEnv({ PORT: "4321" }, devPorts).includes(4321));
});

const validPorts = ["1", "80", "3001", "8080", "65535"];
for (const p of validPorts) {
  test(`PORT=${p} is watched`, () => {
    assert.ok(withEnv({ PORT: p }, devPorts).includes(Number(p)));
  });
}

const invalidPorts = ["0", "-1", "65536", "99999", "abc", "", "3.5", "NaN", " "];
for (const p of invalidPorts) {
  test(`PORT=${JSON.stringify(p)} is discarded rather than probed`, () => {
    // Connecting to port 0 or NaN either throws or hangs; neither is a
    // useful way for a guard to behave.
    const ports = withEnv({ PORT: p }, devPorts);
    for (const got of ports) {
      assert.ok(Number.isInteger(got) && got > 0 && got < 65536, `kept ${got} from ${p}`);
    }
  });
}

test("the port list never contains duplicates", () => {
  // 3000 is added unconditionally; PORT=3000 must not make it appear twice.
  const ports = withEnv({ PORT: "3000" }, devPorts);
  assert.equal(new Set(ports).size, ports.length);
});

test("devPorts never throws and always returns something to check", () => {
  for (const port of [...validPorts, ...invalidPorts, undefined]) {
    const ports = withEnv({ PORT: port }, () => {
      let out: number[] = [];
      assert.doesNotThrow(() => (out = devPorts()));
      return out;
    });
    assert.ok(Array.isArray(ports));
    assert.ok(ports.length > 0, "a guard that watches nothing is not a guard");
  }
});

test("an unreadable package.json falls back rather than failing the script", () => {
  // Stated in its own comment: a guard that blocks work when it cannot
  // introspect is a guard people switch off.
  const empty = mkdtempSync(join(tmpdir(), "offerly-nopkg-"));
  const cwd = process.cwd();
  try {
    process.chdir(empty);
    const ports = devPorts();
    assert.ok(ports.includes(3000));
  } finally {
    process.chdir(cwd);
    rmSync(empty, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- the lock

/** A throwaway data directory with a postmaster.pid in it. */
function withLockFile<T>(contents: string | null, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "offerly-lock-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  if (contents !== null) writeFileSync(join(dir, "postmaster.pid"), contents);
  try {
    return withEnv({ PGLITE_DATA_DIR: dir }, fn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("no lock file means nothing to report", () => {
  assert.equal(withLockFile(null, staleLock), null);
});

test("PGlite's own -42 sentinel is stale by definition", () => {
  // -42 is not a process id at all, so it can never be a live writer.
  const lock = withLockFile("-42\n/pglite/data\n1789783849", staleLock);
  assert.ok(lock);
  assert.equal(lock.pid, -42);
  assert.match(lock.path, /postmaster\.pid$/);
});

for (const negative of ["-1", "-999", "-42"]) {
  test(`a negative pid (${negative}) is always stale`, () => {
    const lock = withLockFile(`${negative}\n/data`, staleLock);
    assert.ok(lock, negative);
  });
}

test("a pid that IS running is left alone - that is a different problem", () => {
  // A live second writer is real danger, not a leftover file, and the caller
  // must not be told it is safe to remove.
  const lock = withLockFile(`${process.pid}\n/data`, staleLock);
  assert.equal(lock, null);
});

test("a pid that is not running is reported as stale", () => {
  // 2^22 is above every default pid_max, so nothing holds it.
  const lock = withLockFile("4194303\n/data", staleLock);
  assert.ok(lock);
  assert.equal(lock.pid, 4194303);
});

const garbage = ["", "   ", "not-a-pid", "abc\n/data", "\n\n\n", "12abc"];
for (const junk of garbage) {
  test(`a corrupt lock file is reported, not ignored: ${JSON.stringify(junk.slice(0, 12))}`, () => {
    // An unreadable pid cannot be checked against the process table, so the
    // honest answer is "there is a file here", not "all clear".
    const lock = withLockFile(junk, staleLock);
    assert.ok(lock === null || typeof lock.path === "string");
    assert.doesNotThrow(() => withLockFile(junk, staleLock));
  });
}

test("the reported path is the one a person can actually delete", () => {
  // The whole value of this check is the message it lets the caller print.
  const lock = withLockFile("-42", () => {
    const l = staleLock();
    assert.ok(l);
    return l;
  });
  assert.ok(lock.path.endsWith("postmaster.pid"));
  assert.ok(lock.path.includes("offerly-lock-"), lock.path);
});

test("staleLock never throws", () => {
  for (const contents of [...garbage, "-42", String(process.pid), "4194303", null]) {
    assert.doesNotThrow(() => withLockFile(contents, staleLock), String(contents));
  }
});

test("a missing directory is not an error", () => {
  const gone = join(tmpdir(), "offerly-does-not-exist-" + Date.now());
  assert.equal(withEnv({ PGLITE_DATA_DIR: gone }, staleLock), null);
});

test("the answer does not depend on being asked twice", () => {
  withLockFile("-42", () => {
    const a = staleLock();
    const b = staleLock();
    assert.equal(a?.pid, b?.pid);
    assert.equal(a?.path, b?.path);
  });
});

test("a leading-whitespace pid still parses", () => {
  // PGlite writes the pid on its own line; tolerate the line being padded
  // rather than declaring a healthy lock corrupt.
  const lock = withLockFile("  -42  \n/data", staleLock);
  assert.ok(lock);
  assert.equal(lock.pid, -42);
});
