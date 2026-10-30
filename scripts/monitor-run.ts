// The monitoring scheduler. Selects due sources in priority order, fetches
// each through its connector, diffs against what's already stored, classifies
// only what's new or changed, and files everything else needed for the admin
// queue and the schedule of the next check.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/monitor-run.ts [--limit N]
//
// Uses whichever database the project is configured for: Postgres when
// DATABASE_URL is set, PGlite otherwise (see src/db/open.ts). On PGlite, stop
// the dev server first - it is single-writer.
//
// Deliberately NOT wired into any scheduler yet. Run by hand until there's a
// real deployment with a real cron - see the plan for why.
import { createHash } from "crypto";
import { preferApplyUrl } from "../src/lib/monitoring/apply-url";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { openDb } from "../src/db/open";
import { isPoolExhausted } from "../src/db/pool";
import {
  isInconclusive,
  inconclusiveWaitMs,
  inconclusiveMessage,
} from "../src/lib/monitoring/http-outcome";
import { describeError, isDatabaseError } from "../src/lib/monitoring/db-outcome";
import { isBoardCollapse, collapseMessage } from "../src/lib/monitoring/board-collapse";
import { decodeEntities } from "../src/lib/monitoring/entities";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import {
  getConnector,
  closeGenericConnectorBrowser,
  type NormalizedListing,
} from "../src/lib/monitoring/connectors";
import { pooledFetch } from "../src/lib/monitoring/fetch-pool";
import { classifyListing, TITLE_INTERNSHIP_PATTERN, publishableWithoutReview, reviewStatusAfterReread } from "../src/lib/monitoring/classify";
import { inferFromFirmPattern } from "../src/lib/monitoring/eligibility";
import type { FirmProgramCategory } from "../src/lib/firm-metadata";
import { computePriorityScore } from "../src/lib/monitoring/priority";
import { seasonBand, seasonFor } from "../src/lib/monitoring/season";
import { detectAnnouncement, AMBIGUOUS_BELOW } from "../src/lib/monitoring/announcements";
import { parseRecruitingEvent, wasRejectedAsEvent } from "../src/lib/monitoring/recruiting-events";
import { recordOpeningSignal, parseWindow } from "../src/lib/opening-signals";
import {
  decideClosure,
  isThinDescription,
  postingStillBacked,
  shouldRetryEnrichment,
} from "../src/lib/monitoring/listing-lifecycle";
import { windowUrgency, applyUrgency } from "../src/lib/monitoring/opening-window";
import { budgetOverrunMs, DeadlineExpired, withAmbientSignal } from "../src/lib/monitoring/deadline";
import { isPortfolioBoard } from "../src/lib/monitoring/portfolio-boards";

/**
 * Whichever database this project is actually using.
 *
 * This was `new PGlite(...)` directly, which ignored DATABASE_URL entirely -
 * so pointing the app at Supabase would have moved the reads and left the
 * crawler writing to a local file nothing served. Two live databases,
 * diverging every hour, with no error anywhere to notice.
 *
 * Assigned in main() rather than at module load because choosing the driver
 * is async and this file is CommonJS.
 */
let opened: Awaited<ReturnType<typeof openDb>> | null = null;
let db!: Awaited<ReturnType<typeof openDb>>["db"];

/**
 * Close the database before leaving, on every path.
 *
 * `process.exit()` does not run cleanup, so this script has always ended by
 * abandoning an open PGlite - which leaves a `postmaster.pid` behind on every
 * single run, successful or not. PGlite overwrites a stale one on the next
 * open, so it never broke anything, and that is exactly why it went unnoticed
 * for weeks: a file that looks like a held lock, sitting in the data directory
 * after every crawl, meaning nothing.
 *
 * It cost real time anyway. When the database was genuinely corrupted, the
 * leftover lock was sitting there too and got blamed for it - the actual cause
 * was unrelated, and an unlocked copy proved it by aborting just the same.
 * Leaving misleading evidence lying around is its own kind of bug.
 */
