// When a stored posting may be closed, and when it may be re-read.
//
// Both decisions were inline in monitor-run.ts, which needs a database, so
// neither had ever been tested - and both were losing real postings:
//
//   - Absence from a TRUNCATED read was treated as evidence of closure. The
//     generic connector capped at 30 candidates and iCIMS at 5 pages, so a
//     board past either ceiling had its tail marked closed on every check.
//   - The re-read of a thin listing sat behind the unchanged-hash short
//     circuit, so on a quiet board it never ran at all.
//
// The interaction in the first is the dangerous part and most of this file is
// about it: a truncation is PERMANENT, so "it has been missing a long time"
// does not rescue the decision - it guarantees the wrong one.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideClosure,
  isThinDescription,
  shouldRetryEnrichment,
  MAX_ENRICHMENT_ATTEMPTS,
  postingStillBacked,
  type StoredListingState,
} from "../../src/lib/monitoring/listing-lifecycle";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-19T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const stored = (patch: Partial<StoredListingState> = {}): StoredListingState => ({
  externalJobId: "abc123",
  status: "open",
  lastConfirmedAt: ago(HOUR),
  title: "2027 Investment Banking Summer Analyst",
  descriptionRaw: "A".repeat(400),
  ...patch,
});

const opts = (patch: Partial<Parameters<typeof decideClosure>[2]> = {}) => ({
  truncated: false,
  intervalMs: HOUR,
  now: NOW,
  ...patch,
});

// -------------------------------------------------------------- seen or not

test("a listing seen in this fetch is never closed", () => {
  const decision = decideClosure(stored(), new Set(["abc123"]), opts());
  assert.equal(decision.close, false);
  assert.match(decision.reason, /seen in this fetch/);
});

test("a listing absent long enough is closed", () => {
  const decision = decideClosure(stored({ lastConfirmedAt: ago(10 * HOUR) }), new Set(), opts());
  assert.equal(decision.close, true);
});

test("a listing that is already closed is left alone", () => {
  for (const status of ["closed", "expired", "archived"]) {
    const decision = decideClosure(
      stored({ status, lastConfirmedAt: ago(10 * HOUR) }),
      new Set(),
      opts(),
    );
    assert.equal(decision.close, false, status);
    assert.match(decision.reason, /not open/);
  }
});

test("a listing with a null id is not matched by an empty key", () => {
  // `seenKeys.has(externalJobId ?? "")` - an empty string in the set must not
  // accidentally confirm every id-less row.
  const decision = decideClosure(
    stored({ externalJobId: null, lastConfirmedAt: ago(10 * HOUR) }),
    new Set(["something-else"]),
    opts(),
  );
  assert.equal(decision.close, true);
});

// ------------------------------------------------------------ the grace period

test("a single missed check does not close a posting", () => {
  // One outage must not masquerade as a closed cycle.
  const decision = decideClosure(stored({ lastConfirmedAt: ago(HOUR) }), new Set(), opts());
  assert.equal(decision.close, false);
  assert.match(decision.reason, /less than one full check cycle/);
});

const graceCases: [string, number, boolean][] = [
  ["just confirmed", 0, false],
  ["half a cycle", 0.5, false],
  ["one cycle", 1, false],
  ["exactly 1.5 cycles", 1.5, false],
  ["just past 1.5 cycles", 1.51, true],
  ["two cycles", 2, true],
  ["ten cycles", 10, true],
];
for (const [name, cycles, expected] of graceCases) {
  test(`grace period - ${name} -> ${expected ? "close" : "keep"}`, () => {
    const decision = decideClosure(
      stored({ lastConfirmedAt: ago(cycles * HOUR) }),
      new Set(),
      opts(),
    );
    assert.equal(decision.close, expected);
  });
}

test("the grace period scales with the source's own interval", () => {
  // A weekly source missing for a day is not a closed posting.
  const day = 24 * HOUR;
  const weekly = opts({ intervalMs: 7 * day });
  assert.equal(decideClosure(stored({ lastConfirmedAt: ago(day) }), new Set(), weekly).close, false);
  assert.equal(
    decideClosure(stored({ lastConfirmedAt: ago(12 * day) }), new Set(), weekly).close,
    true,
  );
});

// ---------------------------------------------- truncation beats everything

test("a truncated read closes nothing", () => {
  const decision = decideClosure(
    stored({ lastConfirmedAt: ago(10 * HOUR) }),
    new Set(),
    opts({ truncated: true }),
  );
  assert.equal(decision.close, false);
  assert.match(decision.reason, /truncated/);
});

