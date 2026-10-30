// The season monitor and investment banking's lead months (5 October 2026).
// IB's recruiting timeline now starts in July two summers before the
// internship (negative phase indices), because that is when its postings
// arrive. The monitor has to count those months as in season, and every other
// sector - which has no lead months - must come out exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";

import { seasonFor } from "@/lib/monitoring/season";
import { CATEGORY_TIMELINE_TRACKS, timelineLead, type FirmProgramCategory } from "@/lib/firm-metadata";
// The monitor as it was before lead months were counted, for comparison.
import { seasonForBefore } from "./helpers/season-before-lead";

const CATEGORIES = Object.keys(CATEGORY_TIMELINE_TRACKS) as FirmProgramCategory[];

test("investment banking is in season while the summer-2028 postings arrive (Aug-Dec 2026)", () => {
  for (const month of [7, 8, 9, 10, 11]) {
    const v = seasonFor("investment_banking", new Date(2026, month, 15));
    assert.equal(v.intervalMultiplier, 1, `${month + 1}/2026: ${v.reason}`);
  }
});

test("investment banking's cadence is unchanged too: its middle-market window already covered these months", () => {
  // Counting the lead months is about correctness, not a change in cadence
  // today: the middle-market track's long apply window kept IB at full cadence
  // all year, and the monitor stops at the first open window it finds. The
  // lead months keep IB covered if that window is ever narrowed.
  for (let m = 0; m < 36; m++) {
    const now = new Date(2026, m, 10);
    assert.equal(seasonFor("investment_banking", now).intervalMultiplier, seasonForBefore("investment_banking", now).intervalMultiplier);
  }
});

test("only investment banking has lead months", () => {
  for (const c of CATEGORIES) {
    assert.equal(timelineLead(CATEGORY_TIMELINE_TRACKS[c]), c === "investment_banking" ? 6 : 0, c);
  }
});

test("every other sector's verdict is unchanged, month by month for three years", () => {
  for (const c of CATEGORIES.filter((x) => x !== "investment_banking")) {
    for (let m = 0; m < 36; m++) {
      const now = new Date(2026, m, 10);
      assert.deepEqual(seasonFor(c, now), seasonForBefore(c, now), `${c} ${now.toISOString().slice(0, 7)}`);
    }
  }
});
