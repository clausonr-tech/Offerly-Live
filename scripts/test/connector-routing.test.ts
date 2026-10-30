// Every real monitored board, routed against the real registry.
//
// `detectConnector` runs only when a source is FIRST registered; after that
// the stored connectorId is what the scheduler uses. So adding a connector
// helps no existing source, and a firm registered on Jobvite before the
// Jobvite connector existed stays on `generic` forever - launching Chromium
// every check to scrape a page whose JSON is one request away, and producing
// listings with no external id, which can never be auto-approved.
//
// That happened to Getro, Breezy and Recruitee, and was waiting for Dayforce,
// BambooHR, Jobvite and Baird. audit-connector-drift.ts reports it; this
// checks the routing those reports depend on, over the actual 106 boards
// rather than invented URLs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { detectConnector, getConnector } from "../../src/lib/monitoring/connectors";

type Board = { slug: string; name: string; careersUrl: string; connectorId: string };
const boards: Board[] = JSON.parse(
  readFileSync(path.join(process.cwd(), "scripts", "data", "monitored-boards.json"), "utf8"),
).boards;

test("the board list is actually populated", () => {
  assert.ok(boards.length > 50, `only ${boards.length} boards`);
});

test("every monitored board routes to a connector without throwing", () => {
  for (const b of boards) {
    assert.doesNotThrow(() => detectConnector(b.careersUrl), `${b.name} ${b.careersUrl}`);
  }
});

test("every board's URL is a URL", () => {
  for (const b of boards) {
    assert.doesNotThrow(() => new URL(b.careersUrl), `${b.name}: ${b.careersUrl}`);
  }
});

test("every connector a board is stored on still exists", () => {
  // A renamed or deleted connector leaves its sources pointing at nothing,
  // and the scheduler finds out one board at a time.
  for (const b of boards) {
    assert.doesNotThrow(() => getConnector(b.connectorId), `${b.name} -> ${b.connectorId}`);
  }
});

test("detection is deterministic", () => {
  // First-match-wins over an ordered registry; if it is not stable, drift
  // reports are noise.
  for (const b of boards.slice(0, 40)) {
    assert.equal(detectConnector(b.careersUrl).id, detectConnector(b.careersUrl).id, b.name);
  }
});

test("a vendor-hosted board never routes to the generic connector", () => {
  // The measurable cost of getting this wrong: the generic connector
  // synthesises no external id, so every listing fails `verifiable` and is
  // held for human review forever.
  const vendorHosts = [
    "myworkdayjobs.com",
    "greenhouse.io",
    "lever.co",
    "tal.net",
    "icims.com",
    "jobvite.com",
    "bamboohr.com",
    "dayforcehcm.com",
  ];
  for (const b of boards) {
    const host = new URL(b.careersUrl).hostname;
    const vendor = vendorHosts.find((v) => host === v || host.endsWith(`.${v}`));
    if (!vendor) continue;
    assert.notEqual(
      detectConnector(b.careersUrl).id,
      "generic",
      `${b.name} is on ${vendor} but detects as generic`,
    );
  }
});

// ------------------------------------------------- the connectors added last

const newConnectors: [string, string][] = [
  ["dayforce", "https://jobs.dayforcehcm.com/en-US/exampleco/CANDIDATEPORTAL"],
  ["dayforce", "https://exampleco.dayforcehcm.com/CandidatePortal/en-US/exampleco/Site/CANDIDATEPORTAL"],
  ["bamboohr", "https://exampleco.bamboohr.com/careers"],
  ["bamboohr", "https://exampleco.bamboohr.co.uk/careers"],
  ["jobvite", "https://jobs.jobvite.com/exampleco"],
  ["talentlink", "https://exampleco.tal.net/candidate/jobboard/vacancy/1/adv/"],
];
for (const [expected, url] of newConnectors) {
  test(`${expected} claims its own URLs: ${url.slice(8, 48)}`, () => {
    assert.equal(detectConnector(url).id, expected, url);
  });
}

// --------------------------------------------------------- lookalike hosts

const lookalikes = [
  "https://evilgreenhouse.io/acme",
  "https://greenhouse.io.attacker.net/acme",
  "https://evillever.co/acme",
  "https://eviltal.net/candidate/jobboard/vacancy/1/adv/",
  "https://evilbamboohr.com/careers",
  "https://myworkdayjobs.com.attacker.net/acme/External",
  "https://evildayforcehcm.com/en-US/acme/CANDIDATEPORTAL",
];
for (const url of lookalikes) {
  test(`a lookalike host is never handed to a vendor parser: ${new URL(url).hostname}`, () => {
    // The parsers take a path segment as a board token and query the REAL
    // vendor API with it - returning another company's postings filed under
    // this firm. board-url.ts is worse still: it REWRITES the URL, turning a
    // lookalike domain into a real board address chosen by whoever owns it.
    const id = detectConnector(url).id;
    assert.equal(id, "generic", `${url} was claimed by ${id}`);
  });
}

test("a genuine subdomain is still claimed", () => {
  // The fix must not overshoot: `x.bamboohr.com` IS BambooHR.
  assert.equal(detectConnector("https://realco.bamboohr.com/careers").id, "bamboohr");
  assert.equal(detectConnector("https://realco.tal.net/candidate/jobboard/vacancy/2/adv/").id, "talentlink");
});

test("an unknown host falls through to generic rather than erroring", () => {
  for (const url of [
    "https://careers.example.com/students",
    "https://example.com",
    "https://example.com/a/b/c?d=e#f",
  ]) {
    assert.equal(detectConnector(url).id, "generic", url);
  }
});

test("detectConnector never throws on any board-shaped input", () => {
  const inputs = [
    ...boards.map((b) => b.careersUrl),
    ...lookalikes,
    "https://example.com",
    "https://example.com/" + "a".repeat(2000),
  ];
  for (const url of inputs) assert.doesNotThrow(() => detectConnector(url), url);
});

test("every connector the registry can return has the shape the scheduler uses", () => {
  const ids = new Set(boards.map((b) => b.connectorId));
  for (const id of ids) {
    const c = getConnector(id);
    assert.equal(typeof c.fetch, "function", `${id} cannot fetch`);
    assert.equal(c.id, id, `${id} reports itself as ${c.id}`);
  }
});
