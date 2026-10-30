import "server-only";

/**
 * Telling "no" apart from "not now".
 *
 * WHY THIS IS A FILE
 * ------------------
 * The probe learned this lesson and the crawler never did. `ats-probe.ts` has
 * carried `isInconclusive` since Personio answered a bogus token with 429 and
 * the rule "any status that is not 200 means no board" turned a rate limit
 * into the assertion that a firm has no board at all. Its own comment calls
 * that "the worse direction of two bad ones - the firm is written off with a
 * stated reason nobody will revisit".
 *
 * monitor-run.ts had the identical bug, against real firms, and nobody had
 * connected the two. Every status at or above 400 went to `recordFailure`,
 * which increments failureCount, degrades the source to `degraded` at 2 and
 * `broken` at 5, and backs the next check off exponentially to a day.
 *
 * Measured 20 September 2026, across every sector rather than just investment
 * banking: all thirteen Workable sources - nine hedge funds, three venture
 * capital firms and one real estate manager - answered 429. They share one
 * host, `apply.workable.com`, so the crawl was throttling itself. Each had
 * already logged its first failure; five hourly runs would have marked every
 * one of them broken and tiered them out of the schedule.
 *
 * A throttle is not an answer about a firm. It is the vendor asking us to
 * slow down, and the only correct response is to slow down.
 */

/**
 * Statuses that mean "we did not get an answer", not "no".
 *
 * - 429 is the vendor throttling us.
 * - 408 is our own request timing out.
 * - 5xx is the vendor being broken.
 * - 0 is how every connector reports a read it could not complete at all.
 *
 * Every one of these is certain to appear across 188 sources checked hourly,
 * and not one of them says anything about whether a firm has postings.
 */
export function isInconclusive(status: number): boolean {
  return status === 0 || status === 403 || status === 408 || status === 429 || status >= 500;
}

/**
 * Why 403 joined the list, on 20 September 2026.
 *
 * A 403 is the server refusing to serve US, and it says nothing whatever
 * about whether the firm has internships - which is the only question this
 * crawler asks. It was charged as a failure, which meant two real investment
 * banks were three strikes from being marked broken and tiered out of the
 * schedule:
 *
 *   Stephens Inc       2 failures, HTTP 403 on every check
 *   Cascadia Capital   2 failures, HTTP 403 on every check
 *
 * Both sites' robots.txt PERMIT the careers page. Stephens disallows only
 * /cpresources/, /vendor/, /.env and /cache/; Cascadia's is a bare
 * "Disallow:" - allow everything. So the site's own stated policy lets us
 * read it, and an automated defence in front of it is refusing anyway. That
 * is a fact about their CDN, not about their graduate programme.
 *
 * The honest response is the same as for a 429: come back later, and do not
 * write the firm off. The cost of being wrong in this direction is one extra
 * request against a URL that may be permanently forbidden. The cost of being
 * wrong in the other direction is a real bank with real internships dropped
 * out of the crawl with a stated reason nobody revisits.
 *
 * NOT an invitation to get around the block. Nothing in this repository
 * rotates a user agent, spoofs a fingerprint or routes around an access
 * control, and this change deliberately does not start: it identifies itself
 * as OfferlyMonitor, honours Retry-After, and respects robots.txt. A 403 that
 * keeps coming back means the board has to be reached another way - a
 * different address for the same firm, which discover-boards.ts looks for -
 * or not at all.
 */

/**
 * How long the vendor asked us to wait, in milliseconds.
 *
 * `Retry-After` comes in two shapes - a number of seconds, or an HTTP date -
 * and both appear in the wild. A vendor that troubles to tell us when to come
 * back has given us better information than any backoff we could invent, so
 * it is worth reading both.
 *
 * Clamped to twelve hours, which is longer than it looks like it should be
 * because a real vendor really did ask for more. Measured 20 September 2026,
 * every endpoint and every user agent on apply.workable.com:
 *
 *   HTTP 429   Retry-After: 32615     (nine hours)
 *
 * An hour's cap would have meant retrying nine times inside a window the
 * vendor had already closed, and each retry is another request against a
 * limit we are already over. Honouring the number is both politer and the
 * faster route back: ignoring it is how a temporary block becomes a
 * permanent one.
 *
 * Still clamped, because a header asking for a week is a ban or a mistake and
 * neither should drop a source out of the schedule entirely.
 */
export const MAX_RETRY_AFTER_MS = 12 * 60 * 60_000;

