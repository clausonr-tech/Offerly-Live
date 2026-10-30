// Turn a probe report into monitoring sources - through the enrollment rule,
// never around it.
//
// This is the only place probe results reach the database, and it is
// deliberately thin: every judgement (is this firm worth crawling, is this
// board a duplicate, which tier, is this industry enacted yet) belongs to
// src/lib/monitoring/enrollment.ts, so the same answers come out no matter
// which path added the firm. This script's own job is reading, writing and
// reporting.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/apply-probed-boards.ts --in scripts/data/probed-vc-sample.json
//   ... --apply     to actually write
//
import { readFileSync } from "fs";
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { decideEnrollment, type FirmForEnrollment } from "../src/lib/monitoring/enrollment";
import { dedupKey } from "../src/lib/monitoring/board-identity";
import { detectConnector } from "../src/lib/monitoring/connectors";
import { FIRM_TIER_BY_SLUG } from "../src/lib/firm-content";
import { sizeForWebsite, formAdvStatus } from "../src/lib/monitoring/form-adv";

type Hit = {
  slug: string;
  name: string;
  category: string;
  platform: string;
  connectorId: string | null;
  token: string;
  boardUrl: string;
  listings: number;
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const IN = arg("in") ?? "scripts/data/probed-boards.json";
const APPLY = process.argv.includes("--apply");

async function main() {
  /**
   * Follows DATABASE_URL, like the six scripts ported before it.
   *
   * This script is the ONLY thing that turns a probe result into a monitored
   * source, and it was opening PGlite directly - so every board the probes
   * found was being written to a local file nothing reads, while the crawler
   * ran against Supabase. It would have reported "wrote 82 source(s)" and
   * added nothing to any sector.
   *
   * That mattered most to the eight sectors with no sources at all, because
   * this is the only route they have to their first one.
   */
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}`);

  try {
    const report = JSON.parse(readFileSync(IN, "utf8")) as { hits: Hit[] };
    const hits = report.hits ?? [];
    if (!hits.length) {
      console.log(`${IN} contains no hits.`);
      return;
    }

    const adv = formAdvStatus();
    console.log(
      adv.loaded
        ? `Form ADV sizes loaded for ${adv.firms} firms.`
        : `NO Form ADV data (${adv.error ?? "file missing"}) - firms will be sized as unknown. ` +
          "Run scripts/ingest-form-adv.ts.",
    );

    const tiers = await db.select().from(schema.monitoringTiers);
    const tierByName = new Map(tiers.map((t) => [t.name, t]));
    const missingTiers = ["critical", "high", "standard", "discovery", "inactive"].filter(
      (n) => !tierByName.has(n),
    );
    if (missingTiers.length) {
      throw new Error(
        `Tiers not seeded: ${missingTiers.join(", ")}. Run scripts/seed-monitoring-config.ts first.`,
      );
    }

    // Every board already monitored, keyed by identity rather than by URL -
    // this is what stops a second firm registering a board we already poll.
    // Seeded from the database so the script is idempotent across runs and
    // safe to interleave with the other discovery paths.
    const existing = await db.select().from(schema.firmMonitoringSources);
    const seenKeys = new Set(existing.map((s) => dedupKey(s.careersUrl, s.connectorId)));
    console.log(`${existing.length} sources already registered (${seenKeys.size} distinct boards).`);

    const slugs = hits.map((h) => h.slug);
    const firmRows = await db
      .select()
      .from(schema.firms)
      .where(inArray(schema.firms.slug, slugs));
    const firmBySlug = new Map(firmRows.map((f) => [f.slug, f]));

    const outcomes: Record<string, number> = {};
    const skipped: { name: string; reason: string }[] = [];
    let written = 0;

    for (const hit of hits) {
      const firm = firmBySlug.get(hit.slug);
      if (!firm) {
        // The directory JSON and the database can disagree: `npm run
        // db:sync-firms` reconciles `firms` against the seeds, so a row present
        // in the file may legitimately not be in the database yet.
        outcomes["firm not in database"] = (outcomes["firm not in database"] ?? 0) + 1;
        skipped.push({ name: hit.name, reason: "no firms row - run the seeder first" });
        continue;
      }

      // Headcount and AUM from the firm's own SEC filing, matched by domain.
      // Null when the firm does not file as an investment adviser - which is
      // most banks and broker-dealers, and means unknown rather than small.
      const size = sizeForWebsite(firm.website);

      const forEnrollment: FirmForEnrollment = {
        slug: firm.slug,
        name: firm.name,
        website: firm.website,
        category: hit.category,
        // The directory's own AUM when it has one, the SEC filing otherwise.
        aum: firm.aum ?? size?.aum ?? null,
        employees: size?.employees ?? null,
        hasVerifiedProgram: firm.hasVerifiedProgram,
        ibTier: FIRM_TIER_BY_SLUG[firm.slug]?.ibTier ?? null,
      };

      const decision = decideEnrollment(
        forEnrollment,
        {
          careersUrl: hit.boardUrl,
          /**
           * Resolved from the URL now, not read from the report.
           *
           * A probe report records the connector that existed WHEN IT RAN.
           * The private equity sweep found three Recruitee boards - one of
           * them BC Partners', carrying "French Intern | July 2026" - and
           * recorded them as having no connector, because the Recruitee
           * connector was written afterwards. Trusting that stale field would
           * register a readable board against the generic connector and launch
           * Chromium every check to scrape JSON.
           */
          connectorId: detectConnector(hit.boardUrl).id,
          // A probe that returned postings has demonstrably parsed a real
          // board. One that returned an empty board has demonstrated only
          // that the board exists - so it enrols at the discovery cadence,
          // not as a working source. That distinction is the whole reason
          // `listings` is carried through the report.
          verifiedParsing: hit.listings > 0,
        },
        seenKeys,
      );

      outcomes[decision.action] = (outcomes[decision.action] ?? 0) + 1;

      if (decision.action === "skip" || decision.action === "duplicate") {
        skipped.push({ name: hit.name, reason: decision.reason });
        continue;
      }

      const tier = tierByName.get(decision.tier)!;
      console.log(
        `  ${decision.action === "enroll" ? "+" : "~"} ${firm.name} -> ${decision.connectorId} ` +
          `[${decision.tier}] ${decision.reason}`,
      );

      if (APPLY) {
        await db.insert(schema.firmMonitoringSources).values({
          firmId: firm.id,
          careersUrl: decision.careersUrl,
          sourceType: decision.sourceType,
          connectorId: decision.connectorId,
          sectorCategory: hit.category as typeof schema.firmMonitoringSources.$inferInsert.sectorCategory,
          hasConfirmedInternshipHistory: false,
          tierId: tier.id,
          // The audit trail this codebase keeps paying for the absence of:
          // why the row exists, found how, and on what evidence.
          notes:
            `found by ATS probe on ${hit.platform} (token "${hit.token}", ` +
            `${hit.listings} listings at discovery); ${decision.reason}`,
        });
      }
      // Reserved whether or not we wrote, so a dry run reports the same
      // duplicate decisions a real one would make.
      seenKeys.add(decision.dedupKey);
      written += 1;
    }

    console.log(`\n${APPLY ? "wrote" : "would write"} ${written} source(s).`);
    console.log("outcomes:");
    for (const [action, n] of Object.entries(outcomes).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${action}`);
    }

    if (skipped.length) {
      console.log("\nnot registered, and why:");
      for (const s of skipped.slice(0, 40)) console.log(`  - ${s.name}: ${s.reason}`);
      if (skipped.length > 40) console.log(`  ... and ${skipped.length - 40} more`);
    }

    if (!APPLY) console.log("\nDry run - pass --apply to write.");
  } finally {
    await opened.close();
  }
}

main();
