// Do the staged sources actually parse?
//
// Discovery has written 44 sources for industries that are built but not
// enacted. None has ever been fetched, because staged means inactive and
// inactive means never polled - so "coverage" for those industries is, at the
// moment, a claim. A probe proved a board EXISTS; it did not prove we can read
// it, and the difference is the whole point of the exercise.
//
// This fetches each staged source exactly once through its real connector and
// reports what came back. It writes NOTHING: no listings, no tiers, no source
// updates. The database is opened read-only in intent - the only reason it is
// opened at all is to learn which sources to ask about.
//
// Worth running before enacting any industry, because the failure it catches
// is the expensive one: a source that fetches cleanly and parses zero listings
// looks exactly like a board with no open roles, and stays in the rotation
// forever costing a request per cycle to re-learn nothing.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/verify-staged-sources.ts [--category X]
//
// Network plus a database read. Stop the dev server first.
import { openScriptDb } from "./_db";
import { getConnector, closeGenericConnectorBrowser } from "../src/lib/monitoring/connectors";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const ONLY_CATEGORY = arg("category");
const GAP_MS = 700;

type Result = {
  firm: string;
  category: string;
  connectorId: string;
  httpStatus: number;
  listings: number;
  error: string | null;
};

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const sources = await db.query.firmMonitoringSources.findMany({
      with: { firm: true, tier: true },
    });

    const staged = sources.filter(
      (s) =>
        s.tier.name === "inactive" &&
        // A parked duplicate is inactive on purpose and its board is already
        // read under the parent firm - fetching it here would be the second
        // fetch the parking exists to prevent.
        !s.parentFirmId &&
        (!ONLY_CATEGORY || s.sectorCategory === ONLY_CATEGORY),
    );

    console.log(`${staged.length} staged sources to verify (nothing will be written).\n`);

    const results: Result[] = [];
    for (const source of staged) {
      let result: Result = {
        firm: source.firm.name,
        category: source.sectorCategory,
        connectorId: source.connectorId,
        httpStatus: 0,
        listings: 0,
        error: null,
      };

      try {
        const connector = getConnector(source.connectorId);
        const fetched = await connector.fetch({
          careersUrl: source.careersUrl,
          sourceType: source.sourceType,
          // Deliberately null: a conditional GET could return 304 and tell us
          // nothing about whether the board parses.
          lastEtag: null,
        });
        result = {
          ...result,
          httpStatus: fetched.httpStatus,
          listings: fetched.listings.length,
        };
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }

      results.push(result);
      const verdict = result.error
        ? "ERROR"
        : result.listings > 0
          ? "READS"
          : result.httpStatus >= 200 && result.httpStatus < 400
            ? "EMPTY"
            : "FAILS";
      console.log(
        `  ${verdict.padEnd(6)} ${result.firm.slice(0, 34).padEnd(34)} ${result.connectorId.padEnd(13)} ` +
          `HTTP ${String(result.httpStatus).padStart(3)}  ${String(result.listings).padStart(4)} listings` +
          `${result.error ? `  ${result.error.slice(0, 50)}` : ""}`,
      );
      await new Promise((r) => setTimeout(r, GAP_MS));
    }

    const reads = results.filter((r) => !r.error && r.listings > 0);
    const empty = results.filter((r) => !r.error && r.listings === 0 && r.httpStatus >= 200 && r.httpStatus < 400);
    const fails = results.filter((r) => r.error || r.httpStatus === 0 || r.httpStatus >= 400);

    console.log(
      `\n${reads.length} read real listings, ${empty.length} parsed but are empty, ${fails.length} failed.`,
    );
    console.log(`${reads.reduce((n, r) => n + r.listings, 0)} listings behind the staged sources in total.`);

    if (empty.length) {
      console.log(
        "\nEMPTY is not necessarily wrong - a real board between seasons has no postings - but a\n" +
          "source that is empty on every check forever is indistinguishable from a broken one:",
      );
      for (const r of empty.slice(0, 15)) console.log(`  - ${r.firm} (${r.connectorId})`);
    }

    if (fails.length) {
      console.log("\nFAILED - these would be dead sources the day an industry is enacted:");
      for (const r of fails) {
        console.log(`  - ${r.firm} (${r.connectorId}): HTTP ${r.httpStatus}${r.error ? ` ${r.error.slice(0, 60)}` : ""}`);
      }
    }
  } finally {
    await closeGenericConnectorBrowser();
    await closeDb();
  }
}

main();
