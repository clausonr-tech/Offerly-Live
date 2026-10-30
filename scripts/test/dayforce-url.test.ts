// Which URLs are a Dayforce board, and which tenant they name.
//
// Two things make this worth a file of its own.
//
// First, Dayforce publishes the SAME tenant under two unrelated path shapes,
// and board discovery recorded one firm under each:
//
//   https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL
//   https://us231.dayforcehcm.com/CandidatePortal/EN-US/Realterm/Site/Candidateportal
//
// Second, the two hosts are not equivalent in POLICY: `us231` redirects its
// robots.txt to `www.dayforcehcm.com`, which is `Disallow: /`, while
// `jobs.dayforcehcm.com` permits everything. So the parser has to recover the
// tenant from the disallowed shape precisely so the connector can go and read
// it on the permitted host instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDayforceBoard } from "../../src/lib/monitoring/connectors/dayforce";
import { dayforceConnector } from "../../src/lib/monitoring/connectors/dayforce";
import { detectConnector } from "../../src/lib/monitoring/connectors";

const ref = (url: string) => ({ careersUrl: url, sourceType: "", lastEtag: null });

// ---------------------------------------------------------------- real boards

test("the shared-host shape names its tenant", () => {
  assert.deepEqual(parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL"), {
    namespace: "stockbridge",
    boardCode: "CANDIDATEPORTAL",
  });
});

test("the per-instance shape names the same kind of tenant", () => {
  assert.deepEqual(
    parseDayforceBoard(
      "https://us231.dayforcehcm.com/CandidatePortal/EN-US/Realterm/Site/Candidateportal",
    ),
    { namespace: "Realterm", boardCode: "Candidateportal" },
  );
});

test("a board URL with no locale still parses", () => {
  assert.deepEqual(parseDayforceBoard("https://jobs.dayforcehcm.com/stockbridge/CANDIDATEPORTAL"), {
    namespace: "stockbridge",
    boardCode: "CANDIDATEPORTAL",
  });
});

test("a two-letter locale is recognised as a locale, not a tenant", () => {
  assert.deepEqual(parseDayforceBoard("https://jobs.dayforcehcm.com/fr/stockbridge/CANDIDATEPORTAL"), {
    namespace: "stockbridge",
    boardCode: "CANDIDATEPORTAL",
  });
});

test("a deep link to one posting still names the board", () => {
  // monitor-run stores whatever URL a source was registered with, and a human
  // pasting a link from the board lands on a posting, not the index.
  assert.deepEqual(
    parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL/jobs/743"),
    { namespace: "stockbridge", boardCode: "CANDIDATEPORTAL" },
  );
});

test("a trailing slash changes nothing", () => {
  assert.deepEqual(parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL/"), {
    namespace: "stockbridge",
    boardCode: "CANDIDATEPORTAL",
  });
});

test("a query string changes nothing", () => {
  assert.deepEqual(
    parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL?page=2"),
    { namespace: "stockbridge", boardCode: "CANDIDATEPORTAL" },
  );
});

test("a fragment changes nothing", () => {
  assert.deepEqual(
    parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL#results"),
    { namespace: "stockbridge", boardCode: "CANDIDATEPORTAL" },
  );
});

// ------------------------------------------------------------- tenant casing

