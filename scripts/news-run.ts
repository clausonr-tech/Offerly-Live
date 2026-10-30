/**
 * One run of the news pipeline: collect, label, group and rank.
 *
 *   npm run news:run                  everything (the scheduled job runs this every 30 minutes)
 *   npm run news:run -- --no-ai       collect and rank only; stories wait unlabelled for the next run
 *   npm run news:run -- --desk        also run the sector desk and write the daily briefing (the schedule does this twice a day)
 *   npm run news:run -- --briefing    write the daily briefing without the desk
 *   npm run news:run -- --no-photos   skip the photo step
 *   npm run news:run -- --recheck-photos[=2026-10-05T20:00:00-04:00]
 *       look again at this week's events that got a tile instead of a photo,
 *       if they were last checked before that time (default: now). Repeat
 *       with the same time to work through them all, 250 events a run.
 *   npm run news:run -- --no-summaries   skip the story summaries
 *
 * On weekdays, the first run after 10:30 and after 16:30 New York time also
 * writes "How markets moved" for the Markets view.
 *
 * Any run also writes the daily briefing when today's has not been written
 * yet - a desk run that failed would otherwise leave the digest without one
 * until the next.
 *
 * Prints a report for all fourteen sectors on every run - a sector that has
 * gone empty is the failure worth seeing first, so it is never summarised away.
 *
 * Exit code 0 on success; 2 when the AI step could not run (CLI signed out or
 * missing) so the scheduler can say so loudly rather than log a quiet success.
 */
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { runClassify } from "../src/lib/news/classify";
import { runDesk } from "../src/lib/news/desk";
import { runIngest, silentSources } from "../src/lib/news/ingest";
import { rebuildClusters } from "../src/lib/news/rebuild";
import { runPhotos } from "../src/lib/news/photos";
import { briefingWritten, runBriefing } from "../src/lib/news/briefing";
import { runSummaries } from "../src/lib/news/summary";
import { runMarketWrap } from "../src/lib/news/market-wrap";
import { SECTORS, SECTOR_LABELS } from "../src/lib/news/types";

// Three database connections, not the default twelve. The Supabase pooler
// allows fifteen for the whole project, the dev server holds eight and the
// crawl wants its own - on 21 September 2026 that collision lost fifteen firms
// from a crawl. This job's queries are small and sequential enough for three.
process.env.OFFERLY_DB_POOL ??= "3";

