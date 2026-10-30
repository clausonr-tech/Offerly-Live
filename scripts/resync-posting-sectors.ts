/**
 * Re-file published postings under what their listing now says.
 *
 * Covers three fields, all with the same failure mode: written once at
 * publication and never updated, so a rule fix corrects the listing and
 * leaves the thing students actually see showing the old answer.
 *
 *   categories         which industry it is filed under
 *   programYear        WHICH SUMMER it runs
 *   eligibleGradYears  WHO the firm said it will accept
 *
 * The year matters as much as the sector. "Summer 2027 Financial Analyst
 * (Class of 2028)" was stored as programYear 2028, because "Class of 2028"
 * was read as the cycle instead of as a graduating class - so a Summer 2027
 * internship sat on the Summer 2028 page, where the students who could apply
 * never saw it and a year of students who could not were shown it as theirs.
 *
 *
 * `internship_postings.category` is written ONCE, at publication, from
 * `classification.sector ?? source.sectorCategory`. Nothing updates it
 * afterwards: `reclassify-listings.ts` rewrites the listing's classification
 * and only ever DELETES a posting, on retraction. So a sector rule that gets
 * fixed corrects the listing and leaves the thing students actually see
 * showing the old answer.
 *
 * Measured on Supabase, 20 September 2026: 31 of 764 relevant listings were
 * filed under a sector their own title contradicts, and most were already
 * published - "2028 Equities: Sales & Trading Summer Intern Program" and
 * "2027 Private Credit Investment Summer Internship Programme" both live under
 * investment banking. A student filtering for sales and trading, private
 * credit, corporate banking or wealth management was shown nothing, which
 * reads as the crawler having no coverage in those sectors when it has the
 * postings and filed them one category over.
 *
 * Run this AFTER `reclassify-listings.ts --apply`, which is what puts the
 * corrected sector on the listing in the first place.
 *
 * Only moves a posting between sectors. Never publishes, never retracts,
 * never touches a posting whose listing has no sector - the publication rule
 * falls back to the source's registered sector there, and this has no better
 * answer than that fallback did - and never touches a posting filed under
 * more than one category, which is a human's widening rather than the
 * crawler's single guess.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/resync-posting-sectors.ts
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/resync-posting-sectors.ts --apply
 */
import { and, eq } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import * as schema from "../src/db/schema";
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import type { Classification } from "../src/lib/monitoring/classify";

const APPLY = process.argv.includes("--apply");