test("tenant case is preserved, because the API rejects the wrong one", () => {
  // Measured 19 Sep: `Realterm` answers 200 with four postings, `realterm`
  // does not. Lowercasing here would silently empty the board.
  assert.equal(parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/Realterm/Candidateportal")?.namespace, "Realterm");
  assert.equal(parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/MiXeDcAsE/Board")?.namespace, "MiXeDcAsE");
});

test("board-code case is preserved too", () => {
  assert.equal(
    parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/x/CANDIDATEPORTAL")?.boardCode,
    "CANDIDATEPORTAL",
  );
  assert.equal(
    parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/x/Candidateportal")?.boardCode,
    "Candidateportal",
  );
});

test("the /Site/ marker is matched case-insensitively", () => {
  // The two real URLs disagree on it: `/Site/` on us231, and the shared host
  // writes paths in lower case.
  for (const marker of ["Site", "site", "SITE"]) {
    assert.deepEqual(
      parseDayforceBoard(`https://us231.dayforcehcm.com/CandidatePortal/EN-US/Acme/${marker}/Board`),
      { namespace: "Acme", boardCode: "Board" },
      `marker ${marker}`,
    );
  }
});

// ------------------------------------------------------------ hosts refused

const lookalikes = [
  "https://evildayforcehcm.com/en-US/x/Board",
  "https://dayforcehcm.com.attacker.net/en-US/x/Board",
  "https://notdayforcehcm.com/en-US/x/Board",
  "https://dayforcehcm.evil.com/en-US/x/Board",
];
for (const url of lookalikes) {
  test(`a lookalike host is refused: ${url}`, () => {
    // "evildayforcehcm.com".endsWith("dayforcehcm.com") is true, which is the
    // trap a bare endsWith falls into.
    assert.equal(parseDayforceBoard(url), null);
  });
}

const otherVendors = [
  "https://boards.greenhouse.io/acme",
  "https://acme.breezy.hr",
  "https://acme.recruitee.com",
  "https://jobs.lever.co/acme",
  "https://acme.bamboohr.com/careers/list",
  "https://jobs.jobvite.com/acme/jobs",
  "https://www.bairdcareers.com/jobs/",
  "https://recruiting2.ultipro.com/ABC1234/JobBoard/guid/",
];
for (const url of otherVendors) {
  test(`another vendor is not a Dayforce board: ${url}`, () => {
    assert.equal(parseDayforceBoard(url), null);
  });
}

// ------------------------------------------------------------- malformed input

const malformed = [
  "",
  "not a url",
  "https://",
  "javascript:alert(1)",
  "mailto:careers@dayforcehcm.com",
  "//jobs.dayforcehcm.com/en-US/x/Board",
  "https://jobs.dayforcehcm.com",
  "https://jobs.dayforcehcm.com/",
  "https://jobs.dayforcehcm.com/en-US",
  "https://jobs.dayforcehcm.com/en-US/",
];
for (const url of malformed) {
  test(`unusable input yields null, never a throw: ${JSON.stringify(url)}`, () => {
    assert.doesNotThrow(() => parseDayforceBoard(url));
    assert.equal(parseDayforceBoard(url), null);
  });
}

test("a bare tenant with no board code is not a board", () => {
  // One segment cannot say which of the tenant's boards is meant, and
  // guessing CANDIDATEPORTAL would read the wrong one silently.
  assert.equal(parseDayforceBoard("https://jobs.dayforcehcm.com/stockbridge"), null);
});

test("a locale plus a tenant, with no board code, is not a board", () => {
  assert.equal(parseDayforceBoard("https://jobs.dayforcehcm.com/en-US/stockbridge"), null);
});

test("a /Site/ marker in first position is not a tenant", () => {
  // `siteAt > 0` - there is no segment before it to be the tenant.
  assert.equal(parseDayforceBoard("https://us231.dayforcehcm.com/Site/Board"), null);
});

test("a /Site/ marker with nothing after it is not a board", () => {
  assert.equal(parseDayforceBoard("https://us231.dayforcehcm.com/CandidatePortal/EN-US/Acme/Site"), null);
});

test("http is accepted as well as https", () => {
  // safeFetch decides what may be requested; this parser decides what is a
  // board. Conflating the two hides one of the decisions.
  assert.deepEqual(parseDayforceBoard("http://jobs.dayforcehcm.com/en-US/x/Board"), {
    namespace: "x",
    boardCode: "Board",
  });
});

test("an uppercase host is still the vendor", () => {
  assert.deepEqual(parseDayforceBoard("https://JOBS.DAYFORCEHCM.COM/en-US/x/Board"), {
    namespace: "x",
    boardCode: "Board",
  });
});

// ------------------------------------------------------------------- routing

test("canHandle agrees with the parser", () => {
  assert.equal(dayforceConnector.canHandle(ref("https://jobs.dayforcehcm.com/en-US/x/Board")), true);
  assert.equal(dayforceConnector.canHandle(ref("https://evildayforcehcm.com/en-US/x/Board")), false);
  assert.equal(dayforceConnector.canHandle(ref("not a url")), false);
});

test("the registry routes a Dayforce board here, not to generic", () => {
  assert.equal(
    detectConnector("https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL").id,
    "dayforce",
  );
  assert.equal(
    detectConnector("https://us231.dayforcehcm.com/CandidatePortal/EN-US/Realterm/Site/Candidateportal").id,
    "dayforce",
  );
});
