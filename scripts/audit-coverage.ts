// How many firms can we actually find internship information for?
//
// Grades every monitored firm on what the pipeline currently knows about it,
// not on whether a fetch returned HTTP 200. A source that reliably downloads a
// FAQ page every four hours is "healthy" by every internal metric and tells a
// student nothing, which is the failure this script exists to make visible.
//
// Stop the dev server first - PGlite is single-process.
//   npx tsx --conditions=react-server scripts/audit-coverage.ts
import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";

/**
 * The rungs a firm can be on, worst to best. Only DATED and LISTED put
 * anything truthful in front of a student; everything below them is the
 * pipeline knowing it does not know.
 */
type Grade =
  | "DATED" // relevant listing + a real date we can count down to
  | "LISTED" // relevant listing, no date published anywhere
  | "FETCHING" // source reads fine, nothing student-relevant on it
  | "NO_LISTINGS" // fetches succeed, zero listings parsed at all
  | "BLOCKED" // source errors or 403s
  | "NEVER" // never once fetched successfully
  | "UNMONITORED"; // no source row at all

const GRADE_ORDER: Grade[] = [
  "DATED",
  "LISTED",
  "FETCHING",
  "NO_LISTINGS",
  "BLOCKED",
  "NEVER",
  "UNMONITORED",
];

