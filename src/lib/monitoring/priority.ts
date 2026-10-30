import "server-only";
import { count, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { firmMonitoringSources, userTopFirms, openingSignals } from "@/db/schema";
import { windowUrgency } from "./opening-window";

// Takes `db` as a parameter rather than calling getDb() itself. Every
// monitoring script (seed-monitoring-sources.ts, monitor-run.ts) opens its
// own direct PGlite connection, the same convention every other script in
// this repo uses - calling getDb() from inside this function would open a
// SECOND, independent PGlite connection to the same directory in the same
// process, and the two don't see each other's writes. That bug shipped once
// already: every source after the first scored 0 because this function's own
// getDb() connection couldn't see rows the seed script had just inserted
// through its own connection.

// Categories where assets under management actually signals firm scale.
// Pure advisory shops (most investment banks) file no AUM at all, so scoring
// AUM outside this set would just reward "happens to have a number" over
// "is actually a bigger deal" - the same scoping rule firms.aum's own column
// comment establishes.
export const AUM_RELEVANT_SECTORS = new Set([
  "private_equity",
  "venture_capital",
  "private_credit",
  "hedge_fund",
  "asset_wealth_management",
]);

// Enough students top-listing a firm promotes it a full tier faster than its
// sector/history alone would justify - "a small investment bank with
// significant student interest should outrank a large but irrelevant one."
export const DEMAND_TIER_PROMOTION_THRESHOLD = 5;

/**
 * ONE-BASED. Rank 1 is the top sector, not rank 0.
 *
 * `sector_priorities.priority_rank` runs 1..14 - investment_banking is 1,
 * other_finance is 14 - so every real caller is already correct. But the
 * formula has no floor, and a zero-based rank is the natural instinct in
 * JavaScript: `sectorWeight(0, 14)` returns 32.14, over the 30-point budget
 * this weight is documented to live inside, with nothing raising an error.
 *
 * Clamped rather than thrown, because a priority score is not worth failing a
 * crawl over - and clamped rather than left alone, because a weight that
 * silently exceeds its budget cannot be reasoned about against the other
 * components. Found by the sector-weight budget test, not in production.
 */
export function sectorWeight(priorityRank: number, totalSectors: number): number {
  // Rank 1 (investment banking) scores highest; linear falloff is enough for
  // v1 - the point is ORDER, not the exact gap between adjacent sectors.
  const rank = Math.min(Math.max(priorityRank, 1), totalSectors);
  return ((totalSectors - rank + 1) / totalSectors) * 30;
}

export function demandWeight(topFirmCount: number): number {
  return Math.min(20, topFirmCount * 4);
}

export function aumTierBonus(aum: number | null, sectorCategory: string): number {
  if (aum === null || !AUM_RELEVANT_SECTORS.has(sectorCategory)) return 0;
  if (aum >= 100_000_000_000) return 10; // $100B+
  if (aum >= 10_000_000_000) return 6; // $10B+
  if (aum >= 1_000_000_000) return 3; // $1B+
  return 0;
}

export async function computePriorityScore(db: Db, sourceId: string): Promise<number> {
  const source = await db.query.firmMonitoringSources.findFirst({
    where: eq(firmMonitoringSources.id, sourceId),
    with: { firm: true },
  });
  if (!source) return 0;

  const allSectors = await db.query.sectorPriorities.findMany();
  const sectorRow = allSectors.find((s) => s.category === source.sectorCategory);
  const totalSectors = allSectors.length || 1;
  const rank = sectorRow?.priorityRank ?? totalSectors; // unranked sectors fall to the back

  const [{ topFirmCount }] = await db
    .select({ topFirmCount: count() })
    .from(userTopFirms)
    .where(eq(userTopFirms.firmId, source.firmId));

  let score = 0;
  score += sectorWeight(rank, totalSectors);
  score += demandWeight(topFirmCount);
  score += source.firm.hasVerifiedProgram ? 15 : 0;
  score += aumTierBonus(source.firm.aum, source.sectorCategory);
  score += source.hasConfirmedInternshipHistory ? 10 : 0;
  score += source.isRolling ? 5 : 0;

  if (source.sourceHealth === "degraded") score -= 10;
  if (source.sourceHealth === "broken") score -= 25;

  /**
   * A firm about to open, by its own history, sorts to the front.
   *
   * The score decides ORDER, and order decides who survives the `--limit 110`
   * the scheduled crawl runs with. So the interval multiplier in
   * opening-window.ts is only half the mechanism: bringing a source's
   * nextCheckAt forward achieves nothing if a hundred higher-scoring sources
   * are ahead of it in the same run.
   *
   * The boost is large enough to beat sector rank and demand - up to 50,
   * against a sector weight in the tens - because "this firm posts its
   * internships in the next three days" is a better reason to look than "this
   * sector is generally important". It is also transient by construction: it
   * is recomputed from today's date, so it decays to zero on its own once the
   * window passes, with nothing to clean up.
   *
   * Only positive. A prediction may not push a firm DOWN the queue.
   */
  const predictions = await db.query.openingSignals.findMany({
    where: eq(openingSignals.firmId, source.firmId),
  });
  let bestBoost = 0;
  for (const row of predictions) {
    if (row.source !== "prediction" || !row.opensStart || !row.opensEnd) continue;
    const urgency = windowUrgency({ opensStart: row.opensStart, opensEnd: row.opensEnd });
    if (urgency.priorityBoost > bestBoost) bestBoost = urgency.priorityBoost;
  }
  score += bestBoost;

  return Math.round(score * 100) / 100;
}

/** True when a firm's own-student demand is high enough to justify a faster
 *  tier than its sector/history alone would put it in. The scheduler script
 *  applies this at seed/refresh time - it doesn't gate scoring itself. */
export async function shouldPromoteForDemand(db: Db, firmId: string): Promise<boolean> {
  const [{ topFirmCount }] = await db
    .select({ topFirmCount: count() })
    .from(userTopFirms)
    .where(eq(userTopFirms.firmId, firmId));
  return topFirmCount >= DEMAND_TIER_PROMOTION_THRESHOLD;
}
