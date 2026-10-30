// When the crawler comes back, in every sector.
//
// Scheduling is where accuracy and cost meet. Check too rarely and a posting
// opens and closes unseen; check too often and 4,950 sources become a bill and
// a rate limit. Three rules decide it, and all three multiply:
//
//   tier interval    how important this firm is
//   seasonFor        whether this SECTOR is recruiting right now
//   windowUrgency    whether THIS firm's own history says it is about to open
//
// The sector one is the reason this file is parameterised. A seasonal rule
// tuned to banking would slow every other industry down during the months
// those industries actually recruit - and the sectors with the fewest sources
// are the ones that cannot afford a missed window.
//
// One-way by design: a prediction may only ever speed a source UP. It is the
// weakest evidence in the system and must never be able to silence a board.

import { test } from "node:test";
import assert from "node:assert/strict";
import { windowUrgency, applyUrgency, MIN_INTERVAL_MS } from "../../src/lib/monitoring/opening-window";
import { seasonFor } from "../../src/lib/monitoring/season";
import { sectorWeight, demandWeight, aumTierBonus, AUM_RELEVANT_SECTORS } from "../../src/lib/monitoring/priority";
import type { FirmProgramCategory } from "../../src/lib/firm-metadata";

const SECTORS: FirmProgramCategory[] = [
  "investment_banking", "private_equity", "venture_capital", "private_credit",
  "real_estate", "hedge_fund", "sales_trading", "asset_wealth_management",
  "commercial_banking", "insurance", "fintech", "market_infrastructure",
  "consulting", "other_finance",
];

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const NOW = new Date("2026-09-20T12:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

// ------------------------------------------------------------ tier intervals

const TIERS: [string, number][] = [
  ["critical", 60 * 60_000],
  ["high", 120 * 60_000],
  ["standard", 720 * 60_000],
  ["discovery", 43200 * 60_000],
];

for (const [tier, intervalMs] of TIERS) {
  test(`${tier}: no urgency leaves the interval alone`, () => {
    const u = windowUrgency(null, NOW);
    assert.equal(applyUrgency(intervalMs, u), intervalMs);
  });

  test(`${tier}: the floor is never breached, whatever the multiplier`, () => {
    // A 15-minute floor is the politeness guarantee. No prediction, however
    // confident, may turn a source into a hammer.
    const hot = { intervalMultiplier: 0.0001, inSeason: true, reason: "test", priorityBoost: 0, imminent: true };
    assert.ok(applyUrgency(intervalMs, hot) >= MIN_INTERVAL_MS);
  });

  test(`${tier}: an urgency multiplier never produces a fractional millisecond`, () => {
    const u = { intervalMultiplier: 0.333333, inSeason: true, reason: "test", priorityBoost: 0, imminent: false };
    assert.equal(applyUrgency(intervalMs, u) % 1, 0);
  });
}

// -------------------------------------------------- windows, read literally

test("no window is neutral, and says so", () => {
  const u = windowUrgency(null, NOW);
  assert.equal(u.intervalMultiplier, 1);
  assert.ok(u.reason.length > 0, "a neutral verdict still has to explain itself");
});

test("an undefined window is neutral, not a crash", () => {
  assert.equal(windowUrgency(undefined, NOW).intervalMultiplier, 1);
});

const BAD_WINDOWS: [unknown, string][] = [
  [{ opensStart: new Date("nonsense"), opensEnd: at(10) }, "an unreadable start"],
  [{ opensStart: at(1), opensEnd: new Date("nonsense") }, "an unreadable end"],
  [{ opensStart: at(30), opensEnd: at(10) }, "an inverted window"],
  [{ opensStart: null, opensEnd: null }, "null dates"],
  [{}, "no dates at all"],
];

for (const [window, why] of BAD_WINDOWS) {
  test(`${why} is neutral, never a guess`, () => {
    const u = windowUrgency(window as never, NOW);
    assert.equal(u.intervalMultiplier, 1, u.reason);
    assert.ok(u.reason.length > 0);
  });
}

test("a window may only ever speed a source up", () => {
  // The one-way rule. A prediction is the weakest evidence in the system and
  // must never be able to silence a board that is posting.
  for (const days of [-60, -10, -1, 0, 1, 5, 20, 60, 200, 400]) {
    const u = windowUrgency({ opensStart: at(days), opensEnd: at(days + 14) }, NOW);
    assert.ok(u.intervalMultiplier <= 1, `${days} days -> ${u.intervalMultiplier}`);
    assert.ok(u.intervalMultiplier > 0, `${days} days -> ${u.intervalMultiplier}`);
  }
});

test("being inside the window is at least as urgent as being far from it", () => {
  const inside = windowUrgency({ opensStart: at(-2), opensEnd: at(5) }, NOW);
  const distant = windowUrgency({ opensStart: at(180), opensEnd: at(200) }, NOW);
  assert.ok(inside.intervalMultiplier <= distant.intervalMultiplier);
});

test("windowUrgency never throws, whatever it is handed", () => {
  for (const w of [null, undefined, {}, { opensStart: 1, opensEnd: 2 }, "nonsense", 42]) {
    assert.doesNotThrow(() => windowUrgency(w as never, NOW));
  }
});

// ------------------------------------------------- season, for every sector

for (const sector of SECTORS) {
  test(`${sector}: has a season verdict with a stated reason`, () => {
    const v = seasonFor(sector, NOW);
    assert.ok(v.reason.length > 0, "a multiplier without a reason is unauditable");
    assert.equal(typeof v.inSeason, "boolean");
  });

  test(`${sector}: the seasonal multiplier can only slow down, never speed up`, () => {
    // Speeding up is windowUrgency's job, from a firm's OWN history. A sector
    // timeline is a generalisation and must not outrank it.
    const v = seasonFor(sector, NOW);
    assert.ok(v.intervalMultiplier >= 1, `${sector} -> ${v.intervalMultiplier}`);
  });

  test(`${sector}: is never slowed to a standstill`, () => {
    const v = seasonFor(sector, NOW);
    assert.ok(v.intervalMultiplier <= 8, `${sector} -> ${v.intervalMultiplier}`);
  });

  for (const month of [0, 3, 6, 9]) {
    test(`${sector}: month ${month + 1} produces a usable multiplier`, () => {
      const when = new Date(Date.UTC(2027, month, 15));
      const v = seasonFor(sector, when);
      assert.ok(Number.isFinite(v.intervalMultiplier) && v.intervalMultiplier >= 1, v.reason);
    });
  }
}

test("a sector with no timeline is never slowed on data we do not have", () => {
  const v = seasonFor("other_finance", NOW);
  assert.ok(v.intervalMultiplier >= 1);
});

// --------------------------------------------------------- priority weights

test("sector weight falls with rank and never goes negative", () => {
  // Ranks are ONE-based: sector_priorities.priority_rank runs 1..14.
  let previous = Infinity;
  for (let rank = 1; rank <= 14; rank++) {
    const w = sectorWeight(rank, 14);
    assert.ok(w >= 0, `rank ${rank} -> ${w}`);
    assert.ok(w <= previous, `rank ${rank} rose`);
    previous = w;
  }
});

test("sector weight stays inside its 30-point budget", () => {
  for (let rank = 1; rank <= 14; rank++) assert.ok(sectorWeight(rank, 14) <= 30, `rank ${rank}`);
  assert.equal(sectorWeight(1, 14), 30, "the top sector gets exactly the budget");
});

test("an out-of-contract rank is clamped, not allowed over budget", () => {
  // Zero-based is the natural instinct in JavaScript, and it used to return
  // 32.14 - over budget, with nothing raising an error.
  assert.equal(sectorWeight(0, 14), sectorWeight(1, 14));
  assert.equal(sectorWeight(-5, 14), sectorWeight(1, 14));
  assert.ok(sectorWeight(0, 14) <= 30);
});

test("a rank past the end is clamped to the last sector", () => {
  assert.equal(sectorWeight(99, 14), sectorWeight(14, 14));
  assert.ok(sectorWeight(99, 14) > 0, "the last sector still scores something");
});

test("demand weight rises with students and never runs away", () => {
  let previous = -1;
  for (const n of [0, 1, 2, 5, 10, 50, 500, 5000]) {
    const w = demandWeight(n);
    assert.ok(w >= previous, `${n} students fell`);
    assert.ok(w <= 100, `${n} students -> ${w}`);
    previous = w;
  }
});

test("no students is worth nothing, not a negative", () => {
  assert.equal(demandWeight(0), 0);
});

for (const sector of SECTORS) {
  const relevant = AUM_RELEVANT_SECTORS.has(sector);
  test(`${sector}: AUM ${relevant ? "counts" : "does not count"} toward priority`, () => {
    const bonus = aumTierBonus(50_000_000_000, sector);
    if (relevant) assert.ok(bonus > 0, `${sector} should reward AUM`);
    else assert.equal(bonus, 0, `${sector} should ignore AUM`);
  });

  test(`${sector}: unknown AUM is never a penalty`, () => {
    assert.ok(aumTierBonus(null, sector) >= 0);
  });
}

test("AUM bonus is monotonic where it applies", () => {
  const sector = [...AUM_RELEVANT_SECTORS][0] as string;
  let previous = -1;
  for (const aum of [0, 1e8, 1e9, 1e10, 1e11, 1e12]) {
    const b = aumTierBonus(aum, sector);
    assert.ok(b >= previous, `${aum} fell`);
    previous = b;
  }
});
