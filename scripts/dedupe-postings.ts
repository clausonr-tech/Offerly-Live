/**
 * Collapse duplicate published postings, then make them impossible.
 *
 * `savePosting` upserts on (firmId, roleTitle, programYear) - it reads for an
 * existing row and inserts when it finds none. NOTHING IN THE DATABASE
 * ENFORCES THAT. Checked on Supabase, 20 September 2026: internship_postings
 * carries four indexes, all non-unique, so the "upsert" is a convention held
 * up by application code alone. Any second writer, any retry, any path that
 * inserts without going through savePosting creates a duplicate, and a
 * student sees the same internship twice.
 *
 * 18 duplicate groups existed - Houlihan Lokey's "Q2 2027 Off-Cycle
 * Internship - Corporate Finance (Technology)", Piper Sandler's "2027 Campus
 * Recruiting - Investment Banking Summer Associate - Charlotte", and others,
 * every one identical in firm, title and year.
 *
 * WHICH COPY SURVIVES. The one with the most description, because that is the
 * one a student can actually judge and the one eligibility was read from. Ties
 * go to the oldest, so a posting keeps the id it has been published under.
 *
 * Listings that pointed at a deleted copy are re-pointed at the survivor
 * rather than orphaned: detected_listings.promoted_posting_id is what stops a
 * listing being published twice, and clearing it would invite exactly that.
 *
 * Pass --apply to dedupe, and --with-index to add the unique constraint
 * afterwards. The index is separate because it is the irreversible half: it
 * will refuse any future duplicate outright rather than leaving one to be
 * cleaned up later.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/dedupe-postings.ts
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/dedupe-postings.ts --apply --with-index
 */
import { createPostgresClient } from "../src/db/connection";

const APPLY = process.argv.includes("--apply");
const WITH_INDEX = process.argv.includes("--with-index");

const INDEX_NAME = "internship_postings_firm_role_year_key";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run this with --env-file=.env.local.");
    process.exit(1);
  }
  const sql = createPostgresClient(process.env.DATABASE_URL, { pooling: "as-configured", max: 2, onnotice: () => {} }).sql;

  // Every row in a duplicate group, richest description first, oldest first
  // on a tie. `rn = 1` is the survivor.
  const groups = await sql<
    {
      id: string;
      firm_id: string;
      role_title: string;
      program_year: number;
      firm: string;
      desc_len: number;
      rn: number;
      group_size: number;
    }[]
  >`
    select p.id, p.firm_id, p.role_title, p.program_year, f.name as firm,
           length(coalesce(p.description_full, '')) as desc_len,
           row_number() over (
             partition by p.firm_id, p.role_title, p.program_year
             order by length(coalesce(p.description_full, '')) desc, p.created_at asc
           )::int as rn,
           count(*) over (partition by p.firm_id, p.role_title, p.program_year)::int as group_size
    from internship_postings p
    join firms f on f.id = p.firm_id`;

  const dupes = groups.filter((g) => g.group_size > 1);
  const survivors = new Map<string, string>();
  for (const g of dupes) {
    if (g.rn === 1) survivors.set(`${g.firm_id}|${g.role_title}|${g.program_year}`, g.id);
  }
  const doomed = dupes.filter((g) => g.rn > 1);

  console.log(
    `${dupes.length - doomed.length} duplicate group(s), ${doomed.length} extra cop(y|ies) to remove\n`,
  );
  for (const d of doomed.slice(0, 20)) {
    console.log(`  ${d.firm.slice(0, 20).padEnd(20)} ${d.role_title.slice(0, 52).padEnd(52)} ${d.desc_len}ch`);
  }
  if (doomed.length > 20) console.log(`  ... and ${doomed.length - 20} more`);

  if (APPLY && doomed.length) {
    for (const d of doomed) {
      const keep = survivors.get(`${d.firm_id}|${d.role_title}|${d.program_year}`);
      if (!keep) continue;
      // Re-point first: the foreign key means deleting a posting a listing
      // still references would fail, and clearing the reference instead would
      // let that listing be published all over again.
      await sql`
        update detected_listings set promoted_posting_id = ${keep}, updated_at = now()
        where promoted_posting_id = ${d.id}`;
      await sql`delete from internship_postings where id = ${d.id}`;
    }
    console.log(`\nremoved ${doomed.length} duplicate posting(s)`);
  }

  if (WITH_INDEX) {
    const remaining = await sql`
      select count(*)::int as n from (
        select 1 from internship_postings group by firm_id, role_title, program_year having count(*) > 1
      ) x`;
    if (remaining[0].n > 0) {
      console.log(`\n${remaining[0].n} duplicate group(s) remain - not adding the index.`);
    } else if (!APPLY) {
      console.log("\n--with-index needs --apply; nothing written.");
    } else {
      await sql`
        create unique index if not exists ${sql(INDEX_NAME)}
        on internship_postings (firm_id, role_title, program_year)`;
      console.log(`\ncreated unique index ${INDEX_NAME} - savePosting's key is now enforced by the database`);
      console.log("Mirror it in src/db/schema.ts so drizzle-kit push does not drop it.");
    }
  }

  if (!APPLY) console.log("\nDry run - pass --apply to write.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
