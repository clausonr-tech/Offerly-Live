// Live check of the three mid-market connectors against real boards.
//
//   npx tsx --conditions=react-server scripts/midmarket-connectors-live-check.ts
//
// Hits real vendors, opens no database, and lives outside scripts/test/ for
// the same reason the Kroll check does: that directory is the `npm run test`
// suite and must stay pure and offline. See scripts/safety/README.md.
import { ashbyConnector, parseAshbyOrg } from "../src/lib/monitoring/connectors/ashby";
import {
  smartRecruitersConnector,
  parseSmartRecruitersCompany,
} from "../src/lib/monitoring/connectors/smartrecruiters";
import { workableConnector, parseWorkableAccount } from "../src/lib/monitoring/connectors/workable";
import { detectConnector } from "../src/lib/monitoring/connectors";
import type { SourceConnector } from "../src/lib/monitoring/connectors/types";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

async function live(name: string, connector: SourceConnector, url: string, expectSome: boolean) {
  console.log(`\n${name}: ${url}`);
  try {
    const r = await connector.fetch({ careersUrl: url, sourceType: "", lastEtag: null });
    console.log(`    HTTP ${r.httpStatus}, ${r.listings.length} listing(s), hash ${r.contentHash.slice(0, 12)}`);
    check(`  ${name} responded 2xx`, r.httpStatus >= 200 && r.httpStatus < 300, `got ${r.httpStatus}`);
    if (expectSome) {
      check(`  ${name} parsed listings`, r.listings.length > 0, `${r.listings.length}`);
      check(`  ${name} every listing has a title`, r.listings.every((l) => l.title.length > 0));
      check(`  ${name} every listing has a URL`, r.listings.every((l) => /^https?:\/\//.test(l.listingUrl)));
      check(`  ${name} content hash is set`, r.contentHash.length === 64);
      for (const l of r.listings.slice(0, 3)) {
        console.log(`       - ${l.title.slice(0, 58)} | ${l.location ?? "-"} | desc ${l.descriptionRaw.length}c`);
      }
    }
  } catch (err) {
    check(`  ${name} fetch threw`, false, (err as Error).message.slice(0, 80));
  }
}

async function main() {
  console.log("URL parsing");
  check("ashby org from jobs.ashbyhq.com/ramp", parseAshbyOrg("https://jobs.ashbyhq.com/ramp") === "ramp");
  check("ashby rejects another host", parseAshbyOrg("https://jobs.lever.co/ramp") === null);
  check(
    "smartrecruiters keeps identifier case",
    parseSmartRecruitersCompany("https://jobs.smartrecruiters.com/AcmeCorp/123") === "AcmeCorp",
  );
  check(
    "workable reads the subdomain form",
    parseWorkableAccount("https://acme.workable.com/jobs") === "acme",
  );
  check(
    "workable reads the apply-path form",
    parseWorkableAccount("https://apply.workable.com/acme/") === "acme",
  );
  check(
    "workable does not treat 'apply' as the account",
    parseWorkableAccount("https://apply.workable.com/") === null,
  );

  console.log("\nconnector selection routes to the new connectors");
  check("ashby URL -> ashby", detectConnector("https://jobs.ashbyhq.com/ramp").id === "ashby");
  check(
    "smartrecruiters URL -> smartrecruiters",
    detectConnector("https://jobs.smartrecruiters.com/AcmeCorp").id === "smartrecruiters",
  );
  check("workable URL -> workable", detectConnector("https://apply.workable.com/acme").id === "workable");

  // Real boards. Ashby is the one verified to carry postings; the other two
  // are checked for a clean 200 and correct shape, since whether a given
  // account currently has openings is not ours to control.
  await live("ashby", ashbyConnector, "https://jobs.ashbyhq.com/ramp", true);
  await live("workable", workableConnector, "https://apply.workable.com/deliveroo", false);
  await live(
    "smartrecruiters",
    smartRecruitersConnector,
    "https://jobs.smartrecruiters.com/smartrecruiters",
    false,
  );

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