const LABEL: Record<Grade, string> = {
  DATED: "relevant listing + real date",
  LISTED: "relevant listing, no date",
  FETCHING: "page reads, nothing relevant on it",
  NO_LISTINGS: "page reads, zero listings parsed",
  BLOCKED: "blocked or erroring",
  NEVER: "never fetched successfully",
  UNMONITORED: "no monitoring source",
};

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const firms = await db.select().from(schema.firms);
    const sources = await db.select().from(schema.firmMonitoringSources);
    const listings = await db.select().from(schema.detectedListings);
    const runs = await db.select().from(schema.monitoringCheckRuns);
    const signals = await db.select().from(schema.openingSignals);

    const sourcesByFirm = new Map<string, typeof sources>();
    for (const s of sources) {
      const list = sourcesByFirm.get(s.firmId) ?? [];
      list.push(s);
      sourcesByFirm.set(s.firmId, list);
    }

    const listingsBySource = new Map<string, typeof listings>();
    for (const l of listings) {
      const list = listingsBySource.get(l.sourceId) ?? [];
      list.push(l);
      listingsBySource.set(l.sourceId, list);
    }

    const lastRunBySource = new Map<string, (typeof runs)[number]>();
    for (const r of runs) {
      const prev = lastRunBySource.get(r.sourceId);
      if (!prev || r.startedAt > prev.startedAt) lastRunBySource.set(r.sourceId, r);
    }

    const signalFirms = new Set(signals.map((s) => s.firmId));

    // Grade each firm by its best source - a firm with one dead URL and one
    // working board is covered, not broken.
    const graded = new Map<Grade, { firm: string; category: string; detail: string }[]>();
    for (const g of GRADE_ORDER) graded.set(g, []);

    for (const firm of firms) {
      const firmSources = sourcesByFirm.get(firm.id) ?? [];
      if (firmSources.length === 0) continue; // 22k directory rows nobody monitors
      // The sector lives on the source, not the firm - `firms` is the whole
      // 22k-row directory and carries no category column.
      const category = firmSources[0].sectorCategory;

      let best: Grade = "NEVER";
      let bestDetail = "-";

      for (const s of firmSources) {
        const mine = listingsBySource.get(s.id) ?? [];
        const relevant = mine.filter(
          (l) => (l.classification as { relevant?: boolean } | null)?.relevant === true,
        );
        const dated = relevant.filter((l) => l.publishedAt !== null);
        const lastRun = lastRunBySource.get(s.id);

        let grade: Grade;
        let detail: string;
        if (relevant.length > 0 && (dated.length > 0 || signalFirms.has(firm.id))) {
          grade = "DATED";
          // Say where the date came from: a date printed on the posting and a
          // date read out of a sentence by the signals pipeline are different
          // strengths of evidence, and collapsing them hides which is which.
          const from = dated.length > 0 ? `${dated.length} posting-dated` : "signal-dated";
          detail = `${relevant.length} relevant, ${from} · ${s.connectorId}`;
        } else if (relevant.length > 0) {
          grade = "LISTED";
          detail = `${relevant.length} relevant of ${mine.length} · ${s.connectorId}`;
        } else if (mine.length > 0) {
          grade = "FETCHING";
          detail = `${mine.length} listings, none relevant · ${s.connectorId}`;
        } else if (s.lastSuccessAt) {
          grade = "NO_LISTINGS";
          detail = `${s.connectorId} · ${new URL(s.careersUrl).hostname}`;
        } else if (lastRun?.errorMessage || lastRun?.httpStatus === 403) {
          grade = "BLOCKED";
          detail = `${lastRun.httpStatus ?? "err"} · ${lastRun.errorMessage?.slice(0, 48) ?? ""}`;
        } else {
          grade = "NEVER";
          detail = s.lastAttemptedAt ? "attempted, no success" : "never attempted";
        }

        if (GRADE_ORDER.indexOf(grade) < GRADE_ORDER.indexOf(best)) {
          best = grade;
          bestDetail = detail;
        }
      }

      graded.get(best)!.push({ firm: firm.name, category, detail: bestDetail });
    }

    console.log(`firms: ${firms.length} in the directory, ${sourcesByFirm.size} monitored\n`);

    for (const g of GRADE_ORDER) {
      const rows = graded.get(g)!;
      console.log(`${g.padEnd(12)} ${String(rows.length).padStart(4)}  ${LABEL[g]}`);
    }

    // Investment banking on its own - it is the sector the product leads with
    // and the one the last audit pass was scoped to.
    console.log("\n--- investment banking only ---");
    for (const g of GRADE_ORDER) {
      const rows = graded.get(g)!.filter((r) => r.category === "investment_banking");
      console.log(`${g.padEnd(12)} ${String(rows.length).padStart(4)}  ${LABEL[g]}`);
    }

    console.log("\n--- IB firms we can actually show something for ---");
    for (const g of ["DATED", "LISTED"] as Grade[]) {
      for (const r of graded.get(g)!.filter((x) => x.category === "investment_banking")) {
        console.log(`  [${g}] ${r.firm} — ${r.detail}`);
      }
    }

    // "Never fetched successfully" collapses two very different situations:
    // a source the scheduler has simply not reached yet, and one that has been
    // tried and does not work. Only the second is a problem to fix.
    // The strict bar. Every row from a structured ATS is a real requisition by
    // construction - one row, one job, its own apply URL. A generic-connector
    // "listing" is a chunk of scraped page text, so a row titled "Internships"
    // is a navigation link to a page we have not read, not an opening a
    // student can act on. Both are counted as "relevant" by the classifier and
    // they are not remotely the same thing.
    const firmName = new Map(firms.map((f) => [f.id, f.name]));
    const STRUCTURED = new Set([
      "workday",
      "talentlink",
      "greenhouse",
      "oracle-hcm",
      "lever",
      "icims",
      "goldman",
      "eightfold",
    ]);
    const actionable = new Set<string>();
    const wordsOnly = new Set<string>();
    for (const s of sources) {
      const rel = (listingsBySource.get(s.id) ?? []).filter(
        (l) => (l.classification as { relevant?: boolean } | null)?.relevant === true,
      );
      if (rel.length === 0) continue;
      // Graded on the TARGET, not the connector. Morgan Stanley and Nomura run
      // real TalentLink boards that publish no Atom feed, so they are polled by
      // the generic connector - but every row is still a real requisition.
      // Scoring by connector name called those two "scraped page text", which
      // is exactly wrong.
      const host = new URL(s.careersUrl).hostname;
      const onAtsHost =
        /\.(myworkdayjobs\.com|tal\.net|greenhouse\.io|oraclecloud\.com|lever\.co|icims\.com)$/.test(
          host,
        );
      if (STRUCTURED.has(s.connectorId) || onAtsHost) actionable.add(s.firmId);
      else wordsOnly.add(s.firmId);
    }
    for (const id of actionable) wordsOnly.delete(id);

    console.log("\n--- how solid is a 'relevant listing', really ---");
    console.log(`  real requisitions from a structured ATS: ${actionable.size} firms`);
    console.log(`  scraped page text only (link, not a role): ${wordsOnly.size} firms`);
    for (const id of actionable) {
      const dated = graded.get("DATED")!.some((r) => r.firm === firmName.get(id));
      console.log(`    ${dated ? "+date" : "     "} ${firmName.get(id)}`);
    }

    console.log("\n--- what NEVER actually means ---");
    let untried = 0;
    let tried = 0;
    for (const s of sources) {
      if (s.lastSuccessAt) continue;
      if (s.lastAttemptedAt) tried++;
      else untried++;
    }
    console.log(`  never attempted by the scheduler: ${untried} sources`);
    console.log(`  attempted and failed:             ${tried} sources`);

    console.log("\n--- sources that fetch but parse nothing (wrong page?) ---");
    for (const s of sources) {
      if (!s.lastSuccessAt) continue;
      if ((listingsBySource.get(s.id) ?? []).length > 0) continue;
      const firm = firms.find((f) => f.id === s.firmId);
      console.log(`  ${(firm?.name ?? "?").padEnd(32)} ${s.connectorId.padEnd(11)} ${s.careersUrl}`);
    }
  } finally {
    // PGlite holds the WAL until the handle closes, and piped stdout is fully
    // buffered - skipping this hangs the script with no output at all.
    await closeDb();
  }
}

main();
