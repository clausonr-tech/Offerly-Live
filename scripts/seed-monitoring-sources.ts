// Registers monitoring sources for firms whose careers URL we already know.
//
// ALL FOURTEEN SECTORS, not just investment banking.
//
// This script used to select `category = 'investment_banking'` AND
// `hasVerifiedProgram = true`, and hardcode "investment_banking" into every
// row it wrote. That was the right first step in the vertical slice and it is
// the reason, measured 20 September 2026, that six of fourteen sectors have
// sources and eight have none.
//
// Probing cannot close that gap, because probe-boards.ts skips any firm that
// already has a careers URL - it exists to FIND boards for firms with none.
// The eight empty sectors are mostly the opposite problem:
//
//   commercial_banking     908 firms, 903 with a careers URL, 0 sources
//   insurance              159 firms, 150 with a careers URL, 0 sources
//   fintech                 63 firms,  45 with a careers URL, 0 sources
//   sales_trading          171 firms,  37 with a careers URL, 0 sources
//   private_credit         148 firms,  32 with a careers URL, 0 sources
//   market_infrastructure   27 firms,  23 with a careers URL, 0 sources
//   consulting               2 firms,   2 with a careers URL, 0 sources
//
// Roughly 1,190 firms whose board address is already sitting in the
// directory, unreachable by the probe and unregistered by the only script
// that could register them.
//
// It also opened PGlite directly, so on a project that now runs on Supabase
// it would have reported sources registered and written them where nothing
// reads.
//
// WHAT CONTROLS VOLUME. Not this script: `decideEnrollment` and
// `isWorthCrawling` in enrollment.ts do, and they want a confirmed programme,
// a real ATS connector, 50+ employees or $1B+ AUM. Dropping the
// verified-program filter hands them more candidates to judge; it does not
// lower the bar. Pass --verified-only to keep the old, narrower selection.
//
// Idempotent: skips a firm that already has a source registered, and skips a
// board another firm already points at.
//
// DRY RUN BY DEFAULT - pass --apply to write.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/seed-monitoring-sources.ts
//   npx tsx --env-file=.env.local --conditions=react-server scripts/seed-monitoring-sources.ts --category insurance
//   npx tsx --env-file=.env.local --conditions=react-server scripts/seed-monitoring-sources.ts --apply
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { detectConnector } from "../src/lib/monitoring/connectors";
import { FIRM_TIER_BY_SLUG } from "../src/lib/firm-content";
import { computePriorityScore } from "../src/lib/monitoring/priority";
import {
  decideEnrollment,
  ENABLED_CATEGORIES,
  type FirmForEnrollment,
} from "../src/lib/monitoring/enrollment";
import { dedupKey } from "../src/lib/monitoring/board-identity";
import { sizeForWebsite } from "../src/lib/monitoring/form-adv";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const APPLY = process.argv.includes("--apply");
const VERIFIED_ONLY = process.argv.includes("--verified-only");
const ONLY_CATEGORY = arg("category");