test("truncation is checked BEFORE the age test, not after", () => {
  // This is the whole bug. A board over its cap is over it on every check, so
  // the tail is missing permanently and would clear any age bar eventually.
  // Age must not be able to override truncation.
  for (const cycles of [2, 10, 100, 10_000]) {
    const decision = decideClosure(
      stored({ lastConfirmedAt: ago(cycles * HOUR) }),
      new Set(),
      opts({ truncated: true }),
    );
    assert.equal(decision.close, false, `${cycles} cycles`);
    assert.match(decision.reason, /truncated/);
  }
});

test("a truncated read still confirms what it DID see", () => {
  // Truncation suppresses closure, not confirmation - otherwise a large board
  // could never close anything at all.
  const decision = decideClosure(stored(), new Set(["abc123"]), opts({ truncated: true }));
  assert.equal(decision.close, false);
  assert.match(decision.reason, /seen in this fetch/);
});

test("an untruncated read closes normally again", () => {
  // The guard must not be sticky: once a board fits, absence means what it
  // used to mean.
  const listing = stored({ lastConfirmedAt: ago(10 * HOUR) });
  assert.equal(decideClosure(listing, new Set(), opts({ truncated: true })).close, false);
  assert.equal(decideClosure(listing, new Set(), opts({ truncated: false })).close, true);
});

test("truncated defaults are not assumed - the flag is explicit", () => {
  // `result.truncated ?? false` at the call site; a connector that never sets
  // it must behave exactly as before.
  const decision = decideClosure(
    stored({ lastConfirmedAt: ago(10 * HOUR) }),
    new Set(),
    opts({ truncated: false }),
  );
  assert.equal(decision.close, true);
});

test("every decision explains itself", () => {
  // The reason is what makes a wrong closure auditable later.
  const cases = [
    decideClosure(stored(), new Set(["abc123"]), opts()),
    decideClosure(stored(), new Set(), opts({ truncated: true })),
    decideClosure(stored(), new Set(), opts()),
    decideClosure(stored({ status: "closed" }), new Set(), opts()),
    decideClosure(stored({ lastConfirmedAt: ago(10 * HOUR) }), new Set(), opts()),
  ];
  for (const decision of cases) {
    assert.ok(decision.reason.length > 0);
  }
});

// --------------------------------------------------------- thin descriptions

const thinCases: [string, string, string, boolean][] = [
  ["empty", "", "Summer Analyst", true],
  ["whitespace only", "   \n\t ", "Summer Analyst", true],
  ["identical to the title", "Summer Analyst", "Summer Analyst", true],
  ["title with padding", "  Summer Analyst  ", "Summer Analyst", true],
  ["just under the bar", "A".repeat(119), "Summer Analyst", true],
  ["exactly at the bar", "A".repeat(120), "Summer Analyst", false],
  ["comfortably over", "A".repeat(400), "Summer Analyst", false],
];
for (const [name, description, title, expected] of thinCases) {
  test(`thin description - ${name}`, () => {
    assert.equal(isThinDescription(description, title), expected);
  });
}

test("a long description equal to the title is still thin", () => {
  // A DOM candidate's description IS its link text. A 200-character link is
  // still no more information than the title.
  const long = "Investment Banking Summer Analyst Programme ".repeat(5);
  assert.equal(isThinDescription(long, long), true);
});

// ------------------------------------------------------------ retry decisions

test("a thin internship is retried", () => {
  assert.equal(
    shouldRetryEnrichment({ title: "2027 Summer Analyst", descriptionRaw: "2027 Summer Analyst" }),
    true,
  );
});

test("a thin non-internship is not retried", () => {
  // Spending a detail fetch to reject a compliance officer is the budget the
  // real internships need.
  assert.equal(
    shouldRetryEnrichment({
      title: "Commercial Banking Compliance Officer",
      descriptionRaw: "Commercial Banking Compliance Officer",
    }),
    false,
  );
});

test("an internship that already has text is not retried", () => {
  // Otherwise it is re-fetched on every check forever.
  assert.equal(
    shouldRetryEnrichment({ title: "2027 Summer Analyst", descriptionRaw: "B".repeat(400) }),
    false,
  );
});

const retryTitles: [string, boolean][] = [
  ["2027 Investment Banking Summer Analyst", true],
  ["Summer Associate - M&A", true],
  ["Internship - Marketing (Year-Round)", true],
  ["Intern, Transfer Pricing", true],
  ["2027 January Off-Cycle Analyst", true],
  ["Vice President, Asset Management", false],
  ["Front Desk Agent", false],
  ["Property Administrator", false],
  ["", false],
];
for (const [title, expected] of retryTitles) {
  test(`retry by title: ${JSON.stringify(title)} -> ${expected}`, () => {
    assert.equal(shouldRetryEnrichment({ title, descriptionRaw: title }), expected);
  });
}

