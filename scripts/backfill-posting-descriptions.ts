// Give published postings the description the crawler already has.
//
// Measured on 21 September 2026: 248 published postings carry a stub where
// the detected_listing they were promoted from holds the full text. The
// Evercore Sales & Trading listing is typical - 115 characters on the
// posting, 3,771 on the listing - and on screen that renders as a card with
// a title and nothing under it, because PostingBody has no sections to show.
//
// HOW THE TEXT GETS LOST
// ----------------------
// A board row carries a title and a location and nothing else; the vacancy's
// own page is fetched later by `enrich`, which is where the description
// lives. Promotion copies descriptionRaw at the moment it runs
// (admin/monitoring/actions.ts: `String(... ?? listing.descriptionRaw)`), so
// a listing promoted BEFORE its page was enriched takes the stub and keeps
// it. Later enrichment updates the listing and never revisits the posting.
//
// WHAT THIS WILL NOT TOUCH
// ------------------------
// Only a posting whose stored description is SHORTER than the listing's by a
// real margin. A posting that already has the longer text, or that an admin
// has written by hand into something fuller, is left exactly as it is - the
// point is to fill blanks, never to overwrite an editor.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-posting-descriptions.ts
//   ... --apply
import { createPostgresClient } from "../src/db/connection";

const APPLY = process.argv.includes("--apply");

/** Below this the two texts are the same text, and rewriting is churn. */
const MIN_GAIN = 200;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\nDATABASE_URL is not set.\n");
    process.exit(1);
  }
  const sql = createPostgresClient(url, { pooling: "as-configured", max: 4, onnotice: () => {} }).sql;
  console.log(APPLY ? "Backfilling posting descriptions.\n" : "DRY RUN - nothing will be written.\n");

  try {
    // The longest listing per posting: a posting can have several listings
    // promoted onto it over a cycle, and the fullest text is the one worth
    // showing.
    const rows = (await sql`
      select p.id::text as id,
             f.name as firm,
             p.role_title as title,
             coalesce(length(p.description_full), 0) as have,
             max(length(d.description_raw)) as best
      from internship_postings p
      join firms f on f.id = p.firm_id
      join detected_listings d on d.promoted_posting_id = p.id
      where d.description_raw is not null and d.description_raw <> ''
      group by p.id, f.name, p.role_title, p.description_full
      having max(length(d.description_raw)) > coalesce(length(p.description_full), 0) + ${MIN_GAIN}
      order by max(length(d.description_raw)) - coalesce(length(p.description_full), 0) desc
    `) as unknown as { id: string; firm: string; title: string; have: number; best: number }[];

    console.log(`${rows.length} posting(s) have a fuller description waiting on their listing.\n`);
    for (const r of rows.slice(0, 8)) {
      console.log(`  ${String(r.have).padStart(5)} -> ${String(r.best).padStart(6)} chars  ${r.firm} - ${r.title.slice(0, 44)}`);
    }
    if (rows.length > 8) console.log(`  ... and ${rows.length - 8} more`);

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to write.");
      return;
    }

    // Set from the listing itself rather than from a value round-tripped
    // through this process: the text stays server-side, and `trim` matches
    // what promotion does with it.
    const res = await sql`
      update internship_postings p
      set description_full = trim(best.raw), updated_at = now()
      from (
        select d.promoted_posting_id as id,
               (array_agg(d.description_raw order by length(d.description_raw) desc))[1] as raw
        from detected_listings d
        where d.promoted_posting_id is not null and d.description_raw is not null and d.description_raw <> ''
        group by d.promoted_posting_id
      ) best
      where p.id = best.id
        and length(best.raw) > coalesce(length(p.description_full), 0) + ${MIN_GAIN}
    `;
    console.log(`\n${res.count} posting(s) updated.`);
    if (res.count !== rows.length) {
      console.log(`  ! expected ${rows.length}; the database reported ${res.count}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
