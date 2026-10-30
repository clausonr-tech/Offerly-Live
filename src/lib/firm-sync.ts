import "server-only";
import { eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firmPrograms, firms } from "@/db/schema";
import { FIRM_SEEDS, type FirmSeed } from "./firm-content";
import { FIRM_MERGE_REDIRECTS } from "./firm-merge-redirects";

// Reconciles the `firms` / `firm_programs` tables against the firm catalog.
//
// An explicit maintenance step - `npm run db:sync-firms` - and nothing else.
// It used to be ensureFirmsSeeded(), awaited at server boot and at the top of
// every firm read in lib/firms.ts. Its first call per process loaded every firm
// WITH its programs to diff against the seeds: ~29MB and 9-13 seconds against
// the remote database, paid by whichever request or cold start got there
// first. The database is the runtime source of truth; the catalog only changes
// when someone edits the seed files, so that is when this runs.
//
// Idempotent: a second run against an up-to-date database writes nothing. And
// non-destructive by default - firms are inserted or updated in place (their
// ids, and everything hanging off them, survive), and a firm that has dropped
// out of the catalog is only reported. Deleting those needs `pruneOrphans`,
// and even then only a firm nothing meaningful depends on is deleted.
//
// All of it runs in ONE transaction: a failure part-way leaves the database as
// it was, never half-synced or half-merged. A dry run is the same transaction,
// always rolled back - so its report is exactly what a real run would do.

/**
 * Every column that references firms.id, and what a merge does with its rows.
 * firm_programs is the one omission: it is regenerated from the catalog and is
 * deleted with its firm. scripts/test/firm-sync-db.test.ts fails if the schema
 * gains a reference to firms that is not listed here.
 *
 * - "move": repoint to the parent brand. No uniqueness involves the column.
 * - dropDuplicatesOn: repoint, but first delete the orphan's rows the parent
 *   already holds under that key (the same student following both, the same
 *   news item tagged with both) - the parent's row is the one kept.
 * - moveUnlessParentHas: repoint, except rows that would collide with a row the
 *   parent already holds under that key (a posting with the same role and year,
 *   an event at the same URL). Those are distinct records that cannot be merged
 *   automatically, so they stay on the orphan and block its deletion.
 * - "keep": never repoint. The admin audit trail records what happened to THAT
 *   firm; rewriting it would falsify history. Its rows block deletion.
 *
 * Anything still pointing at an orphan blocks pruning it, whatever its
 * onDelete: a cascade would destroy the rows, a set-null would disconnect them.
 */
type MergePolicy =
  | "move"
  | "keep"
  | { dropDuplicatesOn: string[] }
  | { moveUnlessParentHas: string[] };

export const FIRM_DEPENDANTS: { table: string; column: string; onMerge: MergePolicy }[] = [
  { table: "user_top_firms", column: "firm_id", onMerge: { dropDuplicatesOn: ["user_id"] } },
  { table: "follows", column: "firm_id", onMerge: { dropDuplicatesOn: ["follower_id"] } },
  { table: "news_item_firms", column: "firm_id", onMerge: { dropDuplicatesOn: ["item_id"] } },
  { table: "internship_postings", column: "firm_id", onMerge: { moveUnlessParentHas: ["role_title", "program_year"] } },
  {
    table: "opening_signals",
    column: "firm_id",
    onMerge: { moveUnlessParentHas: ["cycle_year", "program_category", "source"] },
  },
  {
    table: "student_opening_reports",
    column: "firm_id",
    onMerge: { moveUnlessParentHas: ["reported_by_user_id", "program_category", "cycle_year"] },
  },
  { table: "firm_recruiting_events", column: "firm_id", onMerge: { moveUnlessParentHas: ["event_url"] } },
  { table: "firm_notifications", column: "firm_id", onMerge: { moveUnlessParentHas: ["dedupe_key"] } },
  // One row per firm: the parent's own settings win, the orphan's stay put.
  { table: "firm_match_criteria", column: "firm_id", onMerge: { moveUnlessParentHas: [] } },
  { table: "firm_email_patterns", column: "firm_id", onMerge: { moveUnlessParentHas: [] } },
  { table: "firm_monitoring_sources", column: "firm_id", onMerge: "move" },
  // No onDelete at all: a firm still named as a source's parent cannot even be
  // deleted, so it must move with the merge.
  { table: "firm_monitoring_sources", column: "parent_firm_id", onMerge: "move" },
  { table: "firm_recruiting_contacts", column: "firm_id", onMerge: "move" },
  { table: "contact_sourcing_runs", column: "firm_id", onMerge: "move" },
  { table: "firm_engagement", column: "firm_id", onMerge: "move" },
  { table: "posts", column: "firm_id", onMerge: "move" },
  { table: "discussions", column: "firm_id", onMerge: "move" },
  { table: "directory_people", column: "firm_id", onMerge: "move" },
  // Set-null, so without this an org account linked to an absorbed entity
  // would quietly lose its firm.
  { table: "users", column: "org_firm_id", onMerge: "move" },
  { table: "firm_admin_audit", column: "target_firm_id", onMerge: "keep" },
];

