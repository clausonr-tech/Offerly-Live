// Size every firm we can, from the SEC's own filings.
//
// WHAT THIS IS FOR
// ----------------
// Tiers are supposed to be DERIVED rather than hand-assigned - 22,575 rows of
// manual tiering is a job nobody does - and the inputs that decide whether a
// firm plausibly runs a summer analyst programme are how big it is and
// whether it recruits at all. Nothing in the directory carried a headcount,
// so `enrollment.ts` has been asking for `employees` and getting null, and
// saying so in its reasons ("no Form ADV size data to judge by").
//
// Form ADV Part 1A answers it for 23,918 SEC-registered advisers and exempt
// reporting advisers - which covers most of asset management, private equity,
// hedge funds and venture capital, the four largest buckets in the directory.
//
//   Item 5A  TtlEmp   total employees
//   Item 5F  Q5F2C    regulatory assets under management, whole dollars
//   Item 1   WebAddr  the firm's own website
//
// MATCHED BY DOMAIN, NOT BY NAME
// ------------------------------
// Deliberately. The directory stores Form ADV LEGAL ENTITY names - "Blackstone
// Isg-i Advisors L.L.C." rather than "Blackstone" - and so does this feed, but
// the two do not agree often enough to rely on: entity names differ by
// punctuation, suffix and which affiliate filed. Domains are exact, and a firm
// that publishes the same website in its SEC filing and in our directory is
// the same firm with no fuzzy matching involved.
//
//   npx tsx --conditions=react-server scripts/ingest-form-adv.ts
//
// Network, no database. Writes scripts/data/form-adv-firms.json.
import { writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import bulkFirmRows from "../src/lib/firm-seeds-bulk.json";
import {
  domainOf,
  parseFirmBlocks,
  type AdvFirm,
} from "../src/lib/monitoring/form-adv-parse";

const UA = "OfferlyMonitor/1.0 (internship listing research; contact via site)";
const BASE = "https://reports.adviserinfo.sec.gov/reports/CompilationReports";
const OUT = "scripts/data/form-adv-firms.json";

/** The feed is regenerated daily and named for its date, with no "latest"
 *  alias - so the newest one is found by asking backwards from today. */
async function findLatestFeed(): Promise<{ url: string; name: string }> {
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let back = 0; back < 21; back++) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - back);
    const name = `IA_FIRM_SEC_Feed_${pad(date.getUTCMonth() + 1)}_${pad(date.getUTCDate())}_${date.getUTCFullYear()}.xml.gz`;
    const url = `${BASE}/${name}`;
    const response = await fetch(url, { method: "HEAD", headers: { "user-agent": UA } });
    if (response.status === 200) return { url, name };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("No Form ADV feed found in the last 21 days - the naming scheme may have changed");
}

// The parser, the normaliser and the blocklist all live in
// src/lib/monitoring/form-adv-parse.ts, which is pure and has committed
// fixtures. They used to be duplicated here - two copies of `domainOf`, one
// on each side of a join that IS a domain comparison, which is the one place
// a silent divergence costs every firm its size.
export {
  domainOf,
  pickFirmWebsite,
  parseFirmBlock,
  parseFirmBlocks,
  NOT_A_FIRM_SITE,
  type AdvFirm,
} from "../src/lib/monitoring/form-adv-parse";

async function main() {
  console.log("finding the latest Form ADV feed...");
  const { url, name } = await findLatestFeed();
  console.log(`  ${name}`);

  const response = await fetch(url, { headers: { "user-agent": UA } });
  const gz = Buffer.from(await response.arrayBuffer());
  // ISO-8859-1, per the feed's own XML declaration. Read as UTF-8 the
  // accented names in it become replacement characters.
  const xml = gunzipSync(gz).toString("latin1");
  console.log(`  ${(gz.length / 1e6).toFixed(1)}MB gzipped, ${(xml.length / 1e6).toFixed(1)}MB of XML`);

  const firms: AdvFirm[] = parseFirmBlocks(xml);

  const withDomain = firms.filter((f) => f.domain).length;
  const withEmployees = firms.filter((f) => f.employees !== null).length;
  const withAum = firms.filter((f) => f.aum !== null).length;
  console.log(
    `\nparsed ${firms.length} firms: ${withDomain} with a website, ` +
      `${withEmployees} with a headcount, ${withAum} with RAUM`,
  );

  // How much of OUR directory this actually sizes - the only number that
  // decides whether this was worth doing.
  const advByDomain = new Map<string, AdvFirm>();
  for (const firm of firms) {
    if (firm.domain && !advByDomain.has(firm.domain)) advByDomain.set(firm.domain, firm);
  }

  const directory = bulkFirmRows as { name: string; website: string | null; category: string }[];
  const matchedByCategory: Record<string, { firms: number; matched: number }> = {};
  let matched = 0;
  for (const row of directory) {
    const bucket = (matchedByCategory[row.category] ??= { firms: 0, matched: 0 });
    bucket.firms += 1;
    const domain = domainOf(row.website);
    if (domain && advByDomain.has(domain)) {
      bucket.matched += 1;
      matched += 1;
    }
  }

  console.log(
    `\nmatched ${matched} of ${directory.length} directory firms by domain ` +
      `(${((matched / directory.length) * 100).toFixed(1)}%)\n`,
  );
  console.log("by category (sized / total):");
  for (const [category, c] of Object.entries(matchedByCategory).sort((a, b) => b[1].matched - a[1].matched)) {
    const rate = c.firms ? ((c.matched / c.firms) * 100).toFixed(1) : "0.0";
    console.log(`  ${String(c.matched).padStart(6)} / ${String(c.firms).padEnd(6)} ${rate.padStart(5)}%  ${category}`);
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        feed: name,
        firms: firms.filter((f) => f.domain || f.crd),
      },
      null,
      0,
    ),
  );
  console.log(`\nwritten to ${OUT}`);
  process.exit(0);
}

main();