async function leave(code: number): Promise<never> {
  // Without this, a launched headless Chromium keeps the process alive
  // indefinitely instead of letting process.exit actually exit.
  await closeGenericConnectorBrowser().catch(() => {});
  await opened?.close().catch(() => {});
  process.exit(code);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const limit = arg("limit") ? Number(arg("limit")) : 10;

/**
 * `--firm "Kroll"` - crawl only firms whose name contains this.
 *
 * Sources are picked by priority score, so a firm that has always yielded
 * nothing sorts last - which is exactly the firm you have just written a
 * connector for and need to watch go through the pipeline. Without this the
 * only way to reach it is to crawl everything ahead of it first, spending
 * real requests on a hundred boards to test one.
 *
 * Applied after the query rather than inside it, so the output still says how
 * many sources were due and how many this run deliberately skipped.
 */
const firmFilter = arg("firm")?.toLowerCase() ?? null;

/**
 * `--force` - check the named firm even though it is not due yet.
 *
 * Requires --firm, deliberately. Ignoring the schedule across every source at
 * once is not a debugging aid, it is an unannounced full crawl of 188 boards.
 */
const force = process.argv.includes("--force") && firmFilter !== null;
if (process.argv.includes("--force") && !firmFilter) {
  console.error("--force needs --firm: refusing to ignore the schedule for every source at once.");
  process.exit(1);
}

/**
 * The cycle an announcement is about when it does not say.
 *
 * "We are now accepting applications for our summer internship program" is a
 * real opening with no year in it. Banking recruits roughly two years ahead,
 * so this follows the same convention the report form uses. It is a weaker
 * claim than a stated year and the evidence sentence makes that visible - a
 * reviewer can see no year was quoted.
 */
function defaultCycleForAnnouncement(now = new Date()): number {
  return now.getMonth() >= 3 ? now.getFullYear() + 2 : now.getFullYear() + 1;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function listingIdentityKey(listing: NormalizedListing): string {
  // Real external IDs (Greenhouse) are used as-is; a source with no stable
  // ID of its own (most generic career pages) gets a synthetic one derived
  // from its own detail URL, which is normally stable even without a
  // JobPosting identifier - stored in the same externalJobId column so one
  // lookup covers both cases.
  return listing.externalJobId ?? sha256(listing.listingUrl);
}

/**
 * Fill in descriptions for postings we already store but could not read.
 *
 * Hoisted out of the main loop so it can run on BOTH paths. It used to sit
 * only in the changed-board branch, behind the unchanged-hash short circuit -
 * and the content hash is computed by the connector before `enrich` runs, so
 * it does not move when a description fills in and does not move at all on a
 * quiet board. The effect was that the one step written to recover a thin
 * listing ran only when something ELSE on the board changed: a posting
 * confirmed on every check and enriched on none, which is the exact failure
 * its own comment described.
 *
 * Returns how many were actually back-filled.
 */
async function backfillThinListings(
  source: { careersUrl: string; sectorCategory: string | null },
  connector: ReturnType<typeof getConnector>,
  /** `enrichmentAttempts` is what the rotation below orders by - see
   *  `attemptable`. Optional so a caller that cannot supply it still works,
   *  in which case every target reads as zero and the order is board order. */
  targets: { listing: NormalizedListing; existingId: string; enrichmentAttempts?: number | null }[],
  // The caller's budget. One detail request per thin listing and a write for
  // each one that comes back, which is exactly the kind of tail the per-source
  // budget exists to cut - so a cancelled check stops here too, rather than
  // enriching a board nobody is waiting for.
  signal?: AbortSignal,
): Promise<number> {
  if (!targets.length || !connector.enrich) return 0;
  if (signal?.aborted) return 0;

  /**
   * ONLY THE LISTINGS THE CONNECTOR WILL ACTUALLY FETCH.
   *
   * An attempt is spent whether or not it produces text - a detail page that
   * keeps returning nothing is exactly the one that must stop being asked, and
   * 233 listings across 91 sources were in that loop, HSBC's for 38 days. But
   * it must be spent only on a listing that was TRIED. The generic connector
   * fetches at most `maxEnrichPerCheck` details and returns the rest
   * unchanged, so charging every target handed over charged everything past
   * the cap for nothing: five checks later those listings fail
   * `shouldRetryEnrichment` forever, and a listing with no description can
   * never be published. That is the calendar bug this counter replaced,
   * reproduced faster.
   *
   * NOT A FIX FOR STARVATION, and it was not one before either: `targets` is
   * built in board order, so the same first N are offered every check and a
   * thin listing past the cap on a big board is never enriched. That is
   * pre-existing and wants a rotation, which is its own change.
   */
  /**
   * ROTATED, so the back of a long queue is not starved.
   *
   * `targets` is built in board order and the connector fetches at most
   * `maxEnrichPerCheck` of them, so the SAME first 25 were offered on every
   * check and a thin listing at position 26 was never tried - not because
   * anything failed, but because the queue never advanced. A listing with no
   * description cannot be published, so those were invisible indefinitely.
   *
   * Ordered by attempts already spent, fewest first. That is a rotation
   * without needing a cursor to persist anywhere: a listing that has been
   * tried twice yields to one that has been tried once, which yields to one
   * never tried at all. The window therefore moves on its own as attempts
   * accumulate, and it converges on the listings that have had the least
   * attention rather than the ones that happen to sort first.
   *
   * NOT MORE REQUESTS. The cap is unchanged and so is the politeness gap
   * inside the connector; this only changes WHICH of the thin listings get
   * this check's attempts. Ties keep board order, so a board whose listings
   * all have the same count behaves exactly as before.
   */
  const attemptable = connector.maxEnrichPerCheck
    ? [...targets]
        .sort((a, b) => (a.enrichmentAttempts ?? 0) - (b.enrichmentAttempts ?? 0))
        .slice(0, connector.maxEnrichPerCheck)
    : targets;

  const refreshed = await pooledFetch(source.careersUrl, () =>
    connector.enrich!(attemptable.map((t) => t.listing)),
  );

  /**
   * Charged AFTER the call, and not at all once the budget has gone.
   *
   * The guard at the top of this function runs before `pooledFetch`, and the
   * abort can land while that is still waiting for a slot - after which every
   * `fetchStatic` rejects instantly and the whole batch would have lost an
   * attempt to our own clock rather than to the board.
   *
   * Written in one statement rather than per row: a board can offer this
   * function a hundred listings, and this is the cheap half of the work.
   */
  if (!signal?.aborted && attemptable.length > 0) {
    await db
      .update(schema.detectedListings)
      .set({ enrichmentAttempts: sql`${schema.detectedListings.enrichmentAttempts} + 1` })
      .where(
        inArray(
          schema.detectedListings.id,
          attemptable.map((t) => t.existingId),
        ),
      );
  }

  let filled = 0;
  for (const [i, listing] of refreshed.entries()) {
    // Mid-way is a fine place to stop: every row written so far is a listing
    // that now has its real description, and the rest are picked up on the
    // next check, which is how enrichment is resumable by design.
    if (signal?.aborted) break;
    const target = attemptable[i];
    if (!target || listing.descriptionRaw.trim().length < 120) continue;

    const reclassified = classifyListing(
      listing,
      source.sectorCategory as FirmProgramCategory,
    );
    // The fresh evidence, which is worth storing on any row.
    await db
      .update(schema.detectedListings)
      .set({
        descriptionRaw: listing.descriptionRaw,
        location: listing.location ?? undefined,
        classification: reclassified,
        updatedAt: new Date(),
      })
      .where(eq(schema.detectedListings.id, target.existingId));

    /**
     * The VERDICT, which is not.
     *
     * Re-judged on real evidence, so the review state is re-decided too - a
     * listing held only because we could not read it should not stay held
     * once we can. But only when no person has decided it. This used to write
     * the status unconditionally, so a listing an admin had REJECTED and
     * whose detail page later served a long description was flipped to
     * `auto_approved` and published by the promote step later in the same
     * hourly run - the one unattended script that did not enforce the rule
     * adjudicate-rejections.ts and reclassify-listings.ts both state as "a
     * person's verdict is not a machine's to revisit" (security review, 10
     * October 2026). `reviewedBy` is the only discriminator: a human and the
     * classifier write the same status values.
     *
     * Enforced in the WHERE clause as well as in the helper, so the guard is
     * atomic against an admin deciding the row between the read and the write.
     */
    const status = reviewStatusAfterReread(reclassified, { reviewedBy: null });
    if (status) {
      await db
        .update(schema.detectedListings)
        .set({ reviewStatus: status, updatedAt: new Date() })
        .where(
          and(
            eq(schema.detectedListings.id, target.existingId),
            isNull(schema.detectedListings.reviewedBy),
          ),
        );
    }
    filled += 1;
  }
  return filled;
}

async function main() {
  // viaOpenDb: this script follows DATABASE_URL properly, so it is exempt from
  // the wrong-database warning the guard prints for the scripts that do not.
  await assertExclusiveDbAccess({ viaOpenDb: true });
  // openDb picks Postgres when DATABASE_URL is set and PGlite otherwise, and
  // pins the local clock to UTC either way - see src/db/utc-clock.ts for why
  // that matters, and what it cost when the two clocks disagreed.
  opened = await openDb();
  db = opened.db;
  console.log(`database: ${opened.backend}`);

  /**
   * Which due boards a capped run takes first: sectors whose applications are
   * open, then rolling ones, then the out-of-season rest (see seasonBand) -
   * and within each, the urgent tiers before the weekly discovery sweep.
   *
   * It used to be priority score alone. That knows nothing about the calendar
   * or the tier, and with ~3,700 boards due at once it filled every run with
   * weekly discovery boards scoring ~25 while 2-hourly "high" boards scoring
   * 0 waited - and every sector outside IB went days without a check.
   */
  const bandBySector = new Map(
    schema.firmProgramCategoryEnum.enumValues.map((c) => [c, seasonBand(c)] as const),
  );
  // Inlined rather than bound: the values are this file's own enum constants
  // and small integers, and a bound THEN arrives untyped, which makes Postgres
  // resolve the CASE as text.
  const seasonOrder = sql`case ${sql.join(
    [...bandBySector].map(
      ([c, band]) => sql`when ${schema.firmMonitoringSources.sectorCategory} = ${sql.raw(`'${c}'`)} then ${sql.raw(String(band))}`,
    ),
    sql` `,
  )} else 0 end`;
  // Table names written out, not drizzle columns: the relational query rewrites
  // EVERY column inside raw SQL onto its root alias, so monitoringTiers.sortOrder
  // would come out as a column of firm_monitoring_sources.
  const tierOrder = sql`coalesce((select t.sort_order from monitoring_tiers t where t.id = ${schema.firmMonitoringSources.tierId}), 99)`;
  const bandCounts = [0, 1, 2].map((b) => [...bandBySector.values()].filter((v) => v === b).length);
  console.log(
    `season: ${bandCounts[0]} sector(s) with applications open, ${bandCounts[1]} rolling, ${bandCounts[2]} out of season.`,
  );

  const allDue = await db.query.firmMonitoringSources.findMany({
    // `--force` drops the due-date filter. Without it a source that was just
    // checked cannot be checked again, and the firm you have this moment
    // written or fixed a connector for is precisely the one whose next check
    // is an hour away - so the only way to see it run was to wait, or to
    // crawl everything else first. Narrow by construction: it is only
    // reachable together with --firm.
    where: and(
      force ? undefined : lte(schema.firmMonitoringSources.nextCheckAt, new Date()),
      /**
       * `--firm` is matched in SQL, not in JavaScript.
       *
       * It used to load every source and filter the array afterwards, with
       * `limit: undefined` so the filter had rows to work on. That was a
       * 188-row read when it was written. After enrolment it is 4,889 rows
       * with two lateral joins each, and combined with `--force`, which also
       * drops the due-date filter, the query became large enough to fail
       * outright - which is how `--firm X --force`, the documented way to
       * test a connector you have just fixed, stopped working at all.
       */
      firmFilter
        ? inArray(
            schema.firmMonitoringSources.firmId,
            db
              .select({ id: schema.firms.id })
              .from(schema.firms)
              .where(ilike(schema.firms.name, `%${firmFilter}%`)),
          )
        : undefined,
    ),
    orderBy: [
      asc(seasonOrder),
      asc(tierOrder),
      desc(schema.firmMonitoringSources.priorityScore),
      asc(schema.firmMonitoringSources.nextCheckAt),
    ],
    limit,
    with: { firm: true, tier: true },
  });

  const dueSources = allDue;

  /**
   * The historical opening windows, read once for the whole run.
   *
   * These come from Internet Archive history (opening-history.ts, swept by
   * opening-windows-sweep.ts) and are stored as `prediction` signals - the
   * weakest evidence in the system. Their job here is narrow and one-way:
   * bring a firm's next check FORWARD when its own history says it is about
   * to open. See opening-window.ts on why this is a multiplier rather than a
   * tier change, and why it may only ever speed a source up.
   *
   * One query rather than one per source: a run touches up to 110 sources and
   * the whole prediction set is a few hundred rows.
   */
  const predictions = await db.query.openingSignals.findMany({
    where: eq(schema.openingSignals.source, "prediction"),
  });
  const windowByFirm = new Map<string, { opensStart: Date; opensEnd: Date }>();
  for (const row of predictions) {
    if (!row.opensStart || !row.opensEnd) continue;
    const existing = windowByFirm.get(row.firmId);
    // The soonest window wins when a firm has several - it is the one that
    // decides whether we should be looking now.
    if (!existing || row.opensStart < existing.opensStart) {
      windowByFirm.set(row.firmId, { opensStart: row.opensStart, opensEnd: row.opensEnd });
    }
  }
  const imminentCount = [...windowByFirm.values()].filter((w) => windowUrgency(w).imminent).length;
  if (windowByFirm.size) {
    console.log(
      `${windowByFirm.size} firms have a historical opening window; ${imminentCount} are inside or approaching one.`,
    );
  }

  if (dueSources.length === 0) {
    console.log(
      firmFilter
        ? `No sources due for a check matching --firm "${firmFilter}" (${allDue.length} due overall).`
        : "No sources due for a check.",
    );
    await leave(0);
  }

  console.log(
    firmFilter
      ? `${dueSources.length} of ${allDue.length} due source(s) match --firm "${firmFilter}".\n`
      : `${dueSources.length} source(s) due, running up to --limit ${limit}.`,
  );
  if (!firmFilter) {
    // The sector mix this run is about to check - the line that shows whether
    // the budget is following the calendar or has fallen back onto one sector.
    const bySector = new Map<string, number>();
    for (const s of dueSources) bySector.set(s.sectorCategory, (bySector.get(s.sectorCategory) ?? 0) + 1);
    console.log(
      `by sector: ${[...bySector].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}\n`,
    );
  }

  let listingsNewTotal = 0;
  let autoApprovedTotal = 0;
  let rejectedTotal = 0;
  let announcementsFound = 0;
  let eventsFound = 0;

  /**
   * One source's whole check, as a function so several can run at once.
   *
   * This was the body of a `for` loop, and the loop was the bottleneck. Every
   * fetch in this file already goes through `pooledFetch`, which caps the
   * crawl at OFFERLY_FETCH_CONCURRENCY requests (12 by default, 4 when this
   * was written) and holds a 2-second gap per domain - so processing sources
   * one after another used ONE of those slots and left the rest idle for the
   * whole run.
   *
   * Measured over 24 hours on 20 September 2026, per-source check duration:
   *
   *   connector     median   mean    worst
   *   workable       10.1s   68.4s   1208s
   *   talentlink      3.5s   30.1s    975s
   *   generic         4.3s   13.1s    935s
   *
   * The median source is quick. The mean is three to fifteen times higher
   * because a handful run for twenty minutes - Workable paging through a
   * throttled host, the generic connector rendering a page that never
   * settles - and in a sequential loop every one of those blocks all the
   * sources behind it.
   *
   * Concurrency here is safe by construction rather than by luck: the pool is
   * the throttle, not the loop, so raising this cannot make the crawler ruder
   * to any host. Per-source state (`siblingEligibility`, the per-run counts)
   * is declared inside; the only values shared across sources are numeric
   * totals, and `+=` on a number cannot interleave in a single-threaded event
   * loop.
   */
  const checkSource = async (source: (typeof dueSources)[number], i: number, signal: AbortSignal) => {
    /**
     * The per-source budget, at the points where there is work left to stop.
     *
     * Called at each stage boundary rather than sprinkled between statements:
     * a stage is where this function decides to spend more time on a source -
     * a detail fetch, a board's worth of per-listing writes, the closure pass -
     * and stopping at one leaves the database in the same state a finished
     * stage does. Everything already written stays written, which is what the
     * budget has always promised (see SOURCE_BUDGET_MS): the source keeps its
     * place in the schedule and is read again next cycle.
     */
    const stopIfCancelled = () => {
      if (signal.aborted) {
        throw signal.reason instanceof BudgetExpired ? signal.reason : new BudgetExpired(source.firm.name);
      }
    };
    /**
     * What enrichment cost this check, accumulated.
     *
     * Declared up here rather than beside the first backfill because
     * enrichment runs on BOTH outcomes: the unchanged path back-fills thin
     * listings too (a board can be byte-identical while a listing it already
     * carries is still a stub), and both report the figure. Accumulated, not
     * measured once, because the column answers "what did enriching this
     * source cost" rather than "which call did it".
     */
    let enrichMs = 0;
    /**
     * A tier with no interval means never auto-check - the `inactive` tier,
     * for sources with no usable board or no programme. They are filtered here
     * rather than in the query so the reason is visible in a run's output
     * instead of the source silently never appearing.
     */
    if (source.tier.checkIntervalMinutes == null) {
      console.log(`[${i + 1}/${dueSources.length}] ${source.firm.name} - skipped (tier: ${source.tier.name})`);
      await db
        .update(schema.firmMonitoringSources)
        .set({ nextCheckAt: new Date(Date.now() + 30 * 24 * 60 * 60_000) })
        .where(eq(schema.firmMonitoringSources.id, source.id));
      return;
    }

    console.log(`[${i + 1}/${dueSources.length}] ${source.firm.name} (${source.connectorId})`);
    const [run] = await db
      .insert(schema.monitoringCheckRuns)
      .values({ sourceId: source.id })
      .returning();

    try {
      const connector = getConnector(source.connectorId);
      const result = await pooledFetch(source.careersUrl, () =>
        connector.fetch({
          careersUrl: source.careersUrl,
          sourceType: source.sourceType,
          lastEtag: source.lastEtag,
        }),
      );

      /**
       * The tier sets the cadence; the sector's recruiting calendar stretches
       * it when nothing can be opening.
       *
       * A real estate fund in March and an investment bank in August want very
       * different amounts of attention, and CATEGORY_TIMELINE_TRACKS already
       * knows which windows are open - it just had never been connected to the
       * scheduler. Out of season is a MULTIPLIER, never a skip: the tracks
       * describe the typical cycle and firms break it, and this very run found
       * live Summer 2028 postings in a month the bulge-bracket track calls
       * closed. Quieter, never silent.
       */
      const season = seasonFor(source.sectorCategory as FirmProgramCategory);
      const baseIntervalMs = (source.tier.checkIntervalMinutes ?? 1440) * 60_000;
      const seasonalMs = baseIntervalMs * season.intervalMultiplier;

      /**
       * The firm's own history, applied AFTER the seasonal multiplier.
       *
       * Order matters, and this way round is the point: the sector timeline
       * says when firms of this kind usually recruit, and the window says
       * when THIS firm actually has. So a firm that opens outside its
       * sector's normal season - which is precisely the case a sector
       * timeline gets wrong - is still caught, because the acceleration is
       * applied to whatever the season decided rather than being overruled
       * by it.
       *
       * Only ever downward. A prediction may spend extra requests on a guess;
       * it may not stop us looking at a firm because a guess said nothing
       * would happen.
       */
      const urgency = windowUrgency(windowByFirm.get(source.firmId));
      const intervalMs = applyUrgency(seasonalMs, urgency);
      const nextCheckAt = new Date(Date.now() + intervalMs);
      if (!season.inSeason) {
        console.log(`    out of season (x${season.intervalMultiplier}): ${season.reason}`);
      }
      if (urgency.imminent) {
        console.log(
          `    OPENING WINDOW (x${urgency.intervalMultiplier}, next check in ${Math.round(intervalMs / 60000)}m): ${urgency.reason}`,
        );
      }

      /**
       * The vendor did not answer. That is not an answer about the firm.
       *
       * Checked BEFORE the error branch below, because both used to go the
       * same way: `recordFailure` increments failureCount, degrades the
       * source at 2 and marks it broken at 5, and backs off exponentially to
       * a day. Applied to a 429 that is a healthy firm written off with a
       * stated reason nobody revisits.
       *
       * Measured 20 September across every sector: all thirteen Workable
       * sources - nine hedge funds, three VC firms, one real estate manager -
       * answered 429 on one shared host. Five hourly runs would have marked
       * every one of them broken.
       *
       * So: no failure recorded, no health change, and a SHORTER retry than
       * the source's own interval rather than a longer one. See
       * src/lib/monitoring/http-outcome.ts.
       */
      if (isInconclusive(result.httpStatus)) {
        /**
         * Count it against ITS OWN counter, not failureCount.
         *
         * This used to pass `source.failureCount + 1`, and the branch it sits
         * in is the one that deliberately never increments failureCount - so
         * the argument was permanently 1 and the retry never grew past 15
         * minutes. A board answering nothing was asked four times an hour
         * forever: 351 sources that had never once succeeded accounted for
         * 12,902 of 28,597 check runs by 11 October 2026.
         *
         * `consecutiveInconclusive` is what the retry curve was always meant
         * to be reading. Health and failureCount are untouched here, exactly
         * as before - see http-outcome.ts for why that matters.
         */
        /**
         * OUR OWN CLOCK IS NOT THE BOARD'S FAULT.
         *
         * `deadline_exceeded` means the per-source budget cancelled this read.
         * It arrives here as `httpStatus: 0` like any other non-answer, and
         * was counted against `consecutiveInconclusive` exactly as if the firm
         * had failed to reply - which pushes `next_check_at` out on the
         * inconclusive curve, doubling toward a day. So a board that is merely
         * SLOW, or one whose enrichment legitimately ran long, was
         * progressively silenced for a fact about our machine. That is the
         * same inversion `BudgetExpired`'s own comment forbids one layer in:
         * "running out of OUR time is the same class of non-answer as a
         * vendor's 429" - except a 429 at least came from the vendor.
         *
         * Not counted, and retried on the ordinary tier interval instead: the
         * source keeps its place in the schedule, exactly as `withBudget`
         * promises for a cancelled check. The streak is left untouched rather
         * than reset, because a board that was genuinely not answering before
         * this check still was not answering.
         */
        const ourOwnDeadline = result.inconclusiveReason === "deadline_exceeded";
        const attempt = ourOwnDeadline
          ? source.consecutiveInconclusive
          : source.consecutiveInconclusive + 1;
        const retryMs = ourOwnDeadline
          ? intervalMs
          : inconclusiveWaitMs(attempt, result.retryAfterMs);
        await db
          .update(schema.firmMonitoringSources)
          .set({
            lastAttemptedAt: new Date(),
            nextCheckAt: new Date(Date.now() + retryMs),
            consecutiveInconclusive: attempt,
          })
          .where(eq(schema.firmMonitoringSources.id, source.id));
        await db
          .update(schema.monitoringCheckRuns)
          .set({
            finishedAt: new Date(),
            outcome: "error",
            errorMessage: inconclusiveMessage(result.httpStatus, result.inconclusiveReason),
          })
          .where(eq(schema.monitoringCheckRuns.id, run.id));
        console.log(
          ourOwnDeadline
            ? `    CANCELLED BY OUR BUDGET (not the board's fault) - streak left at ${attempt}; retrying on the normal ${Math.round(retryMs / 60000)}m interval`
            : `    NO ANSWER (HTTP ${result.httpStatus}${result.inconclusiveReason ? ` ${result.inconclusiveReason}` : ""}) #${attempt} in a row - not counted as a failure; retrying in ${Math.round(retryMs / 60000)}m`,
        );
        return;
      }

      if (result.httpStatus !== 0 && result.httpStatus >= 400) {
        await recordFailure(source, run.id, `HTTP ${result.httpStatus}`, nextCheckAt);
        console.log(`    ERROR: HTTP ${result.httpStatus}`);
        return;
      }

      /**
       * A board that is empty because nobody filled in its search box.
       *
       * Surfaced rather than written: there is no posting here to store, and
       * the point is that "produces nothing" stops being indistinguishable
       * from "has nothing". audit-connector-conversion.ts is where this
       * should be counted once it has somewhere to live.
       */
      if (result.blockedBy === "search_form") {
        console.log("    NO LISTINGS - page is a search form awaiting input, not an empty board");
      }

      const unchanged = result.notModified || result.contentHash === source.lastContentHash;
      if (unchanged) {
        /**
         * An unchanged board is not a finished board.
         *
         * Every connector caps how many detail pages one pass may fetch, so a
         * busy board leaves real internships holding a title and nothing else -
         * and the description is where eligibility, deadlines and the
         * recruiting cycle live. If the only chance to go back for them were a
         * check where the board changed, a stable board would keep its stubs
         * forever. This is that second chance, and it costs nothing once a
         * listing has real text.
         *
         * Skipped entirely when the connector reported 304, because then there
         * are no listings in hand to enrich.
         */
        let backfilled = 0;
        // How many were ASKED for, so "tried and got nothing" is countable.
        let thinCount = 0;
        if (!result.notModified && result.listings.length) {
          const stored = await db.query.detectedListings.findMany({
            where: eq(schema.detectedListings.sourceId, source.id),
          });
          const storedByKey = new Map(stored.map((l) => [l.externalJobId, l]));
          const thin: { listing: NormalizedListing; existingId: string; enrichmentAttempts?: number | null }[] = [];
          for (const listing of result.listings) {
            const existing = storedByKey.get(listingIdentityKey(listing));
            if (!existing) continue;
            if (shouldRetryEnrichment(existing)) {
              thin.push({ listing, existingId: existing.id, enrichmentAttempts: existing.enrichmentAttempts });
            }
          }
          thinCount = thin.length;
          stopIfCancelled();
          const enrichStartedAt = Date.now();
          backfilled = await backfillThinListings(source, connector, thin, signal);
          enrichMs += Date.now() - enrichStartedAt;
        }

        await db
          .update(schema.monitoringCheckRuns)
          .set({
            finishedAt: new Date(),
            outcome: "no_change",
            httpStatus: result.httpStatus,
            staticMs: result.timings?.staticMs ?? null,
            renderMs: result.timings?.renderMs ?? null,
            enrichMs: enrichMs,
          })
          .where(eq(schema.monitoringCheckRuns.id, run.id));
        await db
          .update(schema.firmMonitoringSources)
          .set({
            lastAttemptedAt: new Date(),
            lastSuccessAt: new Date(),
            nextCheckAt,
            failureCount: 0,
            consecutiveInconclusive: 0,
            sourceHealth: await healthAfterSuccess(source, result.listings.length, run.id, true),
          })
          .where(eq(schema.firmMonitoringSources.id, source.id));
        /**
         * "0 back-filled from 32 thin" is a finding; silence is not.
         *
         * A connector whose `enrich` runs and returns nothing looked exactly
         * like a board with nothing to enrich: both printed "no change".
         * Robert W. Baird sat that way with 32 listings in the review queue,
         * every one of them a real internship with an empty description,
         * while its board returned all 119 rows on every check and the source
         * read healthy.
         *
         * The count is what separates "nothing to do" from "tried and got
         * nothing", which are different problems with different fixes - and
         * the second one is invisible without this line.
         */
        const enrichNote = thinCount
          ? `, ${backfilled} back-filled of ${thinCount} thin${backfilled === 0 ? " - ENRICH RETURNED NOTHING" : ""}`
          : "";
        console.log(`    no change${enrichNote}`);
        return;
      }

      /**
       * A source with no parseable board, whose page text changed.
       *
       * 64 of 110 monitored firms point their careers link at a contact form
       * or a homepage. LionTree and Qatalyst genuinely have no board - that is
       * how a twenty-analyst boutique recruits - so no connector will ever
       * reach them. What does change is a sentence: "Applications for our
       * Summer 2028 Analyst Program are now open."
       *
       * That gets recorded as an opening SIGNAL, never a posting. We have no
       * title, no link and no requirements, and manufacturing a posting out of
       * a sentence would be inventing exactly what this pipeline refuses to
       * invent. The signal carries the sentence verbatim, and the resolver
       * already knows how to rank it.
       *
       * NOT only when the board yields nothing, which is what this used to
       * require. That gate confused two different things: for a posting that
       * is open NOW, a parseable board is indeed a better source than prose
       * about one - but an announcement is about a cycle that has not opened
       * yet, and no board can carry a posting that does not exist. A firm with
       * three live roles that also says "Summer 2028 applications open in
       * September" was never read for that sentence, and `firm_announcement`
       * is the highest-authority signal this system models.
       *
       * Duplication is not a risk: a signal is only written when the sentence
       * is NEW relative to the stored page text, and a board's own listings
       * are not prose.
       */
      if (result.pageText) {
        const announcement = detectAnnouncement(source.lastPageText, result.pageText);

        if (announcement && announcement.confidence >= AMBIGUOUS_BELOW) {
          const cycleYear = announcement.cycleYear ?? defaultCycleForAnnouncement();
          const openingLater = announcement.kind === "opens_later";

          /**
           * A firm saying WHEN it will open is the strongest claim this system
           * can hold.
           *
           * `firm_announcement` outranks what we saw live, a student's report
           * and our own prediction - and rightly: the firm is the authority on
           * its own calendar. So "applications open in September" is not
           * discarded for being future tense, it is recorded as a schedule,
           * and the student sees when to come back rather than nothing at all.
           *
           * The window comes from parseWindow, which keeps vague vague: a month
           * becomes that whole month, "the fall" returns null rather than a
           * guess, and a null window still leaves a dated, quotable claim.
           */
          const window =
            openingLater && announcement.whenPhrase && announcement.whenYear
              ? parseWindow(announcement.whenPhrase, announcement.whenYear)
              : null;

          try {
            await recordOpeningSignal(
              {
                firmId: source.firmId,
                cycleYear,
                programCategory: source.sectorCategory as FirmProgramCategory,
                source: openingLater ? "firm_announcement" : "seen_live",
                // The firm's own sentence, quoted. Same rule the classifier
                // follows: a claim that cannot say where it came from is not
                // reviewable, and an unreviewable date is worse than none.
                evidence: `announced on the careers page: "${announcement.sentence}"`,
                sourceUrl: source.careersUrl,
                // A future announcement carries a real opensStart - the firm
                // named it. A live sighting never does: seeing a posting says
                // it had opened BY now and nothing about when.
                opensStart: openingLater ? (window?.start ?? null) : null,
                opensEnd: openingLater ? (window?.end ?? null) : new Date(),
                observedAt: new Date(),
              },
              db,
            );
            announcementsFound += 1;
            const when = window
              ? `${window.start.toISOString().slice(0, 10)} to ${window.end.toISOString().slice(0, 10)}`
              : openingLater
                ? `${announcement.whenPhrase ?? "unspecified"} (no parseable window)`
                : "open now";
            console.log(
              `    ANNOUNCEMENT ${openingLater ? "OPENS LATER" : "OPEN NOW"} (${announcement.confidence}, cycle ${cycleYear}, ${when})`,
            );
            console.log(`      "${announcement.sentence.slice(0, 96)}"`);
          } catch (err) {
            console.error("    announcement signal write failed:", err);
          }
        } else if (announcement) {
          // Below the bar on its own - named an opening but neither the
          // programme nor the cycle. Logged rather than written; this is the
          // band a model could adjudicate.
          console.log(`    weak announcement (${announcement.confidence}, not recorded): "${announcement.sentence.slice(0, 80)}"`);
        }
      }

      // Something changed on the page - diff listing by listing.
      const existingListings = await db.query.detectedListings.findMany({
        where: eq(schema.detectedListings.sourceId, source.id),
      });
      const existingByKey = new Map(existingListings.map((l) => [l.externalJobId, l]));
      const seenKeys = new Set<string>();
      // Everything from here to the end of this branch is per-listing work on a
      // board that may hold hundreds of them.
      stopIfCancelled();

      let listingsNew = 0;
      /**
       * Rows waiting to be written, and how many before a flush.
       *
       * 100 keeps a single statement well inside Postgres' parameter limit
       * for this table's width while turning a 391-listing board from 391
       * round trips into four.
       */
      const newListingRows: (typeof schema.detectedListings.$inferInsert)[] = [];
      const INSERT_BATCH = 100;
      let listingsClosed = 0;
      // Closed AND never readable: removed from the review queue, not deleted.
      let listingsRetired = 0;
      let listingsEnriched = 0;
      // Postings taken down because the listing behind them closed. Reported
      // separately from listingsClosed: one is the crawler's own bookkeeping,
      // the other is a row disappearing from what a student can see.
      let postingsRetired = 0;
      // Which listings THIS pass closed, and the postings that may now have
      // nothing behind them. Both collected rather than acted on in the loop:
      // see the note at the retirement pass below.
      const closedNow = new Set<string>();
      const postingsToReview = new Set<string>();

      // Confirm what we already had, and set aside what we didn't. The split
      // exists so the detail fetch below runs over new listings only - see
      // SourceConnector.enrich. Classification happens after enrichment, not
      // before, since classifying an index-page stub and then replacing the
      // text it was based on would file the listing on evidence we just threw
      // away.
      const newListings: typeof result.listings = [];
      // Already stored, still missing a description, and worth another look.
      const retryListings: { listing: NormalizedListing; existingId: string; enrichmentAttempts?: number | null }[] = [];
      for (const listing of result.listings) {
        stopIfCancelled();
        const key = listingIdentityKey(listing);
        seenKeys.add(key);
        const existing = existingByKey.get(key);

        if (existing) {
          /**
           * Seen before - but if it is a relevant posting we still have no
           * description for, put it back through enrichment.
           *
           * Connector detail caps mean a busy board cannot enrich everything
           * in one pass, and a listing confirmed-but-thin would otherwise keep
           * its stub for as long as it stays open: confirmed on every check,
           * enriched on none. Re-queueing it is the "try to find the
           * information again" step, and it costs nothing once the listing has
           * a real description, because then this test stops matching.
           */
          // Same test the unchanged path uses - see listing-lifecycle.ts.
          // They have to agree, or a listing is thin to one and full to the
          // other and either never enriched or re-fetched forever.
          const worthRetrying = shouldRetryEnrichment(existing);

          await db
            .update(schema.detectedListings)
            .set({ lastConfirmedAt: new Date(), status: "open", updatedAt: new Date() })
            .where(eq(schema.detectedListings.id, existing.id));

          if (worthRetrying) retryListings.push({ listing, existingId: existing.id, enrichmentAttempts: existing.enrichmentAttempts });
          continue;
        }
        newListings.push(listing);
      }

      /**
       * Likely internships go to the front of the enrich queue.
       *
       * Every connector caps how many detail pages one pass will fetch, and
       * the cap used to be spent in whatever order the board happened to list
       * things - so a Stifel board of 149 rows spent its whole budget on
       * compliance officers and product managers while the one Summer Analyst
       * posting kept a title and nothing else. The description is where
       * eligibility and requirements live, so that ordering decided which real
       * internships were publishable purely by where they sat on the page.
       *
       * This does not fetch more, it fetches the right ones first. Anything
       * missed keeps its stub and is picked up on the next cycle, by which
       * point the rows ahead of it have descriptions and no longer need one.
       */
      const looksLikeInternship = (l: NormalizedListing) =>
        TITLE_INTERNSHIP_PATTERN.test(`${l.title} ${l.division ?? ""}`);
      const prioritised = [
        ...newListings.filter(looksLikeInternship),
        ...newListings.filter((l) => !looksLikeInternship(l)),
      ];

      // Outside the pooledFetch slot above, and given its own, so the detail
      // requests are rate-limited against the domain like any other. Never
      // entered once the budget has gone: this is the most expensive thing a
      // source can still ask for - one request per new listing.
      stopIfCancelled();
      const newEnrichStartedAt = Date.now();
      const enriched =
        prioritised.length && connector.enrich
          ? await pooledFetch(source.careersUrl, () => connector.enrich!(prioritised))
          : prioritised;
      // Counted too. This is the most expensive enrichment a check does - one
      // request per NEW listing - and leaving it out meant `enrich_ms` measured
      // the cheap half and read as though enrichment were nearly free.
      enrichMs += Date.now() - newEnrichStartedAt;

      /**
       * Eligibility already read from this firm's other postings, for the
       * pattern fill below.
       *
       * Loaded once per source rather than per listing: a board publishes tens
       * of postings and they all consult the same set.
       */
      const siblingEligibility = existingListings
        .map((l) => {
          const c = l.classification as {
            eligibility?: { gradYears?: number[] };
            recruitingCycle?: number | null;
          } | null;
          return {
            gradYears: c?.eligibility?.gradYears ?? [],
            cycleYear: c?.recruitingCycle ?? null,
          };
        })
        .filter((x) => x.gradYears.length > 0);

      for (let listing of enriched) {
        stopIfCancelled();
        /**
         * A row with no title and no URL is not a posting anybody can act on.
         *
         * Measured on Supabase, 20 September 2026: 22 stored listings carry no
         * title, no description, no listing URL and no external id - 19 from
         * Morgan Stanley's TalentLink board, 2 from Stifel's iCIMS, 1 from
         * Barclays on the generic connector. Three different connectors, which
         * is why the guard belongs here rather than in any one of them.
         *
         * They were all written between 03:41 and 03:44 that morning and never
         * since - 1,276 listings have been stored after that with none - so the
         * path that produced them is already gone. This is the invariant that
         * keeps it gone, at the one place every connector's output funnels
         * through.
         *
         * The cost of storing them was not nothing: each was auto-approved,
         * sat unpublishable for want of a programme year, and then became an
         * item in a human review queue with nothing in it to review.
         */
        if (!listing.title.trim() && !listing.listingUrl?.trim()) {
          continue;
        }

        /**
         * Decode HTML entities once, here, for every connector.
         *
         * BlackRock's "Quantitative Master&rsquo;s Internship Program" was
         * published to students exactly like that. Four connectors carried
         * their own private decoder and the rest carried none - including the
         * generic connector, which is 97.3% of sources and reads titles
         * straight out of scraped HTML.
         *
         * Done at the choke point rather than in each connector, so the next
         * one written gets it without having to remember.
         */
        listing = {
          ...listing,
          title: decodeEntities(listing.title),
          division: listing.division ? decodeEntities(listing.division) : listing.division,
          location: listing.location ? decodeEntities(listing.location) : listing.location,
        };

        const key = listingIdentityKey(listing);
        const classification = classifyListing(
          listing,
          // The board is registered under a sector; use it when the posting
          // does not name one itself.
          source.sectorCategory as FirmProgramCategory,
        );

        /**
         * A posting that did not state who may apply gets the answer this
         * firm gave on its other postings for the same cycle - and only if
         * they all agree. Failing that the field stays blank rather than
         * being filled with a plausible number.
         */
        if (classification.relevant && classification.eligibility.gradYears.length === 0) {
          const pattern = inferFromFirmPattern(
            siblingEligibility,
            classification.recruitingCycle,
          );
          if (pattern) {
            classification.eligibility = pattern;
            classification.matchedEvidence.push(`eligibility from firm pattern: ${pattern.evidence[0]}`);
          }
        }

        // Feed this listing back in, so later listings in the same batch can
        // learn from one that stated its eligibility earlier in the run.
        if (classification.eligibility.gradYears.length > 0) {
          siblingEligibility.push({
            gradYears: classification.eligibility.gradYears,
            cycleYear: classification.recruitingCycle,
          });
        }
        /**
         * Three outcomes, not two.
         *
         * This was `needsHumanReview ? "pending_review" : "auto_approved"`, and
         * that binary is wrong the moment the classifier can say "this is not a
         * posting at all". Those rows set `needsHumanReview: false` meaning
         * "do not spend a human on page furniture" - and the binary read it as
         * "publish without review". One run auto-approved 221 full-time roles,
         * including "Head of Strategic Initiatives" and "AI-Application
         * Security Architect", on the strength of a flag that was trying to
         * say the opposite.
         *
         * `rejected` is the state that was missing: filed, searchable, and
         * overturnable by an admin, but never published and never queued.
         */
        // `auto_approved` means publishable with no human in the loop, which
        // needs a programme year as well as confidence - see
        // publishableWithoutReview. Without that, the crawler stored rows an
        // hour before promotion set them straight back to pending_review.
        /**
         * BINARY. Published or rejected - there is no queue.
         *
         * This used to route a relevant-but-not-publishable listing to
         * `pending_review`, for a person to settle. Measured 11 October 2026:
         * `reviewed_by` was NULL on all 21,716 rows. Nobody had ever settled
         * one, in the system's entire history. 748 listings were open in that
         * queue, and 3,244 more had been classified as genuine internships
         * and then quietly retired when they closed, unseen.
         *
         * A queue nobody works is not a safety mechanism; it is a place
         * listings go to be forgotten while looking handled.
         *
         * SO WHY REJECT RATHER THAN PUBLISH? Because the holds are not
         * borderline internships - they are listings with nothing to show.
         * Of the 61 that a looser rule would release, 45 have a description
         * that is just the title, and an adversarial pass over everything
         * such a rule would publish found 11.4% that are not undergraduate
         * finance internships at all: a part-time bank-teller job, a
         * vice-president hire, a senior data scientist, an apprenticeship.
         * Publishing those breaks the one property this system has never
         * broken.
         *
         * NOTHING IS LOST BY REJECTING. Every rejection carries its reason -
         * see `reasonForUncertainty`, which now names all five conditions
         * rather than three - and a rule change plus
         * `reclassify-listings.ts` recovers them: 39 listings came back that
         * way today under "recovered from machine rejection". A rejected row
         * with a stated reason is recoverable. A queued row nobody reads is
         * not.
         */
        /**
         * A PORTFOLIO BOARD'S JOBS ARE NOT THIS FIRM'S JOBS.
         *
         * A Getro board aggregates openings at a venture firm's PORTFOLIO
         * companies, and the connector reads one as the firm's own careers
         * page - so everything it finds was published under the board owner's
         * name. Measured 12 October 2026: 26 `getro` sources and 64 live
         * postings across four firms. Group 11 carried 55, every application
         * URL on careers.munichre.com, so a student browsing a venture firm
         * was shown Munich Re's German Praktikant and actuarial roles.
         *
         * Rejected rather than held: the listing is real, it is simply not
         * attributable from what this board tells us, and the reason says so
         * for whoever builds the per-listing employer extraction that would
         * make these publishable properly.
         */
        const fromPortfolioBoard = isPortfolioBoard(source.connectorId);
        const reviewStatus =
          !fromPortfolioBoard && publishableWithoutReview(classification)
            ? "auto_approved"
            : "rejected";
        // The reason, like every other rejection - otherwise this becomes one
        // more unexplained row, which is the defect half of them already had.
        if (fromPortfolioBoard) {
          classification.reasonForUncertainty =
            "portfolio board: the job belongs to a company this firm invested in, not to this firm";
        }
        /**
         * Queued, not written one at a time.
         *
         * This was an `await` per listing, and a first crawl of a busy board
         * is hundreds of them: JPMorgan holds 391 listings, Kroll 381, Morgan
         * Stanley 253. Every one was a separate round trip to Supabase over
         * the session pooler, and they are all the same statement.
         *
         * It matters most exactly now, because 4,725 sources were enrolled on
         * 20 September 2026 and every one of them still has its first crawl
         * ahead of it - the single pass where a board inserts everything it
         * holds rather than the handful that changed.
         *
         * Flushed in batches inside the loop rather than once at the end, so
         * a failure part way through loses a batch rather than a board. No
         * `.returning()` here and nothing downstream reads the inserted row,
         * which is what makes this a shape change rather than a behaviour
         * one.
         */
        newListingRows.push({
          sourceId: source.id,
          externalJobId: key,
          contentHash: sha256(`${listing.title}|${listing.listingUrl}`),
          title: listing.title,
          division: listing.division,
          location: listing.location,
          descriptionRaw: listing.descriptionRaw,
          employmentType: listing.employmentType,
          // Not listing.applicationUrl directly: most connectors set it to the
          // listing url, which sends the student to the advert rather than
          // the form. preferApplyUrl keeps a connector's own answer when it
          // has one and derives a candidate only when it does not.
          applicationUrl: preferApplyUrl(listing),
          listingUrl: listing.listingUrl,
          publishedAt: listing.publishedAt ? new Date(listing.publishedAt) : null,
          // Stored as well as forwarded into opening_signals, so a rebuilt
          // signals table can recover it. See the column's comment.
          deadlineAt: listing.deadlineAt ? new Date(listing.deadlineAt) : null,
          classification,
          reviewStatus,
          /**
           * Written here rather than left to the column default.
           *
           * Finding a listing IS confirming it, so the run that inserts it
           * should say when - and the value then comes from the same clock as
           * every later confirmation, instead of from Postgres `now()`. The
           * two disagreed by five hours (src/db/utc-clock.ts) and the default
           * was the losing half: a new listing read back as already stale and
           * was closed on its first missed check.
           *
           * utc-clock.ts makes the two clocks agree. This makes there be one.
           */
          lastConfirmedAt: new Date(),
        });
        if (newListingRows.length >= INSERT_BATCH) {
          await db.insert(schema.detectedListings).values(newListingRows.splice(0));
        }
        /**
         * A row rejected FOR being an event is filed as one rather than lost.
         *
         * Evercore publishes campus info sessions and coffee chats on the same
         * board as its vacancies. Rejecting them as internships was right and
         * discarding them was not - a coffee chat with Evercore is worth a lot
         * to a student, just not as a job posting.
         *
         * Kept out of `events`, which is a student's own calendar and syncs to
         * their Google account. A firm's info session belongs to no student
         * until one picks it.
         */
        if (!classification.relevant && wasRejectedAsEvent(classification.matchedEvidence, listing.title)) {
          const parsed = parseRecruitingEvent(listing);
          try {
            await db
              .insert(schema.firmRecruitingEvents)
              .values({
                firmId: source.firmId,
                sourceId: source.id,
                externalId: listing.externalJobId,
                title: listing.title.slice(0, 300),
                eventKind: parsed.kind,
                eventDate: parsed.eventDate,
                registrationDeadline: parsed.registrationDeadline,
                school: parsed.school,
                location: listing.location,
                eventUrl: listing.listingUrl,
                descriptionRaw: listing.descriptionRaw.slice(0, 4000),
                evidence: parsed.evidence,
              })
              .onConflictDoUpdate({
                target: [schema.firmRecruitingEvents.firmId, schema.firmRecruitingEvents.eventUrl],
                set: {
                  lastConfirmedAt: new Date(),
                  eventDate: parsed.eventDate,
                  registrationDeadline: parsed.registrationDeadline,
                  updatedAt: new Date(),
                },
              });
            eventsFound += 1;
          } catch (err) {
            console.error("    recruiting-event write failed:", err);
          }
        }

        listingsNew += 1;
        if (reviewStatus === "auto_approved") autoApprovedTotal += 1;
        else rejectedTotal += 1;

        // Seeing a listing live is a claim about when this firm's programme is
        // open, so it goes into opening_signals alongside every other source
        // rather than being written onto the posting directly. The resolver
        // decides later whether it outranks a student report or a prediction.
        //
        // `db` is passed explicitly: this script owns its own PGlite
        // connection, and letting the helper call getDb() would open a second
        // one on the same data directory.
        if (classification.relevant && classification.recruitingCycle) {
          try {
            await recordOpeningSignal(
              {
                firmId: source.firmId,
                cycleYear: classification.recruitingCycle,
                programCategory: classification.sector,
                source: "seen_live",
                // The classifier's own matched phrases, verbatim - this is the
                // "quote the evidence" rule: every claim carries the text it
                // was read out of, so a reviewer can check it in seconds and a
                // wrong one is visible rather than plausible.
                evidence:
                  classification.matchedEvidence.slice(0, 4).join(" | ") || listing.title,
                sourceUrl: listing.listingUrl,
                // Only opensEnd, never opensStart. Finding a posting live says
                // it had opened BY now; it says nothing about when it opened,
                // and inventing a start date would be the guess this table
                // exists to avoid.
                opensEnd: new Date(),
                // An exact closing date, when the source stated one outright -
                // both ends of the window are the same day because there is no
                // vagueness to preserve. Structured feeds give this; a page
                // the connector had to guess at leaves it null.
                closesStart: listing.deadlineAt ? new Date(listing.deadlineAt) : null,
                closesEnd: listing.deadlineAt ? new Date(listing.deadlineAt) : null,
                observedAt: new Date(),
              },
              db,
            );
          } catch (err) {
            console.error("    opening-signal write failed:", err);
          }
        }
      }

      // Whatever the last batch left. A board with fewer than INSERT_BATCH
      // new listings writes exactly here, in one statement.
      if (newListingRows.length) {
        await db.insert(schema.detectedListings).values(newListingRows.splice(0));
      }

      /**
       * Second pass: fill in descriptions for postings already stored.
       *
       * Runs after the new ones, so a first sighting is never delayed by a
       * backlog, and only for listings whose titles say they are internships -
       * there is no value in fetching the detail page of a compliance officer
       * role we are going to reject either way.
       */
      stopIfCancelled();
      const enrichStartedAt = Date.now();
      listingsEnriched += await backfillThinListings(source, connector, retryListings, signal);
      enrichMs += Date.now() - enrichStartedAt;

      /**
       * Anything previously open but absent from this fetch.
       *
       * The decision lives in listing-lifecycle.ts so it can be tested; the
       * part worth knowing here is that a TRUNCATED read closes nothing. The
       * generic connector and iCIMS both have ceilings, and a board over one
       * is over it on every check - so absence there is permanent and would
       * otherwise turn into a permanent wrong answer.
       */
      if (result.truncated) {
        console.log("    truncated read - no listings closed this pass");
      }
      if (result.httpStatus === 0) {
        console.log("    source unreadable (httpStatus 0) - no listings closed this pass");
      }
      // The closure pass reads a verdict out of what this check already saw, so
      // a cancelled check must not run it: `seenKeys` is only complete if the
      // loops above finished, and closing listings on a partial read is the
      // one mistake listing-lifecycle.ts exists to prevent.
      stopIfCancelled();
      for (const existing of existingListings) {
        const decision = decideClosure(existing, seenKeys, {
          truncated: result.truncated ?? false,
          // httpStatus 0 is how every connector reports "could not read this"
          // - a render timeout, a page that never settled, robots newly
          // disallowing the path. It is not an empty board.
          fetchFailed: result.httpStatus === 0,
          intervalMs,
        });
        if (!decision.close) continue;

        /**
         * A closed listing nobody could ever read leaves the review queue.
         *
         * Closing says the board no longer lists it. If we also never managed
         * to read its description, there is nothing left for a reviewer to
         * judge: no text, and no live posting to go and look at. Leaving it
         * `pending_review` puts a permanently unanswerable question in a human
         * queue.
         *
         * Measured on Supabase, 20 September 2026: 46 of the 145 listings
         * awaiting review were in exactly this state, 44 of them Morgan
         * Stanley's, whose board had started answering with a bot-check page.
         * Every one is a REAL internship - a real title, a real requisition id
         * and a real URL - which is precisely why they are rejected rather
         * than deleted. `rejected` is documented here as filed, searchable and
         * overturnable by an admin; nothing is destroyed, and if the board
         * comes back the crawler re-detects them.
         *
         * Only listings that were never readable. A closed listing WITH a
         * description is still reviewable - a human can read it and decide -
         * so that one stays in the queue where it belongs.
         */
        const unreadable = isThinDescription(existing.descriptionRaw, existing.title);
        const stillQueued = existing.reviewStatus === "pending_review";
        await db
          .update(schema.detectedListings)
          .set({
            status: "closed",
            /**
             * THE REJECTION CARRIES ITS REASON, like every other one.
             *
             * This set `rejected` and wrote nothing to say why. Measured
             * 12 October 2026: 10,413 of 20,457 rejected rows had no
             * `reasonForUncertainty`, 9,138 written in the previous two days,
             * and this branch is the largest single source. 885 of them
             * satisfy every condition `publishableWithoutReview` checks - real
             * Morgan Stanley, JPMorgan and Evercore internships - which is
             * what made them look like silent losses. Every one is `closed`,
             * so nothing live was dropped; what was dropped is any way to
             * count them or get them back.
             *
             * "A rejection states its reason and is recoverable; a queued row
             * nobody reads is not" is the argument the queue's removal rests
             * on. It has to be true of this row too.
             *
             * SCOPE, HONESTLY: this branch is reached only when the row was
             * `pending_review`, and nothing writes that any more - so it fixes
             * the 10,413 rows ALREADY in that state as they close, and for
             * rows created from here on it is close to dead. The ongoing
             * source is upstream, in classify.ts: a listing rejected as
             * page furniture ("View internship programmes", "Internships")
             * gets no `reasonForUncertainty` at all. That is the next fix, and
             * it is not this one.
             *
             * It also OVERWRITES any reason already present. Deliberate: a
             * listing that closed while unreadable is better described by that
             * than by whichever rule first held it back.
             */
            ...(unreadable && stillQueued
              ? {
                  reviewStatus: "rejected" as const,
                  classification: {
                    ...((existing.classification as Record<string, unknown> | null) ?? {}),
                    reasonForUncertainty:
                      "closed while still unreadable - no description was ever retrieved",
                  },
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.detectedListings.id, existing.id));

        /**
         * CLOSING THE LISTING MUST ALSO TAKE DOWN WHAT IT PUT IN FRONT OF A
         * STUDENT.
         *
         * Nothing propagated this. `decideClosure` marked the listing closed
         * and `internship_postings.is_active` stayed true, and no other code
         * closed the gap: the only writers of `is_active = false` are the
         * off-profession retirement and a firm taking its own post down.
         * `isRealPosting` does not catch it either - it judges the title, the
         * description and the deadline, and never asks whether the listing is
         * still open - and no student-facing query joins listing status, the
         * one join that exists reading `first_detected_at` for a badge.
         *
         * Measured 12 October 2026: 416 active crawler postings were backed by
         * a closed listing. Real internships at PJT Partners, Citigroup,
         * Nomura and others, every one gone from the firm's own board and
         * still being shown as live. That is the one failure this system is
         * least allowed: a student applying to something that closed weeks ago.
         *
         * `origin = 'crawler'` in the WHERE as well: a posting a firm wrote
         * itself is the firm's, and the crawler's verdict on a scraped listing
         * says nothing about it.
         *
         * Only when no OTHER open listing still backs the same posting. One
         * vacancy can be promoted from two listings - the same role seen twice
         * on a board, or through two sources for one firm - and the other one
         * still being live means the posting is still real.
         */
        if (existing.promotedPostingId) {
          closedNow.add(existing.id);
          postingsToReview.add(existing.promotedPostingId);
        }
        if (unreadable && stillQueued) listingsRetired += 1;
        listingsClosed += 1;
      }

      /**
       * Decided AFTER the loop, because the answer depends on all of it.
       *
       * Asked per listing inside the loop this was order-dependent and wrong:
       * two listings can promote to the same posting - one vacancy seen twice
       * on a board, or through two sources for one firm - and each iteration
       * reads the OTHER one's pre-pass snapshot, where it is still `open`. So
       * when both closed in the same pass, each deferred to the other and the
       * posting was never taken down. Exactly the silent miss this whole fix
       * exists to remove.
       *
       * `closedNow` is what this pass closed; anything else still open for the
       * same posting means the vacancy is still real and the posting stays.
       *
       * RE-READ FROM THE DATABASE, ACROSS EVERY SOURCE. This asked the
       * question of `existingListings`, which is loaded
       * `where sourceId = source.id` - but posting identity is FIRM-scoped,
       * not source-scoped: `promote-approved-listings.ts` looks a posting up
       * by (firmId, roleTitle, programYear), so two sources for one firm that
       * both carry "2027 Investment Banking Summer Analyst" promote to one
       * posting row. Source A closing its copy could not see that source B's
       * was still live, so it retired a posting for a job still on B's board -
       * permanently, because promote only ever selects
       * `promotedPostingId IS NULL` and B's listing already holds the link.
       *
       * The same re-read fixes a second staleness: the confirm loop above
       * writes `status: "open"` to the DATABASE for a listing seen in this
       * fetch without updating the in-memory row, so a listing that reopened
       * this very pass read as `closed` from the snapshot. The database is
       * authoritative for both, and both writes have already landed by here.
       */
      const backingListings = postingsToReview.size
        ? await db
            .select({
              id: schema.detectedListings.id,
              promotedPostingId: schema.detectedListings.promotedPostingId,
              status: schema.detectedListings.status,
            })
            .from(schema.detectedListings)
            .where(inArray(schema.detectedListings.promotedPostingId, [...postingsToReview]))
        : [];

      for (const postingId of postingsToReview) {
        if (postingStillBacked(postingId, backingListings, closedNow)) continue;
        await db
          .update(schema.internshipPostings)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.internshipPostings.id, postingId),
              eq(schema.internshipPostings.origin, "crawler"),
            ),
          );
        postingsRetired += 1;
      }

      await db
        .update(schema.monitoringCheckRuns)
        .set({
          finishedAt: new Date(),
          outcome: "changed",
          httpStatus: result.httpStatus,
          /**
           * The body's real size, when the connector reports one.
           *
           * This was `result.contentHash.length` - the length of a sha256 hex
           * string - so every one of 6,236 non-null rows held exactly 64 and
           * the column answered nothing. Null now means "not reported",
           * which is a fact, where 64 was not.
           */
          responseBytes: result.responseBytes ?? null,
          /**
           * What the read spent, per stage. Null where the connector reports
           * nothing rather than zero - a zero would read as "instant" in the
           * percentile maths this exists to feed, and the first thing it is
           * for is setting a per-source static timeout instead of the one
           * global 8s set from 24 hand-timed sources.
           *
           * `static_ms` and `render_ms` are measured INSIDE the connector,
           * after the fetch pool's slot is held, so they are time this source
           * actually spent. `enrich_ms` is measured around the two enrichment
           * calls, which acquire their own slots, so it INCLUDES queue and
           * politeness waiting and is not comparable with the other two. That
           * is why `budgetOverrunMs` reads only the first pair.
           */
          staticMs: result.timings?.staticMs ?? null,
          renderMs: result.timings?.renderMs ?? null,
          enrichMs: enrichMs,
          listingsSeen: result.listings.length,
          listingsNew,
          listingsClosed,
        })
        .where(eq(schema.monitoringCheckRuns.id, run.id));

      await db
        .update(schema.firmMonitoringSources)
        .set({
          lastAttemptedAt: new Date(),
          lastSuccessAt: new Date(),
          nextCheckAt,
          failureCount: 0,
          consecutiveInconclusive: 0,
          sourceHealth: await healthAfterSuccess(
            source,
            result.listings.length,
            run.id,
            false,
            result.truncated ?? false,
          ),
          lastEtag: result.etag,
          lastContentHash: result.contentHash,
          /**
           * Remembered so the NEXT check can tell which sentences are new.
           *
           * Kept for every source that returns page text, not only the ones
           * yielding no listings. Clearing it on a board that parses meant two
           * losses: a firm announcing its next cycle alongside live roles was
           * never diffed at all, and the first check after a board stopped
           * parsing had no baseline - and detectAnnouncement returns null
           * without one, so that check's announcement was dropped too.
           */
          lastPageText: result.pageText ?? null,
        })
        .where(eq(schema.firmMonitoringSources.id, source.id));

      listingsNewTotal += listingsNew;
      console.log(
        `    ${listingsNew} new, ${listingsEnriched} back-filled, ${listingsClosed} closed` +
          (listingsRetired ? `, ${listingsRetired} unreadable retired from review` : "") +
          // Called out rather than folded into "closed": this is the count of
          // rows that stopped being visible to a student on this pass.
          (postingsRetired ? `, ${postingsRetired} posting(s) taken down` : "") +
          `, ${result.listings.length} total seen`,
      );

      /**
       * CANCELLATION IS COOPERATIVE, SO ITS FAILURE IS SILENT. Say it out loud.
       *
       * Nothing breaks if the ambient signal stops being installed - the crawl
       * simply stops cancelling, which is the state it was in for its entire
       * history before `withAmbientSignal`. See budgetOverrunMs for why this
       * reads the stage timings rather than the wall clock: a run's elapsed
       * time includes waiting for a fetch-pool slot, so a queued source can
       * finish long after its budget with cancellation working perfectly.
       *
       * Loud, and naming the firm, because this is a bug in a connector or in
       * the carrier rather than anything the board did.
       */
      const overrun = budgetOverrunMs(
        {
          staticMs: result.timings?.staticMs ?? null,
          renderMs: result.timings?.renderMs ?? null,
        },
        SOURCE_BUDGET_MS,
      );
      if (overrun !== null) {
        console.log(
          `    !! BUDGET NOT ENFORCED on ${source.firm.name}: spent ${Math.round(
            (SOURCE_BUDGET_MS + overrun) / 1000,
          )}s against a ${Math.round(SOURCE_BUDGET_MS / 1000)}s budget - cancellation did not stop it`,
        );
      }
    } catch (err) {
      const message = describeError(err);

      /**
       * The budget cancelling this check is not a verdict on the firm either.
       *
       * Rethrown nowhere and recorded nowhere: withBudget has already printed
       * the OVER BUDGET line and closed the check-run row, and this source must
       * keep its failureCount, its health and its place in the schedule -
       * running out of OUR time is the same class of non-answer as a vendor's
       * 429 below. Checked first because `recordFailure` is what the rest of
       * this catch leads to.
       */
      if (err instanceof BudgetExpired) return;

      /**
       * Our own database failing is not a verdict on the firm's board.
       *
       * This is the same rule as `isInconclusive`, one layer further in. That
       * one stops a vendor's 429 being charged to the firm; this stops OUR
       * failed write being charged to it. Both are "we did not get an answer",
       * and `recordFailure` is how a source gets degraded at 2 strikes and
       * marked broken at 5.
       *
       * It is not hypothetical, and it defeats the 429 fix from the outside.
       * The "not counted as a failure" path above writes `next_check_at` to
       * schedule the retry, and that write is inside this try. Measured in
       * /tmp/offerly-crawl.log on 20 September 2026: seven such writes failed
       * in one run, three of them on exactly that line. A throttled Workable
       * source was told it would not be penalised, and was then penalised
       * anyway because the sentence recording the reprieve did not land.
       *
       * The check run is still closed, so nothing is left looking in-flight -
       * but failureCount, sourceHealth and the exponential backoff are left
       * alone, and the source keeps its place in the schedule.
       */
      if (isDatabaseError(err)) {
        console.log(`    DATABASE ERROR - not charged to this source: ${message}`);
        try {
          await db
            .update(schema.monitoringCheckRuns)
            .set({
              finishedAt: new Date(),
              outcome: "error",
              errorMessage: `database error (not the source's fault): ${message}`,
            })
            .where(eq(schema.monitoringCheckRuns.id, run.id));
        } catch {
          // The database is what just failed. Saying so twice adds nothing.
        }
        return;
      }

      await recordFailure(source, run.id, message, new Date(Date.now() + 30 * 60_000));
      console.log(`    ERROR: ${message}`);
    }
  };

  /**
   * Workers, not a `for` loop.
   *
   * Slightly more than the pool's own limit (12 by default): a worker spends
   * part of its time on database writes and classification rather than in a
   * pool slot, so a little slack keeps every fetch slot busy. More than this only
   * queues inside the pool and makes the progress log harder to read.
   */
  const CRAWL_WORKERS = Number(process.env.OFFERLY_CRAWL_WORKERS ?? 16);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(CRAWL_WORKERS, dueSources.length) }, async () => {
      for (;;) {
        const i = nextIndex++;
        if (i >= dueSources.length) return;
        // A source that throws outside its own try/catch must not take the
        // whole run down with it, nor stop this worker taking the next one.
        try {
          await withBudget(dueSources[i], (signal) => checkSource(dueSources[i], i, signal));
        } catch (err) {
          // A refused CONNECTION is not a broken source. Transaction mode
          // should mean this never fires (see src/db/pool.ts), but if the pool
          // is ever exhausted again, dropping the source means a real firm
          // goes uncrawled for the whole cycle and nothing says a listing was
          // missed. Waiting for a connection to come back is cheap; losing
          // PIMCO for an hour is not.
          if (isPoolExhausted(err)) {
            await new Promise((r) => setTimeout(r, 2_000 + Math.random() * 3_000));
            try {
              await withBudget(dueSources[i], (signal) => checkSource(dueSources[i], i, signal));
              continue;
            } catch (retryErr) {
              console.log(
                `    UNCAUGHT on ${dueSources[i].firm.name} (after pool retry): ${describeError(retryErr)}`,
              );
              continue;
            }
          }
          console.log(`    UNCAUGHT on ${dueSources[i].firm.name}: ${describeError(err)}`);
        }
      }
    }),
  );

  console.log(
    `\nDone. ${listingsNewTotal} new listing(s): ${autoApprovedTotal} auto-approved, ` +
      `${rejectedTotal} rejected (not a posting, not relevant, or nothing to show a student).` +
      (announcementsFound ? `\n${announcementsFound} opening announcement(s) recorded from board-less careers pages.` : "") +
      (eventsFound ? `\n${eventsFound} recruiting event(s) filed (info sessions, coffee chats, campus receptions).` : ""),
  );
  await leave(0);
}