async function main() {
  const noAi = process.argv.includes("--no-ai");
  const withDesk = process.argv.includes("--desk");
  const withBriefing = withDesk || process.argv.includes("--briefing");
  const withPhotos = !process.argv.includes("--no-photos");
  const recheckArg = process.argv.find((a) => a === "--recheck-photos" || a.startsWith("--recheck-photos="));
  const recheckCheckedBefore = recheckArg
    ? recheckArg.includes("=")
      ? new Date(recheckArg.slice(recheckArg.indexOf("=") + 1))
      : new Date()
    : undefined;
  if (recheckCheckedBefore && Number.isNaN(recheckCheckedBefore.getTime())) throw new Error(`--recheck-photos: not a date: ${recheckArg}`);
  const withSummaries = !process.argv.includes("--no-summaries");
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  const started = Date.now();
  let aiBlocked: string | undefined;
  console.log(`news run ${new Date().toISOString()}  database: ${opened.backend}`);

  try {
    const ingest = await runIngest(db);
    const sum = (k: "fetched" | "inserted" | "merged" | "duplicate") => ingest.reduce((n, r) => n + r[k], 0);
    console.log(`collect   ${ingest.length} sources, ${sum("fetched")} fetched, ${sum("inserted")} new, ${sum("merged")} merged as syndication, ${sum("duplicate")} already had`);
    for (const r of ingest.filter((r) => !r.ok)) console.log(`  FAILED  ${r.id}: ${r.error}`);
    const quiet = await silentSources(db);
    if (quiet.length) console.log(`  QUIET   no story in 48h or failing: ${quiet.map((s) => s.id).join(", ")}`);

    if (!noAi) {
      const c = await runClassify(db);
      console.log(`label     ${c.labeled} labelled (${c.relevant} relevant) in ${c.packs} calls, ${c.failed} to retry, notional $${c.costUsd.toFixed(3)}`);
      if (c.stoppedBecause) {
        aiBlocked = c.stoppedBecause;
        console.log(`  STOPPED ${c.stoppedBecause}`);
      }
    }

    const rebuilt = await rebuildClusters(db);
    console.log(`rank      ${rebuilt.stories} relevant stories -> ${rebuilt.clusters} events (${rebuilt.multiOutlet} reported by several outlets, ${rebuilt.belowFloor} too thin to show)`);
    console.log(`          ${"main".padEnd(24)} ${String(rebuilt.perSector.main ?? 0).padStart(4)} events`);
    for (const s of SECTORS) {
      const n = rebuilt.perSector[s] ?? 0;
      console.log(`          ${SECTOR_LABELS[s].padEnd(24)} ${String(n).padStart(4)} events${n < 8 ? "   <- THIN (under 8)" : ""}`);
    }

    // Photos need the vision check for most sources, so they wait with the
    // other AI steps when the CLI is signed out.
    if (withPhotos && !noAi && !aiBlocked) {
      const p = await runPhotos(db, { recheckCheckedBefore });
      const list = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
      console.log(`photos    ${p.looked} events looked at (${p.events} on a tab, ${p.alreadyHadPhoto} already had one): ${Object.values(p.found).reduce((a, b) => a + b, 0)} found, ${p.noPhoto} get a tile`);
      console.log(`          found by: ${list(p.found)}; ${p.resolved} Google links matched to the publisher`);
      console.log(`          turned down: ${list(p.rejected)}`);
      console.log(`          photo check: ${p.visionCalls} calls, turned down ${list(p.visionRejected)}${p.defaultsCleared ? `; ${p.defaultsCleared} shared defaults cleared` : ""}`);
      if (p.stopped) console.log(`          STOPPED ${p.stopped}`);
    }

    if (withSummaries && !noAi && !aiBlocked) {
      const s = await runSummaries(db);
      console.log(`summaries ${s.looked} stories looked at: ${s.written} written, ${s.thin} too thin to summarise, ${s.failed} to retry, in ${s.calls} calls`);
      if (s.stopped) console.log(`          STOPPED ${s.stopped}`);
    }

    if (withDesk && !noAi && !aiBlocked) {
      const desk = await runDesk(db);
      for (const d of desk) {
        console.log(`desk      ${SECTOR_LABELS[d.sector].padEnd(24)} ${d.picks} picks, ${d.questions} questions${d.error ? `  ERROR ${d.error}` : ""}`);
      }
    }

    if ((withBriefing || !(await briefingWritten(db))) && !noAi && !aiBlocked) {
      const briefing = await runBriefing(db);
      for (const b of briefing.sort((a, z) => a.scope.localeCompare(z.scope))) {
        console.log(`briefing  ${b.scope.padEnd(24)} ${b.bullets} bullets${b.error ? `  ${b.error === "too few stories" ? "(too few stories)" : `ERROR ${b.error}`}` : ""}`);
      }
    }
    if (!noAi && !aiBlocked) {
      const w = await runMarketWrap(db);
      if (!w.skipped || w.skipped !== "not due") console.log(`markets   wrap ${w.slot ?? ""}: ${w.bullets !== undefined ? `${w.bullets} bullets` : ""}${w.skipped ? ` skipped (${w.skipped})` : ""}${w.error ? `  ERROR ${w.error}` : ""}`);
    }
  } finally {
    await opened.close().catch(() => {});
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  process.exit(aiBlocked ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  // A failed query's wrapper hides why it failed (a dropped connection, a
  // timeout); the database's own error is its cause.
  for (let cause = (err as { cause?: unknown })?.cause, depth = 0; cause && depth < 3; cause = (cause as { cause?: unknown }).cause, depth++) {
    console.error("caused by:", cause instanceof Error ? `${cause.name}: ${cause.message}` : cause);
  }
  process.exit(1);
});
