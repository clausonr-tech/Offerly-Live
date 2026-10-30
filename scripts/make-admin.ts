// One-off: flip a user's role to "admin" so they can see /admin/monitoring.
// There's no self-serve path to become an admin, same as `plan` upgrades -
// this script is the manual equivalent of a person doing it by hand in a
// database console.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/make-admin.ts <email>
//
// Stop the dev server first - PGlite is single-writer.
import type { Db } from "../src/db/types";
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

let db!: Db;

async function main() {
  ({ db } = await openScriptDb());
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: make-admin.ts <email>");
    process.exit(1);
  }

  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }

  await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, user.id));
  console.log(`${email} (${user.name ?? "no name set"}) is now an admin.`);
  process.exit(0);
}

main();
