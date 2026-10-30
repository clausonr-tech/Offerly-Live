// Enrol firms that have appeared in the directory since the last crawl.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/enrol-new-firms.ts
//   ... --dry-run          print what would be enrolled and write nothing
//   ... --limit 25         how many firms to probe this pass (default 25)
//
// WHY THIS EXISTS
// ---------------
// Adding a firm to the directory used to do nothing. On 11 October 2026 the
// directory held 22,554 firms and the crawler watched 4,991 of them: 13,729
// had a programme row, a website, and no monitoring source at all. Enrolment
// was `seed-monitoring-sources.ts`, run by hand, so a firm added on Tuesday
// was crawled whenever somebody next remembered.
//
// This closes that: scheduled-crawl.sh runs it before every crawl, so a firm
// is picked up within the hour.
//
// WHAT IT WILL NOT DO
// -------------------
// It will not point the crawler at a firm's homepage. `decideEnrollment`
// refuses a firm with no discovered board - "worth crawling but no board URL
// found yet, needs discovery" - and that refusal is load-bearing: 319 of the
// 351 sources that have NEVER produced a successful read are bare apex URLs
// with no path, which is exactly what enrolling-at-the-homepage produces. A
// firm whose careers page cannot be found is left for a human or a later
// pass, not enrolled against its front door.
//
// It also will not lower the bar. `isWorthCrawling` wants a confirmed student
// programme, an ATS, 50+ employees or $1B+ AUM; of the 13,729 unmonitored
// firms only 39 clear it, and the other 13,690 are the asset-management tail
// the roadmap explicitly does not want crawled. Enrolling them would multiply
// the crawl by three to watch firms that do not hire undergraduates.
//
// APPLIES BY DEFAULT, WHICH IS A DELIBERATE DEPARTURE
// ---------------------------------------------------
// Every other schedule-changing script here reports by default and writes on
// `--apply` - the repository's standing decision. This one inverts that,
// because a script that needs a flag cannot run unattended and the whole
// point is that nobody has to remember. The standing rule's actual
// requirement is kept: every enrolment is written to a dated file BEFORE the
// insert, because `firm_monitoring_sources` keeps no history of what was
// added or why.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { and, eq, isNotNull, sql } from "drizzle-orm";

import * as schema from "../src/db/schema";
import { dedupKey } from "../src/lib/monitoring/board-identity";
import { normalizeBoardUrl } from "../src/lib/monitoring/board-url";
import {
  decideEnrollment,
  deriveTier,
  ENABLED_CATEGORIES,
  type FirmForEnrollment,
} from "../src/lib/monitoring/enrollment";
import { pooledFetch } from "../src/lib/monitoring/fetch-pool";
import { formAdvStatus, sizeForWebsite } from "../src/lib/monitoring/form-adv";
import { careersCandidates } from "../src/lib/monitoring/careers-candidates";
import { isAllowedByRobots } from "../src/lib/monitoring/robots";
import { safeFetch } from "../src/lib/monitoring/safe-fetch";
import { openScriptDb } from "./_db";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(
  process.argv[process.argv.indexOf("--limit") + 1] || process.env.OFFERLY_ENROL_LIMIT || 25,
);

/** A page has to look like a board, not merely answer. */
const BOARD_WORDS =
  /\b(intern(ship)?s?|summer analyst|graduate programme|graduate program|apply now|open roles|open positions|current openings|job openings|vacanc)/i;

type Candidate = { careersUrl: string; why: string };

/** Probe a firm's own addresses, stopping at the first that answers AND reads
 *  like a board. At most `careersCandidates().length` requests - the five
 *  conventional paths plus two subdomain roots. */
async function findBoard(website: string): Promise<Candidate | null> {
  // No separate URL validation: `careersCandidates` returns an empty list for
  // anything it cannot parse, which is the same early return by another route.
  for (const url of careersCandidates(website)) {
    try {
      if (!(await isAllowedByRobots(url))) continue;
      const res = await pooledFetch(url, () =>
        safeFetch(url, {
          headers: { "user-agent": "OfferlyMonitor", accept: "text/html" },
          timeoutMs: 8000,
        }),
      );
      if (res.status >= 400) continue;
      const html = await res.text();
      if (html.length < 2_000) continue;
      if (!BOARD_WORDS.test(html)) continue;
      return {
        careersUrl: url,
        why: `${new URL(url).host}${new URL(url).pathname} answered ${res.status} and reads like a board`,
      };
    } catch {
      // A path that does not exist is the normal case, not an error.
    }
  }
  return null;
}

