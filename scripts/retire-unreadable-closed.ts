/**
 * Take closed, never-readable listings out of the human review queue.
 *
 * Closing says the board no longer lists a posting. If we also never managed
 * to read its description, there is nothing left for a reviewer to judge: no
 * text to read, and no live posting to go and look at. Leaving it
 * `pending_review` puts a permanently unanswerable question in a human queue.
 *
 * Measured on Supabase, 20 September 2026: 46 of the 145 listings awaiting
 * review were in exactly this state, 44 of them Morgan Stanley's, whose board
 * had begun answering with a bot-check page instead of a vacancy table.
 *
 * REJECTED, NOT DELETED - and this is the important part. Every one of these
 * 46 is a REAL internship: a real title ("2027 Corporate Treasury Summer
 * Analyst Program (New York)"), a real requisition id, a real URL, and a
 * classifier verdict of relevant. They are not the blank artefacts that
 * retire-empty-listings.ts clears. Deleting a real record of a real role
 * because its board went dark would destroy history we cannot recover; and if
 * the board comes back, the crawler re-detects them anyway. `rejected` is
 * documented in this codebase as "filed, searchable, and overturnable by an
 * admin, but never published and never queued", which is exactly right here.
 *
 * Only listings that were never readable. A closed listing WITH a description
 * is still reviewable - a human can read it and decide - so it stays queued.
 *
 * monitor-run.ts now applies this rule at the moment it closes a listing, so
 * this script is a one-off for the backlog rather than a routine job. It is
 * safe to re-run: rows it has already retired no longer match.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   npx tsx --env-file=.env.local scripts/retire-unreadable-closed.ts
 *   npx tsx --env-file=.env.local scripts/retire-unreadable-closed.ts --apply
 */
import { createPostgresClient } from "../src/db/connection";

const apply = process.argv.includes("--apply");

/** Mirrors isThinDescription in src/lib/monitoring/listing-lifecycle.ts. */
const MIN_READABLE = 120;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run this with --env-file=.env.local.");
    process.exit(1);
  }
  const sql = createPostgresClient(process.env.DATABASE_URL, { pooling: "as-configured", max: 2, onnotice: () => {} }).sql;

  const doomed = await sql<
    { id: string; sector: string; firm: string; title: string }[]
  >`
    select d.id, s.sector_category as sector, f.name as firm, d.title
    from detected_listings d
    join firm_monitoring_sources s on s.id = d.source_id
    join firms f on f.id = s.firm_id
    where d.review_status = 'pending_review'
      and d.status = 'closed'
      and d.promoted_posting_id is null
      and (
        length(btrim(coalesce(d.description_raw, ''))) < ${MIN_READABLE}
        or btrim(coalesce(d.description_raw, '')) = btrim(d.title)
      )`;

  console.log(`${doomed.length} closed, never-readable listing(s)${apply ? "" : " (dry run)"}`);
  if (!doomed.length) {
    console.log("Nothing to do.");
    await sql.end();
    return;
  }

  // Per sector, never one total.
  const bySector = new Map<string, number>();
  const byFirm = new Map<string, number>();
  for (const r of doomed) {
    bySector.set(r.sector, (bySector.get(r.sector) ?? 0) + 1);
    byFirm.set(r.firm, (byFirm.get(r.firm) ?? 0) + 1);
  }

  console.log("\nby sector:");
  for (const [k, n] of [...bySector].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${String(n).padStart(4)}`);
  }
  console.log("\nby firm:");
  for (const [k, n] of [...byFirm].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${String(n).padStart(4)}`);
  }
  console.log("\nexamples (these are real roles - filed, not deleted):");
  for (const r of doomed.slice(0, 5)) console.log(`  ${r.title.slice(0, 72)}`);

  if (apply) {
    await sql`
      update detected_listings
      set review_status = 'rejected', updated_at = now()
      where id = any(${sql.array(doomed.map((r) => r.id))}::uuid[])`;
    console.log(`\nretired ${doomed.length} from the review queue (kept as rejected)`);
  } else {
    console.log("\nDry run - pass --apply to write.");
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