test("the retry test and the thin test agree", () => {
  // They must: a listing thin to one and full to the other is either never
  // enriched or re-fetched forever.
  const listing = { title: "2027 Summer Analyst", descriptionRaw: "C".repeat(120) };
  assert.equal(isThinDescription(listing.descriptionRaw, listing.title), false);
  assert.equal(shouldRetryEnrichment(listing), false);
});

test("a retry stops mattering as soon as real text arrives", () => {
  const title = "2027 Summer Analyst";
  assert.equal(shouldRetryEnrichment({ title, descriptionRaw: title }), true);
  assert.equal(shouldRetryEnrichment({ title, descriptionRaw: "D".repeat(200) }), false);
});

test("nothing here throws on empty input", () => {
  assert.doesNotThrow(() => isThinDescription("", ""));
  assert.doesNotThrow(() => shouldRetryEnrichment({ title: "", descriptionRaw: "" }));
  assert.doesNotThrow(() => decideClosure(stored({ title: "" }), new Set(), opts()));
});

// ------------------------------------------------ an unreadable source

test("a failed fetch closes nothing", () => {
  // Connectors report an unreadable source as httpStatus 0 with no listings -
  // a render timeout, a page that never settles, robots newly disallowing the
  // path. monitor-run's error branch only catches >= 400, so a zero used to
  // fall through to the diff as a board that had emptied.
  const decision = decideClosure(
    stored({ lastConfirmedAt: ago(10 * HOUR) }),
    new Set(),
    opts({ fetchFailed: true }),
  );
  assert.equal(decision.close, false);
  assert.match(decision.reason, /fetch failed/);
});

test("a failed fetch beats the grace period, however long", () => {
  // Two consecutive render timeouts on an hourly source already clear 1.5
  // cycles, and that is the common case rather than the exotic one.
  for (const cycles of [2, 5, 50, 5000]) {
    const decision = decideClosure(
      stored({ lastConfirmedAt: ago(cycles * HOUR) }),
      new Set(),
      opts({ fetchFailed: true }),
    );
    assert.equal(decision.close, false, `${cycles} cycles`);
  }
});

test("a successful empty board still closes listings", () => {
  // The guard must not swallow the real signal: a board that genuinely
  // emptied should still close its postings.
  const decision = decideClosure(
    stored({ lastConfirmedAt: ago(10 * HOUR) }),
    new Set(),
    opts({ fetchFailed: false }),
  );
  assert.equal(decision.close, true);
});

test("fetchFailed is optional and defaults to not-failed", () => {
  // Callers that never set it must behave exactly as before.
  const decision = decideClosure(stored({ lastConfirmedAt: ago(10 * HOUR) }), new Set(), {
    truncated: false,
    intervalMs: HOUR,
    now: NOW,
  });
  assert.equal(decision.close, true);
});

test("a failed fetch still confirms nothing it did not see", () => {
  const decision = decideClosure(stored(), new Set(["abc123"]), opts({ fetchFailed: true }));
  assert.match(decision.reason, /seen in this fetch/);
});

test("a listing stops earning enrichment attempts after a fixed number of tries", () => {
  /**
   * The same bug shape as the inconclusive retry loop: a retry with no bound.
   *
   * Measured 11 October 2026: 233 open listings across 91 sources were thin
   * and internship-titled, so they were re-fetched on every check forever.
   * HSBC (US) had 7 re-read for 38 days, Evercore 17 for 28. At up to 25
   * detail fetches per check with a 700ms gap between them, that is 17
   * seconds of every check spent re-reading pages that already refused to
   * answer - which is most of the 22-second median measured on reads that
   * found no new listings at all.
   *
   * The first bound was a seven-day window, and it measured the wrong thing.
   * See the next test.
   */
  const thin = { title: "2027 Summer Analyst Internship", descriptionRaw: "" };

  assert.equal(shouldRetryEnrichment({ ...thin, enrichmentAttempts: 0 }), true);
  assert.equal(shouldRetryEnrichment({ ...thin, enrichmentAttempts: 4 }), true);
  assert.equal(
    shouldRetryEnrichment({ ...thin, enrichmentAttempts: MAX_ENRICHMENT_ATTEMPTS }),
    false,
    "a detail page that served nothing five times must stop being asked",
  );
  assert.equal(
    shouldRetryEnrichment({ ...thin, enrichmentAttempts: 99 }),
    false,
    "and a row already past the cap stays stopped",
  );
});

