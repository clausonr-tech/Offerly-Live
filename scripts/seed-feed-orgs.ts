// Creates one approved club account, plus the club it posts as, so the
// community feed's club role can actually be logged into. Students already
// exist via seed-demo-user; firm accounts via seed-firm-demo.
//
// Approval is a manual flip today (there is no admin UI yet), and this script
// is that flip for local dev.
//
// The password comes from the environment, never from this file - see
// seed-demo-user.ts for why.
//   DEMO_SEED_PASSWORD='<choose one>' npx tsx --conditions=react-server scripts/seed-feed-orgs.ts
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { hashPassword } from "../src/lib/auth";

const CLUB_EMAIL = "club@offerly.test";

async function main() {
  const PASSWORD = process.env.DEMO_SEED_PASSWORD ?? "";
  if (PASSWORD.length < 16) {
    throw new Error("Set DEMO_SEED_PASSWORD (16+ characters) for this shell. It is never read from source.");
  }
  const { db } = await openScriptDb();
  const passwordHash = await hashPassword(PASSWORD);

  // ---- the club ----
  let club = await db.query.clubs.findFirst({ where: eq(schema.clubs.slug, "wharton-finance-club") });
  if (!club) {
    const school = await db.query.schools.findFirst();
    [club] = await db
      .insert(schema.clubs)
      .values({
        slug: "wharton-finance-club",
        name: "Wharton Finance Club",
        schoolId: school?.id ?? null,
        description: "Undergraduate finance club running speaker events and coffee chats.",
      })
      .returning();
    console.log("created club Wharton Finance Club");
  }

  // No firm account any more. This used to link firm@offerly.test to
  // whichever firm came first in the directory - a real company - so anything
  // it posted appeared under a real firm's name. Firm accounts now live in the
  // firm portal, and its demo is a made-up firm: scripts/seed-firm-demo.ts.
  const accounts = [
    {
      email: CLUB_EMAIL,
      name: "Wharton Finance Club",
      accountType: "club_lead" as const,
      clubId: club!.id,
      orgFirmId: null,
    },
  ];

  for (const a of accounts) {
    const existing = await db.query.users.findFirst({ where: eq(schema.users.email, a.email) });
    const values = {
      ...a,
      passwordHash,
      orgApproved: true,
      // Org accounts skip the student onboarding wizard - it asks about
      // recruiting preferences, which a club or firm has no answers for.
      onboardingCompletedAt: new Date(),
      profileLinksPromptedAt: new Date(),
    };
    if (existing) {
      await db.update(schema.users).set(values).where(eq(schema.users.id, existing.id));
      console.log(`updated ${a.email} (${a.accountType}, approved)`);
    } else {
      await db.insert(schema.users).values(values);
      console.log(`created ${a.email} (${a.accountType}, approved)`);
    }
  }

  console.log(`\npassword: ${PASSWORD}`);
  console.log("For a firm account, run scripts/seed-firm-demo.ts (the firm portal's made-up demo firm).");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
