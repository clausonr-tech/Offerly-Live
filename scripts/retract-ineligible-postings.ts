// Retract live postings an undergraduate cannot apply to.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/retract-ineligible-postings.ts [--apply]
//
// WHAT THIS IS FOR. A posting is promoted from a listing once, on the
// classification that was current then. The rules move afterwards, and nothing
// re-checks what is already live - so a posting can keep being shown long
// after the rules would refuse it. Measured 13 October 2026: 13 of the 2,164
// live crawler postings are rejected by the classifier as it stands today.
//
// They fall into two groups and are recorded separately, because the reason
// matters more than the count:
//
//   MBA-LEVEL (12). Moelis, Evercore x3, Piper Sandler, Jefferies and others
//   posting "Summer Associate" - which in US banking is the MBA role, where
//   Summer Analyst is the undergraduate one. Each body says so outright:
//   "Currently be enrolled in an MBA (or equivalent) graduate program", "Be a
//   current First Year MBA student", "Enrolled in a full-time MBA program in
//   the fall of 2026". None of the twelve carries any undergraduate
//   eligibility. Offerly's students graduate 2027-2029; showing them a real
//   opening they cannot apply to is worse than showing them nothing, which is
//   the reasoning EXCLUSION_RULES already states for graduate degrees.
//
//   OFF-PROFESSION (7, added 13 October 2026). Archimed's "HR Internship
//   (Lyon, France)" x6 and Pai Partners' "Talent & Development HR Internship".
//   These are REAL internships - which is why nothing else caught them - and
//   none of them is a finance internship. `OFF_PROFESSION_RULES` had excluded
//   "human resources" for a while and never the abbreviation, which is how the
//   titles are actually written. Kai's decision, in those words: HR is not
//   finance.
//
//   STALE CYCLE (1). Houlihan Lokey's "3 Month Internship - Financial
//   Restructuring (Q4 2026)" is NOT an MBA role - its body says "You will
//   either be an undergraduate, in you final year of study". It is retracted
//   because Q4 2026 is outside the live range 2027-2029, so the round has
//   passed. Read every row before retracting it: this one looked like the
//   other twelve from the count alone and is a different thing entirely.
//
// HOW IT DECIDES. Each live listing is re-classified through `classifyListing`
// with a COMPLETE NormalizedListing. That matters: an earlier measurement in
// this work built the listing without `externalJobId` behind an `as never`
// cast, so posting-quality's "no description and no id" fired on 4,381 real
// postings and reported 77 phantom failures. Build the real object.
//
// WHAT IT DOES NOT TOUCH. `isActive = false`, never a delete, and
// `origin = 'crawler'` in the WHERE as well as the filter - a posting a person
// entered is not ours to withdraw. 437 `user_alerts` rows reference these
// postings; they are left alone, and nothing student-facing reads that table
// (it is written by notifyWatchersOfOpening and read by an admin action).
// Those alerts were already recorded, which retracting cannot undo - it only
// stops further exposure.
//
// Dry run by default, and the dated record goes down before any write.
//
// A NOTE ON THE GUARD BELOW, for whoever edits it. `firm-gaps-db.test.ts`
// checks every write to `internship_postings` by reading a fixed window of
// TEXT after the write and requiring the crawler guard inside it. That makes it
// sensitive to commentary in two opposite ways, both of which happened here: a
// comment long enough pushes the real clause out of the window, so the check
// stops seeing the write at all and passes while guarding nothing - which is
// worse than failing; and a comment quoting the query's own method names gets
// matched INSTEAD of the real clause. So the guard sits immediately after the
// write with a one-line comment, and the reasoning lives up here.
import { and, eq, inArray } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import * as schema from "../src/db/schema";
import { classifyListing } from "../src/lib/monitoring/classify";
import type { NormalizedListing } from "../src/lib/monitoring/connectors/types";
import { openScriptDb } from "./_db";