export type FirmSyncOptions = {
  /** Run everything, report it, and roll it all back. */
  dryRun?: boolean;
  /** Delete orphans that nothing but their own programme rows depends on. */
  pruneOrphans?: boolean;
  /** Tests pass a small catalog; the command uses the real one. */
  seeds?: FirmSeed[];
  redirects?: ReadonlyMap<string, string>;
};

/** Row counts keyed "table.column". */
export type DependantCounts = Record<string, number>;

export type OrphanReport = {
  slug: string;
  /** The parent brand this firm was merged into, when that parent exists. */
  mergedInto: string | null;
  /** Rows repointed to the parent. */
  moved: DependantCounts;
  /** Rows deleted because the parent already held the same record. */
  droppedDuplicates: DependantCounts;
  /** Rows still on the orphan afterwards; any of them blocks deletion. */
  blocking: DependantCounts;
  /** "removed" deletes the firm row and its regenerable programme rows. */
  outcome: "removed" | "blocked" | "not-pruned";
  /** Programme rows deleted with the firm (only when removed). */
  programsDeleted: number;
};

export type FirmSyncReport = {
  seeds: number;
  inserted: number;
  updated: number;
  /** Firms whose program rows were (or would be) rewritten. */
  programsReplaced: number;
  unchanged: number;
  /** Slugs in the database but not in the catalog. */
  orphans: string[];
  /** Orphans absorbed into an existing parent brand. */
  mergedOrphans: number;
  removed: string[];
  /** Orphans pruning left in place because something still depends on them. */
  kept: string[];
  orphanDetails: OrphanReport[];
};

type Db = Awaited<ReturnType<typeof getDb>>;

class DryRunRollback extends Error {}

// "Philadelphia, PA" -> "PA". Returns null for anything that is not a plain
// US "City, ST" - the curated rows carry things like "New York · London" or
// just "United States", and inventing a state for those would make a state
// filter quietly wrong rather than merely narrow.
function parseHqState(headquarters: string): string | null {
  const m = /,\s*([A-Z]{2})\s*$/.exec(headquarters.trim());
  return m ? m[1] : null;
}

/** Rows from tx.execute, whichever driver (postgres-js array, PGlite {rows}). */
async function rowsOf<T>(tx: Db, query: SQL): Promise<T[]> {
  const res = (await tx.execute(query)) as unknown;
  return (Array.isArray(res) ? res : ((res as { rows?: T[] }).rows ?? [])) as T[];
}

