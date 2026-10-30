// What dated evidence does a PGlite directory actually hold?
//
//   PGLITE_DATA_DIR=<dir> npx tsx --conditions=react-server scripts/pgprobe.ts
//
// Two jobs. First, answer the one question a WASM abort will not: does
// `select 1` work? A corrupt directory aborts on every query including that
// one, and the abort arrives as several screens of minified stack with no
// message in it.
//
// Second, report the dated evidence already in the database - opening signals,
// and the dates listings carry - because "when did this firm release last
// year" is answerable from what we already stored, for any firm we were
// already watching, without asking the Internet Archive anything.
import { PGlite } from "@electric-sql/pglite";

type Row = Record<string, unknown>;

async function main() {
  const dir = process.env.PGLITE_DATA_DIR;
  if (!dir) {
    console.log("RESULT\tno-dir\tset PGLITE_DATA_DIR");
    return;
  }

  let client: PGlite | undefined;
  try {
    client = new PGlite(dir);
    await client.query("select 1");
  } catch (err) {
    console.log(`RESULT\tDEAD\t${dir}\t${(err as Error).message.slice(0, 70).replace(/\s+/g, " ")}`);
    return;
  }

  const ask = async (label: string, sql: string) => {
    try {
      const r = await client!.query<Row>(sql);
      console.log(`\n== ${label}`);
      if (r.rows.length === 0) console.log("   (none)");
      else console.table(r.rows);
    } catch (err) {
      console.log(`\n== ${label}\n   unavailable: ${(err as Error).message.slice(0, 70)}`);
    }
  };

  const counts: string[] = [];
  for (const table of ["firms", "firm_monitoring_sources", "detected_listings", "opening_signals"]) {
    try {
      const r = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      counts.push(`${table}=${r.rows[0].n}`);
    } catch {
      counts.push(`${table}=MISSING`);
    }
  }
  console.log(`RESULT\tOK\t${dir}\t${counts.join(" ")}`);

  if (process.argv.includes("--dates")) {
    await ask(
      "opening signals, by source",
      `select source, count(*)::int as n,
              min(observed_at)::date as earliest,
              max(observed_at)::date as latest
         from opening_signals group by source order by n desc`,
    );
    await ask(
      "listings: do they carry a published date?",
      `select count(*)::int as total,
              count(published_at)::int as with_published_at,
              min(published_at)::date as earliest,
              max(published_at)::date as latest
         from detected_listings`,
    );
    await ask(
      "when we first SAW each listing (our own crawl history)",
      `select min(created_at)::date as first_ever_crawl,
              max(created_at)::date as latest_crawl,
              count(distinct created_at::date)::int as distinct_days
         from detected_listings`,
    );
    await ask(
      "internship listings with a stated publish date, by month",
      `select to_char(published_at, 'YYYY-MM') as month, count(*)::int as n
         from detected_listings
        where published_at is not null
        group by 1 order by 1`,
    );
    await ask(
      "monitoring tiers, and how many sources sit in each",
      `select t.name, t.check_interval_minutes, count(s.id)::int as sources
         from monitoring_tiers t
         left join firm_monitoring_sources s on s.tier_id = t.id
        group by t.name, t.check_interval_minutes, t.sort_order
        order by t.sort_order`,
    );
  }

  await client.close().catch(() => {});
}

main().then(
  () => process.exit(0),
  (err) => {
    console.log(`RESULT\tDEAD\t${process.env.PGLITE_DATA_DIR}\t${String(err).slice(0, 70)}`);
    process.exit(0);
  },
);