async function main() {
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}${APPLY ? "" : "  (dry run)"}`);

  try {
    const rows = await db
      .select({
        listing: schema.detectedListings,
        posting: schema.internshipPostings,
      })
      .from(schema.detectedListings)
      .innerJoin(
        schema.internshipPostings,
        eq(schema.internshipPostings.id, schema.detectedListings.promotedPostingId),
      );

    console.log(`${rows.length} published posting(s) to check\n`);

    // Per sector, never one total - a re-filing that reports a single number
    // cannot show that it moved postings OUT of banking and INTO five other
    // sectors, which is the whole point of running it.
    //
    // Postings carrying more than one category are left alone and counted
    // nowhere: see the note below on why.
    const moves = new Map<string, number>();
    let changed = 0;

    for (const { listing, posting } of rows) {
      const c = listing.classification as Classification | null;
      const want = c?.sector;
      // No sector on the listing means the publication rule used the source's
      // registered sector. That fallback is still the best answer available.
      if (!want) continue;

      /**
       * `categories` is an ARRAY, and only a single-entry one is ours to move.
       *
       * The column is plural because a posting can legitimately span several
       * industries, and Discovery counts it under each. The crawler never
       * writes more than one - `savePosting(source.firmId, [category], ...)` -
       * so a row with two or more was widened by somebody, and replacing that
       * with a single guess would throw away a human's work.
       */
      /**
       * The programme year and eligibility, from the same corrected listing.
       *
       * Checked before the sector, because a wrong year puts a posting on the
       * wrong page entirely while a wrong sector only puts it under the wrong
       * heading on the right one.
       *
       * `program_year` is part of savePosting's upsert key (firm, role,
       * year), so moving one can collide with a posting that already occupies
       * the new key. That row is left alone and reported rather than merged:
       * deciding which of two postings survives is not this script's call.
       */
      const wantYear = c?.recruitingCycle ?? null;
      const wantElig = c?.eligibility?.gradYears ?? [];
      const yearWrong = wantYear !== null && wantYear !== posting.programYear;

      /**
       * Eligibility is only ever NARROWED to something stated, never widened
       * back to nothing.
       *
       * A stored posting can carry eligibility this pass cannot reproduce.
       * monitor-run fills a blank one from the firm's own other postings for
       * the same cycle - `inferFromFirmPattern`, and only when they all agree
       * - and that inference runs over a whole board's worth of siblings that
       * a single re-classification never sees. So an empty result here means
       * "this pass did not find one", not "the firm did not say".
       *
       * Clearing on that would have widened 24 postings from a known class to
       * unrestricted, quietly undoing a deliberate feature and showing them to
       * students the firm's own other postings imply are not eligible.
       */
      const eligWrong =
        wantElig.length > 0 &&
        JSON.stringify([...(posting.eligibleGradYears ?? [])].sort()) !==
          JSON.stringify([...wantElig].sort());

      if (yearWrong || eligWrong) {
        if (yearWrong) {
          const clash = await db
            .select({ id: schema.internshipPostings.id })
            .from(schema.internshipPostings)
            .where(
              and(
                eq(schema.internshipPostings.firmId, posting.firmId),
                eq(schema.internshipPostings.roleTitle, posting.roleTitle),
                eq(schema.internshipPostings.programYear, wantYear),
              ),
            );
          if (clash.length) {
            console.log(
              `  SKIP (a Summer ${wantYear} posting already exists) ${posting.roleTitle.slice(0, 54)}`,
            );
            continue;
          }
        }
        const label = yearWrong
          ? `Summer ${posting.programYear} -> Summer ${wantYear}`
          : `eligibility -> [${wantElig.join(",")}]`;
        moves.set(label, (moves.get(label) ?? 0) + 1);
        console.log(`  ${label}  ${posting.roleTitle.slice(0, 60)}`);
        if (APPLY) {
          await db
            .update(schema.internshipPostings)
            .set({
              ...(yearWrong ? { programYear: wantYear } : {}),
              ...(eligWrong ? { eligibleGradYears: wantElig } : {}),
              updatedAt: new Date(),
            })
            .where(and(eq(schema.internshipPostings.id, posting.id), eq(schema.internshipPostings.origin, "crawler")));
        }
        changed += 1;
        continue;
      }

      const current = posting.categories ?? [];
      if (current.length !== 1) continue;
      if (current[0] === want) continue;

      /**
       * Only re-file when the TITLE named the sector.
       *
       * `classifyListing` records which it used - "(from the title)" or
       * "(from the description)" - and only the first is better evidence than
       * what published the posting in the first place. When a listing's title
       * names no sector, publication fell back to the SOURCE's registered
       * sector, and that is a curated fact somebody entered on purpose. The
       * description is the firm's boilerplate, which says "M&A" and "strategic
       * advisory" on every posting a bank publishes.
       *
       * Without this test the sweep moved two real postings the wrong way:
       * "2027 Quantitative Finance Off-Cycle Internship (London)" names no
       * sector in its title, was published under the source's sales_trading,
       * and would have been re-filed as investment banking on the strength of
       * the boilerplate underneath it. Trading a curated answer for a guess is
       * not a correction.
       */
      const fromTitle = (c?.matchedEvidence ?? []).some(
        (e) => e.startsWith("sector keyword") && e.includes("(from the title)"),
      );
      if (!fromTitle) continue;

      const key = `${current[0]} -> ${want}`;
      moves.set(key, (moves.get(key) ?? 0) + 1);
      console.log(`  ${current[0]} -> ${want}  ${posting.roleTitle.slice(0, 66)}`);

      if (APPLY) {
        await db
          .update(schema.internshipPostings)
          .set({ categories: [want], updatedAt: new Date() })
          .where(and(eq(schema.internshipPostings.id, posting.id), eq(schema.internshipPostings.origin, "crawler")));
      }
      changed += 1;
    }

    console.log(`\n${APPLY ? "re-filed" : "would re-file"} ${changed} posting(s).`);
    if (moves.size) {
      console.log("\nby move:");
      for (const [move, n] of [...moves].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(4)}  ${move}`);
      }
    }
    if (!APPLY) console.log("\nDry run - pass --apply to write.");
  } finally {
    await opened.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
