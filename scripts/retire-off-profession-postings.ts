// Deactivate postings that the off-profession rule now rejects.
//
// classify.ts gained OFF_PROFESSION_RULES after these rows had already been
// promoted into internship_postings, and a promoted posting carries no cached
// classification to re-run - it is just a row. So the rule has to be replayed
// against the postings table directly, through the same exported predicate the
// classifier uses, so the two can never drift.
//
// Deactivates rather than deletes: isActive=false removes the row from every
// student-facing query while leaving it recoverable if a rule turns out to be
// too broad. Dry-run by default.
//
// Stop the dev server first.
//   npx tsx --conditions=react-server scripts/retire-off-profession-postings.ts [--apply]
import { openScriptDb } from "./_db";
import { and, eq } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import * as schema from "../src/db/schema";
import { offProfessionReason } from "../src/lib/monitoring/classify";

const apply = process.argv.includes("--apply");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const postings = await db
      .select({
        id: schema.internshipPostings.id,
        title: schema.internshipPostings.roleTitle,
        firmId: schema.internshipPostings.firmId,
        isActive: schema.internshipPostings.isActive,
        // The firm's sectors, which the rule needs: see below.
        categories: schema.internshipPostings.categories,
      })
      .from(schema.internshipPostings);
    const firms = await db.select().from(schema.firms);
    const firmName = new Map(firms.map((f) => [f.id, f.name]));

    /**
     * THE SECTOR HAS TO BE PASSED, OR THIS RETIRES REAL INTERNSHIPS.
     *
     * `offProfessionReason` takes the firm's sector as a third argument, and
     * its accounting-practice rule is exempted for a bank's own Internal Audit
     * division - 83 listings across MUFG, Citigroup, Morgan Stanley, Nomura and
     * six more, all genuine undergraduate summer analyst programmes. Called with
     * the title alone, as this did, every one of them comes back with a reason
     * and this script deactivates it: the exact opposite of its purpose, on a
     * table students read. The header promises it replays "the same exported
     * predicate the classifier uses, so the two can never drift" - an optional
     * argument is how it drifted anyway.
     *
     * A posting carries its firm's sectors as an array, and the exemption is a
     * question about the firm, so the rule is run per sector and the posting is
     * retired only when NO sector of its firm excuses the title. Conservative
     * deliberately: the cost of keeping one off-profession row is a bad listing,
     * and the cost of dropping one is a real internship a student never sees.
     */
    const hits = postings
      .filter((p) => p.isActive)
      .map((p) => {
        const reasons = (p.categories.length > 0 ? p.categories : [null]).map((c) =>
          offProfessionReason(p.title, null, c),
        );
        return { ...p, reason: reasons.every((r) => r !== null) ? reasons[0] : null };
      })
      .filter((p) => p.reason !== null);

    for (const h of hits) {
      console.log(`  - ${firmName.get(h.firmId) ?? "?"}: ${h.title.slice(0, 72)}`);
      if (apply) {
        await db
          .update(schema.internshipPostings)
          .set({ isActive: false })
          .where(and(eq(schema.internshipPostings.id, h.id), eq(schema.internshipPostings.origin, "crawler")));
      }
    }

    console.log(
      `\n${hits.length} active posting(s) retired${apply ? "" : " (dry run - pass --apply)"}`,
    );
  } finally {
    await closeDb();
  }
}

main();
