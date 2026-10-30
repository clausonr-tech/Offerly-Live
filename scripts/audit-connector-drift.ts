// Which sources are being read by the wrong connector?
//
// The scheduler looks a connector up by the STORED connectorId
// (monitor-run.ts: `getConnector(source.connectorId)`), and `detectConnector`
// runs only when a source is first registered. That is deliberate - it lets a
// source be reassigned by hand without re-detection overwriting the decision -
// but it has a consequence nothing reported until now:
//
//   ADDING A CONNECTOR DOES NOT HELP ANY SOURCE THAT ALREADY EXISTS.
//
// A firm registered on Jobvite before the Jobvite connector was written stays
// on `generic` forever. It keeps launching Chromium every check to scrape a
// page whose JSON is one request away, and the handover note records the firm
// as covered, because it is - by the wrong parser. This happened to Getro,
// Breezy and Recruitee between 18 and 19 September and nobody noticed; the
// same trap was waiting for Dayforce, BambooHR, Jobvite and Baird.
//
// Reports by default; --apply writes the corrected connectorId.
//
// Only the CONNECTOR changes - never the careers URL. Re-pointing a source at
// a different board is a decision about where to look and belongs in
// repoint-sources.ts, which records it. Choosing the right parser for a URL we
// already hold is not a decision, it is detectConnector's answer, and leaving
// it stale has a measurable cost: on 19 September Robert W. Baird was still on
// the generic connector and returned HTTP 403 every check, while the `baird`
// connector reads the sitemap the site publishes for crawlers. Morgan Stanley
// was on generic with a TalentLink URL, producing listings with no source id,
// so not one of them could be auto-approved.
//
// WHAT APPLYING COSTS
// -------------------
// The listing identity key is the connector's external id, and a real id is
// not the hash the generic connector synthesises - so a re-pointed source's
// existing rows stop matching and are replaced. That is a one-off churn and
// the right outcome: the new rows carry ids the quality gate can verify.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/audit-connector-drift.ts
//   ... --apply
//
// Stop the dev server first - PGlite is single-writer.
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { detectConnector } from "../src/lib/monitoring/connectors";

/**
 * A mismatch that is NOT drift.
 *
 * `detectConnector` returns the first connector whose `canHandle` matches, and
 * generic matches everything - so a source deliberately pinned to a
 * firm-specific connector must not be reported as wrong just because the
 * generic one would also take it.
 */
function isRealDrift(stored: string, detected: string): boolean {
  if (stored === detected) return false;
  // Detection landing on generic tells us nothing: it is the fallback, and any
  // specialist already chosen by hand beats it.
  if (detected === "generic") return false;
  return true;
}

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const sources = await db.query.firmMonitoringSources.findMany({ with: { firm: true } });

    const drifted: { id: string; firm: string; stored: string; detected: string; url: string }[] = [];
    const byDetected = new Map<string, number>();

    for (const source of sources) {
      let detected: string;
      try {
        detected = detectConnector(source.careersUrl).id;
      } catch {
        continue;
      }
      if (!isRealDrift(source.connectorId, detected)) continue;
      drifted.push({
        id: source.id,
        firm: source.firm?.name ?? source.firmId,
        stored: source.connectorId,
        detected,
        url: source.careersUrl,
      });
      byDetected.set(detected, (byDetected.get(detected) ?? 0) + 1);
    }

    console.log(`${sources.length} sources, ${drifted.length} on a connector that is no longer the best match.\n`);

    if (!drifted.length) {
      console.log("No drift. Every source is on the connector its URL detects to.");
      return;
    }

    for (const row of drifted.sort((a, b) => a.detected.localeCompare(b.detected))) {
      console.log(
        `  ${row.firm.slice(0, 34).padEnd(34)} ${row.stored.padEnd(10)} -> ${row.detected.padEnd(10)} ${row.url.slice(0, 70)}`,
      );
    }

    console.log("\nBy the connector they should be on:");
    for (const [id, count] of [...byDetected].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${id.padEnd(16)} ${count}`);
    }

    /**
     * The cost, stated rather than implied.
     *
     * A source sitting on `generic` when a specialist exists is not merely
     * suboptimal: the generic connector synthesises no external id, so every
     * listing it produces fails `verifiable` and can never be auto-approved
     * (posting-quality.ts). The firm's postings are permanently held for human
     * review because of which parser reads them.
     */
    if (process.argv.includes("--apply")) {
      for (const row of drifted) {
        await db
          .update(schema.firmMonitoringSources)
          .set({
            connectorId: row.detected,
            // Cleared so the next check re-reads the board rather than
            // comparing a new connector's output against the old one's hash.
            lastContentHash: null,
            lastEtag: null,
            failureCount: 0,
            sourceHealth: "healthy",
            nextCheckAt: new Date(),
          })
          .where(eq(schema.firmMonitoringSources.id, row.id));
        console.log(`  re-pointed ${row.firm} to ${row.detected}`);
      }
      console.log(`\n${drifted.length} source(s) updated.`);
    } else {
      console.log("\nDry run - re-run with --apply to write these.");
    }

    const fromGeneric = drifted.filter((d) => d.stored === "generic").length;
    if (fromGeneric) {
      console.log(
        `\n${fromGeneric} of these are on the generic connector, so their listings carry no source id\n` +
          `and can never be auto-approved. Re-point them via scripts/repoint-sources.ts.`,
      );
    }
  } finally {
    await closeDb();
  }
}

main();
