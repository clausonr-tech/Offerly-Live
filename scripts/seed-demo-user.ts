// Creates the local demo account. Uses the app's own hashPassword, so the
// stored format stays whatever lib/auth produces.
//
// The password comes from the environment, never from this file: it used to
// be a literal here AND the login form's pre-filled value, which put a working
// credential for a shared admin account in the public HTML and in git.
//   DEMO_SEED_PASSWORD='<choose one>' npx tsx --conditions=react-server scripts/seed-demo-user.ts
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { hashPassword } from "../src/lib/auth";

const EMAIL = "demo@offerly.test";

async function main() {
  const PASSWORD = process.env.DEMO_SEED_PASSWORD ?? "";
  if (PASSWORD.length < 16) {
    throw new Error("Set DEMO_SEED_PASSWORD (16+ characters) for this shell. It is never read from source.");
  }
  const { db } = await openScriptDb();
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, EMAIL) });
  const passwordHash = await hashPassword(PASSWORD);

  if (existing) {
    await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, existing.id));
    console.log(`reset password for existing ${EMAIL}`);
  } else {
    await db.insert(schema.users).values({ name: "Demo Student", email: EMAIL, passwordHash });
    console.log(`created ${EMAIL}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
