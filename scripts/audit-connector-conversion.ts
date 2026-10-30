// Why does a connector produce hundreds of listings and publish almost none?
//
// The open question from 19 September: Oracle HCM and iCIMS hold 1,026
// listings between them and have published 2. High rejection is often
// correct - 353 of Kroll's 381 are genuinely not internships - but iCIMS at
// 298 of 298 rejected, with not one pending and not one approved, is a
// pattern rather than a coincidence.
//
// This reads the rejection REASONS rather than the counts, because the counts
// have already been looked at twice and said nothing. The reason lives in
// `classification.reasonForUncertainty`, a field no reviewer sees - which is
// exactly how 59 wrongly rejected internships stayed hidden last time.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/audit-connector-conversion.ts [connector]
//
// Read-only. Stop the dev server first - PGlite is single-writer.
import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";

const ONLY = process.argv[2] ?? null;

type Classification = {
  relevant?: boolean;
  sector?: string;
  recruitingCycle?: string;
  confidence?: number;
  reasonForUncertainty?: string;
  needsHumanReview?: boolean;
};

/** Reasons carry the specific title that failed, which makes every one
 *  unique and a frequency count useless. This strips the variable part so
 *  the SHAPE of the rejection is countable. */
function reasonShape(reason: string): string {
  return reason
    .replace(/\([^)]*\)/g, "(...)")
    .replace(/"[^"]*"/g, '"..."')
    .replace(/\b\d{4}\b/g, "YYYY")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const sources = await db.query.firmMonitoringSources.findMany({ with: { firm: true } });
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const listings = await db.select().from(schema.detectedListings);

    const byConnector = new Map<string, typeof listings>();
    for (const listing of listings) {
      const source = sourceById.get(listing.sourceId);
      if (!source) continue;
      if (ONLY && source.connectorId !== ONLY) continue;
      byConnector.set(source.connectorId, [...(byConnector.get(source.connectorId) ?? []), listing]);
    }

    for (const [connectorId, rows] of [...byConnector].sort((a, b) => b[1].length - a[1].length)) {
      const statuses: Record<string, number> = {};
      const reasons: Record<string, number> = {};
      const sectors: Record<string, number> = {};
      const cycles: Record<string, number> = {};
      let noClassification = 0;

      for (const row of rows) {
        statuses[row.reviewStatus] = (statuses[row.reviewStatus] ?? 0) + 1;
        const c = row.classification as Classification | null;
        if (!c) {
          noClassification += 1;
          continue;
        }
        if (c.reasonForUncertainty) {
          const shape = reasonShape(c.reasonForUncertainty);
          reasons[shape] = (reasons[shape] ?? 0) + 1;
        }
        if (c.sector) sectors[c.sector] = (sectors[c.sector] ?? 0) + 1;
        if (c.recruitingCycle) cycles[c.recruitingCycle] = (cycles[c.recruitingCycle] ?? 0) + 1;
      }

      console.log(`\n${"=".repeat(70)}\n${connectorId}: ${rows.length} listings`);
      console.log("  review status:", JSON.stringify(statuses));
      if (noClassification) console.log(`  ${noClassification} with NO classification at all`);
      if (Object.keys(sectors).length) console.log("  sector:", JSON.stringify(sectors));
      if (Object.keys(cycles).length) console.log("  cycle:", JSON.stringify(cycles));

      const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (top.length) {
        console.log("  top rejection shapes:");
        for (const [shape, n] of top) console.log(`    ${String(n).padStart(4)}  ${shape}`);
      }

      // The listings that got closest to publication are the most useful
      // thing here: if a connector's near-misses all share one cause, that
      // cause is the connector's conversion problem.
      const nearMiss = rows
        .filter((r) => {
          const c = r.classification as Classification | null;
          return c?.relevant === true && r.reviewStatus === "rejected";
        })
        .slice(0, 5);
      if (nearMiss.length) {
        console.log("  RELEVANT but rejected (these are the suspicious ones):");
        for (const row of nearMiss) {
          const c = row.classification as Classification | null;
          console.log(`    - ${row.title.slice(0, 70)}`);
          console.log(`      ${c?.reasonForUncertainty ?? "(no reason recorded)"}`);
        }
      }
    }
  } finally {
    await closeDb();
  }
}

main();
