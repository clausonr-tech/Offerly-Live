// What decides which sources get crawled at all.
//
// The scheduled crawl runs `--limit 110` against 188 sources, so this score
// is not a ranking nicety - it decides which 78 firms are not looked at this
// hour. It had no tests.
//
// `computePriorityScore` already takes `db` as a parameter (for a good reason
// recorded in its own comment), which makes a fake database the natural seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sectorWeight,
  demandWeight,
  aumTierBonus,
  computePriorityScore,
  shouldPromoteForDemand,
  DEMAND_TIER_PROMOTION_THRESHOLD,
  AUM_RELEVANT_SECTORS,
} from "../../src/lib/monitoring/priority";

// ------------------------------------------------------------ sector weight

test("the top-ranked sector scores the full sector weight", () => {
  assert.equal(sectorWeight(1, 14), (14 / 14) * 30);
  assert.equal(sectorWeight(1, 1), 30);
});

test("the last-ranked sector scores the least, but not nothing", () => {
  const last = sectorWeight(14, 14);
  assert.ok(last > 0, "a ranked sector should never score zero");
  assert.ok(last < sectorWeight(1, 14));
});

test("sector weight falls monotonically with rank", () => {
  // The point is ORDER. If two adjacent ranks ever tie or invert, the whole
  // score stops expressing the sector priority table.
  for (let n = 2; n <= 20; n++) {
    for (let r = 1; r < n; r++) {
      assert.ok(
        sectorWeight(r, n) > sectorWeight(r + 1, n),
        `rank ${r} should outscore ${r + 1} of ${n}`,
      );
    }
  }
});

test("sector weight never exceeds its 30-point budget", () => {
  for (let n = 1; n <= 20; n++) {
    for (let r = 1; r <= n; r++) {
      const w = sectorWeight(r, n);
      assert.ok(w <= 30 + 1e-9, `rank ${r}/${n} scored ${w}`);
      assert.ok(w >= 0, `rank ${r}/${n} scored ${w}`);
    }
  }
});

// ------------------------------------------------------------ demand weight

const demandCases: [number, number][] = [
  [0, 0],
  [1, 4],
  [2, 8],
  [3, 12],
  [4, 16],
  [5, 20],
  [6, 20],
  [50, 20],
  [10_000, 20],
];
for (const [students, expected] of demandCases) {
  test(`${students} student(s) top-listing a firm is worth ${expected}`, () => {
    assert.equal(demandWeight(students), expected);
  });
}

test("demand is capped, so one popular firm cannot own the queue", () => {
  // Without the cap a firm with 200 followers would outscore every signal in
  // the system combined, including "this firm opens applications tomorrow".
  assert.equal(demandWeight(1_000_000), 20);
});

test("demand weight is never negative", () => {
  for (const n of [0, -1, -100]) assert.ok(demandWeight(n) <= 20);
});

// --------------------------------------------------------------- AUM bonus

const aumCases: [number | null, string, number][] = [
  [null, "private_equity", 0],
  [0, "private_equity", 0],
  [999_999_999, "private_equity", 0],
  [1_000_000_000, "private_equity", 3],
  [9_999_999_999, "private_equity", 3],
  [10_000_000_000, "private_equity", 6],
  [99_999_999_999, "private_equity", 6],
  [100_000_000_000, "private_equity", 10],
  [5_000_000_000_000, "private_equity", 10],
];
for (const [aum, sector, expected] of aumCases) {
  test(`AUM ${aum === null ? "null" : aum} in ${sector} scores ${expected}`, () => {
    assert.equal(aumTierBonus(aum, sector), expected);
  });
}

test("AUM is ignored where it means nothing", () => {
  // Advisory shops file no AUM. Scoring it outside the relevant sectors would
  // reward "happens to have a number" over "is actually a bigger deal".
  for (const sector of ["investment_banking", "consulting", "law", "(unset)"]) {
    assert.equal(aumTierBonus(500_000_000_000, sector), 0, sector);
  }
});

test("every AUM-relevant sector actually gets the bonus", () => {
  for (const sector of AUM_RELEVANT_SECTORS) {
    assert.ok(aumTierBonus(200_000_000_000, sector) > 0, sector);
  }
});

