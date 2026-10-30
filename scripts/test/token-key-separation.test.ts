// B0-1: OAuth tokens are sealed with a key independent of every other secret,
// existing seals stay readable, plaintext is never written in production, and
// the practice-seal key is never derived from ANTHROPIC_API_KEY.
import { test } from "node:test";
import assert from "node:assert/strict";

import { hasTokenKey, isSealed, openToken, resetTokenKeyForTests, sealToken } from "@/lib/token-crypto";
import { resetPracticeSealKeyForTests, sealQuestion } from "@/lib/practice-seal";
import type { PracticeQuestion } from "@/lib/practice-session";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

// Snapshot the env keys so one test cannot bleed into another.
const KEYS = ["OAUTH_TOKEN_KEY", "EMAIL_ARCHIVE_KEY", "PRACTICE_SEAL_KEY", "ANTHROPIC_API_KEY", "VERCEL", "NODE_ENV"] as const;
// process.env types NODE_ENV as read-only; this suite flips it deliberately.
const ENV = process.env as Record<string, string | undefined>;
function withEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>, body: () => void) {
  const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, ENV[k]]));
  try {
    for (const k of KEYS) delete ENV[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) ENV[k] = v;
    resetTokenKeyForTests();
    resetPracticeSealKeyForTests();
    body();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete ENV[k];
      else ENV[k] = saved[k];
    }
    resetTokenKeyForTests();
    resetPracticeSealKeyForTests();
  }
}

test("OAUTH_TOKEN_KEY seals tokens as t2 and round-trips without exposing the token", () => {
  withEnv({ OAUTH_TOKEN_KEY: KEY_A }, () => {
    const sealed = sealToken("ya29.secret-token");
    assert.ok(sealed.startsWith("t2."), "uses the dedicated-key version");
    assert.ok(!sealed.includes("secret-token"));
    assert.equal(openToken(sealed), "ya29.secret-token");
    assert.ok(hasTokenKey());
  });
});

test("the token key is independent of EMAIL_ARCHIVE_KEY", () => {
  // Seal with OAUTH_TOKEN_KEY=A...
  let sealed = "";
  withEnv({ OAUTH_TOKEN_KEY: KEY_A }, () => {
    sealed = sealToken("ya29.secret-token");
  });
  // ...and it cannot be opened when only EMAIL_ARCHIVE_KEY is set (to a different value).
  withEnv({ EMAIL_ARCHIVE_KEY: KEY_B }, () => {
    assert.throws(() => openToken(sealed), /OAUTH_TOKEN_KEY/);
  });
});

test("tokens sealed before OAUTH_TOKEN_KEY existed (t1) still open, and plain legacy rows pass through", () => {
  // EMAIL_ARCHIVE_KEY only: a t1 seal.
  let legacy = "";
  withEnv({ EMAIL_ARCHIVE_KEY: KEY_A }, () => {
    legacy = sealToken("ya29.old");
    assert.ok(legacy.startsWith("t1."), "only the legacy key is present");
    assert.equal(openToken("ya29.plain-legacy"), "ya29.plain-legacy", "a pre-sealing plain row is returned as-is");
  });
  // Both keys present (post-migration world): t1 still opens via the legacy key,
  // new writes use t2.
  withEnv({ EMAIL_ARCHIVE_KEY: KEY_A, OAUTH_TOKEN_KEY: KEY_B }, () => {
    assert.equal(openToken(legacy), "ya29.old", "the old t1 seal is still readable");
    assert.ok(sealToken("ya29.new").startsWith("t2."), "new writes prefer the dedicated key");
  });
});

test("sealToken is a no-op on an already-sealed value (no double-sealing on re-seal)", () => {
  withEnv({ OAUTH_TOKEN_KEY: KEY_A }, () => {
    const once = sealToken("ya29.secret-token");
    assert.equal(sealToken(once), once, "an already-sealed token is returned unchanged");
    assert.equal(openToken(sealToken(once)), "ya29.secret-token");
    assert.equal(sealToken(null), null);
  });
});

test("production refuses to store a token unencrypted when no key is set", () => {
  withEnv({ VERCEL: "1" }, () => {
    assert.equal(hasTokenKey(), false);
    assert.throws(() => sealToken("ya29.secret-token"), /unencrypted/);
    assert.equal(sealToken(null), null, "null is still null, not an error");
  });
});

test("development without a key stores the token as-is (local only)", () => {
  withEnv({ NODE_ENV: "development" }, () => {
    const out = sealToken("ya29.secret-token");
    assert.equal(out, "ya29.secret-token");
    assert.ok(!isSealed(out));
  });
});

const QUESTION = {
  kind: "concept",
  topic: "Valuation",
  difficulty: "easy",
  prompt: "What is added when bridging from equity value to enterprise value?",
  expectedPoints: ["Net debt"],
  options: ["Net debt", "Cash", "Goodwill"],
  correctOption: "Net debt",
} as unknown as PracticeQuestion;

test("the practice-seal key comes from PRACTICE_SEAL_KEY or EMAIL_ARCHIVE_KEY, never ANTHROPIC_API_KEY", () => {
  const at = new Date("2026-01-01T00:00:00Z");
  const sealWith = (values: Partial<Record<(typeof KEYS)[number], string | undefined>>) => {
    let seal = "";
    withEnv(values, () => {
      seal = sealQuestion("user-a", QUESTION, at).seal ?? "";
    });
    return seal;
  };

  // The same key material under either accepted variable yields the same seal.
  const fromPractice = sealWith({ PRACTICE_SEAL_KEY: KEY_A });
  const fromArchive = sealWith({ EMAIL_ARCHIVE_KEY: KEY_A });
  assert.ok(fromPractice.length > 0);
  assert.equal(fromPractice, fromArchive, "PRACTICE_SEAL_KEY and EMAIL_ARCHIVE_KEY are interchangeable sources");

  // The SAME value in ANTHROPIC_API_KEY is NOT a source: the key falls back to
  // an ephemeral random one, so the seal does not match the material-derived one.
  const fromAnthropic = sealWith({ ANTHROPIC_API_KEY: KEY_A });
  assert.notEqual(fromAnthropic, fromPractice, "ANTHROPIC_API_KEY must not be the seal source");
});