/**
 * Flag a board that went from having listings to having none.
 *
 * Returns the health to store. Kept here rather than inlined at the two
 * places health is written, because those two are the success paths and a
 * rule that only guarded one of them would fire on a quiet board and stay
 * silent on a busy one - which is the wrong way round.
 *
 * See src/lib/monitoring/board-collapse.ts for what this is protecting
 * against and why it degrades rather than breaks.
 */
async function healthAfterSuccess(
  source: { id: string },
  seenNow: number,
  runId: string,
  // A 304, or an unchanged content hash. Such a read carries no listings by
  // design, so it can never be evidence that a board emptied.
  notModified = false,
  // The connector knows it did not see the whole board - a capped read, or a
  // render that failed over to the static HTML. Same class as notModified:
  // an empty array that carries no information. See board-collapse.ts.
  truncated = false,
): Promise<"healthy" | "degraded"> {
  const openStored = await db.$count(
    schema.detectedListings,
    and(
      eq(schema.detectedListings.sourceId, source.id),
      eq(schema.detectedListings.status, "open"),
    ),
  );
  if (!isBoardCollapse({ seenNow, openStored, notModified, truncated })) return "healthy";

  const message = collapseMessage(openStored);
  console.log(`    COLLAPSE: ${message}`);
  await db
    .update(schema.monitoringCheckRuns)
    .set({ errorMessage: message })
    .where(eq(schema.monitoringCheckRuns.id, runId));
  return "degraded";
}

