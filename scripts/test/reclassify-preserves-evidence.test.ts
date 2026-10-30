/**
 * A reclassification replaces the CLASSIFIER's output, not everything in the
 * column.
 *
 * `reclassify-listings.ts` rewrites `classification` wholesale, and several
 * keys in there were never written by `classifyListing`. Its own comment
 * records the first time this bit: 18 rows carried an `adjudication` - the
 * model's quote-verified second opinion - and a pass would have wiped every
 * one.
 *
 * `reviewAgent` is the same bug one key later, caught before the first
 * backfill run rather than after. Losing it costs more than the audit trail:
 * the agent reads its own `skips` counter to stop paying for a page that will
 * never read, and reads the key's presence to avoid re-examining a listing it
 * has already judged. A wipe would silently re-spend the whole queue's model
 * budget on work already done.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "scripts/reclassify-listings.ts");

test("every key the classifier does not write is carried forward", () => {
  const src = fs.readFileSync(SRC, "utf8");
  for (const key of ["adjudication", "cycleBasis", "reviewAgent"]) {
    assert.match(
      src,
      new RegExp(`if \\(prior\\.${key}\\) nowWithEvidence\\.${key} = prior\\.${key};`),
      `reclassify would wipe classification.${key}`,
    );
  }
});

test("the carry-forward happens on the row that is written", () => {
  // The guard is worthless if `nowWithEvidence` is built and then `now` is
  // written instead - which is exactly the shape of the original bug.
  const src = fs.readFileSync(SRC, "utf8");
  const built = src.indexOf("const nowWithEvidence");
  assert.ok(built > 0, "nowWithEvidence has been renamed - update this test");
  assert.match(
    src.slice(built),
    /classification: nowWithEvidence/,
    "the preserved object is not the one written to the row",
  );
});