const APPLY = process.argv.includes("--apply");

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { db, close: closeDb } = await openScriptDb();
  try {
    const live = await db
      .select({
        listingId: schema.detectedListings.id,
        postingId: schema.detectedListings.promotedPostingId,
        firmName: schema.firms.name,
        externalJobId: schema.detectedListings.externalJobId,
        title: schema.detectedListings.title,
        division: schema.detectedListings.division,
        location: schema.detectedListings.location,
        descriptionRaw: schema.detectedListings.descriptionRaw,
        employmentType: schema.detectedListings.employmentType,
        applicationUrl: schema.detectedListings.applicationUrl,
        listingUrl: schema.detectedListings.listingUrl,
        publishedAt: schema.detectedListings.publishedAt,
        deadlineAt: schema.detectedListings.deadlineAt,
        sector: schema.firmMonitoringSources.sectorCategory,
        origin: schema.internshipPostings.origin,
        isActive: schema.internshipPostings.isActive,
      })
      .from(schema.detectedListings)
      .innerJoin(
        schema.firmMonitoringSources,
        eq(schema.firmMonitoringSources.id, schema.detectedListings.sourceId),
      )
      .innerJoin(schema.firms, eq(schema.firms.id, schema.firmMonitoringSources.firmId))
      .innerJoin(
        schema.internshipPostings,
        eq(schema.internshipPostings.id, schema.detectedListings.promotedPostingId),
      )
      .where(eq(schema.detectedListings.reviewStatus, "auto_approved"));

    const doomed: {
      postingId: string;
      firm: string;
      title: string;
      reason: string;
      group: "mba-level" | "stale-cycle" | "off-profession" | "other";
    }[] = [];

    for (const r of live) {
      if (r.origin !== "crawler" || !r.isActive || !r.postingId) continue;
      const listing: NormalizedListing = {
        externalJobId: r.externalJobId,
        title: r.title,
        division: r.division,
        location: r.location,
        descriptionRaw: r.descriptionRaw,
        employmentType: r.employmentType,
        applicationUrl: r.applicationUrl,
        listingUrl: r.listingUrl,
        publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        deadlineAt: r.deadlineAt ? r.deadlineAt.toISOString() : null,
      };
      const c = classifyListing(listing, r.sector);
      if (c.relevant) continue;
      const reason = c.matchedEvidence[0] ?? "(no reason recorded)";
      const group = reason.includes("MBA")
        ? "mba-level"
        : reason.includes("outside the live range")
          ? "stale-cycle"
          : reason.includes("not finance")
            ? "off-profession"
            : "other";
      doomed.push({ postingId: r.postingId, firm: r.firmName, title: r.title, reason, group });
    }

    const byGroup = new Map<string, number>();
    for (const d of doomed) byGroup.set(d.group, (byGroup.get(d.group) ?? 0) + 1);
    console.log(`${live.length} live crawler postings examined.`);
    console.log(`${doomed.length} are rejected by the rules as they stand today:\n`);
    for (const [g, n] of [...byGroup].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${g}`);
    }
    console.log("");
    for (const d of doomed) {
      console.log(`  [${d.group}] ${d.firm.slice(0, 20).padEnd(20)} ${d.title.slice(0, 52)}`);
    }

    /**
     * An "other" group is a refusal to proceed, not a category.
     *
     * The two groups above were each read row by row before this script was
     * written. A third reason means the rules have moved again since, and the
     * right response is to go and read those rows rather than to retract a
     * posting on a reason nobody has looked at.
     */
    const other = doomed.filter((d) => d.group === "other");
    if (other.length) {
      console.log(`\nREFUSING: ${other.length} are rejected for a reason this script has not seen:`);
      for (const o of other.slice(0, 10)) console.log(`  ${o.firm} | ${o.title}\n    ${o.reason}`);
      console.log("\nRead those rows, then extend the groups above. Nothing written.");
      return;
    }

    if (!APPLY) {
      console.log("\nDry run. Nothing written. Re-run with --apply.");
      return;
    }

    mkdirSync("scripts/data", { recursive: true });
    const record = `scripts/data/retracted-ineligible-${today}.json`;
    writeFileSync(record, JSON.stringify({ retractedAt: today, doomed }, null, 2));
    /**
     * Listings and postings are not the same count, and saying so matters.
     *
     * Several listings often share one promoted posting - the six Archimed "HR
     * Internship (Lyon, France)" rows are one posting carried six times. The
     * record holds the listings, because that is the evidence; the write
     * touches the postings. An earlier version reported "7 retractions" and
     * then wrote 2, which reads like a failure rather than a de-duplication.
     */
    const distinct = new Set(doomed.map((d) => d.postingId)).size;
    console.log(
      `\nRecorded ${doomed.length} listing(s) covering ${distinct} posting(s) to ${record} ` +
        `before writing.`,
    );

    const ids = doomed.map((d) => d.postingId);
    const done = await db
      .update(schema.internshipPostings)
      .set({ isActive: false, updatedAt: new Date() })
      // Origin guard first - see the note at the top of this file.
      .where(
        and(
          eq(schema.internshipPostings.origin, "crawler"),
          inArray(schema.internshipPostings.id, ids),
        ),
      )
      .returning({ id: schema.internshipPostings.id });
    console.log(`Retracted ${done.length} postings.`);
  } finally {
    await closeDb();
  }
}

main();
