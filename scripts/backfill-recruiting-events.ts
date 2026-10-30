// File recruiting events out of listings the classifier already rejected.
//
// The crawl files these as it goes, but only for rows it sees as NEW. Events
// rejected before that wiring existed are sitting in detected_listings with
// review_status 'rejected' and would otherwise stay there - a re-crawl
// confirms them rather than re-processing them, so they would never be picked
// up.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-recruiting-events.ts [--apply]
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { parseRecruitingEvent, wasRejectedAsEvent } from "../src/lib/monitoring/recruiting-events";
import type { Classification } from "../src/lib/monitoring/classify";

const apply = process.argv.includes("--apply");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const rows = await db.query.detectedListings.findMany({
      where: eq(schema.detectedListings.reviewStatus, "rejected"),
      with: { source: { with: { firm: true } } },
    });

    const events = rows.filter((r) =>
      wasRejectedAsEvent((r.classification as Classification | null)?.matchedEvidence ?? []),
    );
    console.log(`${events.length} rejected listing(s) were rejected for being recruiting events.\n`);

    let written = 0;
    for (const r of events) {
      const parsed = parseRecruitingEvent({
        externalJobId: r.externalJobId,
        title: r.title,
        division: r.division,
        location: r.location,
        descriptionRaw: r.descriptionRaw,
        employmentType: r.employmentType,
        applicationUrl: r.applicationUrl,
        listingUrl: r.listingUrl,
        publishedAt: null,
      });

      console.log(
        `  ${r.source.firm.name.padEnd(14)} ${parsed.kind.padEnd(13)} ` +
          `${parsed.eventDate ? parsed.eventDate.toISOString().slice(0, 10) : "no date   "} ` +
          `${(parsed.school ?? "").padEnd(16)} ${r.title.slice(0, 46)}`,
      );

      if (apply) {
        await db
          .insert(schema.firmRecruitingEvents)
          .values({
            firmId: r.source.firmId,
            sourceId: r.sourceId,
            externalId: r.externalJobId,
            title: r.title.slice(0, 300),
            eventKind: parsed.kind,
            eventDate: parsed.eventDate,
            registrationDeadline: parsed.registrationDeadline,
            school: parsed.school,
            location: r.location,
            eventUrl: r.listingUrl,
            descriptionRaw: r.descriptionRaw.slice(0, 4000),
            evidence: parsed.evidence,
          })
          // Re-derive, don't just touch the timestamps.
          //
          // This used to set lastConfirmedAt and nothing else, which made the
          // script a no-op for any row already filed - so improving the parser
          // improved nothing already in the table, and the only way to pick up
          // a fix was to delete rows by hand. Every field below is derived from
          // the listing text on this run, so rewriting them is the point.
          //
          // firstSeenAt is deliberately absent: when we first saw an event is a
          // fact about us, not about the posting, and re-parsing does not
          // change it.
          .onConflictDoUpdate({
            target: [schema.firmRecruitingEvents.firmId, schema.firmRecruitingEvents.eventUrl],
            set: {
              title: r.title.slice(0, 300),
              eventKind: parsed.kind,
              eventDate: parsed.eventDate,
              registrationDeadline: parsed.registrationDeadline,
              school: parsed.school,
              location: r.location,
              descriptionRaw: r.descriptionRaw.slice(0, 4000),
              evidence: parsed.evidence,
              lastConfirmedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        written++;
      }
    }

    console.log(`\n${apply ? `${written} filed` : `${events.length} would be filed`}.`);
    if (!apply) console.log("Dry run - pass --apply to write.");
  } finally {
    await closeDb();
  }
}

main();
