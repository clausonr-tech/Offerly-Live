// Publishes auto-approved detected listings into internship_postings.
//
// The monitoring pipeline has always had two review outcomes: a listing the
// classifier is confident about is marked `auto_approved`, and everything else
// waits for a human in /admin/monitoring. Approving by hand calls savePosting
// and the role becomes visible to students.
//
// The auto-approved half never had that second step. 143 listings sat marked
// approved and nothing downstream could see them, so every student-facing
// surface that reads internship_postings - Discovery, tracked applications,
// the Applications section - stayed empty while the crawler reported success.
// "Approved" that publishes nothing is just a slower kind of dropped.
//
// Deliberately opens NO database connection of its own: savePosting calls
// getDb(), and a script holding its own PGlite client alongside it would put
// two connections on one data directory - the pattern that has corrupted this
// database before.
//
//   npx tsx --conditions=react-server scripts/promote-approved-listings.ts [--dry]
import { eq, isNull, and } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { detectedListings, firmMonitoringSources, firms } from "../src/db/schema";
import { notifyWatchersOfOpening } from "../src/lib/monitoring/alerts";
import { savePosting, type PublishablePosting } from "../src/lib/internship-postings";
import { publishableFromDetection } from "@/lib/monitoring/publishable";
import { blockedLanguageError } from "../src/lib/content-limits";
import type { FirmProgramCategory } from "@/lib/firm-metadata";
import { hasPublishableUrls, type Classification } from "../src/lib/monitoring/classify";

const dry = process.argv.includes("--dry");

/**
 * Which graduation years a programme is open to.
 *
 * The admin form asks a human for this; an automatic promotion has to derive
 * it. A Summer 2027 internship is worked the summer before final year, so its
 * candidates graduate in 2028 - but "summer associate" intakes routinely take
 * the graduating year itself, and off-cycle roles take both. Both years are
 * listed rather than picking one, because being slightly wide here costs a
 * student an extra row to skim, while being wrong costs them the posting
 * entirely: `getRelevantPostings` filters on this column.
 */
/**
 * No fallback. A posting that did not say who may apply is published with an
 * EMPTY eligibility list.
 *
 * There was a fallback here returning `[programYear + 1]`, and it had to go:
 * it is a guess about a specific employer, written into a field students
 * filter on, and it reads afterwards as something the firm said. Harris
 * Williams' 12,000-word posting states only that roles are "filled by recent
 * university / college graduates" - inventing "graduating 2028" from that is
 * exactly the fabrication this pipeline exists to avoid.
 *
 * Empty is safe because getRelevantPostings treats an empty list as "the
 * posting did not say", which restricts nobody, rather than as "nobody is
 * eligible", which would hide it from everyone.
 */

