// The registry as a whole: who claims what, and who must not.
//
// The per-connector files check that each parser reads its own vendor. This
// one checks the property none of them can check alone - that for any board
// URL, exactly ONE specialist claims it. Order decides which connector wins
// (`index.ts`: first canHandle wins, generic matches everything and is last),
// so an overlap is not a type error and not a test failure anywhere else. It
// is a board quietly read by the wrong parser.
//
// Written after adding four connectors at once, which is exactly when an
// overlap gets introduced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectConnector, getConnector } from "../../src/lib/monitoring/connectors";
import { greenhouseConnector } from "../../src/lib/monitoring/connectors/greenhouse";
import { talentLinkConnector } from "../../src/lib/monitoring/connectors/talentlink";
import { workdayConnector } from "../../src/lib/monitoring/connectors/workday";
import { oracleHcmConnector } from "../../src/lib/monitoring/connectors/oracle-hcm";
import { leverConnector } from "../../src/lib/monitoring/connectors/lever";
import { icimsConnector } from "../../src/lib/monitoring/connectors/icims";
import { goldmanConnector } from "../../src/lib/monitoring/connectors/goldman";
import { eightfoldConnector } from "../../src/lib/monitoring/connectors/eightfold";
import { krollConnector } from "../../src/lib/monitoring/connectors/kroll";
import { ashbyConnector } from "../../src/lib/monitoring/connectors/ashby";
import { smartRecruitersConnector } from "../../src/lib/monitoring/connectors/smartrecruiters";
import { workableConnector } from "../../src/lib/monitoring/connectors/workable";
import { getroConnector } from "../../src/lib/monitoring/connectors/getro";
import { breezyConnector } from "../../src/lib/monitoring/connectors/breezy";
import { recruiteeConnector } from "../../src/lib/monitoring/connectors/recruitee";
import { dayforceConnector } from "../../src/lib/monitoring/connectors/dayforce";
import { bambooHrConnector } from "../../src/lib/monitoring/connectors/bamboohr";
import { jobviteConnector } from "../../src/lib/monitoring/connectors/jobvite";
import { bairdConnector } from "../../src/lib/monitoring/connectors/baird";
import { genericConnector } from "../../src/lib/monitoring/connectors/generic";
import type { SourceConnector } from "../../src/lib/monitoring/connectors/types";

const SPECIALISTS: SourceConnector[] = [
  greenhouseConnector,
  talentLinkConnector,
  workdayConnector,
  oracleHcmConnector,
  leverConnector,
  icimsConnector,
  goldmanConnector,
  eightfoldConnector,
  krollConnector,
  ashbyConnector,
  smartRecruitersConnector,
  workableConnector,
  getroConnector,
  breezyConnector,
  recruiteeConnector,
  dayforceConnector,
  bambooHrConnector,
  jobviteConnector,
  bairdConnector,
];

const ALL = [...SPECIALISTS, genericConnector];
const ref = (url: string) => ({ careersUrl: url, sourceType: "", lastEtag: null });

// -------------------------------------------------------------- the registry