test("age never gives up on a listing that was never tried", () => {
  /**
   * THE REGRESSION THE WINDOW CAUSED, asserted so it cannot come back.
   *
   * A connector's per-check detail cap means a busy board cannot enrich
   * everything in one pass, so a listing can sit for a fortnight without ever
   * having had a detail fetch spent on it. The seven-day window gave up on it
   * anyway - and a listing with no description can never be published, so
   * ageing out an untried one made it invisible permanently rather than
   * merely late.
   *
   * Attempts are what the cap is for. An old listing that has never been
   * tried is exactly the one still worth trying.
   */
  const thin = { title: "2027 Summer Analyst Internship", descriptionRaw: "" };

  // Age is not an input any more - `firstDetectedAt` was removed from the
  // signature rather than left unread, so nothing about when a listing was
  // first seen can reach this decision. A listing that never got a turn keeps
  // its attempts however old it is.
  assert.equal(
    shouldRetryEnrichment({ ...thin, enrichmentAttempts: 0 }),
    true,
    "a listing that never got a turn was aged out by the old window",
  );
  assert.equal(
    shouldRetryEnrichment({ ...thin, enrichmentAttempts: MAX_ENRICHMENT_ATTEMPTS }),
    false,
    "and spent attempts still stop it",
  );
  // The signature itself is the guarantee: an age field would compile.
  // @ts-expect-error firstDetectedAt is deliberately not part of the input
  assert.equal(shouldRetryEnrichment({ ...thin, firstDetectedAt: new Date(), enrichmentAttempts: 0 }), true);
});

test("attempts alone never earn a listing an attempt it would not otherwise get", () => {
  // The cap only ever STOPS a retry. A full description, or a title the
  // internship rule rejects, is still not re-read however few tries it has had.
  assert.equal(
    shouldRetryEnrichment({
      title: "Head of Strategic Initiatives",
      descriptionRaw: "",
      enrichmentAttempts: 0,
    }),
    false,
  );
});

test("an absent attempt count does not stop a retry", () => {
  // The column is NOT NULL with a default of 0, but a caller testing the
  // thin/title rule alone need not invent one.
  const thin = { title: "2027 Summer Analyst Internship", descriptionRaw: "" };
  assert.equal(shouldRetryEnrichment(thin), true);
  assert.equal(shouldRetryEnrichment({ ...thin, enrichmentAttempts: null }), true);
});

test("a posting with no open listing left behind it is unbacked", () => {
  const closed = new Set<string>();
  assert.equal(
    postingStillBacked("p1", [{ id: "l1", promotedPostingId: "p1", status: "closed" }], closed),
    false,
    "a closed listing is not evidence the vacancy is live",
  );
  assert.equal(
    postingStillBacked("p1", [{ id: "l1", promotedPostingId: "p1", status: "open" }], closed),
    true,
  );
  assert.equal(
    postingStillBacked("p1", [{ id: "l1", promotedPostingId: "p2", status: "open" }], closed),
    false,
    "another posting's live listing says nothing about this one",
  );
  assert.equal(postingStillBacked("p1", [], closed), false, "nothing behind it at all");
});

test("one vacancy promoted twice stays backed while either listing is open", () => {
  // The same role seen twice on a board, or through two sources for one firm.
  const listings = [
    { id: "l1", promotedPostingId: "p1", status: "closed" },
    { id: "l2", promotedPostingId: "p1", status: "open" },
  ];
  assert.equal(postingStillBacked("p1", listings, new Set()), true);
});

test("the pass's OWN closures count - the order-dependence bug", () => {
  /**
   * Both listings for one posting closing in the same pass.
   *
   * Asked per listing inside the closure loop, each iteration read the other
   * row's pre-pass snapshot - where it was still `open` - so each deferred to
   * the other and the posting was never taken down. The pass's own closures
   * have to be part of the question, which is why `closedNow` exists.
   */
  const listings = [
    { id: "l1", promotedPostingId: "p1", status: "open" },
    { id: "l2", promotedPostingId: "p1", status: "open" },
  ];
  // Mid-pass: one closed, the other still live - the posting stays.
  assert.equal(postingStillBacked("p1", listings, new Set(["l1"])), true);
  // Both closed in this pass - nothing is behind it any more.
  assert.equal(
    postingStillBacked("p1", listings, new Set(["l1", "l2"])),
    false,
    "two listings closing together left the posting live",
  );
});
