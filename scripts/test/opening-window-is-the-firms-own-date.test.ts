/**
 * A predicted opening window describes the FIRM, never us.
 *
 * `opening-history-from-postings.ts` derives a window from the dates on
 * listings we already collected. Two dates are available on every listing and
 * only one of them is about the firm:
 *
 *   published_at        the firm's own posting date, off the firm's own board.
 *   first_detected_at   the day WE first saw the listing - bounded below by the
 *                       day we started crawling that source.
 *
 * Measured 13 October 2026: insisting on the firm's own date leaves 45 firms
 * with at least one such date and 15 with the two cycles `deriveWindow`
 * requires. Accepting our first sighting instead would qualify 76. That extra
 * coverage is the tempting kind and it is worse than nothing: those firms would
 * get our deployment date stored as their opening window, with nothing in the
 * row to show the difference, and it would later be read back as if the firm
 * had done something in September.
 *
 * So the derivation may not read our own sighting date, and this test is what
 * stops a later coverage push from quietly COALESCEing one in.
 *
 * The two-year minimum and the 75-day span limit are NOT retested here - they
 * live in `deriveWindow`, which this script calls rather than reimplements, and
 * they are covered by scripts/test/opening-history.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deriveWindow } from "../../src/lib/monitoring/opening-history";
import { observationsFromPostings, type Seed } from "../opening-history-from-postings";

const SCRIPT = "scripts/opening-history-from-postings.ts";

/** The file with its comments removed: they discuss first_detected_at at
 *  length, which is the point of them. */
function codeOf(path: string): string {
  return fs
    .readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

test("the derivation never reads our own sighting date", () => {
  const code = codeOf(SCRIPT);
  for (const forbidden of ["first_detected_at", "firstDetectedAt"]) {
    assert.ok(
      !code.includes(forbidden),
      `${SCRIPT} reads ${forbidden}. A predicted opening window must come from ` +
        `the firm's own published_at only - our first sighting is a fact about ` +
        `our crawl schedule, not about the firm.`,
    );
  }
});

test("the prediction goes in as a prediction, so a real sighting outranks it", () => {
  const code = codeOf(SCRIPT);
  assert.ok(
    code.includes('source: "prediction"'),
    `${SCRIPT} must record source "prediction", which ranks last in ` +
      `opening-signals precedence. A derived guess must never outrank a firm ` +
      `announcement, a live sighting, or a student's report.`,
  );
  assert.ok(
    code.includes("recordOpeningSignal"),
    `${SCRIPT} must write through recordOpeningSignal rather than its own ` +
      `insert, so the precedence and evidence rules apply to it too.`,
  );
  assert.ok(
    code.includes("deriveWindow"),
    `${SCRIPT} must call deriveWindow rather than reimplement the two-cycle ` +
      `minimum and the 75-day span limit.`,
  );
});

const seed = (cycle: number, published: string, title = "Summer Analyst"): Seed => ({
  firm_id: "f",
  firm: "Firm",
  category: null,
  cycle,
  first_published: published,
  url: `https://example.test/${cycle}`,
  title,
});

test("two cycles posted in one calendar year are one observation, not two", () => {
  // Leerink Partners' real shape: cycle 2027 and cycle 2028 posted eight days
  // apart in September 2026. One burst, two cycle labels.
  const obs = observationsFromPostings([seed(2027, "2026-09-10"), seed(2028, "2026-09-18")]);
  assert.equal(
    obs.length,
    1,
    "two postings in the same calendar year are one year of evidence, however " +
      "many cycles they are labelled for",
  );
  assert.equal(
    deriveWindow(obs),
    null,
    "and one year of evidence must produce no window at all - otherwise a " +
      "single September burst becomes a prediction",
  );
});

test("the earliest posting in a year is the one that counts", () => {
  const obs = observationsFromPostings([
    seed(2027, "2026-09-18"),
    seed(2028, "2026-09-10"),
    seed(2026, "2025-11-13"),
  ]);
  assert.deepEqual(
    obs.map((o) => o.firstSeen.toISOString().slice(0, 10)),
    ["2025-11-13", "2026-09-10"],
    "one observation per calendar year, each the earliest in that year, oldest first",
  );
});

test("postings in two calendar years do produce a window", () => {
  // BDO Capital Advisors' real shape, and the only firm that qualified on
  // 13 October 2026.
  const obs = observationsFromPostings([seed(2027, "2025-11-13"), seed(2028, "2026-09-17")]);
  assert.equal(obs.length, 2);
  const win = deriveWindow(obs, new Date("2026-10-13T00:00:00Z"));
  assert.ok(win, "two calendar years within one season's span is a real pattern");
});

test("the evidence names the cycle each date was a posting for", () => {
  const obs = observationsFromPostings([seed(2027, "2025-11-13", "Investment Banking Intern")]);
  assert.equal(obs[0].matched, "Investment Banking Intern (cycle 2027)");
});
