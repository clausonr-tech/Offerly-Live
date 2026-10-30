/**
 * One-off backfill. Every existing account really did join, and their real
 * signup timestamp is already on the row - so this is the same event the
 * signup action now emits, recovered for accounts created before the feed
 * existed. It invents nothing: no synthetic users, no made-up streaks or
 * offers, and it leaves the feed exactly as sparse as the real history is.
 *
 * Safe to re-run - recordJoined dedupes on the user id.
 *
 * Run with the dev server STOPPED (PGlite takes an exclusive lock):
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-activity.ts
 */
import { asc } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { activityEvents, users } from "../src/db/schema";

async function main() {
  const db = await getDb();
  const rows = await db
    .select({ id: users.id, name: users.name, createdAt: users.createdAt })
    .from(users)
    .orderBy(asc(users.createdAt));

  let written = 0;
  for (const u of rows) {
    const res = await db
      .insert(activityEvents)
      .values({
        userId: u.id,
        kind: "joined",
        dedupeKey: u.id,
        // Their real signup time, not now - the feed should read as history.
        createdAt: u.createdAt,
      })
      .onConflictDoNothing()
      .returning();
    if (res.length) written++;
  }

  console.log(`accounts: ${rows.length}, joined rows written: ${written}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
