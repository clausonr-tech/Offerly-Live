// A board that used to have listings and now returns none.
//
// The third member of the family with http-outcome and db-outcome, and the
// one with no HTTP signal at all: the request succeeds, the status is 200,
// the parse runs cleanly, and the answer is zero rows.
//
// Measured on Supabase, 20 September 2026. Morgan Stanley's board went from
// 125 listings at 04:34 to 0 at 14:54, because it had started answering with
// a bot-check page - 4,700 bytes of challenge that parses to zero vacancies
// without erroring. Robert W. Baird went from 119 to 0 the same way. Both
// sources read healthy, failure_count 0, last success minutes earlier.
//
// Nothing here is sector-specific, which is the point: it reads two counts
// and knows nothing about what the firm does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isBoardCollapse, collapseMessage, COLLAPSE_FLOOR } from "../../src/lib/monitoring/board-collapse";

test("a full board going to zero is a collapse", () => {
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: 125 }), true);
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: 119 }), true);
});

test("a board still returning listings is not a collapse", () => {
  assert.equal(isBoardCollapse({ seenNow: 125, openStored: 125 }), false);
  // Even a big drop is not a collapse while something still comes back: a
  // board shedding roles at the end of a season is doing its job.
  assert.equal(isBoardCollapse({ seenNow: 3, openStored: 125 }), false);
});

test("a source that never had listings is not collapsing", () => {
  // The 29 sources whose careers URL is not a job board have always returned
  // zero. That is a different problem, with a different fix, and firing here
  // would bury the real signal under them.
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: 0 }), false);
});

test("a handful of listings reaching zero is ordinary", () => {
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: COLLAPSE_FLOOR - 1 }), false);
});

test("the floor itself counts", () => {
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: COLLAPSE_FLOOR }), true);
});

test("the message says what was lost and offers the innocent explanation", () => {
  const m = collapseMessage(125);
  assert.match(m, /125/);
  // A board really can empty out, and the message must not assert a fault.
  assert.match(m, /programme may have closed/);
});

// ------------------------------------------- an unchanged board is not empty
//
// The guard this rule shipped without, and immediately needed.
//
// A not-modified read carries NO listings by design: the crawler sends an
// ETag, the vendor replies "nothing changed" and sends no body, and the
// connector returns an empty array. Reading that as "the board has emptied"
// inverts the meaning of the most common successful answer there is.
//
// Measured 20 September 2026: William Blair was flagged `degraded` with 48
// listings open and failure_count 0. Its Greenhouse board answers HTTP 200
// with 48 jobs and 670KB when asked directly - nothing was wrong with the
// firm, the board, or the connector. The source simply had an ETag.

test("an unchanged board is never a collapse, however many are stored", () => {
  for (const openStored of [5, 48, 125, 1000]) {
    assert.equal(
      isBoardCollapse({ seenNow: 0, openStored, notModified: true }),
      false,
      `${openStored} stored`,
    );
  }
});

test("the same counts WITHOUT not-modified are still a collapse", () => {
  // The guard must not disable the rule - a genuinely changed read that
  // returns nothing is exactly what this exists to catch.
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: 48, notModified: false }), true);
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: 48 }), true);
});

test("a not-modified read that somehow carries listings is still not a collapse", () => {
  assert.equal(isBoardCollapse({ seenNow: 12, openStored: 48, notModified: true }), false);
});

test("William Blair's exact shape: 48 stored, 0 seen, not modified", () => {
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: 48, notModified: true }), false);
});

test("a truncated read is never evidence that a board emptied", () => {
  /**
   * Same class as the 304 guard above, and it arrived the same way: a read
   * that returns an empty array because it never saw the board, not because
   * the board is empty.
   *
   * The case: a readable homepage whose render times out now reports the
   * static HTML it already fetched, flagged truncated, rather than httpStatus
   * 0 - which is what Capital Today's 73 consecutive "no answer" runs were,
   * against a URL that answers 200 with 25,869 bytes in 620ms. Without this,
   * every such source holding stored listings gets marked degraded by a read
   * that found nothing because it never looked.
   *
   * decideClosure already refuses to close on a truncated read. Health has to
   * agree, or the two tell opposite stories about one read.
   */
  assert.equal(
    isBoardCollapse({ seenNow: 0, openStored: 48, truncated: true }),
    false,
    "a truncated read must not read as collapse, however many listings are stored",
  );
  // And the rule still fires on a read that genuinely saw the whole board.
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: 48, truncated: false }), true);
  assert.equal(isBoardCollapse({ seenNow: 0, openStored: 48 }), true);
});
