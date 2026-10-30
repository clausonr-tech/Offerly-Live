/**
 * Retire stored listings that carry nothing anybody could review or publish.
 *
 * A row with no title, no description, no listing URL and no external id is
 * not a posting. It cannot be published - promotion needs a role title - and
 * it cannot be reviewed either, because there is nothing in it to look at. It
 * simply sits in the human queue forever taking up a line.
 *
 * Measured on Supabase, 20 September 2026: 22 such rows, all investment
 * banking, from THREE different connectors - 19 Morgan Stanley (talentlink),
 * 2 Stifel (icims), 1 Barclays US (generic). All were written between 03:41
 * and 03:44 that morning and none since; 1,276 listings stored afterwards are
 * clean. The path that produced them is already gone, and monitor-run.ts now
 * refuses to store a listing with neither a title nor a URL, so this script is
 * a one-off clean-up of what that path left behind rather than a routine job.
 *
 * REJECTED, NOT DELETED. `rejected` is the state this codebase documents as
 * "filed, searchable, and overturnable by an admin, but never published and
 * never queued" - so nothing is destroyed and an admin can still see what the
 * crawl stored. Rows that were already published are left alone entirely.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   npx tsx --env-file=.env.local scripts/retire-empty-listings.ts
 *   npx tsx --env-file=.env.local scripts/retire-empty-listings.ts --apply
 */
import { createPostgresClient } from "../src/db/connection";

const apply = process.argv.includes("--apply");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run this with --env-file=.env.local.");
    process.exit(1);
  }
  const sql = createPostgresClient(process.env.DATABASE_URL, { pooling: "as-configured", max: 2, onnotice: () => {} }).sql;

  const doomed = await sql<
    { id: string; sector: string; firm: string; connector_id: string; review_status: string }[]
  >`
    select d.id, s.sector_category as sector, f.name as firm, s.connector_id, d.review_status
    from detected_listings d
    join firm_monitoring_sources s on s.id = d.source_id
    join firms f on f.id = s.firm_id
    where coalesce(btrim(d.title), '') = ''
      and coalesce(btrim(d.description_raw), '') = ''
      and coalesce(btrim(d.listing_url), '') = ''
      and d.external_job_id is null
      and d.promoted_posting_id is null
      -- Already retired rows are done, and must not be counted again.
      -- Without this the query matches its own output: a second run reports
      -- the same 22 rows and says it marked them rejected, which reads as 22
      -- NEW empty listings having appeared since the last run. The number has
      -- to mean "found and fixed", or nobody can use it to tell whether the
      -- guard in monitor-run.ts is holding.
      and d.review_status <> 'rejected'`;

  // Reported per sector, never as one total - a clean-up that names only
  // investment banking firms is not a finished answer about the crawl.
  const bySector = new Map<string, number>();
  const byFirm = new Map<string, number>();
  for (const r of doomed) {
    bySector.set(r.sector, (bySector.get(r.sector) ?? 0) + 1);
    const label = `${r.firm} (${r.connector_id})`;
    byFirm.set(label, (byFirm.get(label) ?? 0) + 1);
  }

  console.log(`${doomed.length} empty listing(s) not yet retired${apply ? "" : " (dry run)"}`);
  if (!doomed.length) {
    console.log("Nothing to do - the crawler has stored no new ones.");
  }
  if (doomed.length) {
    console.log("\nby sector:");
    for (const [sector, n] of [...bySector].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sector.padEnd(24)} ${n}`);
    }
    console.log("\nby source:");
    for (const [firm, n] of [...byFirm].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${firm.padEnd(34)} ${n}`);
    }
    const queued = doomed.filter((r) => r.review_status === "pending_review").length;
    console.log(`\nsitting in the human review queue: ${queued}`);
  }

  if (apply && doomed.length) {
    await sql`
      update detected_listings
      set review_status = 'rejected', status = 'closed', updated_at = now()
      where id = any(${sql.array(doomed.map((r) => r.id))}::uuid[])`;
    console.log(`\nmarked ${doomed.length} rejected`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