test("every connector id is unique", () => {
  const ids = ALL.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(", ")}`);
});

for (const connector of ALL) {
  test(`getConnector round-trips ${connector.id}`, () => {
    // monitor-run looks a connector up by the stored connectorId. An id that
    // does not resolve is a source that throws on every check.
    assert.equal(getConnector(connector.id).id, connector.id);
  });
}

test("an unknown connector id throws rather than falling back", () => {
  // Silently substituting generic for a typo'd id would read the board with
  // the wrong parser and look like it worked.
  assert.throws(() => getConnector("nope"), /No connector registered/);
});

test("the generic connector matches everything", () => {
  assert.equal(genericConnector.canHandle(ref("https://example.com/careers")), true);
  assert.equal(genericConnector.canHandle(ref("not a url")), true);
});

test("no specialist claims an ordinary careers page", () => {
  // If one did, every unassessed careers page in the directory would be read
  // by that vendor's parser.
  for (const connector of SPECIALISTS) {
    assert.equal(
      connector.canHandle(ref("https://www.example.com/careers/students")),
      false,
      connector.id,
    );
  }
});

// ------------------------------------------------------------- routing table

const ROUTES: [string, string][] = [
  ["https://boards.greenhouse.io/acme", "greenhouse"],
  ["https://job-boards.greenhouse.io/acme", "greenhouse"],
  ["https://acme.tal.net/vacancy/1", "talentlink"],
  ["https://acme.wd1.myworkdayjobs.com/en-US/External", "workday"],
  ["https://jobs.lever.co/acme", "lever"],
  ["https://careers-acme.icims.com/jobs/search", "icims"],
  ["https://jobs.ashbyhq.com/acme", "ashby"],
  ["https://careers.smartrecruiters.com/Acme", "smartrecruiters"],
  ["https://apply.workable.com/acme/", "workable"],
  ["https://acme.breezy.hr/json", "breezy"],
  ["https://acme.recruitee.com/", "recruitee"],
  ["https://careers.kroll.com/en/job/london/intern/12345/", "kroll"],
  ["https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL", "dayforce"],
  ["https://us231.dayforcehcm.com/CandidatePortal/EN-US/Realterm/Site/Candidateportal", "dayforce"],
  ["https://fcp.bamboohr.com/js/jobs2.php", "bamboohr"],
  ["https://centurion.bamboohr.com/careers/1751", "bamboohr"],
  ["https://jobs.jobvite.com/careers/starwoodcapitalgroup/jobs", "jobvite"],
  ["https://jobs.jobvite.com/starwoodcapitalgroup/jobs", "jobvite"],
  ["https://www.bairdcareers.com/jobs/", "baird"],
  ["https://bairdcareers.com/jobs/r20261002/internship-marketing/", "baird"],
];

for (const [url, expected] of ROUTES) {
  test(`routes to ${expected}: ${url}`, () => {
    assert.equal(detectConnector(url).id, expected);
  });
}

for (const [url, expected] of ROUTES) {
  test(`exactly one specialist claims ${url}`, () => {
    // The real invariant. `detectConnector` returning the right answer only
    // proves the right connector is EARLIER in the list, not that it is alone.
    const claimants = SPECIALISTS.filter((c) => c.canHandle(ref(url))).map((c) => c.id);
    assert.deepEqual(claimants, [expected], `claimed by ${claimants.join(", ")}`);
  });
}

// -------------------------------------------------- the gaps, stated on purpose

const UNREACHABLE: [string, string][] = [
  [
    "https://recruiting2.ultipro.com/MES1003MFAC/JobBoard/69451223-cdce-4faf-9407-23a2cd5ac83b/",
    "UltiPro: robots.txt disallows the only enumeration endpoint - re-checked 19 Sep, unchanged",
  ],
  [
    "https://recruiting.ultipro.com/JON1002JROSE/JobBoard/831f2c6f-2842-6082-be63-f7945fe68801/",
    "UltiPro, second host, same robots.txt",
  ],
  ["https://acme.phenompeople.com/careers", "Phenom: no connector"],
  ["https://acme.csod.com/ux/ats/careersite/1/home", "Cornerstone: no connector"],
  ["https://acme.taleo.net/careersection/x/jobsearch.ftl", "Taleo: no connector"],
  ["https://acme.avature.net/careers", "Avature: no connector"],
];

for (const [url, why] of UNREACHABLE) {
  test(`falls through to generic - ${why}`, () => {
    // These are countable gaps, not bugs. A connector appearing here later is
    // a decision someone made; a connector appearing here by accident is the
    // overlap this file exists to catch.
    assert.equal(detectConnector(url).id, "generic");
  });
}

test("UltiPro is deliberately unclaimed, and this test is the record of why", () => {
  // `recruiting*.ultipro.com/robots.txt`:
  //   Disallow: /            Allow: */JobBoard/
  //   Disallow: */JobBoardView
  // The JobBoard page is a React shell carrying no titles and no opportunity
  // ids, and the host publishes no sitemap. So the board is reachable only
  // through the disallowed endpoint, whether requested directly or by
  // pointing a headless browser at the page that requests it.
  const ultipro = "https://recruiting2.ultipro.com/STE1004/JobBoard/fbeef081/";
  assert.equal(SPECIALISTS.filter((c) => c.canHandle(ref(ultipro))).length, 0);
});

// --------------------------------------------------------- canHandle is total

const JUNK = [
  "",
  " ",
  "not a url",
  "https://",
  "http://",
  "//example.com",
  "javascript:alert(1)",
  "mailto:careers@example.com",
  "tel:+15555555555",
  "data:text/html,<h1>hi</h1>",
  "file:///etc/passwd",
  "ftp://example.com/jobs",
  "https://[",
  "https://exam ple.com",
  "https://example.com:99999/careers",
];

for (const url of JUNK) {
  test(`no connector throws on junk input: ${JSON.stringify(url)}`, () => {
    // canHandle runs on whatever is in the database. One that throws takes
    // down connector selection for every source in the run, not just its own.
    for (const connector of ALL) {
      assert.doesNotThrow(() => connector.canHandle(ref(url)), `${connector.id} on ${url}`);
    }
  });
}

test("detectConnector never throws, and always returns something", () => {
  for (const url of JUNK) {
    assert.doesNotThrow(() => detectConnector(url), url);
    assert.ok(detectConnector(url).id, url);
  }
});

test("a junk URL lands on generic, not on a specialist", () => {
  for (const url of JUNK) {
    assert.equal(detectConnector(url).id, "generic", url);
  }
});

// ------------------------------------------------------------ shape contract

for (const connector of ALL) {
  test(`${connector.id} satisfies the connector contract`, () => {
    assert.equal(typeof connector.id, "string");
    assert.ok(connector.id.length > 0);
    assert.equal(typeof connector.canHandle, "function");
    assert.equal(typeof connector.fetch, "function");
    // enrich is optional by contract, but if present it must be callable.
    if (connector.enrich !== undefined) assert.equal(typeof connector.enrich, "function");
  });
}

test("the connectors that return no description all offer enrichment", () => {
  // A connector whose board carries only titles and has no enrich step can
  // never produce anything the classifier can read beyond the title, and
  // 122 listings are already held back for want of detail.
  for (const connector of [bambooHrConnector, jobviteConnector, bairdConnector, krollConnector]) {
    assert.equal(typeof connector.enrich, "function", connector.id);
  }
});

test("Dayforce needs no enrichment, because its search response carries descriptions", () => {
  // Stated as a test so that if someone adds an enrich step here later, they
  // have to decide to - rather than copying it in from a neighbouring file.
  assert.equal(dayforceConnector.enrich, undefined);
});

test("the four new connectors are all registered", () => {
  // A connector that exists but is not in the CONNECTORS array is dead code,
  // and its firms silently keep using the generic connector.
  for (const id of ["dayforce", "bamboohr", "jobvite", "baird"]) {
    assert.equal(getConnector(id).id, id);
  }
});

// ------------------------------------------- lookalike hosts, per connector
//
// `canHandle` decides which parser claims a source. A connector that accepts a
// lookalike domain does not merely mis-route: Greenhouse took the first path
// segment of `evilgreenhouse.io/acme` as a board token and queried the REAL
// Greenhouse API with it, reading another company's board and filing it under
// this firm. Found by opening-history-api.test.ts, and guarded here for all of
// them at once.

const lookalikeHosts = [
  "https://evilgreenhouse.io/acme",
  "https://greenhouse.io.attacker.net/acme",
  "https://eviljobvite.com/acme/jobs",
  "https://evilbamboohr.com/careers/list",
  "https://evildayforcehcm.com/en-US/x/Board",
  "https://evilbreezy.hr/json",
  "https://evilrecruitee.com/",
  "https://evilbairdcareers.com/jobs/r20261002/x/",
  "https://evilmyworkdayjobs.com/en-US/External",
  "https://evilicims.com/jobs/search",
  "https://evillever.co/acme",
  "https://evilashbyhq.com/acme",
  "https://eviltal.net/candidate/jobboard/vacancy/2/adv/",
  "https://evilworkable.com/acme/",
  "https://evilsmartrecruiters.com/Acme",
  "https://eviloraclecloud.com/hcmUI/CandidateExperience/x",
];
for (const url of lookalikeHosts) {
  test(`no specialist claims a lookalike host: ${url.slice(8, 44)}`, () => {
    const claimants = SPECIALISTS.filter((c) => c.canHandle(ref(url))).map((c) => c.id);
    assert.deepEqual(claimants, [], `claimed by ${claimants.join(", ")}`);
  });
}

test("a lookalike host falls through to the generic connector", () => {
  for (const url of lookalikeHosts) {
    assert.equal(detectConnector(url).id, "generic", url);
  }
});

test("the real vendor hosts still route correctly after the boundary fix", () => {
  // The guard must not start refusing legitimate subdomains.
  assert.equal(detectConnector("https://boards.greenhouse.io/acme").id, "greenhouse");
  assert.equal(detectConnector("https://job-boards.greenhouse.io/acme").id, "greenhouse");
});
