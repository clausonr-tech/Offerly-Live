// Backfills what a firm match is supposed to produce - tracked applications -
// for firms that were matched BEFORE that hook worked.
//
//   npx tsx --conditions=react-server scripts/backfill-matched-firm-actions.ts [email]
//
// Normally fired at match time by match-top-firms.ts. This exists only for
// accounts that matched earlier: auto-track used to run solely as a side effect
// of rendering Discovery. That gap does not re-trigger on its own, because
// matching will not re-pick a firm already on the list.
//
// Recruiter/campus-recruiting contacts were deliberately removed from this
// product; nothing here re-creates them.
//
// Deliberately opens NO database connection of its own. It calls the same
// library functions the app does, and those use getDb() - a process-level
// singleton. A script that also constructed its own PGlite client would put two
// connections on one data directory, which is the exact pattern that has
// corrupted this database before.
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { users, userTopFirms } from "../src/db/schema";
import { autoTrackForMatchedFirms } from "../src/lib/discovery-matches";

async function main() {
  const email = process.argv[2] ?? "demo@offerly.test";
  const db = await getDb();

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    console.error(`No account with email ${email}`);
    process.exit(1);
  }

  const matched = await db
    .select({ firmId: userTopFirms.firmId })
    .from(userTopFirms)
    .where(eq(userTopFirms.userId, user.id));
  const firmIds = matched.map((m) => m.firmId);

  console.log(`${email}: ${firmIds.length} matched firms`);
  if (firmIds.length === 0) return;

  const tracked = await autoTrackForMatchedFirms(user, firmIds);
  console.log(`  applications auto-tracked: ${tracked}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
