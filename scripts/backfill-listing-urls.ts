// Repair stored listing_urls that were never absolute.
//
// The connectors are fixed (see resolvedPublicHttpUrl in lib/safe-url.ts), but
// that only governs what arrives from now on. Measured 12 October 2026: 3,492
// rows already stored a relative or unopenable address - 3,488 from
// `eightfold`, whose API returns `positionUrl` as a path, and four
// `javascript:void(0)` anchors from the generic connector's DOM scan.
//
// Every one of them is currently withheld from students by the absolute-URL
// check in posting-quality.ts, which is correct and also why repairing them is
// worth doing: the listing is real, only its address was broken.
//
// WHAT IT WILL NOT DO
//  - It never invents a host. The path is resolved against the board the
//    listing was found on (`firm_monitoring_sources.careers_url`) and then put
//    through `publicHttpUrl`, exactly as a fresh crawl now does.
//  - It never touches a row whose address is already absolute.
//  - It never changes a review status. A repaired address makes a listing
//    eligible for the publish gate; it does not decide the gate's answer.
//    `reclassify-listings.ts` is what re-decides, deliberately separate.
//  - An address that cannot be resolved into something openable is left
//    alone and reported, not blanked - a `javascript:void(0)` row is page
//    furniture and belongs in the rejection it already has.
//
// Dry-run by default. Writes a dated record under scripts/data/ BEFORE any
// update, because this changes live rows and detected_listings keeps no
// history of its own.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-listing-urls.ts
//   ... --apply
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";

import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";
import { resolvedPublicHttpUrl } from "../src/lib/safe-url";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const sources = await db
      .select({
        id: schema.firmMonitoringSources.id,
        careersUrl: schema.firmMonitoringSources.careersUrl,
        connectorId: schema.firmMonitoringSources.connectorId,
      })
      .from(schema.firmMonitoringSources);
    const boardOf = new Map(sources.map((s) => [s.id, s]));

    const listings = await db
      .select({
        id: schema.detectedListings.id,
        sourceId: schema.detectedListings.sourceId,
        title: schema.detectedListings.title,
        listingUrl: schema.detectedListings.listingUrl,
        applicationUrl: schema.detectedListings.applicationUrl,
      })
      .from(schema.detectedListings);

    const absolute = (u: string | null) => /^https?:\/\//i.test(u ?? "");
    const broken = listings.filter((l) => l.listingUrl && !absolute(l.listingUrl));

    const repairs: {
      id: string;
      connector: string;
      title: string;
      from: string;
      to: string;
      applicationFrom: string | null;
      applicationTo: string | null;
    }[] = [];
    const unresolvable: { id: string; connector: string; from: string }[] = [];

    for (const l of broken) {
      const board = boardOf.get(l.sourceId);
      const fixed = resolvedPublicHttpUrl(l.listingUrl, board?.careersUrl ?? null);
      if (!fixed) {
        unresolvable.push({
          id: l.id,
          connector: board?.connectorId ?? "?",
          from: l.listingUrl ?? "",
        });
        continue;
      }
      // The application URL is the same address on every connector that got
      // this wrong, so it is repaired together - but only when it was the
      // same broken value, never overwritten from something else.
      const appFixed =
        l.applicationUrl === l.listingUrl
          ? fixed
          : !absolute(l.applicationUrl)
            ? resolvedPublicHttpUrl(l.applicationUrl, board?.careersUrl ?? null)
            : l.applicationUrl;

      repairs.push({
        id: l.id,
        connector: board?.connectorId ?? "?",
        title: l.title.slice(0, 70),
        from: l.listingUrl ?? "",
        to: fixed,
        applicationFrom: l.applicationUrl,
        applicationTo: appFixed,
      });
    }

    const byConnector = new Map<string, number>();
    for (const r of repairs) byConnector.set(r.connector, (byConnector.get(r.connector) ?? 0) + 1);

    console.log(`${broken.length} stored listings carry a non-absolute address.`);
    console.log(`  repairable: ${repairs.length}`);
    for (const [c, n] of [...byConnector].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${c}`);
    }
    console.log(`  unresolvable (left as they are): ${unresolvable.length}`);
    for (const u of unresolvable.slice(0, 10)) console.log(`    ${u.connector}: ${u.from}`);

    for (const r of repairs.slice(0, 5)) {
      console.log(`\n  e.g. ${r.title}`);
      console.log(`       ${r.from}`);
      console.log(`    -> ${r.to}`);
    }

    if (!APPLY) {
      console.log("\nDry run - nothing written. Pass --apply to repair.");
      return;
    }
    if (repairs.length === 0) {
      console.log("\nNothing to repair.");
      return;
    }

    // Recorded BEFORE the write: detected_listings keeps no history, so this
    // file is the only way back.
    const stamp = new Date().toISOString().slice(0, 10);
    const out = path.join(process.cwd(), "scripts/data", `listing-url-repair-${stamp}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), repairs, unresolvable }, null, 2));
    console.log(`\nRecorded ${repairs.length} before/after pairs to ${out}`);

    let done = 0;
    for (const r of repairs) {
      await db
        .update(schema.detectedListings)
        .set({ listingUrl: r.to, applicationUrl: r.applicationTo, updatedAt: new Date() })
        .where(eq(schema.detectedListings.id, r.id));
      done += 1;
      if (done % 500 === 0) console.log(`  ${done}/${repairs.length}`);
    }
    console.log(`\n${done} addresses repaired.`);
    console.log("Run reclassify-listings.ts next: a repaired address makes a listing");
    console.log("eligible for the publish gate, it does not decide it.");
  } finally {
    await closeDb();
  }
}

main();