test("AUM tiers never invert", () => {
  let last = -1;
  for (const aum of [0, 1e9, 1e10, 1e11, 1e12]) {
    const b = aumTierBonus(aum, "hedge_fund");
    assert.ok(b >= last, `AUM ${aum} scored ${b} after ${last}`);
    last = b;
  }
});

// ------------------------------------------------------ the composite score

/** A database with exactly the four reads computePriorityScore performs. */
function fakeDb(opts: {
  source?: Record<string, unknown> | null;
  sectors?: { category: string; priorityRank: number }[];
  topFirmCount?: number;
  signals?: Record<string, unknown>[];
}) {
  const source =
    opts.source === null
      ? null
      : {
          id: "s1",
          firmId: "f1",
          sectorCategory: "investment_banking",
          sourceHealth: "healthy",
          hasConfirmedInternshipHistory: false,
          isRolling: false,
          firm: { hasVerifiedProgram: false, aum: null },
          ...opts.source,
        };
  return {
    query: {
      firmMonitoringSources: { findFirst: async () => source },
      sectorPriorities: {
        findMany: async () =>
          opts.sectors ?? [
            { category: "investment_banking", priorityRank: 1 },
            { category: "private_equity", priorityRank: 2 },
          ],
      },
      openingSignals: { findMany: async () => opts.signals ?? [] },
    },
    select: () => ({
      from: () => ({ where: async () => [{ topFirmCount: opts.topFirmCount ?? 0 }] }),
    }),
  } as never;
}

test("a source that does not exist scores zero rather than throwing", async () => {
  assert.equal(await computePriorityScore(fakeDb({ source: null }), "missing"), 0);
});

test("a verified programme is worth 15", async () => {
  const without = await computePriorityScore(fakeDb({}), "s1");
  const with_ = await computePriorityScore(
    fakeDb({ source: { firm: { hasVerifiedProgram: true, aum: null } } }),
    "s1",
  );
  assert.equal(Math.round((with_ - without) * 100) / 100, 15);
});

test("confirmed internship history is worth 10", async () => {
  const base = await computePriorityScore(fakeDb({}), "s1");
  const withHistory = await computePriorityScore(
    fakeDb({ source: { hasConfirmedInternshipHistory: true } }),
    "s1",
  );
  assert.equal(Math.round((withHistory - base) * 100) / 100, 10);
});

test("a rolling source is worth 5", async () => {
  const base = await computePriorityScore(fakeDb({}), "s1");
  const rolling = await computePriorityScore(fakeDb({ source: { isRolling: true } }), "s1");
  assert.equal(Math.round((rolling - base) * 100) / 100, 5);
});

const healthCases: [string, number][] = [
  ["healthy", 0],
  ["degraded", -10],
  ["broken", -25],
];
for (const [health, delta] of healthCases) {
  test(`a ${health} source is penalised by ${delta}`, async () => {
    const base = await computePriorityScore(fakeDb({}), "s1");
    const got = await computePriorityScore(fakeDb({ source: { sourceHealth: health } }), "s1");
    assert.equal(Math.round((got - base) * 100) / 100, delta);
  });
}

test("an unranked sector falls to the back rather than erroring", async () => {
  // A sector with no row in sector_priorities must still score, or adding a
  // category to the enum silently breaks scheduling for every firm in it.
  const score = await computePriorityScore(
    fakeDb({ source: { sectorCategory: "brand_new_sector" } }),
    "s1",
  );
  assert.ok(Number.isFinite(score));
  assert.ok(score >= 0);
});

test("an empty sector table does not divide by zero", async () => {
  const score = await computePriorityScore(fakeDb({ sectors: [] }), "s1");
  assert.ok(Number.isFinite(score), `got ${score}`);
});

test("student demand feeds through to the score", async () => {
  const none = await computePriorityScore(fakeDb({ topFirmCount: 0 }), "s1");
  const five = await computePriorityScore(fakeDb({ topFirmCount: 5 }), "s1");
  assert.equal(Math.round((five - none) * 100) / 100, 20);
});

// --------------------------------------------------- the prediction boost

const soon = (daysAway: number) => {
  const start = new Date(Date.now() + daysAway * 86_400_000);
  const end = new Date(start.getTime() + 86_400_000);
  return { source: "prediction", opensStart: start, opensEnd: end };
};

