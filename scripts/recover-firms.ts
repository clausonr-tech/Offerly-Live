// Recover firms lost in the 18 September restore, from the last backup that
// still had them. Reports by default; --apply writes to Supabase.
import { PGlite } from "@electric-sql/pglite";
import { createPostgresClient } from "../src/db/connection";

const BACKUP = "local-data/pglite-v3-backup-20260918-221044";
/**
 * Only BofA Securities.
 *
 * Four firms disappeared between the 22:10 and 22:47 backups on 18 September,
 * the window in which the database was being restored after the corruption.
 * Three of the four should stay gone:
 *
 *   Barclays Investment Bank  - renamed; "Barclays (US)" is live and monitored.
 *   DBO Partners              - website pipersandler.com, source pointed at
 *                               Piper Sandler's Workday board.
 *   Waller Helms Advisors     - website hl.com, source pointed at Houlihan
 *                               Lokey's Workday board.
 *
 * Those last two are firms pointed at a DIFFERENT firm's board. Restoring
 * them would crawl Piper Sandler and Houlihan Lokey twice and file the second
 * copy under the wrong name. Their removal was a fix, not a loss.
 *
 * BofA Securities is the real one: business.bofa.com, reading BofA's own
 * campus board, and named in repoint-sources.ts as a firm we monitor.
 */
const LOST = ["BofA Securities"];
const APPLY = process.argv.includes("--apply");

async function main() {
  const src = new PGlite(BACKUP);
  await src.exec("set enable_indexscan=off; set enable_indexonlyscan=off; set enable_bitmapscan=off;");
  const sql = createPostgresClient(process.env.DATABASE_URL!, { pooling: "as-configured", max: 2, onnotice: () => {} }).sql;

  const firms = (await src.query(
    `select * from firms where name in (${LOST.map((n) => `'${n.replace(/'/g, "''")}'`).join(",")})`,
  )).rows as any[];

  for (const f of firms) {
    const already = await sql`select 1 from firms where id = ${f.id}`;
    const sources = (await src.query(`select * from firm_monitoring_sources where firm_id = '${f.id}'`)).rows as any[];
    console.log(`\n${f.name}`);
    console.log(`   website : ${f.website ?? "-"}`);
    console.log(`   category: ${f.program_category ?? "-"}   tier hint: ${f.tier ?? "-"}`);
    console.log(`   already in Supabase: ${already.length ? "YES" : "no"}`);
    console.log(`   monitoring sources in the backup: ${sources.length}`);
    for (const s of sources) console.log(`      ${s.connector_id}  ${s.careers_url}`);
  }
  // The two mis-pointed firms were removed because the firms they actually
  // pointed at are monitored in their own right. Confirm that is still true.
  for (const real of ["Piper Sandler", "Houlihan Lokey"]) {
    const live = await sql`select name from firms where name ilike ${"%" + real + "%"} limit 3`;
    console.log(`\n${real} covered in its own right: ${live.length ? live.map((r: any) => r.name).join(", ") : "NO - worth a look"}`);
  }

  if (APPLY) {
    for (const f of firms) {
      const sources = (await src.query(`select * from firm_monitoring_sources where firm_id = '${f.id}'`)).rows as any[];
      await sql`insert into firms ${sql(f as never, ...Object.keys(f))} on conflict (id) do nothing`;
      for (const s2 of sources) {
        // nextCheckAt now, so the restored source is picked up on the next run
        // rather than inheriting a date from a database that no longer exists.
        await sql`insert into firm_monitoring_sources ${sql({ ...s2, next_check_at: new Date() } as never, ...Object.keys(s2))} on conflict (id) do nothing`;
      }
      console.log(`restored ${f.name} with ${sources.length} source(s)`);
    }
  } else {
    console.log("\nDry run - re-run with --apply to restore these.");
  }
  await src.close();
  await sql.end({ timeout: 5 });
}
main();