export async function syncFirmCatalog({
  dryRun = false,
  pruneOrphans = false,
  seeds = FIRM_SEEDS,
  redirects = FIRM_MERGE_REDIRECTS,
}: FirmSyncOptions = {}): Promise<FirmSyncReport> {
  const db = await getDb();
  const report: FirmSyncReport = {
    seeds: seeds.length,
    inserted: 0,
    updated: 0,
    programsReplaced: 0,
    unchanged: 0,
    orphans: [],
    mergedOrphans: 0,
    removed: [],
    kept: [],
    orphanDetails: [],
  };

  // One transaction type across the two drivers (PGlite, postgres-js), as in
  // lib/ai-runner.ts.
  const run = db.transaction.bind(db) as unknown as <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  try {
    await run(async (tx) => {
      const existing = await upsertCatalog(tx, seeds, report);
      const seedSlugs = new Set(seeds.map((f) => f.slug));
      const orphans = existing.filter((f) => !seedSlugs.has(f.slug));
      report.orphans = orphans.map((o) => o.slug);
      for (const orphan of orphans) {
        report.orphanDetails.push(await reconcileOrphan(tx, orphan, { pruneOrphans, redirects, report }));
      }
      if (dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return report;
}

async function upsertCatalog(tx: Db, seeds: FirmSeed[], report: FirmSyncReport) {
  const existingFirms = await tx.query.firms.findMany({ with: { programs: true } });

  // Sync firm-by-firm rather than wiping the table first.
  //
  // This used to `db.delete(firms)` and rebuild whenever the counts drifted.
  // The comment on that line said it cascaded to firmPrograms, but four tables
  // hang off firms with onDelete: "cascade" - firmPrograms, userTopFirms,
  // firmRecruitingContacts and internshipPostings. Only the first is
  // regenerable from this file, so adding a single firm to FIRM_SEEDS silently
  // destroyed every crawled posting and every student's saved shortlist on the
  // next page load. Expanding the firm list is a routine thing to want to do,
  // so it must not be destructive.
  const bySlug = new Map(existingFirms.map((f) => [f.slug, f]));

  for (const seed of seeds) {
    const current = bySlug.get(seed.slug);
    const fields = {
      name: seed.name,
      headquarters: seed.headquarters,
      keyOffices: seed.keyOffices,
      website: seed.website,
      description: seed.description,
      aum: seed.aum ?? null,
      hqState: parseHqState(seed.headquarters),
      hasVerifiedProgram: seed.hasVerifiedStudentProgram !== false,
      // Both or neither: a quote without its source is the thing we are
      // avoiding, so a seed missing the URL stores no quote either.
      selfDescription: seed.selfDescriptionSourceUrl ? (seed.selfDescription ?? null) : null,
      selfDescriptionSourceUrl: seed.selfDescription ? (seed.selfDescriptionSourceUrl ?? null) : null,
    };

    const firmUnchanged =
      current !== undefined &&
      current.name === seed.name &&
      current.headquarters === seed.headquarters &&
      current.keyOffices === seed.keyOffices &&
      current.website === seed.website &&
      current.description === seed.description &&
      current.aum === fields.aum &&
      current.hqState === fields.hqState &&
      current.hasVerifiedProgram === fields.hasVerifiedProgram &&
      current.selfDescription === fields.selfDescription &&
      current.selfDescriptionSourceUrl === fields.selfDescriptionSourceUrl;

    const programsUnchanged =
      current !== undefined &&
      current.programs.length === seed.programs.length &&
      seed.programs.every((p) =>
        current.programs.some(
          (q) =>
            q.category === p.category &&
            q.roleLabel === p.roleLabel &&
            q.timingGuidance === p.timingGuidance &&
            q.careersUrl === p.careersUrl &&
            q.recruitingChannelLabel === p.recruitingChannelLabel &&
            q.recruitingChannelUrl === p.recruitingChannelUrl,
        ),
      );

    // Untouched firms cost one comparison instead of a delete + reinsert, so
    // adding N firms writes N rows rather than rewriting the whole table.
    if (firmUnchanged && programsUnchanged) {
      report.unchanged++;
      continue;
    }
    if (!current) report.inserted++;
    else if (!firmUnchanged) report.updated++;
    if (!programsUnchanged) report.programsReplaced++;

    let firmId: string;
    if (!current) {
      const [inserted] = await tx
        .insert(firms)
        .values({ slug: seed.slug, ...fields })
        .returning();
      firmId = inserted.id;
    } else {
      firmId = current.id;
      if (!firmUnchanged) {
        await tx.update(firms).set(fields).where(eq(firms.id, firmId));
      }
    }

    if (!programsUnchanged) {
      // Safe to replace wholesale: nothing references firmPrograms, so this
      // resyncs one firm's reference content without touching its postings.
      await tx.delete(firmPrograms).where(eq(firmPrograms.firmId, firmId));
      await tx.insert(firmPrograms).values(
        seed.programs.map((p) => ({
          firmId,
          category: p.category,
          roleLabel: p.roleLabel,
          timingGuidance: p.timingGuidance,
          careersUrl: p.careersUrl,
          recruitingChannelLabel: p.recruitingChannelLabel,
          recruitingChannelUrl: p.recruitingChannelUrl,
        })),
      );
    }
  }

  return existingFirms.map((f) => ({ id: f.id, slug: f.slug }));
}

// A firm that has dropped out of the catalog is stale reference data, but it
// may be load-bearing: twenty columns reference firms, holding postings,
// shortlists, follows, monitoring sources and their crawl history, contact-
// sourcing runs, events, signals, notifications and more.
//
// An orphan merged into a parent brand is the same employer under another row,
// so its dependants move to the parent per FIRM_DEPENDANTS - on every sync,
// because moving deletes nothing a student would miss. Removal is opt-in
// (`pruneOrphans`) and by construction: only an orphan with NO remaining
// dependant row of any kind is deleted. Anything else is kept and reported.
async function reconcileOrphan(
  tx: Db,
  orphan: { id: string; slug: string },
  {
    pruneOrphans,
    redirects,
    report,
  }: { pruneOrphans: boolean; redirects: ReadonlyMap<string, string>; report: FirmSyncReport },
): Promise<OrphanReport> {
  const canonicalSlug = redirects.get(orphan.slug);
  const [canonical] = canonicalSlug
    ? await tx.select({ id: firms.id }).from(firms).where(eq(firms.slug, canonicalSlug))
    : [];
  const detail: OrphanReport = {
    slug: orphan.slug,
    mergedInto: canonical ? canonicalSlug! : null,
    moved: {},
    droppedDuplicates: {},
    blocking: {},
    outcome: "not-pruned",
    programsDeleted: 0,
  };

  if (canonical) {
    report.mergedOrphans++;
    await moveDependants(tx, orphan.id, canonical.id, detail);
  }

  detail.blocking = await countDependants(tx, orphan.id);
  if (!pruneOrphans) return detail;

  if (Object.keys(detail.blocking).length) {
    detail.outcome = "blocked";
    report.kept.push(orphan.slug);
    return detail;
  }
  const deletedPrograms = await tx
    .delete(firmPrograms)
    .where(eq(firmPrograms.firmId, orphan.id))
    .returning();
  await tx.delete(firms).where(eq(firms.id, orphan.id));
  detail.programsDeleted = deletedPrograms.length;
  detail.outcome = "removed";
  report.removed.push(orphan.slug);
  return detail;
}

async function moveDependants(tx: Db, orphanId: string, canonicalId: string, detail: OrphanReport) {
  for (const dep of FIRM_DEPENDANTS) {
    if (dep.onMerge === "keep") continue;
    const label = `${dep.table}.${dep.column}`;
    const t = sql.identifier(dep.table);
    const c = sql.identifier(dep.column);
    // The parent already holds a row with the same key as orphan row `o`.
    const parentHas = (keys: string[]) =>
      sql`exists (select 1 from ${t} p where p.${c} = ${canonicalId}::uuid${sql.join(
        keys.map((k) => sql` and p.${sql.identifier(k)} = o.${sql.identifier(k)}`),
      )})`;

    if (typeof dep.onMerge === "object" && "dropDuplicatesOn" in dep.onMerge) {
      const dropped = await rowsOf(
        tx,
        sql`delete from ${t} o where o.${c} = ${orphanId}::uuid and ${parentHas(dep.onMerge.dropDuplicatesOn)} returning 1`,
      );
      if (dropped.length) detail.droppedDuplicates[label] = dropped.length;
    }
    const guard =
      typeof dep.onMerge === "object" && "moveUnlessParentHas" in dep.onMerge
        ? sql` and not ${parentHas(dep.onMerge.moveUnlessParentHas)}`
        : sql``;
    const moved = await rowsOf(
      tx,
      sql`update ${t} o set ${c} = ${canonicalId}::uuid where o.${c} = ${orphanId}::uuid${guard} returning 1`,
    );
    if (moved.length) detail.moved[label] = moved.length;
  }
}

/** Every row, in every FIRM_DEPENDANTS column, still pointing at `firmId`. */
async function countDependants(tx: Db, firmId: string): Promise<DependantCounts> {
  const counts = await rowsOf<{ dep: string; n: number }>(
    tx,
    sql.join(
      FIRM_DEPENDANTS.map(
        (d) =>
          sql`select ${`${d.table}.${d.column}`}::text as dep, count(*)::int as n from ${sql.identifier(d.table)} where ${sql.identifier(d.column)} = ${firmId}::uuid`,
      ),
      sql` union all `,
    ),
  );
  return Object.fromEntries(counts.filter((r) => Number(r.n) > 0).map((r) => [r.dep, Number(r.n)]));
}
