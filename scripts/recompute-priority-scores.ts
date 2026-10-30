// Recomputes priorityScore for every registered source - useful any time the
// inputs change (userTopFirms counts, sector_priorities edits, a source's
// health/history flags), not just once at seed time.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/recompute-priority-scores.ts
//
// Stop the dev server first - PGlite is single-writer.
import type { Db } from "../src/db/types";
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { computePriorityScore } from "../src/lib/monitoring/priority";

let db!: Db;

async function main() {
  ({ db } = await openScriptDb());
  // A plain select + join, not the relational `with: { firm: true }` form -
  // that compiles to a lateral join per row, and PGlite's WASM runtime
  // aborted outright running that shape across all 112 rows at once. A flat
  // join has no such per-row subquery to build up.
  const sources = await db
    .select({
      id: schema.firmMonitoringSources.id,
      priorityScore: schema.firmMonitoringSources.priorityScore,
      firmName: schema.firms.name,
    })
    .from(schema.firmMonitoringSources)
    .innerJoin(schema.firms, eq(schema.firmMonitoringSources.firmId, schema.firms.id));

  for (const source of sources) {
    const priorityScore = await computePriorityScore(db, source.id);
    await db
      .update(schema.firmMonitoringSources)
      .set({ priorityScore })
      .where(eq(schema.firmMonitoringSources.id, source.id));
    console.log(`${source.firmName}: ${source.priorityScore} -> ${priorityScore}`);
  }
  process.exit(0);
}

main();
