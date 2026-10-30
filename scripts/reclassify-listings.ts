// Re-run the classifier over every stored detected listing.
//
// Needed whenever a classification rule changes: the `classification` column
// is a cached verdict, so a fixed rule does nothing for the rows already in
// the table until they are re-judged. Dry-run by default - pass --apply to
// write.
//
// Stop the dev server first.
//   npx tsx --env-file=.env.local --conditions=react-server scripts/reclassify-listings.ts [--apply]
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { openDb } from "../src/db/open";
import { and, eq } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import * as schema from "../src/db/schema";
import { classifyListing, publishableWithoutReview } from "../src/lib/monitoring/classify";
import { isUnreviewable } from "../src/lib/monitoring/listing-lifecycle";
import type { FirmProgramCategory } from "../src/lib/firm-metadata";

const apply = process.argv.includes("--apply");

async function main() {
  // Follows DATABASE_URL: re-judging rows in a local file nothing reads is
  // worse than not re-judging them, because it reports success.
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}`);

  try {
    const listings = await db.select().from(schema.detectedListings);
    const retracted: string[] = [];
  // Queued rows a rule change rejected - counted separately from retractions,
  // because nobody ever saw these and no student loses a posting.
  const dequeued: string[] = [];
    const firms = await db.select().from(schema.firms);
    const sources = await db.select().from(schema.firmMonitoringSources);
    const firmName = new Map(firms.map((f) => [f.id, f.name]));
    const sourceFirm = new Map(sources.map((s) => [s.id, s.firmId]));
    const sourceSector = new Map(
      sources.map((s) => [s.id, s.sectorCategory as FirmProgramCategory]),
    );

    let becameIrrelevant = 0;
    let becameRelevant = 0;
    const flips: string[] = [];
    const promoted: string[] = [];
    // Machine-rejected rows the fixed rules now accept. Kept separate from
    // `promoted` so the output says which were recovered from rejection
    // rather than merely advanced out of the review queue.
    const recovered: string[] = [];

    for (const l of listings) {
      const was = (l.classification as { relevant?: boolean } | null)?.relevant === true;
      const now = classifyListing(
        {
        externalJobId: l.externalJobId,
        title: l.title,
        division: l.division,
        location: l.location,
        descriptionRaw: l.descriptionRaw,
        employmentType: l.employmentType,
        applicationUrl: l.applicationUrl,
        listingUrl: l.listingUrl,
          publishedAt: l.publishedAt?.toISOString() ?? null,
          deadlineAt: l.deadlineAt?.toISOString() ?? null,
        },
        // Same fallback the crawler uses: the board's registered sector, for
        // listings whose own words never name one.
        sourceSector.get(l.sourceId) ?? null,
      );

      /**
       * Evidence a reclassification must not destroy.
       *
       * `classification` is REPLACED wholesale below, and three keys living in
       * it were never produced by the classifier: `adjudication`, the model's
       * quote-verified second opinion on a title the phrase list could not
       * read; `cycleBasis`, which records where a derived year came from; and
       * `reviewAgent`, what scripts/review-agent.ts decided after re-reading
       * the posting's own page. Overwriting them loses the only record of why
       * a row was recovered. Measured: 18 rows carry an adjudication, and a
       * reclassify pass would have wiped every one.
       *
       * `reviewAgent` was added to this list before the first backfill run,
       * not after. It is the same bug as the adjudication one, one key later -
       * and losing it costs more than the record: the agent reads its own
       * `skips` counter to stop paying for a page that will never read, and
       * reads the presence of the key at all to avoid re-examining a listing
       * it has already judged. Wiping it would silently re-spend the whole
       * queue's model budget on work already done.
       *
       * THE PATTERN, for whoever adds the fourth key: anything written into
       * `classification` by something other than `classifyListing` has to be
       * named here, because this function's contract is "replace the
       * classifier's own output" and it cannot tell the difference by itself.
       */
      const prior = (l.classification ?? {}) as Record<string, unknown>;
      const nowWithEvidence: Record<string, unknown> = { ...now };
      if (prior.adjudication) nowWithEvidence.adjudication = prior.adjudication;
      if (prior.cycleBasis) nowWithEvidence.cycleBasis = prior.cycleBasis;
      if (prior.reviewAgent) nowWithEvidence.reviewAgent = prior.reviewAgent;

      /**
       * A row the adjudicator recovered is not re-rejected by the very rule
       * that missed it.
       *
       * The adjudicator only runs on listings the phrase list rejected, and
       * only accepts an answer whose quote is verified against the posting.
       * So "the deterministic classifier says no" is exactly the verdict it
       * already overruled with evidence; treating that as a fresh decision
       * would undo the recovery on every pass.
       *
       * Weaker than a human's call, which is untouchable, and stronger than
       * the first-pass guess it disagreed with - so the row simply stays in
       * pending_review for a person to settle.
       */
      const adjudicatorRecovered =
        (prior.adjudication as { isInternship?: boolean } | undefined)?.isInternship === true;

      if (was !== now.relevant) {
        const name = firmName.get(sourceFirm.get(l.sourceId) ?? "") ?? "?";
        flips.push(`  ${was ? "-" : "+"} ${name}: ${l.title.slice(0, 70)}`);
        if (was) becameIrrelevant++;
        else becameRelevant++;
      }

      /**
       * The review status has to move with the verdict.
       *
       * Rewriting `classification` alone left a listing the rules now
       * auto-approve still sitting in `pending_review` forever - and since only
       * auto-approved listings are ever published, a rule fix could silently
       * change nothing a student sees. Only ever promotes: a human decision
       * already recorded (approved / rejected) is never overwritten by a rule
       * change.
       */
      /**
       * A CLOSED JOB IS NEVER RE-APPROVED, HOWEVER GOOD THE NEW VERDICT.
       *
       * `publishableWithoutReview` judges the listing's words; it knows nothing
       * about whether the vacancy still exists. Re-approving a closed one sets
       * `auto_approved` with a null posting link, which is precisely what
       * `promote-approved-listings.ts` publishes - so a rule fix meant to
       * recover wrongly-rejected internships would also put jobs that closed
       * weeks ago back in front of students, undoing the retirement pass.
       *
       * The fresh classification is still worth storing on such a row: if the
       * board lists the role again, the crawler re-detects it and it is judged
       * on the corrected rule. Only the publishable verdict is withheld.
       */
      const isOpen = l.status === "open";
      // `auto_approved` means publishable - see publishableWithoutReview.
      const newStatus = isOpen && publishableWithoutReview(now) ? "auto_approved" : null;
      const humanDecided = l.reviewedBy !== null;
      /**
       * A row that is no longer relevant is retracted, not just re-labelled.
       *
       * The old version only ever promoted pending rows forward. But a rule
       * change can also make something STOP qualifying - four Jefferies
       * "Analyst Programme - London" rows are full-time graduate schemes that
       * a fixed rule now rejects, and they had already been published. Leaving
       * the posting live because the listing's label changed would mean the
       * classifier and the student-facing table disagreeing, with students
       * seeing the older, wrong answer.
       */
      if (!now.relevant && adjudicatorRecovered && l.reviewStatus === "pending_review") {
        // Left exactly as it is, evidence intact, for a human to settle.
        continue;
      }

      if (!now.relevant && l.promotedPostingId) {
        retracted.push(`${l.title.slice(0, 66)} - ${now.matchedEvidence[0] ?? "no longer relevant"}`);
        if (apply) {
          // Clear the reference BEFORE deleting the row it points at -
          // detected_listings.promoted_posting_id is a foreign key, so the
          // other order fails the constraint and aborts the whole pass.
          await db
            .update(schema.detectedListings)
            .set({ reviewStatus: "rejected", promotedPostingId: null, classification: nowWithEvidence, updatedAt: new Date() })
            .where(eq(schema.detectedListings.id, l.id));
          /**
           * EVERY row pointing at that posting, not just this one.
           *
           * Clearing the reference on `l.id` alone is not enough: two
           * detected listings can be promoted to the same posting - the same
           * vacancy seen twice on a board, or through two sources for one
           * firm - and the delete below then fails the foreign key on the
           * OTHER row's reference. It aborted the whole pass on
           * 11 October 2026 with
           * `Key (id)=(34166896-...) is still referenced from table
           * "detected_listings"`, after the classification writes had already
           * landed, leaving the retractions undone.
           */
          await db
            .update(schema.detectedListings)
            .set({ promotedPostingId: null, updatedAt: new Date() })
            .where(eq(schema.detectedListings.promotedPostingId, l.promotedPostingId));
          await db
            .delete(schema.internshipPostings)
            .where(and(eq(schema.internshipPostings.id, l.promotedPostingId), eq(schema.internshipPostings.origin, "crawler")));
        }
        continue;
      }

      /**
       * A QUEUED row that stopped qualifying leaves the queue.
       *
       * The retraction above handles a published listing that a rule change
       * rejects. This is the same event one stage earlier, and it had no
       * branch at all: a pending row was re-labelled `relevant: false` and
       * left sitting in `pending_review`, because the only status change this
       * pass could make was promoting a row FORWARD.
       *
       * Measured 20 September 2026. Adding the breadcrumb and nav-link rules
       * turned 11 listings irrelevant - HSBC's "View internship programmes"
       * six times over, a link to a programme finder that is not a job. Every
       * one kept its place in the human queue after being judged not to be a
       * posting at all.
       *
       * `rejected` is where monitor-run puts a non-relevant listing when it
       * first stores one, so this just brings an existing row to the state it
       * would have been given had the rule existed at the time. A human
       * decision is still never overwritten.
       */
      if (!now.relevant && l.reviewStatus === "pending_review" && !humanDecided) {
        dequeued.push(`${l.title.slice(0, 66)} - ${now.matchedEvidence[0] ?? "no longer relevant"}`);
        if (apply) {
          await db
            .update(schema.detectedListings)
            .set({ reviewStatus: "rejected", classification: nowWithEvidence, updatedAt: new Date() })
            .where(eq(schema.detectedListings.id, l.id));
        }
        continue;
      }

      /**
       * A MACHINE rejection is not a decision, and has to be revisitable.
       *
       * This used to gate on `reviewStatus === "pending_review"`, on the
       * reasoning that "rejected" records a human's call and a rule change
       * must not overwrite it. The reasoning is right and the test was wrong:
       * almost every rejected row here was rejected by the classifier, not by
       * a person. 2,164 of 2,495 listings are rejected and `reviewedBy` is
       * null on effectively all of them.
       *
       * So a fixed rule changed the stored verdict and left the row rejected
       * forever. Measured 19 September 2026: adding French internship words
       * turned 37 Lazard "Stage H/F" listings relevant, and all 37 stayed
       * `rejected` - recognised but not recovered, which is the same shape of
       * bug as a backfill that re-derives a field and only bumps the
       * timestamp.
       *
       * `reviewedBy` is what distinguishes the two. A human's rejection is
       * still untouchable; the classifier's own is not.
       */
      /**
       * A row nobody can judge is not a recoverable rejection.
       *
       * The rule below revisits machine rejections because a fixed rule can
       * overturn one. That cannot help a listing whose board no longer lists
       * it and whose description was never readable - there is nothing for
       * any rule, or any person, to read. Recovering those put 46 Morgan
       * Stanley rows straight back into the review queue the moment after
       * they were retired from it.
       */
      const machineRejected =
        l.reviewStatus === "rejected" && !humanDecided && !isUnreviewable(l);

      if (now.relevant && machineRejected) {
        // Binary, matching monitor-run.ts: there is no queue to send a row
        // back to. A rejection states its reason and is recoverable by a
        // later rule change; a queued row is not, because nobody reads it.
        // Same gate as above: a closed job stays rejected whatever the new
        // rule says about its words.
        const target = isOpen && publishableWithoutReview(now) ? "auto_approved" : "rejected";
        recovered.push(
          `  ^ ${firmName.get(sourceFirm.get(l.sourceId) ?? "") ?? "?"}: ${l.title.slice(0, 62)} -> ${target}`,
        );
        if (apply) {
          await db
            .update(schema.detectedListings)
            .set({ reviewStatus: target, classification: nowWithEvidence, updatedAt: new Date() })
            .where(eq(schema.detectedListings.id, l.id));
        }
        continue;
      }

      if (newStatus && l.reviewStatus === "pending_review" && !humanDecided) {
        promoted.push(
          `  ~ ${firmName.get(sourceFirm.get(l.sourceId) ?? "") ?? "?"}: ${l.title.slice(0, 68)}`,
        );
      }

      if (apply) {
        await db
          .update(schema.detectedListings)
          .set({
            classification: nowWithEvidence,
            ...(newStatus && l.reviewStatus === "pending_review"
              ? { reviewStatus: newStatus as "auto_approved" }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.detectedListings.id, l.id));
      }
    }

    console.log(`${listings.length} listings re-classified${apply ? " and written" : " (dry run)"}`);
    console.log(`  no longer relevant: ${becameIrrelevant}`);
    console.log(`  newly relevant:     ${becameRelevant}\n`);
    console.log(`  removed from the review queue (no longer a posting): ${dequeued.length}`);
    for (const d of dequeued.slice(0, 10)) console.log(`  - ${d}`);
    console.log(`  recovered from machine rejection: ${recovered.length}`);
    for (const r of recovered.slice(0, 20)) console.log(r);
    console.log(`  pending -> auto-approved: ${promoted.length}`);
    for (const f of flips) console.log(f);
    for (const p of promoted.slice(0, 12)) console.log(p);
    if (retracted.length) {
      console.log(`\n=== ${apply ? "RETRACTED" : "WOULD RETRACT"} ${retracted.length} published posting(s) ===`);
      for (const r of retracted) console.log(`  ${r}`);
    }
  } finally {
    await opened.close();
  }
}

main();
