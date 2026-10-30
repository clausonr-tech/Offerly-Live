// Seeds the two configuration tables the monitoring system reads at runtime -
// monitoring_tiers and sector_priorities. Both are meant to be edited by an
// admin later without a code change; this just gets sane defaults in place.
//
// Idempotent: re-running updates existing rows (matched by their unique name/
// category) rather than duplicating them.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/seed-monitoring-config.ts
//
// Stop the dev server first - PGlite is single-writer.
import type { Db } from "../src/db/types";
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { FirmProgramCategory } from "../src/lib/firm-metadata";

let db!: Db;

const TIERS: {
  name: string;
  checkIntervalMinutes: number | null;
  description: string;
  sortOrder: number;
}[] = [
  {
    name: "critical",
    checkIntervalMinutes: 20,
    description: "Highest-priority investment banks during likely opening periods.",
    sortOrder: 1,
  },
  {
    name: "high",
    checkIntervalMinutes: 120,
    description: "Other time-sensitive finance employers.",
    sortOrder: 2,
  },
  {
    name: "standard",
    checkIntervalMinutes: 720,
    description: "Known internship employers outside the highest-urgency set.",
    sortOrder: 3,
  },
  {
    name: "discovery",
    checkIntervalMinutes: 10080,
    description: "Firms without a confirmed internship history yet.",
    sortOrder: 4,
  },
  {
    name: "inactive",
    checkIntervalMinutes: null,
    description: "No usable career page or relevant program - not polled automatically.",
    sortOrder: 5,
  },
];

// Investment banking first, per the product's explicit priority order; the
// unlisted FirmProgramCategory values (venture_capital, insurance, fintech,
// market_infrastructure, consulting) are slotted in sensibly rather than
// left unranked, with other_finance kept last as the deliberate catch-all.
const SECTOR_PRIORITIES: { category: FirmProgramCategory; priorityRank: number; description: string }[] = [
  { category: "investment_banking", priorityRank: 1, description: "Top priority - bulge bracket, elite boutique, middle-market, regional, and industry-specific." },
  { category: "private_equity", priorityRank: 2, description: "Includes growth equity." },
  { category: "venture_capital", priorityRank: 3, description: "" },
  { category: "sales_trading", priorityRank: 4, description: "" },
  { category: "hedge_fund", priorityRank: 5, description: "" },
  { category: "private_credit", priorityRank: 6, description: "" },
  { category: "asset_wealth_management", priorityRank: 7, description: "Includes equity research." },
  { category: "commercial_banking", priorityRank: 8, description: "" },
  { category: "real_estate", priorityRank: 9, description: "Real estate finance." },
  { category: "consulting", priorityRank: 10, description: "" },
  { category: "insurance", priorityRank: 11, description: "" },
  { category: "fintech", priorityRank: 12, description: "" },
  { category: "market_infrastructure", priorityRank: 13, description: "" },
  { category: "other_finance", priorityRank: 14, description: "Catch-all, deliberately lowest priority." },
];

async function main() {
  ({ db } = await openScriptDb());
  for (const tier of TIERS) {
    const existing = await db.query.monitoringTiers.findFirst({
      where: eq(schema.monitoringTiers.name, tier.name),
    });
    if (existing) {
      await db.update(schema.monitoringTiers).set(tier).where(eq(schema.monitoringTiers.id, existing.id));
    } else {
      await db.insert(schema.monitoringTiers).values(tier);
    }
  }
  console.log(`monitoring_tiers: ${TIERS.length} rows seeded/updated`);

  for (const sector of SECTOR_PRIORITIES) {
    const existing = await db.query.sectorPriorities.findFirst({
      where: eq(schema.sectorPriorities.category, sector.category),
    });
    if (existing) {
      await db
        .update(schema.sectorPriorities)
        .set(sector)
        .where(eq(schema.sectorPriorities.id, existing.id));
    } else {
      await db.insert(schema.sectorPriorities).values(sector);
    }
  }
  console.log(`sector_priorities: ${SECTOR_PRIORITIES.length} rows seeded/updated`);

  process.exit(0);
}

main();
