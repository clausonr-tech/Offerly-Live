// A failed render must not erase a successful read.
//
// THE MEASUREMENT BEHIND THIS FILE
// --------------------------------
// On 11 October 2026, 12,303 of 28,597 crawler check runs - 43% - reported
// `inconclusive: HTTP 0 - not an answer about this firm`, and 351 sources had
// never once produced a successful read. 319 of those 351 (91%) point at a
// bare apex homepage with no path.
//
// That is the normal path for a homepage: the plain GET succeeds, there is no
// job board to find because it is a homepage, a render is attempted anyway,
// and a slow render buried the read. Capital Today had 73 such runs, every one
// "no answer", averaging 27.4 seconds - while `safeFetch` against the same URL
// returns 200 with 25,869 bytes in 620ms.
//
// Three losses per run: a 20-second render for a page already in memory; a
// reported non-answer where there was an answer; and - because `pageText` was
// only ever set on the render path or on a static read that found a board -
// the announcement watcher never saw a word of it. That watcher exists FOR
// firms with no board.
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderFailureResult } from "../../src/lib/monitoring/connectors/generic";

const PAGE = `<html><head><title>Capital Today</title></head><body><main>
  <h1>Capital Today</h1>
  <p>We are a long-only investment firm. Our focus and discipline set us apart,
     and we work hands-on with the companies we back across many years.</p>
  <p>Campus recruiting for the summer analyst programme opens in September.</p>
</main></body></html>`;

test("a readable page survives a failed render", () => {
  const r = renderFailureResult({ html: PAGE, httpStatus: 200 });
  assert.equal(r.httpStatus, 200, "a read that worked must not be reported as HTTP 0");
  assert.notEqual(r.httpStatus, 0);
  assert.equal(r.notModified, false);
});

test("the page's prose is carried, so the announcement watcher can see it", () => {
  // monitor-run.ts gates the whole announcement path on `if (result.pageText)`.
  // Without this, a firm with no board is invisible to the one mechanism built
  // for firms with no board.
  const r = renderFailureResult({ html: PAGE, httpStatus: 200 });
  assert.ok(r.pageText, "no pageText - the announcement watcher stays blind");
  assert.match(r.pageText!, /summer analyst programme opens in September/);
});

test("the read is flagged truncated, because a rendered board may exist unseen", () => {
  // decideClosure refuses to close listings on a truncated read, and
  // isBoardCollapse refuses to call it a collapse. Both matter: this result
  // carries zero listings, and a source that has stored listings must not be
  // emptied or degraded by a read that never looked.
  const r = renderFailureResult({ html: PAGE, httpStatus: 200 });
  assert.equal(r.truncated, true);
  assert.deepEqual(r.listings, []);
});

test("the content hash is stable, not an empty string", () => {
  // `monitor-run.ts` compares `result.contentHash === source.lastContentHash`,
  // and the live database holds 3 sources whose stored hash is "". An empty
  // hash here would make `"" === ""` true and record a failed read as a
  // healthy no-change, with lastSuccessAt set and failureCount cleared.
  const r = renderFailureResult({ html: PAGE, httpStatus: 200 });
  assert.notEqual(r.contentHash, "", "an empty hash can collide with a stored empty hash");
  assert.equal(
    r.contentHash,
    renderFailureResult({ html: "<html>different</html>", httpStatus: 200 }).contentHash,
    "no listings either way, so the hash should not move with unrelated page edits",
  );
});

test("nothing read at all is still reported as no answer", () => {
  for (const staticResult of [null, { html: "", httpStatus: 503 }, { html: "x", httpStatus: 404 }]) {
    const r = renderFailureResult(staticResult);
    assert.equal(r.httpStatus === 0 || r.httpStatus >= 400, true, JSON.stringify(staticResult));
    assert.equal(r.pageText, undefined, "no page was read, so there is no prose to carry");
  }
});

test("a 3xx from the cheap path still counts as read", () => {
  // safeFetch follows redirects itself, so a 3xx reaching here is a hop it
  // chose to return - still a real answer, not a non-answer.
  const r = renderFailureResult({ html: PAGE, httpStatus: 304 });
  assert.equal(r.httpStatus, 304);
  assert.ok(r.pageText);
});
