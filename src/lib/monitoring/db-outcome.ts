import "server-only";

/**
 * Telling "the firm's board said no" apart from "our own database fell over".
 *
 * WHY THIS IS A FILE
 * ------------------
 * `http-outcome.ts` exists because a vendor's 429 was being charged to the
 * firm, and its own note calls that "the worse direction of two bad ones - the
 * firm is written off with a stated reason nobody will revisit". This is the
 * identical mistake one layer further in, and it is the one that defeats that
 * fix from the outside.
 *
 * The 429 path in `monitor-run.ts` says "not counted as a failure" and then
 * writes `next_check_at` to schedule the polite retry. That write is inside
 * the same `try` as everything else, so when the write itself fails, the catch
 * calls `recordFailure` - which increments failureCount, degrades the source
 * at 2 and marks it broken at 5. The source was promised a reprieve and
 * penalised because the sentence recording the reprieve did not land.
 *
 * Measured in /tmp/offerly-crawl.log, the hourly run of 20 September 2026:
 * seven queries failed in a single crawl - three of them that exact
 * `next_check_at` write, two reads of `detected_listings`, and two writes of a
 * classification, one of which was an `auto_approved` Morgan Stanley posting
 * whose result was simply lost. None of the seven says anything about whether
 * a firm has postings.
 *
 * Nothing here is sector-specific, and that is the point: a database wobble
 * lands on whichever sources happen to be in the batch, so the sectors with
 * the fewest sources are the ones a wrongly-charged failure can silently
 * empty out.
 */

/**
 * A SQLSTATE code, as every postgres driver attaches to a real database error.
 *
 * Five characters, digits and capitals - "08006" for a broken connection,
 * "57014" for a cancelled statement. Checked by shape rather than by listing
 * codes, because the question here is only "did this come from postgres", and
 * a list would have to grow every time a new failure mode appeared.
 */
function carriesSqlState(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

/** Connection-level failures, which never reach a SQLSTATE at all. */
const TRANSPORT_FAILURE =
  /\b(CONNECT_TIMEOUT|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECTION_DESTROYED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b/;

/**
 * Did OUR database fail, rather than the source?
 *
 * Deliberately CONSERVATIVE. Anything that cannot be positively identified as
 * ours falls through and is charged to the source exactly as before, because
 * the two errors cost very different things: wrongly sparing a genuinely
 * broken source costs one extra check next cycle, while wrongly blaming a
 * healthy one is how a real firm with real openings gets written off and
 * tiered out of the schedule.
 */
export function isDatabaseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Drizzle wraps every query it runs with this exact prefix, and puts the
  // driver's own error in `cause`.
  if (err.message.startsWith("Failed query:")) return true;
  if (carriesSqlState(err) || carriesSqlState(err.cause)) return true;
  const causeText = err.cause instanceof Error ? err.cause.message : "";
  return TRANSPORT_FAILURE.test(`${err.message} ${causeText}`);
}

/**
 * The error text, including the part that actually says what went wrong.
 *
 * Drizzle's `message` is `Failed query: <sql>\nparams: <every bound value>`,
 * and the real reason - the timeout, the dropped connection, the constraint -
 * is in `cause`. Logging `err.message` alone is why seven failed writes on
 * 20 September 2026 recorded the SQL that failed and not one hint of why.
 *
 * The params are dropped rather than printed. One of those log lines was a
 * 4,000-character job description and a full classification JSON blob pasted
 * into /tmp/offerly-crawl.log, which is both unreadable and a copy of posting
 * text sitting in a world-readable file.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const head = err.message.split("\nparams:")[0].trim();
  const cause = err.cause;
  const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : null;
  return causeText && causeText !== head ? `${head} [cause: ${causeText}]` : head;
}
