/**
 * A job that has closed must never be published, by any route.
 *
 * `decideClosure` marks a detected_listing `closed` when it has gone from the
 * firm's board, and the crawl now retires the posting behind it (see
 * postingStillBacked). Two routes could put a closed one back in front of a
 * student, and neither checked:
 *
 *  - `promote-approved-listings.ts` selects on
 *    `review_status = 'auto_approved' AND promoted_posting_id IS NULL` with no
 *    filter on `status`. Measured 12 October 2026: 0 rows qualified, so the
 *    hole was latent rather than leaking.
 *  - `reclassify-listings.ts` sets `auto_approved` on a rule change without
 *    looking at `status` either, which is what would MAKE it leak: a rule fix
 *    that recovers an old rejection hands promote a closed listing with a null
 *    posting link, which is exactly the shape promote publishes.
 *
 * Asserted against the source because both are scripts whose main() needs a
 * database and a live posting write; the regression they guard is a missing
 * clause, which the source shows directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

test("promote will not publish a listing whose job has closed", () => {
  const src = read("scripts/promote-approved-listings.ts");
  const start = src.indexOf('eq(detectedListings.reviewStatus, "auto_approved")');
  assert.ok(start > 0, "promote's selection has moved - update this test");
  // Scoped to the enclosing where(), not a character window: the clause has to
  // sit in the SAME where() as the review-status check, and a comment between
  // them must not be able to hide it.
  const whereStart = src.lastIndexOf(".where(", start);
  const whereEnd = src.indexOf("\n    );", start);
  assert.ok(whereStart > 0 && whereEnd > whereStart, "could not bound promote's where()");
  const clause = src.slice(whereStart, whereEnd);
  assert.match(
    clause,
    /eq\(\s*detectedListings\.status\s*,\s*"open"\s*\)/,
    "promote selects auto-approved listings without checking the job is still open",
  );
});

test("a rule change cannot re-approve a listing whose job has closed", () => {
  const src = read("scripts/reclassify-listings.ts");
  assert.match(
    src,
    /isOpen|l\.status === "open"|status === "open"/,
    "reclassify re-approves without consulting the listing's status",
  );
});

/**
 * THE PROMOTE STEP IS BINARY TOO.
 *
 * `monitor-run.ts` routes published-or-rejected and says so at length, and
 * `reviewStatusAfterReread` was narrowed to match. The promote step was not:
 * it held rows in `pending_review` on three branches - no recruiting cycle,
 * blocked language, unpublishable URLs - and it runs hourly. Measured
 * 12 October 2026: 278 rows carry `pending_review`, most recently written
 * that morning, so the claim that nothing writes it was simply false.
 *
 * Each branch's own comment justified the hold as "visible and countable in
 * the review queue". That premise is the one the queue's removal rests on
 * being false: `reviewed_by` was NULL on all 21,716 rows, so a held row was
 * invisible, not countable. A rejection states its reason and is recoverable;
 * a hold is neither.
 */
test("the promote step holds nothing in the review queue", () => {
  const src = read("scripts/promote-approved-listings.ts");
  assert.doesNotMatch(
    src,
    /reviewStatus:\s*"pending_review"/,
    "promote still routes rows into a queue nobody works",
  );
});

