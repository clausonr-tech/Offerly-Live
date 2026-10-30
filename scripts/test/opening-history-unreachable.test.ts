/**
 * "The Archive holds nothing" and "we never reached the Archive" are different.
 *
 * THE BUG. `gatherObservations` asks the Archive three ways and each layer
 * catches its own failure, which is right - one layer failing is not a
 * finding. But when all three failed it returned `{ observations: [] }`, byte
 * for byte what a firm with genuinely no archive history returns, and both
 * callers wrote that down as fact:
 *
 *   wayback-remote.ts       outcome "no-snapshots", error null
 *   opening-windows-sweep   outcome "no-snapshots", note "no archived capture
 *                           of this board named an internship, by URL index,
 *                           API or page" - written to Supabase
 *
 * Measured 22 September 2026: a cloud session whose network policy denies
 * web.archive.org (403 to the CONNECT) read five firms, Société Générale among
 * them, and recorded all five as having no archive history. Over the
 * 4,479-firm target list that is 4,479 confident false negatives, and the note
 * above is a positive claim about the Archive's holdings made without having
 * reached it - inventing a fact about a firm, which is the one thing this
 * pipeline forbids.
 *
 * A 403 is the shape that matters and the cheapest to test: cdxQuery breaks
 * out of its retry loop on any 4xx, so these run in milliseconds rather than
 * sitting through the backoff.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { gatherObservations } from "../../src/lib/monitoring/opening-history";

const REAL_FETCH = globalThis.fetch;

/** Answer every CDX request the same way, without touching the network. */
async function withFetch<T>(reply: () => Response, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async () => reply()) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

const YEAR = new Date().getUTCFullYear();
const opts = { careersUrl: "https://example.com/careers", fromYear: YEAR - 2, toYear: YEAR };

test("a refused Archive is reported as unreachable, not as an empty history", async () => {
  const result = await withFetch(
    () => new Response("denied", { status: 403 }),
    () => gatherObservations(opts),
  );
  assert.equal(result.observations.length, 0);
  assert.equal(
    result.archiveReachable,
    false,
    "a 403 from the index must not read as a firm with no archive history",
  );
  assert.ok(result.archiveError, "the transport failure has to be reported, not swallowed");
});

test("an Archive that answers with no captures IS reachable", async () => {
  // The honest empty answer, and the one case that must stay "no-snapshots":
  // the Archive was asked and holds nothing for this board. An empty body is
  // CDX's way of saying so.
  const result = await withFetch(
    () => new Response("", { status: 200 }),
    () => gatherObservations(opts),
  );
  assert.equal(result.observations.length, 0);
  assert.equal(
    result.archiveReachable,
    true,
    "a real empty answer is evidence about the firm and must stay distinguishable from a refusal",
  );
  assert.equal(result.archiveError, null);
});

test("a 5xx is unreachable too, once the retries are spent", async () => {
  const result = await withFetch(
    () => new Response("upstream", { status: 503 }),
    () => gatherObservations(opts),
  );
  assert.equal(result.archiveReachable, false);
  assert.ok(result.archiveError);
});

// --------------------------------------------- both callers act on the flag

const remote = readFileSync("scripts/wayback-remote.ts", "utf8");
const sweep = readFileSync("scripts/opening-windows-sweep.ts", "utf8");

test("wayback-remote records an unreachable Archive as an error", () => {
  // An error outcome, not "no-snapshots" - a verdict it never earned.
  assert.match(remote, /!observations\.length && !archiveReachable/);
  assert.match(remote, /row\.outcome = "error"/);
  assert.match(remote, /row\.archiveUnreachable = true/);
});

test("--resume re-reads a firm the Archive could not be reached for", () => {
  // The other half, and the half that is easy to miss: --resume skips every
  // sourceId already in the file, errors included. Without this, one blocked
  // run turns into a permanent hole in the dataset - and silently, because the
  // next run reports those firms as already read.
  assert.match(remote, /const isUnreadable = /);
  assert.match(remote, /loaded\.filter\(\(r\) => !isUnreadable\(r\)\)/);
});

test("the sweep refuses to write its no-snapshots note after a transport failure", () => {
  // That note is a positive claim about what the Archive holds. It must be
  // unreachable behind the archiveReachable check.
  assert.match(sweep, /observations\.length === 0 && !archiveReachable/);
  const noteAt = sweep.indexOf("no archived capture of this board named an internship");
  const guardAt = sweep.indexOf("observations.length === 0 && !archiveReachable");
  assert.ok(guardAt !== -1 && guardAt < noteAt, "the guard must come before the claim");
});

test("wayback-remote stops asking a service that is refusing it", () => {
  // The run policy states this - "being refused is a signal to
  // back off, not to retry harder" - and nothing enforced it. A run against a
  // blocked network worked through all 4,479 firms at full pace.
  assert.match(remote, /UNREACHABLE_STREAK_LIMIT/);
  assert.match(remote, /consecutiveUnreachable >= UNREACHABLE_STREAK_LIMIT/);
  assert.match(remote, /consecutiveUnreachable = 0/, "the streak must reset on a firm that answers");
});
