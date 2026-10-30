import type { PublishablePosting } from "@/lib/internship-postings";
import { deadlineColumnsFromText } from "@/lib/posting-deadline";

/**
 * A detected listing, as the posting a student sees.
 *
 * THE ONE PLACE THE CRAWLER'S WORK BECOMES A POSTING, and it exists because
 * it previously wasn't one. This mapping lived as an object literal inside a
 * loop in scripts/promote-approved-listings.ts, which had two consequences:
 * nothing could test it, and a field that never got forwarded looked exactly
 * like a field the source never supplied.
 *
 * That is not hypothetical. `deadlineAt` was carried faithfully the whole way
 * down the pipeline - TalentLink parses it out of its Atom feed, Dayforce
 * reads postingExpiryTimestampUTC, Oracle reads PostingEndDate, monitor-run
 * writes it to detected_listings.deadline_at AND forwards it into
 * opening_signals - and then the promote step hard-coded:
 *
 *     deadlineStatus: "tbd",
 *     deadlineText: null,
 *     deadlineDateIso: null,
 *
 * So the last hop threw away the one thing the whole connector layer had been
 * built to get. Measured on Supabase, 22 September 2026: 110 detected
 * listings carried a deadline and not one reached internship_postings. The
 * student-visible symptom was the product contradicting itself - the Top
 * applications panel read opening_signals and counted down to 15 November,
 * the Internships tab read this column and said "Deadline TBD" for the same
 * Evercore role.
 *
 * WHAT GOES IN THE POSTING AND WHAT DOES NOT
 * ------------------------------------------
 * Everything with a destination is forwarded. `division`, `employmentType`,
 * `externalJobId` and `publishedAt` are deliberately not: internship_postings
 * has no column for them, so there is nothing to lose them INTO. If one ever
 * gains a column, it belongs here, and scripts/test/publishable.test.ts is
 * the thing that will say so.
 *
 * Nothing here infers. A connector that could not read a deadline leaves it
 * null, and a null stays null rather than becoming an estimate.
 */
export type DetectedForPublish = {
  title: string;
  location: string | null;
  descriptionRaw: string;
  applicationUrl: string | null;
  listingUrl: string;
  /** ISO, and only when the SOURCE stated one. Never inferred. */
  deadlineAt?: string | Date | null;
};

export function publishableFromDetection(
  listing: DetectedForPublish,
  classification: { recruitingCycle: number; eligibility?: { gradYears?: number[] } | null; requirementsRaw?: string | null },
  now: Date = new Date(),
): PublishablePosting {
  const deadline = resolveDeadline(listing, now);

  return {
    roleTitle: listing.title,
    location: listing.location,
    programYear: classification.recruitingCycle,
    // What the posting itself said, when it said anything. Auto-approval
    // requires a STATED eligibility, so a row reaching here should always have
    // one; the fallback covers rows classified before that rule existed.
    eligibleGradYears: classification.eligibility?.gradYears ?? [],
    deadlineStatus: deadline.status,
    deadlineText: deadline.text,
    deadlineDateIso: deadline.iso,
    descriptionFull: listing.descriptionRaw,
    // The employer's own requirements, pulled out so a student does not have
    // to find them inside several hundred words of firm boilerplate.
    requirementsFull: classification.requirementsRaw ?? null,
    sourceUrl: listing.listingUrl,
    applicationUrl: listing.applicationUrl,
    // No destination in a detection. Only a posting that publishes a named
    // contact gets these, and that is set by hand, not by the crawler.
    recruiterName: null,
    recruiterTitle: null,
    recruiterEmail: null,
    recruiterPhone: null,
  };
}

/**
 * Two sources for the deadline, in order of how directly the firm stated it.
 *
 *   1. `deadlineAt` from the connector - the source handed it over AS DATA,
 *      which is the strongest form this pipeline can get. It is the only path
 *      that works for Dayforce and Oracle, whose expiry dates are API fields
 *      and appear nowhere in the description text.
 *
 *   2. the description's own sentence - "Application Deadline:15 Nov 2026
 *      11:55 PM EST" - for connectors that fetch the text without parsing a
 *      date out of it. See lib/posting-deadline.ts for what it refuses.
 *
 * A date already past is `closed`, not `confirmed`: still the firm's date,
 * but a posting that says so should stop being offered as something to apply
 * to.
 */
function resolveDeadline(
  listing: DetectedForPublish,
  now: Date,
): { status: PublishablePosting["deadlineStatus"]; iso: string | null; text: string | null } {
  if (listing.deadlineAt) {
    const at = listing.deadlineAt instanceof Date ? listing.deadlineAt : new Date(listing.deadlineAt);
    if (!Number.isNaN(at.getTime())) {
      return {
        status: at.getTime() > now.getTime() ? "confirmed" : "closed",
        iso: at.toISOString(),
        text: null,
      };
    }
  }

  const stated = deadlineColumnsFromText(listing.descriptionRaw, now);
  if (stated) {
    return {
      status: stated.deadlineStatus,
      iso: stated.deadlineDate.toISOString(),
      text: null,
    };
  }

  return { status: "tbd", iso: null, text: null };
}
