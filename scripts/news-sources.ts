/**
 * The source registry, from the command line.
 *
 *   npm run news:sources -- seed                 write sources.ts into news_sources (new ones approved)
 *   npm run news:sources -- list [status]        approved | proposed | rejected | retired | all
 *   npm run news:sources -- health               approved sources, newest story and failure count
 *   npm run news:sources -- approve <id> [sector,sector]
 *   npm run news:sources -- reject <id>          proposed only; keeps it from being re-proposed
 *   npm run news:sources -- retire <id>          stop ingesting an approved source
 *
 * Taking stories down:
 *   npm run news:sources -- reports              stories students reported, and which are hidden
 *   npm run news:sources -- hide <link|id> [why] take a story and every copy of its event off the site
 *   npm run news:sources -- unhide <link|id>     put it back (and clear its reports)
 *
 * Approval is deliberately a person running a command. The scout proposes; it
 * never approves - a source is the one thing in the pipeline no check
 * downstream can fully undo, because every story it sends is trusted.
 */
import { eq } from "drizzle-orm";
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { newsSources } from "../src/db/schema";
import { findStory, hideEvent, listReports, unhideEvent } from "../src/lib/news/takedown";
import { seedSources, silentSources } from "../src/lib/news/ingest";
import { isSector } from "../src/lib/news/types";

// Three database connections, not the default twelve. The Supabase pooler
// allows fifteen for the whole project, the dev server holds eight and the
// crawl wants its own - on 21 September 2026 that collision lost fifteen firms
// from a crawl. This job's queries are small and sequential enough for three.
process.env.OFFERLY_DB_POOL ??= "3";

async function main() {
  const [command = "list", id, extra] = process.argv.slice(2);
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}`);
  try {
    if (command === "seed") {
      console.log(`seeded ${await seedSources(db)} sources`);
    } else if (command === "list") {
      const status = id ?? "approved";
      const rows = await db.select().from(newsSources);
      for (const s of rows.filter((r) => status === "all" || r.status === status).sort((a, b) => a.id.localeCompare(b.id))) {
        console.log(`${s.status.padEnd(9)} ${s.tier.padEnd(8)} ${s.id.padEnd(34)} ${s.sectors.join(",") || "(any)"}`);
        // A proposal's tier and sectors were decided by a model reading the
        // candidate's OWN headlines, so approving one from the id alone was
        // rubber-stamping an uplift the candidate had a hand in. The evidence
        // is printed with it: what it calls itself, where it is, what the
        // model flagged and why.
        if (s.status === "proposed") {
          const m = (s.metrics ?? {}) as Record<string, unknown>;
          const flags = Array.isArray(m.flags) ? (m.flags as string[]) : [];
          console.log(`          name: ${s.name}`);
          console.log(`          url:  ${s.url}`);
          console.log(`          flags: ${flags.length ? flags.join(",") : "(none)"}`);
          if (m.rationale) console.log(`          model says: ${String(m.rationale)}`);
          console.log(`          NOTE: tier and sectors above are the MODEL'S, from this publisher's own headlines.`);
        }
      }
    } else if (command === "health") {
      const rows = await db.select().from(newsSources).where(eq(newsSources.status, "approved"));
      const quiet = new Set((await silentSources(db)).map((s) => s.id));
      for (const s of rows.sort((a, b) => a.id.localeCompare(b.id))) {
        const newest = s.lastItemAt ? s.lastItemAt.toISOString().slice(0, 16) : "never";
        console.log(`${quiet.has(s.id) ? "QUIET" : "ok   "} ${s.id.padEnd(34)} newest ${newest}  failures ${s.consecutiveFailures}`);
      }
    } else if (["approve", "reject", "retire"].includes(command)) {
      if (!id) throw new Error(`usage: ${command} <id>`);
      const [row] = await db.select().from(newsSources).where(eq(newsSources.id, id));
      if (!row) throw new Error(`no source "${id}"`);
      if (command === "approve") {
        const sectors = extra && extra !== "--major" ? extra.split(",") : row.sectors;
        const bad = sectors.filter((s) => !isSector(s));
        if (bad.length) throw new Error(`not sectors: ${bad.join(", ")}`);
        // "major" is trusted on ANY finance topic and is eligible for the Main
        // tab, and for a scout proposal that tier came from a model reading
        // the candidate's own headlines. Granting it needs a deliberate word
        // from the person approving, not silence.
        const wantsMajor = process.argv.slice(2).includes("--major");
        if (row.status === "proposed" && row.tier === "major" && !wantsMajor) {
          throw new Error(
            `"${id}" was PROPOSED as tier "major" by the scout, on this publisher's own headlines.\n` +
              `Review it (npm run news:sources -- list proposed) and then either:\n` +
              `  approve ${id} --major            to grant the major tier deliberately, or\n` +
              `  approve ${id} <sector,sector>    to approve it as a trade source for those sectors.`,
          );
        }
        const tier = row.status === "proposed" && row.tier === "major" && !wantsMajor ? "trade" : row.tier;
        if (tier === "trade" && sectors.length === 0) throw new Error("a trade source must name the sectors it is trusted for");
        await db
          .update(newsSources)
          .set({ status: "approved", tier, sectors, approvedAt: new Date() })
          .where(eq(newsSources.id, id));
      } else {
        await db.update(newsSources).set({ status: command === "reject" ? "rejected" : "retired" }).where(eq(newsSources.id, id));
      }
      console.log(`${id}: ${command}d`);
    } else if (command === "reports") {
      const rows = await listReports(db);
      if (rows.length === 0) console.log("no reported stories");
      for (const r of rows) {
        const state = r.hiddenReason ? `HIDDEN (${r.hiddenReason})` : "shown";
        console.log(`${String(r.reports).padStart(3)} reports  ${state.padEnd(22)} ${r.itemId}  ${r.title.slice(0, 80)} - ${r.publisher}  [${r.reasons.join(", ")}]`);
      }
    } else if (command === "hide" || command === "unhide") {
      if (!id) throw new Error(`usage: ${command} <link|id>${command === "hide" ? " [why]" : ""}`);
      const story = await findStory(db, id);
      if (!story) throw new Error(`no story matches "${id}"`);
      const n = command === "hide" ? await hideEvent(db, story.id, `admin: ${extra ?? "taken down"}`) : await unhideEvent(db, story.id);
      console.log(`${command === "hide" ? "hid" : "restored"} ${n} ${n === 1 ? "copy" : "copies"} of "${story.title.slice(0, 90)}"`);
    } else {
      throw new Error(`unknown command "${command}"`);
    }
  } finally {
    await opened.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
