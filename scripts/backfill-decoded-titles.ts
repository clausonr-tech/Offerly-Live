/**
 * Decode HTML entities in titles that were stored before the decoder existed.
 *
 * `monitor-run` now decodes every connector's output at the point it stores a
 * listing, but rows written before that keep whatever the board emitted.
 * Measured on Supabase, 20 September 2026: 14 detected listings and one
 * published posting carry an undecoded entity, and a student reading
 * "Quantitative Master&rsquo;s Internship Program" sees the raw markup.
 *
 * It is not only cosmetic. Classification reads the title, so an entity in
 * the middle of a word hides it from every rule that matches on words - the
 * undergraduate-only exclusion could not see `Master&rsquo;s` as "master's",
 * and that posting stayed published when its four siblings were retracted.
 *
 * Titles only. Descriptions are shown as prose and are a separate question
 * from the one that decides which rules fire.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-decoded-titles.ts
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-decoded-titles.ts --apply
 */
import { and, eq } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import * as schema from "../src/db/schema";
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { decodeEntities } from "../src/lib/monitoring/entities";

const APPLY = process.argv.includes("--apply");

async function main() {
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}${APPLY ? "" : "  (dry run)"}\n`);

  try {
    let listings = 0;
    for (const row of await db.select().from(schema.detectedListings)) {
      const decoded = decodeEntities(row.title);
      if (decoded === row.title) continue;
      console.log(`  listing  ${row.title.slice(0, 62)}`);
      console.log(`        -> ${decoded.slice(0, 62)}`);
      listings += 1;
      if (APPLY) {
        await db
          .update(schema.detectedListings)
          .set({ title: decoded, updatedAt: new Date() })
          .where(eq(schema.detectedListings.id, row.id));
      }
    }

    let postings = 0;
    for (const row of await db.select().from(schema.internshipPostings)) {
      const decoded = decodeEntities(row.roleTitle);
      if (decoded === row.roleTitle) continue;
      console.log(`  posting  ${row.roleTitle.slice(0, 62)}`);
      console.log(`        -> ${decoded.slice(0, 62)}`);
      postings += 1;
      if (APPLY) {
        await db
          .update(schema.internshipPostings)
          .set({ roleTitle: decoded, updatedAt: new Date() })
          .where(and(eq(schema.internshipPostings.id, row.id), eq(schema.internshipPostings.origin, "crawler")));
      }
    }

    console.log(
      `\n${APPLY ? "decoded" : "would decode"} ${listings} listing title(s) and ${postings} posting title(s).`,
    );
    if (listings || postings) {
      console.log("Re-run reclassify-listings.ts afterwards: a decoded title can match rules the encoded one hid.");
    }
    if (!APPLY) console.log("Dry run - pass --apply to write.");
  } finally {
    await opened.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
