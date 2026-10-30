import "server-only";

/**
 * A board that used to have listings and now returns none.
 *
 * WHY THIS IS A FILE
 * ------------------
 * `http-outcome.ts` tells a vendor's "not now" from a firm's "no", and
 * `db-outcome.ts` stops our own failures being charged to a firm. This is the
 * third member of that family and the one with no HTTP signal at all: the
 * request succeeds, the status is 200, the parse runs cleanly, and the answer
 * is zero rows.
 *
 * Measured on Supabase, 20 September 2026:
 *
 *   Morgan Stanley   04:34  changed, 125 listings seen
 *   Morgan Stanley   14:54  changed,   0 listings seen
 *   Robert W. Baird  19 Sep 22:15  changed, 119 listings seen
 *   Robert W. Baird  20 Sep 15:54  no_change, 0 listings seen
 *
 * Both sources read `healthy`, `failure_count = 0`, last success minutes ago.
 * Morgan Stanley's board had started answering with a bot-check page - an
 * HTTP 200 carrying a challenge instead of a vacancy table - and 4,700 bytes
 * of that parses to zero vacancies without erroring anywhere.
 *
 * The existing health model cannot see this. Every signal it reads says the
 * check succeeded, because by its own definition it did. So a firm with 125
 * live internships becomes indistinguishable from a firm with none, which is
 * the same failure the tier and rate-limit fixes were both written to stop,
 * arriving through the one door neither of them watches.
 *
 * NOT AN ERROR, AND NOT BROKEN. A board really can empty out - a season ends,
 * a firm closes its programme - and calling that broken would degrade healthy
 * sources every autumn. This raises a flag for a person to look at, which is
 * the only honest response to "this looks like it stopped working, and it
 * might just be over".
 *
 * Sector-neutral by construction: it reads two counts and knows nothing about
 * what the firm does.
 */

/**
 * How many open listings a source must have had for a drop to zero to mean
 * anything.
 *
 * A source holding one or two listings can legitimately reach zero in a week,
 * and firing on that would make the signal noise. Five is the point at which
 * "all of them closed on the same check" stops being an ordinary Tuesday -
 * both real cases here were over a hundred.
 */
export const COLLAPSE_FLOOR = 5;

/**
 * Did this board just go from having listings to having none?
 *
 * `seenNow` is what the connector returned on this check; `openStored` is how
 * many of that source's listings were open before it ran.
 */
export function isBoardCollapse(counts: {
  seenNow: number;
  openStored: number;
  /**
   * True when the board answered 304, or its content hash was unchanged.
   *
   * A NOT-MODIFIED READ CARRIES NO LISTINGS BY DESIGN. That is the whole
   * point of the conditional request: the vendor replies "nothing changed"
   * and sends no body, so the connector returns an empty array. Reading that
   * as "the board has emptied" inverts the meaning of the most common
   * successful answer there is.
   *
   * This check shipped without the guard and immediately proved why it needs
   * one. William Blair was flagged `degraded` on 20 September 2026 with 48
   * listings open and `failure_count: 0` - and its Greenhouse board answers
   * HTTP 200 with 48 jobs and 670KB when asked directly. Nothing was wrong
   * with the firm, the board or the connector: the source simply had an
   * ETag, so the crawler asked "has this changed?", was told "no", and the
   * collapse rule read the empty body as an empty board.
   *
   * An unchanged board is the healthiest possible answer. It cannot be
   * evidence of collapse, and this returns false for it however many
   * listings are stored.
   */
  notModified?: boolean;
  /**
   * True when the connector knows it did not return the whole board.
   *
   * The same class of mistake as `notModified` above, for the same reason: an
   * empty array that carries no information about the board must not be read
   * as a board that emptied. `decideClosure` already refuses to close
   * listings on a truncated read - and it checks truncation BEFORE age,
   * because a capped board is capped on every check, so age would eventually
   * clear any bar. Health has to agree with closure or the two tell opposite
   * stories about the same read.
   *
   * The case that brought this in: a readable homepage whose render times out
   * now reports the static read it already had, flagged truncated, instead of
   * httpStatus 0 (see connectors/generic.ts). Without this guard, every one
   * of those sources that has stored listings would be marked `degraded` by a
   * read that found nothing because it never looked.
   */
  truncated?: boolean;
}): boolean {
  if (counts.notModified || counts.truncated) return false;
  return counts.seenNow === 0 && counts.openStored >= COLLAPSE_FLOOR;
}

/** What to record, in words a person reading the source list can act on. */
export function collapseMessage(openStored: number): string {
  return (
    `board returned 0 listings but ${openStored} were open before this check - ` +
    `the page may have changed, started refusing automated reads, or the programme may have closed`
  );
}
