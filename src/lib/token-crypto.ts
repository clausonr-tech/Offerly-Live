import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// Google OAuth tokens at rest. A stored refresh token is standing access to a
// student's calendar, so a leaked database backup must not hand it over:
// every token is sealed with AES-256-GCM before it is written.
//
// Two keys, by version prefix, so the token key can be separated from the
// email-archive key without losing anything already written:
//
//   t2.  sealed with OAUTH_TOKEN_KEY - a key dedicated to OAuth tokens and
//        independent of every other secret. Preferred for new writes.
//   t1.  sealed with a key DERIVED from EMAIL_ARCHIVE_KEY (HMAC under its own
//        label). What this module wrote before OAUTH_TOKEN_KEY existed; still
//        read so nothing breaks, and migrated to t2 by scripts/reseal-oauth-tokens.ts.
//
// A row with neither prefix holds a plain token written before sealing; openToken
// returns it as-is and lib/google-connection re-seals it on the next read.
//
// In production a token is NEVER stored unsealed: if no key is configured,
// sealToken throws rather than writing plaintext. In development (no key, no
// real tokens) it returns the token unchanged and warns, so local work is not
// blocked. instrumentation.ts warns loudly at boot when a real environment has
// no token key, so the misconfiguration is caught before a token is written.

const PREFIX_V1 = "t1.";
const PREFIX_V2 = "t2.";

function keyMaterial(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : null;
}

// EMAIL_ARCHIVE_KEY-derived key (legacy t1). Cached; `undefined` means "not yet read".
let legacyCached: Buffer | null | undefined;
function legacyKey(): Buffer | null {
  if (legacyCached !== undefined) return legacyCached;
  const base = keyMaterial(process.env.EMAIL_ARCHIVE_KEY);
  legacyCached = base ? createHmac("sha256", base).update("offerly:oauth-tokens:v1").digest() : null;
  return legacyCached;
}

// OAUTH_TOKEN_KEY-derived key (t2), independent of EMAIL_ARCHIVE_KEY.
let dedicatedCached: Buffer | null | undefined;
function dedicatedKey(): Buffer | null {
  if (dedicatedCached !== undefined) return dedicatedCached;
  const base = keyMaterial(process.env.OAUTH_TOKEN_KEY);
  if (process.env.OAUTH_TOKEN_KEY && !base) {
    // Set but malformed: a typo must not silently fall back to no encryption,
    // but it also must not take token storage down - warn and use the legacy key.
    console.warn("[token-crypto] OAUTH_TOKEN_KEY is set but is not 32 bytes of base64; ignoring it");
  }
  dedicatedCached = base ? createHmac("sha256", base).update("offerly:oauth-tokens:v2").digest() : null;
  return dedicatedCached;
}

/** True in a real deployed environment (where plaintext at rest is never acceptable). */
function inProduction(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL;
}

/** Whether OAuth tokens can be sealed at all (a dedicated or legacy key is present). */
export function hasTokenKey(): boolean {
  return dedicatedKey() !== null || legacyKey() !== null;
}

export function isSealed(stored: string | null | undefined): boolean {
  return !!stored && (stored.startsWith(PREFIX_V1) || stored.startsWith(PREFIX_V2));
}

function seal(prefix: string, key: Buffer, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return prefix + [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

function open(prefix: string, key: Buffer, stored: string): string {
  const [iv, tag, ct] = stored.slice(prefix.length).split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function sealToken(token: string): string;
export function sealToken(token: string | null): string | null;
export function sealToken(token: string | null): string | null {
  if (token === null) return null;
  // Already sealed (the re-seal-on-read path can hand us one): leave it be
  // rather than seal a second time, which would corrupt the value. A real
  // Google token never starts with the t1./t2. prefixes.
  if (isSealed(token)) return token;

  const dedicated = dedicatedKey();
  if (dedicated) return seal(PREFIX_V2, dedicated, token);
  const legacy = legacyKey();
  if (legacy) return seal(PREFIX_V1, legacy, token);

  if (inProduction()) {
    throw new Error(
      "Refusing to store an OAuth token unencrypted. Set OAUTH_TOKEN_KEY (or EMAIL_ARCHIVE_KEY) to 32 bytes of base64.",
    );
  }
  console.warn("[token-crypto] no OAUTH_TOKEN_KEY/EMAIL_ARCHIVE_KEY set; storing OAuth token unencrypted (development only)");
  return token;
}

/** The token, from a t2/t1 seal or a plain legacy value. Throws on a tampered or un-openable seal. */
export function openToken(stored: string): string;
export function openToken(stored: string | null): string | null;
export function openToken(stored: string | null): string | null {
  if (stored === null) return null;
  if (stored.startsWith(PREFIX_V2)) {
    const key = dedicatedKey();
    if (!key) throw new Error("An OAuth token sealed with OAUTH_TOKEN_KEY was found but that key is not set.");
    return open(PREFIX_V2, key, stored);
  }
  if (stored.startsWith(PREFIX_V1)) {
    const key = legacyKey();
    if (!key) throw new Error("A sealed OAuth token was found but EMAIL_ARCHIVE_KEY is not set.");
    return open(PREFIX_V1, key, stored);
  }
  return stored; // plain token from before sealing
}

/** For tests: forget the cached keys after changing the environment. */
export function resetTokenKeyForTests() {
  legacyCached = undefined;
  dedicatedCached = undefined;
}
