// Fill in firms.aum from the SEC's own filings.
//
// The column has existed since the directory was built and its comment already
// names its source - Form ADV Item 5.F(2)(c) - but nothing ever populated it,
// so it is null on almost every row. Priority scoring and tiering both reach
// for firm size and both find nothing.
//
// Matched by domain, never by name: both sides carry legal entity names that
// disagree on punctuation and which affiliate filed.
//
// NEVER OVERWRITES. A row that already has a value was set deliberately by
// somebody, and Form ADV covers only SEC-registered advisers - so a null here
// means "does not file", not "manages nothing".
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-firm-aum.ts [--apply]
//
// Stop the dev server first - PGlite is single-writer.
import { openScriptDb } from "./_db";
import { eq, isNull } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { sizeForWebsite, formAdvStatus } from "../src/lib/monitoring/form-adv";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const adv = formAdvStatus();
    if (!adv.loaded) {
      throw new Error(`No Form ADV data (${adv.error ?? "file missing"}). Run scripts/ingest-form-adv.ts.`);
    }
    console.log(`Form ADV sizes loaded for ${adv.firms} firms.`);

    const rows = await db.select().from(schema.firms).where(isNull(schema.firms.aum));
    console.log(`${rows.length} firms have no AUM on file.`);

    let matched = 0;
    let zero = 0;
    for (const firm of rows) {
      const size = sizeForWebsite(firm.website);
      if (!size || size.aum === null) continue;
      // Zero is a real filing - a pure advisory firm manages nothing - and is
      // written as zero rather than skipped, because "filed zero" and "did not
      // file" are different facts and the column should be able to tell them
      // apart.
      if (size.aum === 0) zero += 1;
      matched += 1;
      if (APPLY) {
        await db.update(schema.firms).set({ aum: size.aum }).where(eq(schema.firms.id, firm.id));
      }
    }

    console.log(`${APPLY ? "filled" : "would fill"} ${matched} rows (${zero} of them a filed zero).`);
    if (!APPLY) console.log("\nDry run - pass --apply to write.");
  } finally {
    await closeDb();
  }
}

main();