test("every branch that withholds a listing records why", () => {
  const src = read("scripts/promote-approved-listings.ts");
  // One helper, used by all three branches, so a fourth cannot forget.
  assert.match(src, /const withhold = \(/, "the withhold helper is gone");
  const calls = src.match(/await withhold\(/g) ?? [];
  assert.equal(
    calls.length,
    3,
    `expected three withholding branches, found ${calls.length} - a new one may be unguarded`,
  );
  assert.match(
    src,
    /reasonForUncertainty/,
    "a withheld listing carries no reason, so nothing can recover it",
  );
});

test("a listing withheld for a missing cycle stays findable by the rescue tool", () => {
  /**
   * `adjudicate-rejections.ts` selects its cycle candidates with
   * `reasonForUncertainty?.includes("recruiting-cycle")` - a substring match on
   * the text. So the phrase is an interface, not prose: write the reason any
   * other way and the half of that script which recovers real internships
   * goes back to matching nothing, which is the bug already fixed in it once.
   */
  const promote = read("scripts/promote-approved-listings.ts");
  const adjudicate = read("scripts/adjudicate-rejections.ts");
  assert.match(
    adjudicate,
    /includes\("recruiting-cycle"\)/,
    "the rescue tool's selector has changed - update the phrase promote writes",
  );
  assert.match(
    promote,
    /recruiting-cycle/,
    "promote's missing-cycle reason does not carry the phrase the rescue tool looks for",
  );
});

/**
 * EVERY REJECTION STATES ITS REASON - INCLUDING THE ONE THE CLOSURE PASS MAKES.
 *
 * "A rejection states its reason and is recoverable; a queued row nobody reads
 * is not" is the argument the review queue's removal rests on. Measured
 * 12 October 2026 it was false for half of them: 10,413 of 20,457 rejected
 * rows carry no `reasonForUncertainty` at all, 9,138 of those written in the
 * previous two days - so this is live behaviour, not historical debris.
 *
 * The biggest single source is here. The closure pass retires a listing that
 * was queued and never readable, and it set `reviewStatus: "rejected"` without
 * writing anything to say why. 885 of those rows satisfy every condition
 * `publishableWithoutReview` checks, which is what makes them look alarming -
 * real Morgan Stanley, JPMorgan and Evercore internships - and every one is
 * `closed`, so nothing live was lost. What was lost is the ability to count
 * them or get them back, which is the whole point of rejecting rather than
 * queueing.
 */
test("the closure pass gives its rejection a reason", () => {
  const src = read("scripts/monitor-run.ts");
  const start = src.indexOf('...(unreadable && stillQueued');
  assert.ok(start > 0, "the closure rejection has moved - update this test");
  const block = src.slice(start - 100, start + 600);
  assert.match(
    block,
    /reasonForUncertainty/,
    "the closure pass rejects a listing without recording why",
  );
});

/**
 * THE RETIREMENT PASS MUST ASK THE DATABASE, NOT THIS SOURCE'S SNAPSHOT.
 *
 * Posting identity is FIRM-scoped: `promote-approved-listings.ts` finds a
 * posting by (firmId, roleTitle, programYear), so two sources for one firm
 * carrying the same role promote to one posting row. The retirement pass was
 * handed `existingListings`, loaded `where sourceId = source.id`, so source A
 * closing its copy could not see source B's still-live one and retired a
 * posting for a job still on B's board - permanently, because promote only
 * selects `promotedPostingId IS NULL` and B's listing holds the link.
 *
 * The unit tests for `postingStillBacked` passed throughout, because they hand
 * the function both listings. Only the call site was wrong, so only the call
 * site can be asserted.
 */
test("posting retirement is decided from a cross-source database read", () => {
  const src = read("scripts/monitor-run.ts");
  const start = src.indexOf("for (const postingId of postingsToReview)");
  assert.ok(start > 0, "the retirement loop has moved - update this test");
  const decide = src.slice(start, start + 260);
  assert.doesNotMatch(
    decide,
    /postingStillBacked\(postingId,\s*existingListings/,
    "retirement is back on this source's listings only - it cannot see a sibling source's live listing",
  );
  // And the read it is given is scoped by posting, not by source.
  const before = src.slice(Math.max(0, start - 900), start);
  assert.match(
    before,
    /inArray\(\s*schema\.detectedListings\.promotedPostingId/,
    "the backing listings are not re-read by posting id across sources",
  );
  assert.match(
    before,
    /status: schema\.detectedListings\.status/,
    "the re-read does not select status, so it cannot tell open from closed",
  );
});
