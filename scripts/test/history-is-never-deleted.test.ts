/**
 * `detected_listings` is the only record of when a firm posted an internship.
 *
 * A listing rejected because its cycle has passed - "cycle 2026 is outside the
 * live range" - is not waste. It is the evidence of WHEN that firm posts, and
 * `published_at` on those rows reaches back to 2018. Measured 13 October 2026:
 * 283 past-cycle rejections across 19 sources, and 13,879 listings in total
 * carrying the firm's own posting date.
 *
 * That history is what makes "when will the 2029 summer analyst roles open?"
 * answerable, and it accrues only by being left alone. Today nothing deletes
 * from this table - which is true by accident rather than by design, since no
 * rule said so. This is the rule.
 *
 * A row may be marked `closed`, `rejected`, retired or unlinked. It may not be
 * removed. If a future cleanup genuinely needs to delete listings, it needs a
 * deliberate decision about the history that goes with them, and this test
 * failing is that conversation starting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "test") continue;
      out.push(...sources(p));
    } else if (entry.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

test("nothing deletes a detected listing", () => {
  const offenders: string[] = [];
  for (const file of [...sources("scripts"), ...sources("src")]) {
    const src = fs.readFileSync(file, "utf8");
    // `.delete(schema.detectedListings)` and `.delete(detectedListings)`.
    const hit = src.match(/\.delete\(\s*(?:schema\.)?detectedListings\s*\)/);
    if (hit) offenders.push(`${path.relative(process.cwd(), file)}: ${hit[0]}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "a listing's history is the only record of when a firm posts - mark rows, do not remove them:\n  " +
      offenders.join("\n  "),
  );
});

test("the past-cycle rejection keeps the year it was for", () => {
  /**
   * The signal is useless without it. That early return in classify.ts sets
   * `recruitingCycle: cycleForStaleness` rather than null precisely so the row
   * records WHICH cycle it belonged to - which is what lets the posting date
   * be attributed to a year later on.
   */
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/monitoring/classify.ts"), "utf8");
  const start = src.indexOf("is outside the live range");
  assert.ok(start > 0, "the dead-cycle branch has moved - update this test");
  const block = src.slice(Math.max(0, start - 900), start + 300);
  assert.match(
    block,
    /recruitingCycle: cycleForStaleness/,
    "the past-cycle rejection no longer records which cycle it was for",
  );
});