async function main() {
  // Follows DATABASE_URL, like the scripts ported before it.
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}${APPLY ? "" : "  (dry run)"}`);
  const tiers = await db.query.monitoringTiers.findMany();
  const tierByName = new Map(tiers.map((t) => [t.name, t]));
  if (!tierByName.get("critical") || !tierByName.get("standard")) {
    throw new Error("Run scripts/seed-monitoring-config.ts first - tiers not seeded.");
  }

  const programRows = await db
    .select({
      firmId: schema.firms.id,
      slug: schema.firms.slug,
      name: schema.firms.name,
      hasVerifiedProgram: schema.firms.hasVerifiedProgram,
      careersUrl: schema.firmPrograms.careersUrl,
      category: schema.firmPrograms.category,
    })
    .from(schema.firmPrograms)
    .innerJoin(schema.firms, eq(schema.firmPrograms.firmId, schema.firms.id))
    .where(
      and(
        ...(ONLY_CATEGORY
          ? [eq(schema.firmPrograms.category, ONLY_CATEGORY as "investment_banking")]
          : []),
        ...(VERIFIED_ONLY ? [eq(schema.firms.hasVerifiedProgram, true)] : []),
      ),
    );

  // One source per firm, not per program - a firm's programs share a career
  // site, so registering each separately would just poll the same URL twice.
  const byFirm = new Map<
    string,
    {
      firmId: string;
      slug: string;
      name: string;
      careersUrl: string;
      category: string;
      hasVerifiedProgram: boolean;
    }
  >();
  for (const row of programRows) {
    if (!row.careersUrl) continue;
    // A category nobody has enabled is not a candidate. ENABLED_CATEGORIES
    // lists all fourteen today, so this is a guard rather than a filter - but
    // it is the guard that used to be a hardcoded "investment_banking".
    if (!ENABLED_CATEGORIES.has(row.category)) continue;
    if (!byFirm.has(row.firmId)) {
      byFirm.set(row.firmId, {
        firmId: row.firmId,
        slug: row.slug,
        name: row.name,
        careersUrl: row.careersUrl,
        category: row.category,
        hasVerifiedProgram: row.hasVerifiedProgram,
      });
    }
  }

  let inserted = 0;
  let skipped = 0;
  const insertedBySector = new Map<string, number>();
  const skippedBySector = new Map<string, number>();

  /**
   * Boards already registered, by IDENTITY rather than by firm.
   *
   * The old check was "does this firm already have a source", which cannot
   * see two firms pointing at one board - the exact hole that left Stifel and
   * Miller Buckfire both polling careers-stifel.icims.com, and 353 duplicate
   * listing rows behind five such pairs.
   */
  const existing = await db.select().from(schema.firmMonitoringSources);
  const seenKeys = new Set(existing.map((s) => dedupKey(s.careersUrl, s.connectorId)));
  const firmsWithSource = new Set(existing.map((s) => s.firmId));

  const tierByNameLookup = new Map(tiers.map((t) => [t.name, t]));

  for (const firm of byFirm.values()) {
    if (firmsWithSource.has(firm.firmId)) {
      skipped += 1;
      skippedBySector.set(firm.category, (skippedBySector.get(firm.category) ?? 0) + 1);
      continue;
    }

    const firmRow = await db.query.firms.findFirst({
      where: eq(schema.firms.id, firm.firmId),
    });
    const size = sizeForWebsite(firmRow?.website);
    const connector = detectConnector(firm.careersUrl);

    /**
     * The same rule every other path uses.
     *
     * This script used to decide for itself - hardcoding investment banking,
     * splitting tiers two ways on bulge-bracket status, and checking for
     * duplicates by firm. Those judgements now live in enrollment.ts so that
     * "added to the directory" and "considered for the crawler" mean the same
     * thing however a firm arrives.
     */
    const forEnrollment: FirmForEnrollment = {
      slug: firm.slug,
      name: firm.name,
      website: firmRow?.website ?? null,
      category: firm.category,
      aum: firmRow?.aum ?? size?.aum ?? null,
      employees: size?.employees ?? null,
      hasVerifiedProgram: firm.hasVerifiedProgram,
      ibTier: FIRM_TIER_BY_SLUG[firm.slug]?.ibTier ?? null,
    };

    const decision = decideEnrollment(
      forEnrollment,
      {
        careersUrl: firm.careersUrl,
        connectorId: connector.id,
        // These are seeds, not probe results: nothing has been fetched yet, so
        // the board is a claim rather than a demonstrated source.
        verifiedParsing: false,
      },
      seenKeys,
    );

    if (decision.action === "skip" || decision.action === "duplicate") {
      skipped += 1;
      skippedBySector.set(firm.category, (skippedBySector.get(firm.category) ?? 0) + 1);
      continue;
    }

    const tier = tierByNameLookup.get(decision.tier);
    if (!tier) throw new Error(`tier "${decision.tier}" not seeded`);

    if (APPLY) {
      const [source] = await db
        .insert(schema.firmMonitoringSources)
        .values({
          firmId: firm.firmId,
          careersUrl: decision.careersUrl,
          sourceType: decision.sourceType,
          connectorId: decision.connectorId,
          // The firm's OWN sector. Hardcoding investment_banking here is what
          // made every source this script ever wrote an IB source, whatever
          // the firm actually does.
          sectorCategory: firm.category as typeof schema.firmMonitoringSources.$inferInsert.sectorCategory,
          // Only claim confirmed history when the firm really has a verified
          // programme. It was hardcoded true, which was safe while the query
          // selected verified firms only and is a false statement now.
          hasConfirmedInternshipHistory: firm.hasVerifiedProgram,
          tierId: tier.id,
          notes: decision.reason,
        })
        .returning();

      const priorityScore = await computePriorityScore(db, source.id);
      await db
        .update(schema.firmMonitoringSources)
        .set({ priorityScore })
        .where(eq(schema.firmMonitoringSources.id, source.id));
      console.log(`+ [${firm.category}] ${firm.name} -> ${decision.connectorId} (${decision.tier}, score ${priorityScore})`);
    } else {
      console.log(`+ [${firm.category}] ${firm.name} -> ${decision.connectorId} (${decision.tier})`);
    }

    // Reserved whether or not we wrote, so a dry run reports the same
    // duplicate decisions a real one would make.
    seenKeys.add(decision.dedupKey);
    insertedBySector.set(firm.category, (insertedBySector.get(firm.category) ?? 0) + 1);
    inserted += 1;
  }

  // Per sector, never one total - a result that names only investment banking
  // firms does not answer whether the crawler covers the other thirteen.
  console.log(`\n${APPLY ? "registered" : "would register"} ${inserted} source(s), ${skipped} skipped.`);
  if (insertedBySector.size) {
    console.log("\nby sector:");
    for (const [sector, n] of [...insertedBySector].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sector.padEnd(24)} ${String(n).padStart(5)}`);
    }
  }
  if (skippedBySector.size) {
    console.log("\nskipped, by sector:");
    for (const [sector, n] of [...skippedBySector].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sector.padEnd(24)} ${String(n).padStart(5)}`);
    }
  }
  if (!APPLY) console.log("\nDry run - pass --apply to write.");
  await opened.close();
}

main();
