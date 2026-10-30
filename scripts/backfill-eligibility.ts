// Fill in eligibility the deterministic parser could not read, using a model.
//
// Runs OVER stored listings rather than inside the crawl, on purpose. The crawl
// stays deterministic, fast and free; model spend is a separate, capped,
// explicitly invoked pass. It also means a prompt or model change can be
// re-run over the same rows without re-fetching a single careers page.
//
// Only touches listings whose eligibility is BLANK. A posting that stated its
// own requirements is already correct and a model cannot improve on it.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-eligibility.ts [--limit N] [--apply]
import { and, eq, inArray } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import * as schema from "../src/db/schema";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { openDb } from "../src/db/open";
import { extractEligibilityWithLlm } from "../src/lib/monitoring/llm-extract";
import type { Classification } from "../src/lib/monitoring/classify";

const apply = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg === -1 ? 25 : Number(process.argv[limitArg + 1]);

async function main() {
  // Follows DATABASE_URL, so this reads and writes whichever database the
  // project is actually using. Opening PGlite directly here would have
  // re-tiered a local file nothing reads, and reported success doing it.
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}`);

  try {
    const rows = await db.query.detectedListings.findMany({
      where: inArray(schema.detectedListings.reviewStatus, ["auto_approved", "approved", "pending_review"]),
      with: { source: { with: { firm: true } } },
    });

    const blanks = rows.filter((r) => {
      const c = r.classification as Classification | null;
      return c?.relevant && !(c.eligibility?.gradYears?.length);
    });

    console.log(`${blanks.length} listing(s) with blank eligibility; trying up to ${limit}.\n`);

    let filled = 0;
    let nothingToFind = 0;

    for (const r of blanks.slice(0, limit)) {
      const c = r.classification as Classification;
      const result = await extractEligibilityWithLlm(
        { title: r.title, descriptionRaw: r.descriptionRaw, requirementsRaw: c.requirementsRaw },
        c.recruitingCycle,
      );

      if (!result) {
        nothingToFind++;
        continue;
      }

      console.log(`  ${r.source.firm.name.padEnd(18)} grad ${result.gradYears.join("/")}  ${r.title.slice(0, 44)}`);
      console.log(`      "${result.quote.slice(0, 110)}"`);
      filled++;

      if (apply) {
        const next: Classification = {
          ...c,
          eligibility: {
            gradYears: result.gradYears,
            level: (result.level as Classification["eligibility"]["level"]) ?? null,
            // `stated`, not `inferred`. The model did not reason its way here -
            // it copied a sentence out of the posting, and that sentence was
            // checked against the source before we accepted it. The firm stated
            // this; we simply needed help finding where.
            basis: "stated",
            evidence: [result.quote],
          },
          matchedEvidence: [...c.matchedEvidence, `eligibility read by model: "${result.quote.slice(0, 120)}"`],
        };

        await db
          .update(schema.detectedListings)
          .set({ classification: next, updatedAt: new Date() })
          .where(eq(schema.detectedListings.id, r.id));

        // Keep the published row in step. A posting whose eligibility we have
        // just learned should start being filtered by it.
        if (r.promotedPostingId) {
          await db
            .update(schema.internshipPostings)
            .set({ eligibleGradYears: result.gradYears, updatedAt: new Date() })
            .where(and(eq(schema.internshipPostings.id, r.promotedPostingId), eq(schema.internshipPostings.origin, "crawler")));
        }
      }
    }

    console.log(
      `\n${filled} ${apply ? "filled" : "would fill"}, ${nothingToFind} had nothing to find ` +
        `(the posting genuinely does not say, which is a correct blank).`,
    );
    if (!apply) console.log("Dry run - pass --apply to write.");
  } finally {
    await opened.close();
  }
}

main();
