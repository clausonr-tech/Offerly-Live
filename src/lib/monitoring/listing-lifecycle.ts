import "server-only";
import { TITLE_INTERNSHIP_PATTERN } from "./classify";

/**
 * When a stored listing may be closed, and when it may be re-read.
 *
 * Extracted from monitor-run.ts because both decisions were inline in a
 * function that needs a database, which meant neither could be tested - and
 * both were wrong in ways that cost real postings:
 *
 *   - A listing absent from a TRUNCATED read was closed as though it had
 *     ended. The generic connector capped at 30 candidates and iCIMS at 5
 *     pages, so any board past those sizes had its tail marked closed on
 *     every check.
 *   - A listing still missing its description was only re-queued on checks
 *     where the board had CHANGED, because the re-queue sat behind the
 *     unchanged-hash short circuit. On a quiet board that is never, so a
 *     posting confirmed on every check was enriched on none.
 *
 * Both are now decisions with names, and both have tests.
 */

export type StoredListingState = {
  externalJobId: string | null;
  status: string;
  lastConfirmedAt: Date;
  title: string;
  descriptionRaw: string;
};

export type CloseDecision = { close: boolean; reason: string };

/**
 * Has this posting really ended, or did we just not see it?
 *
 * The distinction is the whole function. "Absent from this fetch" is evidence
 * of an ending only when the fetch could have contained it, and there are two
 * ways it could not: the read was cut short at a ceiling, or the posting has
 * not been missing long enough to rule out a single bad check.
 *
 * Recording a live internship as closed is worse than not seeing it, because
 * a closed row looks like an answer and nothing goes looking for it again.
 */
export function decideClosure(
  listing: StoredListingState,
  seenKeys: ReadonlySet<string>,
  options: { truncated: boolean; fetchFailed?: boolean; intervalMs: number; now?: Date },
): CloseDecision {
  if (listing.status !== "open") return { close: false, reason: "not open" };
  if (seenKeys.has(listing.externalJobId ?? "")) {
    return { close: false, reason: "seen in this fetch" };
  }

  /**
   * The read did not succeed, so there was no board to be absent from.
   *
   * Connectors report an unreadable source as `httpStatus: 0` with an empty
   * listing array - a render timeout, a page that never settles, a DNS
   * failure, or robots.txt newly disallowing the path. monitor-run's error
   * branch only catches `>= 400`, so a zero fell through to the diff as a
   * board that had simply emptied. Two consecutive render timeouts on an
   * hourly source clear the grace period below, and the entire board is
   * recorded as closed.
   *
   * An empty result from a failed fetch is not evidence about any posting.
   */
  if (options.fetchFailed) {
    return { close: false, reason: "fetch failed - no board to be absent from" };
  }

  /**
   * The read had a ceiling, so absence proves nothing.
   *
   * Checked before the age test rather than after, because age does not
   * rescue it: a board that is over the cap is over it on EVERY check, so the
   * tail stays missing indefinitely and would eventually clear any age bar.
   * That is precisely how a permanent truncation turns into a permanent
   * wrong answer.
   */
  if (options.truncated) {
    return { close: false, reason: "read was truncated - absence is not evidence of closure" };
  }

  const now = options.now ?? new Date();
  const missingFor = now.getTime() - listing.lastConfirmedAt.getTime();
  // One and a half cycles, so a single outage cannot masquerade as a closed
  // posting.
  if (missingFor <= options.intervalMs * 1.5) {
    return { close: false, reason: "missing for less than one full check cycle" };
  }

  return { close: true, reason: `absent for ${Math.round(missingFor / 60000)} minutes` };
}

/**
 * Is this listing's description too thin to classify on?
 *
 * The same test in both directions: it decides whether a connector's `enrich`
 * should run, and whether a stored listing is worth re-reading later. They
 * have to agree - a listing judged thin by one and full by the other either
 * never gets enriched or gets re-fetched forever.
 */
export function isThinDescription(description: string, title: string): boolean {
  const trimmed = description.trim();
  return trimmed.length < 120 || trimmed === title.trim();
}

/**
 * Should a stored listing be put back through enrichment?
 *
 * Restricted to titles that read as an internship, because the description of
 * a compliance officer role is a request we would spend to reject it either
 * way. This is the "go and look again" step, and it costs nothing once the
 * listing has real text, because then `isThinDescription` stops matching.
 */
