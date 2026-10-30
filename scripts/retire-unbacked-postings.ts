// Deactivate crawler postings the crawler no longer stands behind.
//
// THE GAP. `decideClosure` marks a detected_listing `closed` when it has gone
// from the board, and `reclassify-listings.ts` sets `promoted_posting_id` to
// NULL when a rule change re-rejects one. Neither touches the posting itself,
// and nothing else does either: the only writers of `is_active = false` are the
// off-profession retirement and a firm taking down its own post. So a posting
// outlives the evidence for it.
//
// Measured 12 October 2026 against the live database:
//   1,580 active postings whose listing is CLOSED - the job is gone from the
//         firm's board and a student is still being shown it.
//     230 active crawler postings with NO backing listing at all - unlinked by
//         a reclassification that rejected the listing and left the posting up.
//
// `isRealPosting` does not catch either: it judges the title, the description
// and the deadline, and never asks whether the listing is still open. Nor does
// any student-facing query join listing status - the one join that exists reads
// `first_detected_at` for the "new" badge.
//
// WHAT IT WILL NOT DO
//  - `origin = 'crawler'` on every write. A posting a firm wrote itself on the
//    firm portal is the firm's, and no script may retire it.
//  - Deactivates rather than deletes: `is_active = false` removes the row from
//    every student-facing query while leaving it recoverable.
//  - Never touches a posting whose listing is still open.
//
// Dry-run by default. Records a dated file under scripts/data/ BEFORE any
// write, because internship_postings keeps no history of its own.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/retire-unbacked-postings.ts
//   ... --apply
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";

import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const postings = await db
      .select({
        id: schema.internshipPostings.id,
        title: schema.internshipPostings.roleTitle,
        firmId: schema.internshipPostings.firmId,
        origin: schema.internshipPostings.origin,
        isActive: schema.internshipPostings.isActive,
      })
      .from(schema.internshipPostings);

    const listings = await db
      .select({
        promotedPostingId: schema.detectedListings.promotedPostingId,
        status: schema.detectedListings.status,
      })
      .from(schema.detectedListings);

    const firms = await db.select({ id: schema.firms.id, name: schema.firms.name }).from(schema.firms);
    const firmName = new Map(firms.map((f) => [f.id, f.name]));

    // A posting is backed if ANY listing pointing at it is still open. More
    // than one listing can promote to the same posting when a board lists a
    // role twice, and one of them still being live is enough.
    const openBacked = new Set<string>();
    const anyBacked = new Set<string>();
    for (const l of listings) {
      if (!l.promotedPostingId) continue;
      anyBacked.add(l.promotedPostingId);
      if (l.status === "open") openBacked.add(l.promotedPostingId);
    }

    const candidates = postings
      .filter((p) => p.isActive && p.origin === "crawler" && !openBacked.has(p.id))
      .map((p) => ({
        id: p.id,
        firm: firmName.get(p.firmId) ?? "?",
        title: p.title.slice(0, 70),
        why: anyBacked.has(p.id) ? ("listing closed" as const) : ("no backing listing" as const),
      }));

    const closed = candidates.filter((c) => c.why === "listing closed");
    const orphaned = candidates.filter((c) => c.why === "no backing listing");

    /**
     * ONLY THE ONES WITH POSITIVE EVIDENCE ARE RETIRED.
     *
     * "No backing listing" cannot distinguish a posting whose listing was
     * unlinked from one that never had a listing at all. `origin` is
     * `text("origin").notNull().default("crawler")`, and both
     * `scripts/import-postings.ts` and `upsertPosting` in
     * lib/internship-postings.ts insert WITHOUT setting it - so every manually
     * imported posting is `origin = 'crawler'` with no detected_listings row
     * pointing at it, and is indistinguishable here from an orphan.
     *
     * Retiring that group would deactivate the imported catalogue. So it is
     * reported and left alone: a closed listing is evidence the job is gone,
     * and an absent listing is evidence of nothing.
     */
    const retiring = closed;

    console.log(`${candidates.length} active crawler postings are no longer backed:`);
    console.log(`  listing closed:      ${closed.length}  <- retired`);
    console.log(`  no backing listing:  ${orphaned.length}  <- REPORTED ONLY, not retired`);
    console.log(
      "    (origin defaults to 'crawler', and import-postings.ts / upsertPosting do not",
    );
    console.log(
      "     set it, so this group cannot be told apart from manually imported postings)",
    );
    for (const c of retiring.slice(0, 12)) {
      console.log(`  - [${c.why}] ${c.firm}: ${c.title}`);
    }

    if (!APPLY) {
      console.log(`\nDry run - nothing written. Pass --apply to retire ${retiring.length}.`);
      return;
    }
    if (retiring.length === 0) {
      console.log("\nNothing to retire.");
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const out = path.join(process.cwd(), "scripts/data", `unbacked-postings-retired-${stamp}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        { at: new Date().toISOString(), retired: retiring, reportedNotRetired: orphaned },
        null,
        2,
      ),
    );
    console.log(`\nRecorded ${retiring.length} retirements (and ${orphaned.length} left alone) to ${out}`);

    // Batched, and `origin` re-checked in SQL as well as in the filter above:
    // the guard has to hold even if this list were built wrongly.
    const BATCH = 200;
    let done = 0;
    for (let i = 0; i < retiring.length; i += BATCH) {
      const ids = retiring.slice(i, i + BATCH).map((c) => c.id);
      await db
        .update(schema.internshipPostings)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            inArray(schema.internshipPostings.id, ids),
            eq(schema.internshipPostings.origin, "crawler"),
          ),
        );
      done += ids.length;
      console.log(`  ${done}/${retiring.length}`);
    }
    console.log(`\n${done} postings retired.`);
  } finally {
    await closeDb();
  }
}

main();
