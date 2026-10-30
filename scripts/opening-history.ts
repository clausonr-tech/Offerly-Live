// Derive opening windows from Internet Archive history.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/opening-history.ts [--firm NAME] [--limit N] [--years 3] [--apply]
//
// Answers the question the crawler structurally cannot: a firm with no
// internship posted today - does it never post one, or does it open in three
// weeks? The announcement watcher was built for that and has never fired,
// because it needs two crawls of one source and there is no schedule. The
// Archive already holds years of those crawls.
//
// Writes `opening_signals` rows with source "prediction", which ranks LAST in
// opening-signals.ts precedence. A firm announcement, a live sighting, or a
// student's report all beat it.
//
// Dry run by default. Requires TWO years of evidence before it will store a
// window - see deriveWindow for why one is an anecdote.
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import {
  fetchSnapshots,
  findFirstInternshipSnapshot,
  deriveWindow,
  type YearObservation,
} from "../src/lib/monitoring/opening-history";
import { recordOpeningSignal } from "../src/lib/opening-signals";

const apply = process.argv.includes("--apply");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const firmFilter = arg("firm")?.toLowerCase() ?? null;
const limit = arg("limit") ? Number(arg("limit")) : 5;
const years = arg("years") ? Number(arg("years")) : 3;

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const rows = await db
      .select({
        firmId: schema.firms.id,
        firm: schema.firms.name,
        url: schema.firmMonitoringSources.careersUrl,
        category: schema.firmMonitoringSources.sectorCategory,
      })
      .from(schema.firmMonitoringSources)
      .innerJoin(schema.firms, eq(schema.firms.id, schema.firmMonitoringSources.firmId));

    const targets = (firmFilter ? rows.filter((r) => r.firm.toLowerCase().includes(firmFilter)) : rows).slice(
      0,
      limit,
    );

    console.log(
      `${targets.length} firm(s), reading ${years} year(s) of archive history each.\n` +
        `${apply ? "WRITING" : "Dry run"} - windows need two years of evidence to be stored.\n`,
    );

    const thisYear = new Date().getUTCFullYear();
    let stored = 0;
    let thin = 0;
    let nothing = 0;

    for (const [i, t] of targets.entries()) {
      if (!t.url) continue;
      process.stdout.write(`[${i + 1}/${targets.length}] ${t.firm}\n`);

      let snapshots;
      try {
        snapshots = await fetchSnapshots(t.url, thisYear - years);
      } catch (err) {
        console.log(`    CDX failed: ${(err as Error).message.slice(0, 90)}`);
        continue;
      }
      if (snapshots.length === 0) {
        console.log(`    no archived captures since ${thisYear - years}`);
        nothing++;
        continue;
      }
      console.log(`    ${snapshots.length} content-distinct capture(s) since ${thisYear - years}`);

      const observations: YearObservation[] = [];
      // Only PRIOR years - the current year's opening is what we are predicting.
      for (let y = thisYear - years; y < thisYear; y++) {
        const found = await findFirstInternshipSnapshot(snapshots, y);
        if (found) {
          observations.push(found);
          console.log(`    ${y}: internships present by ${found.firstSeen.toISOString().slice(0, 10)}`);
          console.log(`         "${found.matched.slice(0, 96)}"`);
        } else {
          console.log(`    ${y}: no internship language found in that year's captures`);
        }
      }

      const win = deriveWindow(observations);
      if (!win) {
        console.log(
          `    -> ${observations.length} year(s) of evidence; needs 2. Reported, not stored.\n`,
        );
        thin++;
        continue;
      }

      console.log(
        `    -> cycle ${win.cycleYear}: opens ${win.opensStart.toISOString().slice(0, 10)}` +
          ` to ${win.opensEnd.toISOString().slice(0, 10)}`,
      );

      if (apply) {
        await recordOpeningSignal(
          {
            firmId: t.firmId,
            cycleYear: win.cycleYear,
            programCategory: (t.category as never) ?? null,
            source: "prediction",
            evidence: win.evidence,
            sourceUrl: win.observations[win.observations.length - 1].snapshotUrl,
            opensStart: win.opensStart,
            opensEnd: win.opensEnd,
          },
          db as never,
        );
        stored++;
        console.log(`    stored.\n`);
      } else {
        console.log(`    would store.\n`);
      }
    }

    console.log(
      `\n${apply ? stored + " window(s) stored" : "dry run"}; ` +
        `${thin} had too little evidence; ${nothing} had no archive history.`,
    );
    if (!apply) console.log("Pass --apply to write.");
  } finally {
    await closeDb();
  }
}

main();
