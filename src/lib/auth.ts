import "server-only";
import { cache } from "react";
import { randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { sessions, users } from "@/db/schema";

const scrypt = promisify(scryptCallback);

const SESSION_COOKIE = "session_token";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hashHex, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * The cost of one password check, spent when there is no account to check
 * against - so "no such account" takes as long as "wrong password" and the
 * response time cannot be used to find out which addresses are registered.
 */
let decoyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<false> {
  decoyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await decoyHash);
  return false;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// `ttlMs` is shorter for firm accounts (lib/firm-account FIRM_SESSION_TTL_MS):
// their access has to end soon after their work inbox does.
export async function createSession(userId: string, ttlMs: number = SESSION_TTL_MS): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ttlMs);
  const db = await getDb();

  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  jar.delete(SESSION_COOKIE);
}

/** Signs out every other device for this user, keeping the current session. */
export async function revokeOtherSessions(userId: string): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const db = await getDb();
  await db
    .delete(sessions)
    .where(
      token
        ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, hashToken(token)))
        : eq(sessions.userId, userId),
    );
}

// Reads the session cookie and returns the logged-in user, or null if there
// isn't a valid one. Never redirects — callers decide what to do.
/**
 * The signed-in user for THIS request, or null.
 *
 * Wrapped in React's `cache`, which deduplicates by argument for the life of
 * one request. That is not a micro-optimisation here. Rendering a single app
 * page calls `getCurrentUser()` at least three times - the app layout (for the
 * consent and onboarding gates), the section layout, and the page itself - and
 * each call ran the two queries below again from scratch. Against a database
 * in another region that was six network round trips to answer one question,
 * and the answer cannot change midway through rendering a single response.
 *
 * Dedupe is per-request, so a login that creates a session in one request is
 * still read fresh by the next one.
 */
export const getSessionUser = cache(async () => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = await getDb();
  // ONE round trip, not two.
  //
  // This used to fetch the session, then fetch its user - two sequential
  // queries, and with the database in another region that is two network
  // waits to answer "who is this". An ordinary INNER JOIN answers it in one.
  //
  // Deliberately `.select().innerJoin()` rather than a relational
  // `with: { user: true }` load: the relational form generates a
  // LEFT JOIN LATERAL / json_build_array query that crashes PGlite's WASM
  // engine outright (RuntimeError: Aborted()), and PGlite is still the
  // fallback when DATABASE_URL is unset. A plain join is fine on both.
  const [row] = await db
    .select({ sessionId: sessions.id, expiresAt: sessions.expiresAt, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    // Second trip, but only on the rare request that presents an expired
    // token - not on every signed-in page load.
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
    return null;
  }
  return row.user;
});