async function main() {
  const db = await getDb();

  /**
   * Withhold a row, with its reason recorded. One spelling, every branch.
   *
   * This was `hold()`, and it wrote `pending_review`. Each caller's comment
   * justified that as keeping the row "visible and countable in the review
   * queue" - the premise the queue's removal rests on being false. Measured
   * 11 October 2026: `reviewed_by` was NULL on all 21,716 rows, so nothing
   * held here had ever been looked at, and 278 rows were still carrying the
   * status with the most recent write that morning. `monitor-run.ts` routes
   * published-or-rejected and `reviewStatusAfterReread` was narrowed to match;
   * this step was the one that had not been.
   *
   * The REASON is the whole difference between the two states. A rejection
   * that states why is recoverable - `reclassify-listings.ts` re-decides it on
   * a rule change, and `adjudicate-rejections.ts` reads the reason to find
   * candidates - and a queued row nobody reads is not. Merged into the stored
   * classification rather than replacing it, because the evidence the
   * classifier recorded is what a later pass re-judges from.
   */
  const withhold = (id: string, classification: unknown, reason: string) =>
    db
      .update(detectedListings)
      .set({
        reviewStatus: "rejected",
        classification: {
          ...((classification as Record<string, unknown> | null) ?? {}),
          reasonForUncertainty: reason,
        },
        updatedAt: new Date(),
      })
      .where(eq(detectedListings.id, id));

  const rows = await db
    .select({ listing: detectedListings, source: firmMonitoringSources, firm: firms })
    .from(detectedListings)
    .innerJoin(firmMonitoringSources, eq(detectedListings.sourceId, firmMonitoringSources.id))
    .innerJoin(firms, eq(firms.id, firmMonitoringSources.firmId))
    .where(
      and(
        eq(detectedListings.reviewStatus, "auto_approved"),
        isNull(detectedListings.promotedPostingId),
        /**
         * AND THE JOB IS STILL ON THE BOARD.
         *
         * This selected on review status and the absent posting link alone, so
         * a listing `decideClosure` had already marked `closed` was still
         * publishable. Measured 12 October 2026: 0 rows qualified, so nothing
         * had leaked - the hole was latent, and what would open it is a rule
         * change: `reclassify-listings.ts` re-approves an old rejection without
         * consulting `status`, and hands exactly this query a closed listing
         * with a null posting link.
         *
         * Publishing one undoes the retirement pass directly - 416 active
         * postings were found backed by a closed listing, real internships at
         * PJT Partners, Citigroup and Nomura that had gone from the firms' own
         * boards. Re-publishing a closed job is the one failure this system is
         * least allowed.
         */
        eq(detectedListings.status, "open"),
      ),
    );

  console.log(`${rows.length} auto-approved listings awaiting publication\n`);

  let published = 0;
  let skipped = 0;
  let alerted = 0;
  // Counted separately so "skipped" stops hiding it. This number is the
  // backlog the cycle-less sectors are building up, and it belongs in the
  // run's own summary line rather than in a database query nobody runs.
  let withheldNoCycle = 0;

  for (const { listing, source, firm } of rows) {
    const c = listing.classification as Classification | null;
    /**
     * A missing cycle is now NORMAL, and must not be dropped in silence.
     *
     * This branch used to read "auto-approval already required both of these,
     * so a row missing one is a data inconsistency" and `continue` past it.
     * That premise died on 20 September 2026, when auto-approval stopped
     * requiring a recruiting cycle - the fix that let every sector which does
     * not date its job titles reach students at all. Banks write "2027
     * Investment Banking Summer Analyst"; a hedge fund writes "Quantitative
     * Researcher Intern" and names no year anywhere.
     *
     * So the sectors that fix was FOR are exactly the ones that arrive here
     * without a cycle, and they were being auto-approved and then silently
     * skipped, every hour, forever. Measured before this change: 41 listings
     * sat auto-approved and unpublished - 28 investment banking, 8 private
     * equity, 4 hedge fund, 1 real estate - and every single one of them was
     * stuck for this reason, with not one cycle-bearing row among them. Going
     * forward it is 94% of private equity listings and 92% of hedge fund ones.
     *
     * `internship_postings.program_year` is NOT NULL and students see it as
     * "Summer 2027" and filter on it, so this cannot be fixed by inventing a
     * year here - that is the fabrication `deriveRecruitingCycle` and the
     * eligibility note above both exist to refuse. Held for a human instead,
     * exactly as the blocked-language branch below holds: visible and
     * countable in the review queue, rather than invisible in a state that
     * looks healthy on every dashboard.
     */
    if (!c?.recruitingCycle) {
      // "recruiting-cycle" verbatim: adjudicate-rejections.ts selects its
      // cycle candidates with `reasonForUncertainty?.includes(...)`, so the
      // phrase is an interface and this is the row that script exists for.
      if (!dry)
        await withhold(
          listing.id,
          listing.classification,
          "no recruiting-cycle year could be read from the posting",
        );
      console.log(
        `  ${dry ? "WOULD WITHHOLD" : "WITHHELD"} ${listing.title.slice(0, 60)} - no recruiting cycle; needs a programme year`,
      );
      withheldNoCycle++;
      skipped++;
      continue;
    }

    /**
     * The blocked-language check, on text this system did not write.
     *
     * The project rule is that the check runs before anything is "shown to
     * another person", and this is the one path where crawled text reaches
     * students with no human in between: an admin approving by hand goes
     * through approveListing, which checks; auto-approved rows come straight
     * through here and did not.
     *
     * Not a hypothetical distinction. A title or description is a firm's own
     * copy, fetched from a page we do not control, and a source that gets
     * defaced or a board that carries an unrelated posting would otherwise
     * publish it verbatim. Withheld with its reason recorded rather than
     * dropped - the
     * check is a reason to look, not a verdict.
     */
    const blocked = blockedLanguageError([
      ["Title", listing.title],
      ["Description", listing.descriptionRaw],
    ]);
    if (blocked) {
      // Guarded by `dry` like the publish below. It was not, so `--dry` - the
      // command you run to find out what WOULD happen - changed rows as a
      // side effect of asking.
      //
      // The reason records that the check fired, never the matched term: this
      // string is stored and read back by other scripts, and repeating a slur
      // into the database is the thing content-limits exists to prevent.
      if (!dry)
        await withhold(
          listing.id,
          listing.classification,
          "blocked language in the firm's own copy - see content-limits",
        );
      console.log(`  ${dry ? "WOULD WITHHOLD" : "WITHHELD"} ${listing.title.slice(0, 60)} - ${blocked}`);
      skipped++;
      continue;
    }

    /**
     * The URLs, on the same terms as the language check above and for the
     * same reason.
     *
     * The classifier now refuses to auto-approve a listing whose URLs are not
     * public http(s) (see `hasPublishableUrls`), but rows that were
     * auto-approved BEFORE that rule existed are sitting in this table
     * already, and this is the step that turns one into an href on a
     * student's screen. Held for a human rather than dropped: an unreadable
     * link is a reason to look at the posting, not evidence that the opening
     * is fake.
     */
    if (!hasPublishableUrls({ listingUrl: listing.listingUrl, applicationUrl: listing.applicationUrl })) {
      if (!dry)
        await withhold(
          listing.id,
          listing.classification,
          "no public http(s) address a student could open",
        );
      console.log(
        `  ${dry ? "WOULD WITHHOLD" : "WITHHELD"} ${listing.title.slice(0, 60)} - link is not a public http(s) URL: ${JSON.stringify(listing.applicationUrl ?? listing.listingUrl)?.slice(0, 80)}`,
      );
      skipped++;
      continue;
    }

    const category = (c.sector ?? source.sectorCategory) as FirmProgramCategory;
    /**
     * Built by lib/monitoring/publishable.ts, not inline here.
     *
     * This used to be an object literal in this loop, and the comment sitting
     * where the deadline is now read said the connectors' closing dates were
     * "not carried onto detected_listings" - which had stopped being true.
     * detected_listings.deadline_at is written on every run by monitor-run.ts;
     * only this step never looked at it. 110 listings carried a deadline the
     * whole way here and had it discarded at the last hop, which is what put
     * "Deadline TBD" on the Internships tab for a role the panel beside it was
     * counting down to.
     *
     * A mapping nothing can test is a mapping that loses a field quietly. That
     * one is unit-tested in scripts/test/publishable.test.ts.
     */
    const posting: PublishablePosting = publishableFromDetection(
      {
        title: listing.title,
        location: listing.location,
        descriptionRaw: listing.descriptionRaw,
        applicationUrl: listing.applicationUrl,
        listingUrl: listing.listingUrl,
        deadlineAt: listing.deadlineAt,
      },
      { recruitingCycle: c.recruitingCycle, eligibility: c.eligibility, requirementsRaw: c.requirementsRaw },
    );

    if (dry) {
      console.log(`  would publish  ${listing.title.slice(0, 70)}`);
      published++;
      continue;
    }

    try {
      const outcome = await savePosting(source.firmId, [category], posting);
      // No usable title, or a careers-site placeholder (see isNamedRoleTitle
      // and isPlaceholderTitle): nothing was stored, so there is no posting
      // to link or announce.
      if (outcome === "skipped") {
        console.log(`  skipped (no usable title, or a placeholder)  ${JSON.stringify(listing.title)}  ${listing.listingUrl}`);
        skipped++;
        continue;
      }
      const saved = await db.query.internshipPostings.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(
            eqOp(t.firmId, source.firmId),
            eqOp(t.roleTitle, listing.title),
            eqOp(t.programYear, c.recruitingCycle!),
          ),
        columns: { id: true },
      });
      await db
        .update(detectedListings)
        .set({ promotedPostingId: saved?.id ?? null, updatedAt: new Date() })
        .where(eq(detectedListings.id, listing.id));

      /**
       * Tell the students watching this firm.
       *
       * Until now this ran nowhere but the admin approval action, so a posting
       * the crawler published reached a student only if they happened to open
       * Discovery and scroll to it. The pipeline diagram in the handoff drew an
       * arrow to `user_alerts` from here that did not exist.
       *
       * Only on "inserted". `savePosting` returns "updated" when it has
       * re-published a posting already on file - a description that changed, a
       * deadline that firmed up - and a student does not want "just opened"
       * twice for the same role. `notifyWatchersOfOpening` is idempotent on
       * (userId, postingId, kind) as well, so this is belt and braces, but the
       * belt is the part that carries the meaning.
       *
       * In-app rows only: this writes `user_alerts` and sends no email.
       */
      if (outcome === "inserted" && saved?.id) {
        const notified = await notifyWatchersOfOpening(db, {
          postingId: saved.id,
          firmId: source.firmId,
          firmName: firm.name,
          roleTitle: posting.roleTitle,
        });
        if (notified > 0) {
          alerted += notified;
          console.log(`  alerted ${notified} watcher(s) of ${firm.name} · ${posting.roleTitle.slice(0, 50)}`);
        }
      }

      published++;
    } catch (err) {
      console.log(`  FAILED ${listing.title.slice(0, 50)}: ${(err as Error).message.slice(0, 80)}`);
      skipped++;
    }
  }

  console.log(
    `\n${dry ? "would publish" : "published"} ${published}, skipped ${skipped}` +
      (withheldNoCycle ? `, ${withheldNoCycle} withheld, rejected with a reason (no recruiting cycle)` : "") +
      (dry ? "" : `, alerted ${alerted} watcher(s)`),
  );
}

main().then(
  () => {
    // getDb() is a process-level singleton with no close() exposed, so the
    // PGlite handle it holds keeps the event loop alive and the script hangs
    // after its final line - work finished, process never exits, which reads
    // exactly like a hang mid-run. Scripts that own their own client call
    // client.close() here instead; this family has to exit explicitly.
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