/**
 * How long any ONE source may hold a worker.
 *
 * Concurrency stopped a slow source blocking the whole run, but it cannot
 * divide a single source across workers: a run's wall clock is now bounded by
 * its slowest member. Measured over 24 hours on 20 September 2026, per-source
 * duration ran to 1,208 seconds on Workable, 975 on TalentLink and 935 on the
 * generic connector - twenty minutes of one worker, which with sixteen of
 * them is an hour of crawl capacity spent on one board.
 *
 * Three minutes is well past the slowest healthy source seen (JPMorgan at 57
 * seconds), so this cuts the pathological tail and nothing else.
 *
 * NOTHING IS LOST WHEN IT FIRES. The source keeps its place in the schedule
 * and is read again next cycle, and enrichment is resumable by design -
 * `backfillThinListings` runs on every check, including ones where the board
 * did not change, precisely so a partially-read board finishes later. A
 * listing already written stays written; the work simply stops early.
 *
 * The check-run row is closed on the way out, so a timed-out source does not
 * leave a run looking permanently in flight.
 *
 * And the work actually STOPS: the budget carries an AbortSignal that
 * checkSource checks at every stage boundary, so the source it gave up on is
 * not still enriching listings and writing rows minutes later. See withBudget.
 */
const SOURCE_BUDGET_MS = Number(process.env.OFFERLY_SOURCE_BUDGET_MS ?? 180_000);

