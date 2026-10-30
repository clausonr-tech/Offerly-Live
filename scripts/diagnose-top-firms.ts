/**
 * Why does this account have no top firms?
 *
 * Every failure in matchTopFirmsForUser is silent by design - the caller in
 * onboarding/actions.ts logs and moves on, because finishing onboarding must
 * not fail just because matching did. Good for the student, useless for
 * debugging: an empty Opportunities page looks identical whether the sectors
 * never saved, the firm directory is empty, or the filters excluded every
 * firm. This walks the same path and says which.
 *
 * Read-only. It never writes, so it is safe to run against a real account.
 *
 *   npx tsx --conditions=react-server scripts/diagnose-top-firms.ts you@example.com
 *
 * IMPORTANT, on a local PGlite checkout: stop the dev server first. Two
 * processes on ./local-data/pglite is what corrupts it.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, userTopFirms, firms } from "@/db/schema";
import {
  satisfiesTierPreferences,
  satisfiesCoveragePreferences,
} from "@/lib/match-top-firms";
import { getFirmsForCategories } from "@/lib/firms";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: npx tsx --conditions=react-server scripts/diagnose-top-firms.ts <email>");
    process.exit(1);
  }

  const db = await getDb();

  const user = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase().trim()),
    columns: {
      id: true,
      email: true,
      preferredCategories: true,
      ibTierPreferences: true,
      peTierPreferences: true,
      nicheInterests: true,
      topFirmsMatchedAt: true,
      topFirmsTarget: true,
      topFirmsEligibleCount: true,
      onboardingCompletedAt: true,
    },
  });

  if (!user) {
    console.log(`FAIL  no account with email ${email}`);
    console.log("      Accounts present:");
    for (const u of await db.select({ email: users.email }).from(users)) console.log("       -", u.email);
    process.exit(0);
  }

  console.log(`account            ${user.email}`);
  console.log(`onboarding done    ${user.onboardingCompletedAt ? "yes" : "NO - matching only runs when onboarding completes"}`);
  console.log(`sectors            ${JSON.stringify(user.preferredCategories ?? [])}`);
  console.log(`ib tiers           ${JSON.stringify(user.ibTierPreferences ?? [])}`);
  console.log(`pe tiers           ${JSON.stringify(user.peTierPreferences ?? [])}`);
  console.log(`coverage           ${JSON.stringify(user.nicheInterests ?? [])}`);
  console.log(`last matched at    ${user.topFirmsMatchedAt ?? "never"}`);
  console.log(`target / eligible  ${user.topFirmsTarget ?? "-"} / ${user.topFirmsEligibleCount ?? "-"}`);

  const saved = await db.select({ n: sql<number>`count(*)::int` }).from(userTopFirms).where(eq(userTopFirms.userId, user.id));
  console.log(`top firms saved    ${saved[0]?.n ?? 0}`);

  const totalFirms = await db.select({ n: sql<number>`count(*)::int` }).from(firms);
  console.log(`firms in directory ${totalFirms[0]?.n ?? 0}`);

  const cats = user.preferredCategories ?? [];
  if (!cats.length) {
    console.log("\nFAIL  no sectors on the account - matchTopFirmsForUser returns immediately.");
    console.log("      The student's onboarding answers never reached the users row.");
    process.exit(0);
  }
  if ((totalFirms[0]?.n ?? 0) === 0) {
    console.log("\nNOTE  firm directory is empty; it seeds lazily on first access. Continuing.");
  }

  // The same three filters the matcher applies, counted one at a time.
  const all = await getFirmsForCategories(cats);
  const servesCategory = all.filter((f) => f.programs.some((p) => cats.includes(p.category)));
  const afterTier = servesCategory.filter((f) =>
    satisfiesTierPreferences(f, cats, user.ibTierPreferences ?? [], user.peTierPreferences ?? []),
  );
  const afterCoverage = afterTier.filter((f) => satisfiesCoveragePreferences(f, user.nicheInterests));

  console.log("\nfilter funnel");
  console.log(`  firms in chosen sectors   ${all.length}`);
  console.log(`  serve a chosen category   ${servesCategory.length}`);
  console.log(`  survive tier preference   ${afterTier.length}`);
  console.log(`  survive coverage filter   ${afterCoverage.length}`);

  if (afterCoverage.length === 0) {
    const culprit = afterTier.length === 0 ? "tier" : "coverage";
    console.log(`\nFAIL  every firm was excluded by the ${culprit} filter.`);
    console.log("      The matcher records this as a COMPLETED run and never retries,");
    console.log("      so the section stays empty with nothing shown to the student.");
  } else if ((saved[0]?.n ?? 0) === 0) {
    console.log(`\nFAIL  ${afterCoverage.length} firms qualify but none were saved.`);
    console.log("      Matching never ran, or it threw before inserting. Re-run onboarding");
    console.log("      and check the dev server log for 'ranked firm matching failed'.");
  } else {
    console.log(`\nOK    ${saved[0]?.n} firms saved and ${afterCoverage.length} more qualify.`);
  }

}

main().catch((e) => { console.error(e); process.exit(1); });
