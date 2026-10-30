// Our own database failing is not a verdict on a firm's board.
//
// http-outcome stops a vendor's 429 being charged to the firm. This is the
// same rule one layer in, and it is the one that defeats that fix from
// outside: the 429 path prints "not counted as a failure" and then WRITES
// next_check_at to schedule the retry, inside the same try. When that write
// fails, the catch calls recordFailure and the source is penalised anyway.
//
// Measured in /tmp/offerly-crawl.log, the hourly run of 20 September 2026:
// seven queries failed in one crawl, three of them that exact write. Nothing
// about it is sector-specific, which is why it matters most to the sectors
// with the fewest sources - hedge funds have 20 and real estate has 9, so a
// handful of wrongly-charged failures empties one out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isDatabaseError, describeError } from "../../src/lib/monitoring/db-outcome";

// ------------------------------------------------------------ ours, not theirs

test("a drizzle-wrapped query failure is ours", () => {
  // The exact shape from the log: the SQL, then the bound parameters.
  const err = new Error(
    'Failed query: update "firm_monitoring_sources" set "last_attempted_at" = $1, "next_check_at" = $2 where "id" = $3\nparams: 2026-09-20T09:38:08.032Z,2026-09-20T09:51:34.875Z,2e5707f7',
  );
  assert.equal(isDatabaseError(err), true);
});

test("a SQLSTATE on the error itself is ours", () => {
  const err = Object.assign(new Error("terminating connection"), { code: "08006" });
  assert.equal(isDatabaseError(err), true);
});

test("a SQLSTATE on the cause is ours", () => {
  const err = new Error("query failed", {
    cause: Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    }),
  });
  assert.equal(isDatabaseError(err), true);
});

test("a dropped connection with no SQLSTATE is still ours", () => {
  const err = new Error("write CONNECTION_CLOSED aws-0-us-east-1.pooler.supabase.com:5432");
  assert.equal(isDatabaseError(err), true);
});

test("a connection reset carried in the cause is ours", () => {
  const err = new Error("fetch-adjacent wrapper", { cause: new Error("read ECONNRESET") });
  assert.equal(isDatabaseError(err), true);
});

// ---------------------------------------------------------- theirs, not ours
//
// The conservative direction. Anything not positively identified as ours is
// still charged to the source, because wrongly sparing a broken source costs
// one extra check while wrongly blaming a healthy firm writes it off.

test("a connector's own parse failure is charged to the source", () => {
  assert.equal(isDatabaseError(new Error("Unexpected token < in JSON at position 0")), false);
});

test("a board returning nothing parseable is charged to the source", () => {
  assert.equal(isDatabaseError(new Error("no vacancy rows found on the board")), false);
});

test("a non-Error throw is not assumed to be ours", () => {
  assert.equal(isDatabaseError("boom"), false);
  assert.equal(isDatabaseError(null), false);
  assert.equal(isDatabaseError(undefined), false);
});

test("a four-character code is not a SQLSTATE", () => {
  // Node's own errors carry short codes; only the five-character shape is
  // postgres'. ENOENT is six and lowercase-free, so the digit/capital test
  // is what keeps this honest rather than the length alone.
  const err = Object.assign(new Error("nope"), { code: "E404" });
  assert.equal(isDatabaseError(err), false);
});

// --------------------------------------------------------- what reaches the log

test("the bound parameters are never printed", () => {
  // One of the seven failures pasted a 4,000-character job description and a
  // full classification blob into a world-readable log file.
  const err = new Error(
    'Failed query: update "detected_listings" set "description_raw" = $1\nparams: Long Term Internship - Sovereign Advisory, and four thousand more characters',
  );
  const text = describeError(err);
  assert.ok(!text.includes("Sovereign Advisory"));
  assert.ok(!text.includes("params:"));
  assert.ok(text.startsWith("Failed query:"));
});

test("the cause is what says why, so it is kept", () => {
  const err = new Error("Failed query: select 1\nparams: ", {
    cause: new Error("canceling statement due to statement timeout"),
  });
  assert.match(describeError(err), /statement timeout/);
});

test("no cause leaves the message alone", () => {
  assert.equal(describeError(new Error("plain failure")), "plain failure");
});

test("a cause identical to the message is not repeated", () => {
  const err = new Error("same text", { cause: new Error("same text") });
  assert.equal(describeError(err), "same text");
});

test("a non-Error is stringified rather than thrown over", () => {
  assert.equal(describeError("boom"), "boom");
});
