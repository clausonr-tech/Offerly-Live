// Put every monitoring source on a tier that matches how prominent the firm is
// and whether we can actually read its board.
//
// Replaces the two-way split seed-monitoring-sources.ts made (bulge bracket ->
// critical, everyone else -> standard), which left the `high`, `discovery` and
// `inactive` tiers empty and every firm on one of two cadences regardless of
// whether polling it achieved anything.
//
// The rule, in order:
//   bulge bracket                     -> critical   (1 hour)
//   elite boutique                    -> high       (2 hours)
//   any source whose board parses     -> standard   (12 hours)
//   board found but parses nothing    -> discovery  (30 days)
//   no board at all                   -> discovery  (30 days)
//   explicitly no programme           -> inactive   (never)
//
// Then: a firm five or more students have put on their own list is promoted
// one tier, because student demand is a better signal of what matters than any
// league table - see priority.ts's DEMAND_TIER_PROMOTION_THRESHOLD.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/assign-tiers.ts [--apply]
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { openDb } from "../src/db/open";
import { count, eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { FIRM_TIER_BY_SLUG } from "../src/lib/firm-content";
import { DEMAND_TIER_PROMOTION_THRESHOLD } from "../src/lib/monitoring/priority";
import { sizeForWebsite, formAdvStatus } from "../src/lib/monitoring/form-adv";
import { EMPLOYEE_FLOOR, AUM_FLOOR, ENABLED_CATEGORIES } from "../src/lib/monitoring/enrollment";

/**
 * Big enough that a working board is worth the faster cadence.
 *
 * Well above the enrollment floor, which only asks whether a firm is worth
 * reading at all. This asks a different question - whether it is worth reading
 * OFTEN - and the answer should be yes for the few hundred firms that run
 * real programmes at scale, not for everyone who clears the floor.
 */
const LARGE_EMPLOYEES = 500;
const LARGE_AUM = 10_000_000_000;

const apply = process.argv.includes("--apply");

/** Fastest first - promotion moves a source one step up this list. */
const LADDER = ["critical", "high", "standard", "discovery", "inactive"] as const;
type TierName = (typeof LADDER)[number];

function promote(tier: TierName): TierName {
  const i = LADDER.indexOf(tier);
  return i > 0 ? LADDER[i - 1] : tier;
}

async function main() {
  // Follows DATABASE_URL, so this reads and writes whichever database the
  // project is actually using. Opening PGlite directly here would have
  // re-tiered a local file nothing reads, and reported success doing it.
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}`);

  try {
    const adv = formAdvStatus();
    console.log(
      adv.loaded
        ? `Form ADV sizes loaded for ${adv.firms} firms - tiers will use headcount and AUM.`
        : `NO Form ADV data (${adv.error ?? "file missing"}) - tiers fall back to league position ` +
          "and run history. Run scripts/ingest-form-adv.ts.",
    );

    const tiers = await db.select().from(schema.monitoringTiers);
    const byName = new Map(tiers.map((t) => [t.name as TierName, t]));

    /**
     * The intervals themselves, brought in line with what these boards
     * actually do. Twenty minutes was never justified: a recruiting programme
     * opens once a cycle, so checking a firm 72 times a day to catch it is
     * ~71 requests spent confirming nothing changed - and being the loudest
     * client a careers site sees is how a crawler gets blocked.
     */
    const INTERVALS: Record<TierName, number | null> = {
      critical: 60,      // 1 hour  - bulge bracket and high-demand firms
      high: 120,         // 2 hours - elite boutiques
      standard: 720,     // 12 hours - everyone with a working board
      discovery: 43200,  // 30 days - no board, or a board that parses nothing
      inactive: null,    // never
    };

    for (const [name, minutes] of Object.entries(INTERVALS) as [TierName, number | null][]) {
      const tier = byName.get(name);
      if (!tier || tier.checkIntervalMinutes === minutes) continue;
      console.log(`tier ${name}: ${tier.checkIntervalMinutes ?? "never"} -> ${minutes ?? "never"} min`);
      if (apply) {
        await db
          .update(schema.monitoringTiers)
          .set({ checkIntervalMinutes: minutes })
          .where(eq(schema.monitoringTiers.id, tier.id));
      }
    }

    const sources = await db.query.firmMonitoringSources.findMany({
      with: { firm: true, tier: true, detectedListings: { columns: { id: true } } },
    });

    // Sources whose run history shows a check that actually saw listings.
    const runs = await db.select().from(schema.monitoringCheckRuns);
    const runsWithListings = new Set(
      runs.filter((r) => (r.listingsSeen ?? 0) > 0).map((r) => r.sourceId),
    );

    const moves: Record<string, number> = {};
    for (const s of sources) {
      const ibTier = FIRM_TIER_BY_SLUG[s.firm.slug]?.ibTier;

      /**
       * "Can we read this board" - judged durably.
       *
       * The first version of this asked whether the source currently has any
       * detected listings, and that is a fact about the listings table rather
       * than about the source. Clearing listings to re-run the classifier
       * demoted Nomura to a 30-day cadence even though its board had produced
       * thirty postings an hour earlier, and a 30-day tier means the mistake
       * takes a month to notice.
       *
       * Two signals that survive a reset instead:
       *   - a specialist connector, which is only ever assigned after a real
       *     fetch parsed real listings (see apply-discovered-boards.ts)
       *   - any successful check that saw listings, from the run history
       */
      const usesSpecialistConnector = s.connectorId !== "generic";
      const everSawListings =
        s.detectedListings.length > 0 ||
        runsWithListings.has(s.id);
      const producesListings = usesSpecialistConnector || everSawListings;

      /**
       * Size, from the firm's own SEC filing. Null means "does not file as an
       * investment adviser" - most banks and broker-dealers - and is never
       * read as small.
       */
      const size = sizeForWebsite(s.firm.website);
      const isLarge =
        (size?.employees ?? 0) >= LARGE_EMPLOYEES || (size?.aum ?? 0) >= LARGE_AUM;
      /**
       * Known to be too small to run a programme - not merely unknown.
       *
       * Both halves matter. A firm with no size data on file is unknown and
       * keeps the 30-day discovery cadence; a firm that FILED a headcount of
       * four and no assets has told us the answer.
       */
      const knownTooSmall =
        size !== null &&
        (size.employees ?? 0) < EMPLOYEE_FLOOR &&
        (size.aum ?? 0) < AUM_FLOOR;

      /**
       * A linked duplicate stays parked.
       *
       * audit-duplicate-boards.ts sets parentFirmId and drops a source to
       * inactive when two firms share one board - Greenhill behind Mizuho,
       * Miller Buckfire behind Stifel, and so on across 353 duplicate listing
       * rows. This pass would have read those as "inactive but the firm looks
       * healthy" and promoted them straight back to standard, restoring the
       * double fetching they exist to stop.
       *
       * The parent link IS the decision. Re-deriving a tier for a source that
       * is deliberately not polled is re-deciding something already decided.
       */
      if (s.parentFirmId) continue;

      /**
       * A staged industry stays staged.
       *
       * This tier logic reasons about league position, board health and size -
       * none of which know that private equity and venture capital are BUILT
       * but not ENACTED. Without this guard the first run promoted 40 staged
       * sources straight into active polling (32 to standard, 8 to high) and
       * would have started crawling four industries nobody asked for.
       *
       * Enacting an industry is adding it to ENABLED_CATEGORIES in
       * enrollment.ts; it is not something a tiering pass gets to decide.
       */
      if (!ENABLED_CATEGORIES.has(s.sectorCategory)) {
        if (s.tier.name !== "inactive") {
          moves[`${s.tier.name} -> inactive (not enacted)`] =
            (moves[`${s.tier.name} -> inactive (not enacted)`] ?? 0) + 1;
          if (apply) {
            const inactive = byName.get("inactive")!;
            await db
              .update(schema.firmMonitoringSources)
              .set({ tierId: inactive.id, updatedAt: new Date() })
              .where(eq(schema.firmMonitoringSources.id, s.id));
          }
        }
        continue;
      }

      let target: TierName =
        ibTier === "bulge_bracket"
          ? "critical"
          : ibTier === "elite_boutique"
            ? "high"
            : producesListings
              ? // A board that works, at a firm big enough to hire at scale,
                // is worth checking more than twice a day.
                isLarge
                ? "high"
                : "standard"
              : knownTooSmall
                ? /**
                   * Never polled rather than monthly.
                   *
                   * At 142 sources this saves little. It is written for the
                   * shape the directory is heading toward: the largest bucket
                   * is 8,284 asset and wealth managers, a great many of them
                   * two-person RIAs, and a 30-day cadence over thousands of
                   * firms that have told the SEC they employ four people is
                   * thousands of requests a month to re-learn nothing.
                   */
                  "inactive"
                : "discovery";

      const [{ demand }] = await db
        .select({ demand: count() })
        .from(schema.userTopFirms)
        .where(eq(schema.userTopFirms.firmId, s.firmId));

      if (demand >= DEMAND_TIER_PROMOTION_THRESHOLD) {
        const promoted = promote(target);
        if (promoted !== target) {
          console.log(`  demand ${demand}: ${s.firm.name} ${target} -> ${promoted}`);
          target = promoted;
        }
      }

      if (s.tier.name === target) continue;
      moves[`${s.tier.name} -> ${target}`] = (moves[`${s.tier.name} -> ${target}`] ?? 0) + 1;

      if (apply) {
        const t = byName.get(target)!;
        await db
          .update(schema.firmMonitoringSources)
          .set({ tierId: t.id, updatedAt: new Date() })
          .where(eq(schema.firmMonitoringSources.id, s.id));
      }
    }

    console.log(`\n${apply ? "applied" : "would apply"}:`);
    for (const [k, v] of Object.entries(moves).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
    if (!apply) console.log("\nDry run - pass --apply to write.");
  } finally {
    await opened.close();
  }
}

main();
