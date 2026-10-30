// Put every monitoring source on the standard (12-hour) tier.
//
// Before this, seed-monitoring-sources.ts split sources two ways: the eight
// bulge brackets went to `critical` (every 20 minutes) and everyone else to
// `standard` (every 12 hours). Seven sources ended up on the 20-minute tier,
// which is ~500 checks a day for seven firms - and since every source is
// currently read by the browser-based generic connector, that is ~500 Chromium
// renders a day to re-read pages that change a few times a year.
//
// A recruiting programme opens once per cycle. Twenty minutes buys nothing over
// twelve hours except load, on us and on them, and being the loudest client a
// careers site sees is the fastest way to get blocked.
//
// Recorded as a script rather than run as a loose SQL statement so the decision
// is replayable after a restore - the same reason repoint-sources.ts keeps its
// proposal list in the file.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/set-all-sources-standard.ts [--apply]
import { openScriptDb } from "./_db";
import { eq, ne } from "drizzle-orm";
import * as schema from "../src/db/schema";

const apply = process.argv.includes("--apply");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const tiers = await db.select().from(schema.monitoringTiers);
    const standard = tiers.find((t) => t.name === "standard");
    if (!standard) throw new Error("No 'standard' tier - run seed-monitoring-config.ts first.");

    const moving = await db.query.firmMonitoringSources.findMany({
      where: ne(schema.firmMonitoringSources.tierId, standard.id),
      with: { firm: true, tier: true },
    });

    if (moving.length === 0) {
      console.log("Every source is already on the standard tier.");
      return;
    }

    for (const s of moving) {
      console.log(`${apply ? "MOVE " : "would move "}${s.firm.name.padEnd(34)} ${s.tier.name} -> standard`);
    }

    if (apply) {
      for (const s of moving) {
        await db
          .update(schema.firmMonitoringSources)
          .set({ tierId: standard.id, updatedAt: new Date() })
          .where(eq(schema.firmMonitoringSources.id, s.id));
      }
      console.log(`\n${moving.length} source(s) moved to standard (${standard.checkIntervalMinutes} min).`);
    } else {
      console.log(`\n${moving.length} source(s) would move - pass --apply to write.`);
    }
  } finally {
    await closeDb();
  }
}

main();