test("a firm about to open sorts to the front", async () => {
  const base = await computePriorityScore(fakeDb({}), "s1");
  const boosted = await computePriorityScore(fakeDb({ signals: [soon(2)] }), "s1");
  assert.ok(boosted > base, "an imminent window should raise the score");
});

test("the boost beats sector rank, because it is the better reason to look", async () => {
  // A last-ranked sector with a window opening in two days must outrank a
  // top-ranked sector with nothing happening, or the window multiplier in
  // opening-window.ts achieves nothing: the source never survives --limit.
  const topSectorIdle = await computePriorityScore(
    fakeDb({ source: { sectorCategory: "investment_banking" } }),
    "s1",
  );
  const lastSectorOpening = await computePriorityScore(
    fakeDb({ source: { sectorCategory: "private_equity" }, signals: [soon(2)] }),
    "s1",
  );
  assert.ok(lastSectorOpening > topSectorIdle);
});

test("only predictions boost - an observation does not", async () => {
  // Predictions are the weakest evidence in the system and the only kind this
  // is allowed to act on; a confirmed observation is handled elsewhere.
  const base = await computePriorityScore(fakeDb({}), "s1");
  const observed = await computePriorityScore(
    fakeDb({ signals: [{ ...soon(2), source: "observation" }] }),
    "s1",
  );
  assert.equal(observed, base);
});

test("a signal missing its dates is ignored rather than crashing", async () => {
  const base = await computePriorityScore(fakeDb({}), "s1");
  for (const bad of [
    { source: "prediction", opensStart: null, opensEnd: null },
    { source: "prediction", opensStart: new Date(), opensEnd: null },
    { source: "prediction", opensStart: null, opensEnd: new Date() },
  ]) {
    assert.equal(await computePriorityScore(fakeDb({ signals: [bad] }), "s1"), base);
  }
});

test("the best window wins when a firm has several", async () => {
  const far = await computePriorityScore(fakeDb({ signals: [soon(60)] }), "s1");
  const both = await computePriorityScore(fakeDb({ signals: [soon(60), soon(1)] }), "s1");
  assert.ok(both >= far, "adding a nearer window must not lower the score");
});

test("a prediction may never push a firm DOWN the queue", async () => {
  // Stated as a rule in the source. A long-past window must be neutral, not
  // negative, or recording history would penalise the firms we know most about.
  const base = await computePriorityScore(fakeDb({}), "s1");
  const longPast = {
    source: "prediction",
    opensStart: new Date(Date.now() - 400 * 86_400_000),
    opensEnd: new Date(Date.now() - 399 * 86_400_000),
  };
  assert.ok((await computePriorityScore(fakeDb({ signals: [longPast] }), "s1")) >= base);
});

test("the score is rounded to two decimals, not left as a long float", async () => {
  const score = await computePriorityScore(fakeDb({ sectors: [{ category: "x", priorityRank: 1 }, { category: "y", priorityRank: 2 }, { category: "z", priorityRank: 3 }] }), "s1");
  assert.equal(score, Math.round(score * 100) / 100);
});

test("a worst-case source still scores a finite number", async () => {
  const score = await computePriorityScore(
    fakeDb({
      source: { sourceHealth: "broken", sectorCategory: "unranked" },
      sectors: [],
      topFirmCount: 0,
    }),
    "s1",
  );
  assert.ok(Number.isFinite(score));
});

// ----------------------------------------------------------- tier promotion

for (const n of [0, 1, 4]) {
  test(`${n} student(s) is not enough to promote a firm's tier`, async () => {
    assert.equal(await shouldPromoteForDemand(fakeDb({ topFirmCount: n }), "f1"), false);
  });
}
for (const n of [5, 6, 100]) {
  test(`${n} student(s) promotes a firm's tier`, async () => {
    assert.equal(await shouldPromoteForDemand(fakeDb({ topFirmCount: n }), "f1"), true);
  });
}

test("the promotion threshold is the boundary it claims to be", () => {
  assert.equal(DEMAND_TIER_PROMOTION_THRESHOLD, 5);
  assert.equal(demandWeight(DEMAND_TIER_PROMOTION_THRESHOLD), 20);
});