/**
 * What a cancelled source throws, so nothing downstream mistakes it for the
 * board's fault.
 *
 * It travels out through checkSource's own catch, which recognises it and
 * returns without touching failureCount, sourceHealth or the backoff - the
 * budget firing is a fact about our wall clock, not about the firm, exactly as
 * `isInconclusive` and `isDatabaseError` are elsewhere in that catch.
 */
/**
 * A `DeadlineExpired`, so the failure is named as OURS rather than the board's.
 *
 * The abort reason travels: `safeFetch` aborts its transport with it, so this
 * is the error a cancelled in-flight read rejects with, and `fetch-reason.ts`
 * classifies it through `isDeadlineExpired` - which matches a subclass. Left as
 * a plain Error it would have fallen through to the generic bucket and been
 * reported as the board failing to answer, when the truth is that we stopped
 * asking. Still its own class, because checkSource's catch has to tell running
 * out of our time from a fault of the firm.
 */
export class BudgetExpired extends DeadlineExpired {
  constructor(sourceName: string) {
    super(SOURCE_BUDGET_MS);
    this.message = `cancelled: over the ${Math.round(SOURCE_BUDGET_MS / 1000)}s budget for ${sourceName}`;
    this.name = "BudgetExpired";
  }
}

export async function withBudget(
  source: { id: string; firm: { name: string } },
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  /**
   * Noted before the work starts, so the cleanup below can tell THIS attempt's
   * check run from any older one left open. There were 38 such rows from
   * 7 October, debris from the era when the budget did not cancel; without
   * this bound, a source that goes over budget stamps every one of its own
   * stale rows with this run's message.
   */
  const attemptStartedAt = new Date();

  let timer: NodeJS.Timeout | undefined;
  const expired = Symbol("expired");
  /**
   * The budget CANCELS the work; it used to only stop waiting for it.
   *
   * Racing a task against a timer and returning leaves the task running, and
   * this one is not cheap: it holds a fetch-pool slot, a Chromium tab on the
   * generic connector, and a database connection, and it goes on writing to
   * the source it was just given up on. So a run that gave up on twenty slow
   * sources still had twenty of them going, which is the opposite of what a
   * per-source budget is for - the cap on our own machine (see MAX_CONCURRENT
   * in fetch-pool) stops being a cap at all.
   *
   * The signal reaches `run` and is checked at every stage boundary inside
   * checkSource, so a cancelled source stops at the next one. An HTTP request
   * already in flight inside a connector is NOT interrupted - connectors arm
   * their own per-request timeouts and take no caller signal (SourceRef in
   * lib/monitoring/connectors/types.ts has no `signal` field), so the longest
   * a cancelled source can still occupy is one connector request past the
   * budget rather than the whole remaining board.
   *
   * Aborted BEFORE the race is resolved below, deliberately: the rejection
   * handler attached to the task reads `signal.aborted` to decide whether
   * anybody is still listening, and the two must not be able to interleave.
   */
  const controller = new AbortController();
  const budget = new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new BudgetExpired(source.firm.name));
      resolve(expired);
    }, SOURCE_BUDGET_MS);
  });

  /**
   * A task that fails AFTER the race has been decided has nobody waiting on
   * it, and an unhandled rejection takes the whole crawl down in Node. So the
   * handler is attached to the task itself rather than to the race: before the
   * abort it re-throws, which is how a real error still reaches the worker's
   * catch; after it, the BudgetExpired coming back out of the cancelled task
   * ends here.
   */
  /**
   * The SAME signal, in ambient scope as well as in the parameter.
   *
   * `run` checks it at every stage boundary (`stopIfCancelled` in
   * checkSource), which stops a cancelled source BETWEEN stages. That leaves
   * the case the comment above describes as unavoidable: a request already in
   * flight inside a connector, because `SourceRef` carries no `signal` field
   * and twenty-two connectors would each have to thread one.
   *
   * Putting it in ambient scope closes that without touching any of them.
   * `safeFetch` reads it through `withAmbientDeadline` and the generic
   * connector's `withPage` reads it directly, so an in-flight read is aborted
   * and a pending navigation's tab is closed - including inside code that has
   * never heard of this file. Measured 11 October 2026 over 28,597 check runs,
   * that is the difference between a budget and a log line: `changed` runs
   * averaged 1,141 seconds against this 180-second budget, with a p95 of
   * 18,002 seconds and one error run at 36 hours.
   *
   * The race below still stands in front of it. Cancelling is cooperative, so
   * a connector that honours neither the signal nor a checkpoint must not be
   * able to pin this worker - which is why the worker stops waiting either
   * way, and only the abandoned work changed.
   */
  const task = withAmbientSignal(controller.signal, () => run(controller.signal)).catch((err: unknown) => {
    if (!controller.signal.aborted) throw err;
    if (!(err instanceof BudgetExpired)) {
      console.log(`    (after cancelling ${source.firm.name}) ${describeError(err)}`);
    }
  });

  try {
    const outcome = await Promise.race([task, budget]);
    if (outcome !== expired) return;

    console.log(
      `    OVER BUDGET after ${Math.round(SOURCE_BUDGET_MS / 1000)}s - cancelled; ${source.firm.name} is read again next cycle`,
    );
    // The check-run row is closed here rather than by the cancelled task,
    // which stops at its next checkpoint without writing anything further.
    try {
      await db
        .update(schema.monitoringCheckRuns)
        .set({
          finishedAt: new Date(),
          outcome: "error",
          errorMessage: `over the ${Math.round(SOURCE_BUDGET_MS / 1000)}s per-source budget - not a fault of the board`,
        })
        .where(
          and(
            eq(schema.monitoringCheckRuns.sourceId, source.id),
            isNull(schema.monitoringCheckRuns.finishedAt),
            gte(schema.monitoringCheckRuns.startedAt, attemptStartedAt),
          ),
        );
    } catch {
      // Bookkeeping only. A failure here must not become the run's problem.
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function recordFailure(
  source: typeof schema.firmMonitoringSources.$inferSelect,
  runId: string,
  errorMessage: string,
  nextCheckAt: Date,
) {
  await db
    .update(schema.monitoringCheckRuns)
    .set({ finishedAt: new Date(), outcome: "error", errorMessage })
    .where(eq(schema.monitoringCheckRuns.id, runId));

  const failureCount = source.failureCount + 1;
  const health = failureCount >= 5 ? "broken" : failureCount >= 2 ? "degraded" : "healthy";
  // Exponential-ish backoff, capped at a day, so a broken source doesn't
  // burn its retry budget every tier interval while it stays down.
  const backoffMs = Math.min(24 * 60 * 60_000, (nextCheckAt.getTime() - Date.now()) * Math.pow(2, Math.min(failureCount, 5)));

  await db
    .update(schema.firmMonitoringSources)
    .set({
      lastAttemptedAt: new Date(),
      failureCount,
      sourceHealth: health,
      nextCheckAt: new Date(Date.now() + backoffMs),
      /**
       * A conclusive failure ENDS an inconclusive streak.
       *
       * Reaching here means the source answered - a 404, a 4xx that is not
       * 403 - and an answer is the thing the streak was counting the absence
       * of. Leaving it standing would charge a source twice for one outage:
       * `failureCount` is already backing it off exponentially here, and the
       * stale streak would then compound that the next time the board failed
       * to answer at all.
       *
       * `scripts/backfill-inconclusive-streaks.ts` reconstructs the streak
       * the same way, stopping at the first conclusive run. The two have to
       * agree or the backfill would undo live state.
       */
      consecutiveInconclusive: 0,
    })
    .where(eq(schema.firmMonitoringSources.id, source.id));

  // Two awaits rather than a `.then` returning a query builder: drizzle's
  // builders are thenables, so returning one from inside `.then` made the
  // whole expression's type depend on which driver is underneath.
  const score = await computePriorityScore(db, source.id);
  await db
    .update(schema.firmMonitoringSources)
    .set({ priorityScore: score })
    .where(eq(schema.firmMonitoringSources.id, source.id));
}

/**
 * Run unless something has imported this file to test one piece of it.
 *
 * The budget and its cancellation are worth a test of their own - the whole
 * point of withBudget is a path that only happens when a source runs long -
 * and reaching it must not start a crawl against the live database.
 *
 * The default is to RUN. An absent variable means "this is the crawl", so
 * nothing about a deployment, a plist or a shell can turn the hourly job into
 * a silent no-op through this line; only a caller that deliberately sets
 * OFFERLY_MONITOR_IMPORT_ONLY before importing gets the quiet module, and the
 * only caller that does is scripts/test/deferred-source-budget-cancel.test.ts.
 */
if (!process.env.OFFERLY_MONITOR_IMPORT_ONLY) main();