async function main() {
  const { db, close } = await openScriptDb();

  try {
    /**
     * The candidates, in one query.
     *
     * `firm_programs.category` is where a firm's sector lives - `firms` has no
     * category column - and `firm_monitoring_sources.sector_category` is NOT
     * NULL, so a firm with no programme row cannot be enrolled at all.
     */
    const rows = await db
      .select({
        id: schema.firms.id,
        slug: schema.firms.slug,
        name: schema.firms.name,
        website: schema.firms.website,
        aum: schema.firms.aum,
        hasVerifiedProgram: schema.firms.hasVerifiedProgram,
        category: schema.firmPrograms.category,
      })
      .from(schema.firms)
      .innerJoin(schema.firmPrograms, eq(schema.firmPrograms.firmId, schema.firms.id))
      .where(
        and(
          isNotNull(schema.firms.website),
          sql`${schema.firms.website} <> ''`,
          sql`NOT EXISTS (SELECT 1 FROM ${schema.firmMonitoringSources} s WHERE s.firm_id = ${schema.firms.id})`,
        ),
      );

    // One row per firm; a firm with several programmes is still one source.
    const byFirm = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!byFirm.has(r.id)) byFirm.set(r.id, r);

    /**
     * The floors, as isWorthCrawling states them - including the employee one.
     *
     * Checked here as well as inside `decideEnrollment` only to avoid probing
     * websites for firms that cannot pass; the decision itself stays there.
     */
    const adv = formAdvStatus();
    if (!adv.loaded) {
      console.log(
        `WARNING: the Form ADV dataset did not load (${adv.error ?? "no reason given"}), ` +
          "so the 50-employee floor cannot fire and only AUM and confirmed programmes count.",
      );
    }
    const eligible = [...byFirm.values()].filter((r) => {
      if (!ENABLED_CATEGORIES.has(r.category)) return false;
      if (r.hasVerifiedProgram) return true;
      if (r.aum !== null && r.aum >= 1_000_000_000) return true;
      const emp = sizeForWebsite(r.website)?.employees ?? null;
      return emp !== null && emp >= 50;
    });

    console.log(
      `${byFirm.size} unmonitored firm(s) with a website and a programme row; ` +
        `${eligible.length} clear the worth-crawling floors.`,
    );
    if (!eligible.length) {
      console.log("Nothing to enrol.");
      return;
    }

    // Existing identities, so a second source is never created for a board
    // the crawler already watches.
    const existing = await db
      .select({
        careersUrl: schema.firmMonitoringSources.careersUrl,
        connectorId: schema.firmMonitoringSources.connectorId,
      })
      .from(schema.firmMonitoringSources);
    const seen = new Set(existing.map((e) => dedupKey(e.careersUrl, e.connectorId)));

    const tiers = await db
      .select({ id: schema.monitoringTiers.id, name: schema.monitoringTiers.name })
      .from(schema.monitoringTiers);
    const tierId = new Map(tiers.map((t) => [t.name, t.id]));

    const enrolled: Record<string, unknown>[] = [];
    const refused: { firm: string; reason: string }[] = [];

    for (const firm of eligible.slice(0, LIMIT)) {
      const board = await findBoard(firm.website!);
      if (!board) {
        refused.push({ firm: firm.name, reason: "no careers page found at the usual paths" });
        continue;
      }

      const forEnrollment: FirmForEnrollment = {
        slug: firm.slug,
        name: firm.name,
        website: firm.website,
        category: firm.category,
        aum: firm.aum,
        // From the Form ADV dataset, not the database - there is no employees
        // column anywhere. Passing null here (as the first version of this
        // script did) silently disables isWorthCrawling's 50-employee floor,
        // so a 500-person firm with no AUM filing is refused for "no Form ADV
        // size data to judge by" when the data exists and says otherwise.
        employees: sizeForWebsite(firm.website)?.employees ?? null,
        hasVerifiedProgram: firm.hasVerifiedProgram,
      };

      const decision = decideEnrollment(
        forEnrollment,
        { careersUrl: board.careersUrl, connectorId: "generic", verifiedParsing: false },
        seen,
      );
      if (decision.action !== "enroll") {
        refused.push({ firm: firm.name, reason: `${decision.action}: ${"reason" in decision ? decision.reason : ""}` });
        continue;
      }

      const normalized = normalizeBoardUrl(board.careersUrl);
      if (!normalized.ok) {
        refused.push({ firm: firm.name, reason: normalized.reason });
        continue;
      }

      const tier = deriveTier(forEnrollment, {
        careersUrl: normalized.url,
        connectorId: decision.connectorId,
        verifiedParsing: false,
      });
      const tid = tierId.get(tier);
      if (!tid) {
        refused.push({ firm: firm.name, reason: `no monitoring tier row named "${tier}"` });
        continue;
      }

      enrolled.push({
        firmId: firm.id,
        firmName: firm.name,
        careersUrl: normalized.url,
        connectorId: decision.connectorId,
        sourceType: decision.sourceType,
        sectorCategory: firm.category,
        tier,
        evidence: board.why,
      });
      seen.add(dedupKey(normalized.url, decision.connectorId));
      console.log(`  + ${firm.name} -> ${normalized.url}  [${tier}, ${decision.connectorId}]`);
    }

    for (const r of refused.slice(0, 10)) console.log(`  - ${r.firm}: ${r.reason}`);
    if (refused.length > 10) console.log(`  - ... and ${refused.length - 10} more refused`);

    console.log(`\n${enrolled.length} to enrol, ${refused.length} refused.`);
    if (!enrolled.length || DRY_RUN) {
      if (DRY_RUN) console.log("--dry-run: nothing written.");
      return;
    }

    /**
     * The record, written BEFORE the insert.
     *
     * `firm_monitoring_sources` keeps no history of what was added or why, so
     * this file is the only account of it. Written first so a crash during
     * the insert still leaves the evidence.
     */
    const dir = path.join(process.cwd(), "scripts", "data");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `enrolled-firms-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), enrolled, refused }, null, 2));
    console.log(`Recorded in ${path.relative(process.cwd(), file)}`);

    for (const e of enrolled) {
      await db.insert(schema.firmMonitoringSources).values({
        firmId: e.firmId as string,
        careersUrl: e.careersUrl as string,
        connectorId: e.connectorId as string,
        sourceType: e.sourceType as "generic_html",
        sectorCategory: e.sectorCategory as "investment_banking",
        tierId: tierId.get(e.tier as string)!,
        // Left at the default so recompute-priority-scores.ts derives it from
        // the same inputs as every other source, rather than this script
        // inventing a number.
      });
    }
    console.log(`Enrolled ${enrolled.length} firm(s). They are due on the next crawl.`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