/**
 * Is there anything here a human could actually decide?
 *
 * A listing that the board no longer lists AND whose description we never
 * managed to read is not a hard case - it is an unanswerable one. There is no
 * text to read and no live posting to go and look at, so a reviewer can only
 * skip it, every time they open the queue.
 *
 * ONE DEFINITION, because two steps disagreed about it. `monitor-run` retires
 * such a listing from the queue when it closes it, and
 * `reclassify-listings` recovered it straight back: its rule is that "a
 * MACHINE rejection is not a decision, and has to be revisitable", which is
 * right for a rejection that a fixed rule might overturn, and wrong for a row
 * no rule can ever speak to. Measured 20 September 2026: retiring 46 of
 * these, then running a reclassify pass, put all 46 back.
 *
 * Not the same as "rejected". A rejected listing with a description stays
 * revisitable, because a changed rule really can overturn it and a human
 * really can read it. This is narrower: closed, and never readable.
 */
export function isUnreviewable(listing: {
  status: string;
  title: string;
  descriptionRaw: string;
}): boolean {
  return listing.status === "closed" && isThinDescription(listing.descriptionRaw, listing.title);
}

/**
 * How many detail fetches one listing may consume before it is left alone.
 *
 * Five, because the cap exists to stop unbounded re-fetching rather than to
 * ration a scarce resource: a listing whose detail page has served nothing
 * useful five separate times is not going to start, and five attempts against
 * a board checked hourly is a few hours rather than the 38 days one listing
 * actually ran for.
 *
 * What it replaced, and what that cost. Measured 11 October 2026: 233 open
 * listings across 91 sources were thin AND internship-titled, so they were
 * re-fetched on EVERY check with nothing to stop them - HSBC (US) had 7
 * re-read for 38 days, Evercore 17 for 28. At up to MAX_DETAIL_FETCHES (25)
 * per check and DETAIL_GAP_MS (700ms) between them, that is 17 seconds of a
 * source's check spent re-reading pages that had already refused to answer.
 * The first bound was a seven-day window, which measured the wrong thing: see
 * `shouldRetryEnrichment`.
 */
export const MAX_ENRICHMENT_ATTEMPTS = Number(
  process.env.OFFERLY_MAX_ENRICHMENT_ATTEMPTS ?? 5,
);

export function shouldRetryEnrichment(
  listing: {
    title: string;
    descriptionRaw: string;
    /**
     * Detail fetches already spent on this listing. Optional so a caller
     * testing the thin/title rule alone need not invent one; absent counts as
     * zero, which keeps the original always-retry behaviour.
     */
    enrichmentAttempts?: number | null;
  },
): boolean {
  if (!isThinDescription(listing.descriptionRaw, listing.title)) return false;
  if (!TITLE_INTERNSHIP_PATTERN.test(listing.title)) return false;

  /**
   * BOUNDED BY ATTEMPTS SPENT, NOT BY THE CALENDAR.
   *
   * This read `now - firstDetectedAt > 7 days`, and that measured the wrong
   * thing. A connector's per-check detail cap means a busy board cannot enrich
   * everything in one pass, so a listing can sit for a fortnight without ever
   * having been TRIED - and the clock gave up on it exactly as if its detail
   * page had failed. A listing with no description cannot be published, so
   * ageing out an untried one makes it invisible permanently.
   *
   * An attempt count bounds the waste the window was added for - 233 listings
   * across 91 sources re-fetched on every check indefinitely, HSBC's for 38
   * days - and spends those attempts only on listings that actually got one.
   */
  if ((listing.enrichmentAttempts ?? 0) >= MAX_ENRICHMENT_ATTEMPTS) return false;
  return true;
}

/**
 * Does anything still stand behind this posting?
 *
 * WHY IT IS A FUNCTION. Nothing propagated a closed listing to the posting it
 * had put in front of a student: `decideClosure` marked the listing `closed`
 * and `internship_postings.is_active` stayed true, and the only writers of
 * `is_active = false` were the off-profession retirement and a firm taking
 * down its own post. `isRealPosting` does not catch it - it judges the title,
 * the description and the deadline, never whether the listing is still open -
 * and no student-facing query joins listing status. Measured 12 October 2026:
 * 416 active crawler postings were backed by a closed listing, real
 * internships at PJT Partners, Citigroup and Nomura among them, every one gone
 * from the firm's own board and still shown as live.
 *
 * WHY IT TAKES `closedNow` RATHER THAN READING STATUS ALONE. One vacancy can
 * be promoted from two listings - the same role seen twice on a board, or
 * through two sources for one firm - so a posting is only unbacked when NO
 * listing for it is still open. Asked per listing in the middle of the closure
 * loop that was order-dependent and wrong: each iteration read the other
 * row's pre-pass snapshot, where it was still `open`, so when both closed in
 * the same pass each deferred to the other and the posting was never taken
 * down. The pass's own closures have to be part of the question.
 */
export function postingStillBacked(
  postingId: string,
  listings: readonly { id: string; promotedPostingId: string | null; status: string }[],
  closedNow: ReadonlySet<string>,
): boolean {
  return listings.some(
    (l) => l.promotedPostingId === postingId && l.status === "open" && !closedNow.has(l.id),
  );
}
