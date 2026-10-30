import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";

// Open-source build: no accounts, no login, no sessions.
//
// Upstream this read the session cookie and redirected to /login when there
// wasn't one. A self-hosted copy has exactly one person using it — whoever
// cloned it — so identity is a single fixed row instead, created the first
// time anything asks for it. Everything that used to receive "the logged-in
// student" receives that row, so no caller had to change.
//
// passwordHash is a sentinel rather than a hash: the column is NOT NULL,
// nothing reads it any more, and it cannot match any password if login code
// ever comes back.
const LOCAL_EMAIL = "you@localhost";

// A note on where "this page is dynamic" is declared, because it is not here
// and the reason is easy to lose:
//
// The session lookup this replaced read cookies(), and reading cookies is
// itself what told Next these pages were dynamic. Returning a row with no
// request-scoped input made the whole (app) group look statically
// prerenderable, and `next build` then rendered ~55 pages at once across 7
// workers, all opening the same embedded PGlite directory — which takes a
// single connection and aborts its WASM engine outright under that
// (RuntimeError: Aborted()).
//
// Declaring it here with connection() is wrong: this is also called from
// inside "use cache: private" scopes, where connection() is illegal by design
// — a cache has to be fillable before any navigation exists. So the
// declaration lives on the route segments instead, as
// `export const dynamic = "force-dynamic"` in (app)/layout.tsx and
// onboarding/layout.tsx, which is also where a reader would look for it.
//
// Per-request dedupe, matching the session lookup this replaced: one render
// touches this from many components and must not issue a query for each.
export const getCurrentUser = cache(async () => {
  const db = await getDb();

  const read = async () => {
    const [row] = await db.select().from(users).where(eq(users.email, LOCAL_EMAIL)).limit(1);
    return row;
  };

  const existing = await read();
  if (existing) return existing;

  // First run on an empty database. Two requests can arrive here together —
  // the unique index on email is what settles that, so insert and then read
  // back rather than trusting the insert to have been ours.
  await db
    .insert(users)
    .values({
      email: LOCAL_EMAIL,
      passwordHash: "local-no-auth",
      name: "You",
      accountType: "student",
    })
    .onConflictDoNothing();

  return await read();
});

export async function getCurrentUserId() {
  const user = await getCurrentUser();
  return user.id;
}

// Kept for the callers that used it. There is no logged-out state any more,
// so this is the same lookup; it stays separate only so those call sites read
// the way they always did.
export async function getOptionalUser() {
  return await getCurrentUser();
}
