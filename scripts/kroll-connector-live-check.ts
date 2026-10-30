// Live check of the Kroll connector against careers.kroll.com.
//
// Hits the real site - it is the only way to know the sitemap and the
// detail-page meta tags still look the way the connector expects, which is
// the thing that actually breaks. Opens no database, so it runs with the dev
// server up.
//
// DELIBERATELY NOT in scripts/test/. That directory is the `npm run test`
// suite: 129 pure assertions that finish in half a second and pass with no
// network. A live fetch in there would make the suite fail on a plane and
// turn Kroll's uptime into our build status. It also would not have run - the
// suite globs `*.test.ts`, and this file was named `-test.ts`, so while it
// sat there it was neither a unit test nor executed by anything.
//
// The pure half of this - which URLs count as a job - is unit-tested in
// scripts/test/kroll-url.test.ts and does run in the suite.
//
//   npx tsx --conditions=react-server scripts/kroll-connector-live-check.ts
import { krollConnector, parseKrollJobUrl } from "../src/lib/monitoring/connectors/kroll";
import type { NormalizedListing } from "../src/lib/monitoring/connectors/types";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

const INTERNSHIP = /\b(intern|internship|summer analyst|summer associate|off[- ]cycle|insight|spring week|placement)\b/i;

async function main() {
  console.log("\nURL shape");
  check("accepts a real job URL", !!parseKrollJobUrl("https://careers.kroll.com/en/job/amsterdam/intern-restructuring/21014771"));
  check("rejects the careers home page", parseKrollJobUrl("https://careers.kroll.com/en") === null);
  check("rejects a students landing page", parseKrollJobUrl("https://careers.kroll.com/en/students") === null);
  check(
    "rejects a job-shaped path with a non-numeric id",
    parseKrollJobUrl("https://careers.kroll.com/en/job/london/opening-doors-to-a-more-secure-future/story") === null,
  );
  check("rejects another host entirely", parseKrollJobUrl("https://careers.example.com/en/job/a/b/1") === null);
  check(
    "canHandle matches the careers host only",
    krollConnector.canHandle({ careersUrl: "https://careers.kroll.com/en", sourceType: "", lastEtag: null }) &&
      !krollConnector.canHandle({ careersUrl: "https://www.kroll.com/en/careers", sourceType: "", lastEtag: null }),
  );

  console.log("\nfetch() against the live sitemap");
  const result = await krollConnector.fetch({
    careersUrl: "https://careers.kroll.com/en",
    sourceType: "sitemap",
    lastEtag: null,
  });
  check("HTTP 200", result.httpStatus === 200, `got ${result.httpStatus}`);
  check("parsed a full board", result.listings.length > 300, `${result.listings.length} listings`);
  check("content hash is set", result.contentHash.length === 64);
  check("every listing has a numeric external id", result.listings.every((l) => /^\d+$/.test(l.externalJobId ?? "")));
  check("every listing URL is a Kroll job URL", result.listings.every((l) => parseKrollJobUrl(l.listingUrl) !== null));
  check("no duplicate requisition ids", new Set(result.listings.map((l) => l.externalJobId)).size === result.listings.length);
  check(
    "publishedAt is left null by the index",
    result.listings.every((l) => l.publishedAt === null),
    "lastmod is not a posted date",
  );

  const internships = result.listings.filter((l) => INTERNSHIP.test(l.title));
  check("internships are visible from the slug alone", internships.length >= 20, `${internships.length} found`);

  console.log("\nfetch() is stable across calls");
  const second = await krollConnector.fetch({
    careersUrl: "https://careers.kroll.com/en",
    sourceType: "sitemap",
    lastEtag: null,
  });
  check("content hash is unchanged on an unchanged board", second.contentHash === result.contentHash);

  console.log("\nenrich() on three real internships");
  const sample = internships.slice(0, 3);
  console.log(`  (${sample.map((l) => l.externalJobId).join(", ")})`);
  const enriched = await krollConnector.enrich!(sample);

  for (const l of enriched) {
    console.log(`\n  ${l.externalJobId}`);
    console.log(`    title:       ${l.title}`);
    console.log(`    division:    ${l.division}`);
    console.log(`    location:    ${l.location}`);
    console.log(`    type:        ${l.employmentType}`);
    console.log(`    publishedAt: ${l.publishedAt}`);
    console.log(`    description: ${l.descriptionRaw.length} chars - ${l.descriptionRaw.slice(0, 90)}...`);
  }

  const has = (f: (l: NormalizedListing) => unknown) => enriched.every((l) => !!f(l));
  check("\n  every enriched listing gained a real description", enriched.every((l) => l.descriptionRaw.length > 200));
  check("  title came from the source, with its punctuation", enriched.some((l) => l.title.includes(",")));
  check("  division is stated", has((l) => l.division));
  check("  location gained a country", enriched.every((l) => (l.location ?? "").includes(",")));
  check("  requisition type is stated", has((l) => l.employmentType));
  check("  employmentType says Internship", enriched.every((l) => /intern/i.test(l.employmentType ?? "")));
  check("  publishedAt is a real ISO date", enriched.every((l) => !!l.publishedAt && !Number.isNaN(Date.parse(l.publishedAt))));
  check("  no description leaked raw HTML", enriched.every((l) => !/<[a-z]/i.test(l.descriptionRaw)));

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