export function retryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const text = header.trim();
  if (!text) return null;

  // The numeric form: a count of seconds.
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Math.min(ms, MAX_RETRY_AFTER_MS);
  }

  /**
   * A malformed NUMBER is not a date, and must not be treated as one.
   *
   * `Date.parse` accepts "-5" and "1.5" and resolves both to moments in the
   * past, which this function then reported as a zero wait - "retry now".
   * Against a vendor that has just thrown 429, retrying immediately is the
   * worst available answer and the exact behaviour the caller wanted to avoid
   * by asking. Anything number-shaped that was not a clean count of seconds
   * is a broken header, and a broken header means "fall back to our own
   * backoff", not "go again".
   */
  if (/^[-+]?[\d.]+$/.test(text)) return null;

  // The date form: an absolute moment to come back at. HTTP dates always
  // carry a weekday and month name, so requiring a letter keeps the numeric
  // shapes above from reaching here at all.
  if (!/[a-z]/i.test(text)) return null;

  const when = Date.parse(text);
  if (Number.isNaN(when)) return null;
  const ms = when - Date.now();
  // A date already in the past means "now"; negative waits are not waits.
  if (ms <= 0) return 0;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * How many no-answers in a row are treated as a bad moment rather than a
 * pattern.
 *
 * Inside this window the retry stays short, which is the whole point of the
 * 20 September change: a vendor throttling us for a few minutes must not cost
 * the firm a day of silence. Past it, "we have asked this board eleven times
 * and it has never once answered" is a different fact and gets a different
 * interval.
 */
export const INCONCLUSIVE_PATIENCE = 3;

/** The slowest this will ever come back. One day. */
export const INCONCLUSIVE_MAX_MS = 24 * 60 * 60_000;

/**
 * When to come back after an inconclusive read, absent a Retry-After.
 *
 * SHORT AT FIRST, THEN NOT
 * ------------------------
 * The original version of this was exponential to 24 hours, which is right
 * for a broken source and wrong for a busy one. It was replaced with a flat
 * 15 minutes - right for a busy source and wrong for a dead one, and it is
 * what a dead one got, because the only counter in the system was
 * `failureCount` and the inconclusive path deliberately never increments it.
 * `inconclusiveRetryMs(failureCount + 1)` was therefore always called with 1,
 * the `Math.min(4, ...)` growth never fired, and a board that answers nothing
 * was asked every 15 minutes indefinitely.
 *
 * Measured 11 October 2026: 351 sources had never produced a successful read
 * and had spent 12,902 check runs between them, 45% of the whole crawl.
 *
 * So both shapes, in the order the evidence arrives: flat and short while a
 * throttle might still clear, then doubling to a daily check once the source
 * has had every chance. `consecutiveInconclusive` resets to zero on the first
 * good read, so a vendor that recovers never reaches the slow end - which is
 * the Workable case this function was rewritten for in the first place.
 *
 * Jittered, because thirteen sources on one host all retrying at the same
 * instant is how the throttle happened.
 */
export function inconclusiveRetryMs(attempt: number, random: () => number = Math.random): number {
  const base = 15 * 60_000; // a quarter of the fastest tier's interval
  const n = Math.max(1, Math.floor(attempt));
  const grown =
    n <= INCONCLUSIVE_PATIENCE
      ? base * n
      : Math.min(
          INCONCLUSIVE_MAX_MS,
          base * INCONCLUSIVE_PATIENCE * 2 ** (n - INCONCLUSIVE_PATIENCE),
        );
  const jitter = 0.5 + random(); // 0.5x to 1.5x
  // The cap is a cap, not a target the jitter may exceed.
  return Math.min(INCONCLUSIVE_MAX_MS, Math.round(grown * jitter));
}

/**
 * How long to wait when the vendor has also named a time.
 *
 * Retry-After wins while we are still being patient - it is the vendor's own
 * statement about its own load, and arguing with it is how you get blocked.
 * Past the patience window it becomes a FLOOR instead: a board that answers
 * "try again in 30 seconds" on every one of two hundred attempts is not
 * telling us to keep asking every 30 seconds forever, and honouring it
 * literally is how a dead source pins the crawl to its fastest loop.
 *
 * Waiting longer than asked cannot offend anybody. Waiting less could.
 */
export function inconclusiveWaitMs(
  attempt: number,
  retryAfterMs: number | null | undefined,
  random: () => number = Math.random,
): number {
  const ours = inconclusiveRetryMs(attempt, random);
  if (retryAfterMs == null) return ours;
  if (attempt <= INCONCLUSIVE_PATIENCE) return retryAfterMs;
  return Math.max(retryAfterMs, ours);
}

/**
 * The message stored for an inconclusive read.
 *
 * The prefix and suffix are unchanged on purpose: `crawl-status.ts`, the audit
 * scripts and three weeks of existing rows all match on
 * `inconclusive: HTTP n - not an answer about this firm`, and a reason is an
 * addition to that sentence rather than a replacement for it.
 *
 * Only a value from the closed vocabulary is ever interpolated. Error messages
 * in this codebase carry hostnames and resolved IP addresses, and a message
 * from a third-party page is untrusted text.
 */
export function inconclusiveMessage(status: number, reason?: string | null): string {
  const why = reason ? ` (${reason})` : "";
  return `inconclusive: HTTP ${status}${why} - not an answer about this firm`;
}
