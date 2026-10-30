// Spot-check what the classifier called relevant. The coverage audit counts
// rows; this prints the actual titles, because "17 firms with dated listings"
// is only a real number if those listings are really student internships.
//
//   npx tsx --conditions=react-server scripts/audit-titles.ts
import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const firms = await db.select().from(schema.firms);
    const sources = await db.select().from(schema.firmMonitoringSources);
    const listings = await db.select().from(schema.detectedListings);

    const firmName = new Map(firms.map((f) => [f.id, f.name]));
    const sourceFirm = new Map(sources.map((s) => [s.id, s.firmId]));

    const byFirm = new Map<string, { title: string; dated: boolean; conn: string }[]>();
    const connBySource = new Map(sources.map((s) => [s.id, s.connectorId]));

    for (const l of listings) {
      if ((l.classification as { relevant?: boolean } | null)?.relevant !== true) continue;
      const fid = sourceFirm.get(l.sourceId);
      if (!fid) continue;
      const name = firmName.get(fid) ?? "?";
      const rows = byFirm.get(name) ?? [];
      rows.push({
        title: l.title,
        dated: l.publishedAt !== null,
        conn: connBySource.get(l.sourceId) ?? "?",
      });
      byFirm.set(name, rows);
    }

    for (const [name, rows] of [...byFirm].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`\n${name}  (${rows.length}, ${rows[0].conn})`);
      for (const r of rows.slice(0, 6)) {
        console.log(`   ${r.dated ? "[date]" : "[    ]"} ${r.title}`);
      }
      if (rows.length > 6) console.log(`   ... ${rows.length - 6} more`);
    }
  } finally {
    await closeDb();
  }
}

main();
