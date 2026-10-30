// Is the same posting stored twice, under two sources?
//
// A new problem, introduced by the Getro connector. A portfolio board
// republishes its companies' postings and links straight at the underlying
// board, so one posting can arrive from a fund's Getro collection AND from the
// employer's own Greenhouse - two rows, two externalJobIds, one application.
// Nothing downstream notices, and a student sees it twice.
//
// Identity is the APPLICATION URL, because that is what a student clicks.
// See listingDedupKey in board-identity.ts.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/audit-duplicate-listings.ts [--apply]
//
// Stop the dev server first - PGlite is single-writer.
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { listingDedupKey } from "../src/lib/monitoring/board-identity";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const sources = await db.select().from(schema.firmMonitoringSources);
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const listings = await db.select().from(schema.detectedListings);

    const groups = new Map<string, typeof listings>();
    for (const listing of listings) {
      const key = listingDedupKey({
        listingUrl: listing.listingUrl,
        applicationUrl: listing.applicationUrl,
        title: listing.title,
        firmId: sourceById.get(listing.sourceId)?.firmId ?? null,
      });
      groups.set(key, [...(groups.get(key) ?? []), listing]);
    }

    const duplicated = [...groups.entries()].filter(([, g]) => g.length > 1);
    console.log(`${listings.length} listings -> ${groups.size} distinct postings.`);

    if (!duplicated.length) {
      console.log("No posting is stored twice.");
      return;
    }

    let merged = 0;
    for (const [key, group] of duplicated) {
      /**
       * Which copy survives.
       *
       * The one already published wins outright - it may be linked from a
       * student's saved list. Otherwise the earliest, because it has the
       * detection history and moving that gains nothing.
       */
      const ordered = [...group].sort(
        (a, b) =>
          Number(Boolean(b.promotedPostingId)) - Number(Boolean(a.promotedPostingId)) ||
          a.firstDetectedAt.getTime() - b.firstDetectedAt.getTime(),
      );
      const [keep, ...rest] = ordered;

      /**
       * Same URL is not always the same posting.
       *
       * The generic connector takes its listing URL from the anchor it found,
       * so a careers page listing five internships that all link back to that
       * one page yields five rows sharing a URL - and collapsing them would
       * destroy four real openings. Deutsche Bank's page does exactly this:
       * "Internship Programme" and the marketing sentence beside it share
       * careers.db.com/students-graduates/internship-programme.
       *
       * So a merge needs one of two things: the copies came from DIFFERENT
       * sources (the cross-board case this exists for), or their titles are
       * the same (the same posting, seen twice). Different titles from the
       * same source are left alone.
       */
      const normalizeTitle = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

      console.log(`\n${key.slice(0, 90)}`);
      console.log(`  keep  ${keep.title.slice(0, 60)}`);
      for (const dup of rest) {
        // A human's decision is not a script's to overwrite.
        if (dup.reviewedBy) {
          console.log(`  skip  ${dup.title.slice(0, 55)} (a person already reviewed this)`);
          continue;
        }
        const crossSource = dup.sourceId !== keep.sourceId;
        const sameTitle = normalizeTitle(dup.title) === normalizeTitle(keep.title);
        if (!crossSource && !sameTitle) {
          console.log(`  keep  ${dup.title.slice(0, 55)} (same URL, same source, different title - a separate posting)`);
          continue;
        }
        console.log(`  merge ${dup.title.slice(0, 60)}`);
        merged += 1;
        if (APPLY) {
          await db
            .update(schema.detectedListings)
            .set({
              // The schema already has "merged" for exactly this, and reuses
              // promotedPostingId as the link - so if the survivor published,
              // both copies point at the same posting.
              reviewStatus: "merged",
              promotedPostingId: keep.promotedPostingId ?? null,
              updatedAt: new Date(),
            })
            .where(eq(schema.detectedListings.id, dup.id));
        }
      }
    }

    console.log(`\n${duplicated.length} posting(s) stored more than once; ${merged} ${APPLY ? "merged" : "would be merged"}.`);
    if (!APPLY) console.log("\nDry run - pass --apply to write.");
  } finally {
    await closeDb();
  }
}

main();
