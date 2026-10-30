// Which URLs are a BambooHR board, and what its rows become.
//
// Board discovery found two real estate firms here and recorded NEITHER at a
// board URL: `fcp.bamboohr.com/js/jobs2.php` is an embed script and
// `centurion.bamboohr.com/careers/1751` is a single posting. So the account
// has to be recoverable from any URL on the host, and the board URL built
// rather than trusted - which is most of what this file checks.
//
// Fixtures are cut from the real `/careers/list` and `/careers/{id}/detail`
// responses measured 19 September 2026 against both accounts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBambooAccount,
  bambooRowsToListings,
  bambooHrConnector,
  type BambooListRow,
} from "../../src/lib/monitoring/connectors/bamboohr";
import { detectConnector } from "../../src/lib/monitoring/connectors";
import { dedupKey } from "../../src/lib/monitoring/board-identity";

const ref = (url: string) => ({ careersUrl: url, sourceType: "", lastEtag: null });

// ------------------------------------------------------------------- accounts

const accountUrls = [
  "https://fcp.bamboohr.com",
  "https://fcp.bamboohr.com/",
  "https://fcp.bamboohr.com/careers",
  "https://fcp.bamboohr.com/careers/list",
  "https://fcp.bamboohr.com/careers/71",
  "https://fcp.bamboohr.com/careers/71/detail",
  "https://fcp.bamboohr.com/js/jobs2.php",
  "https://fcp.bamboohr.com/careers?department=18434",
  "https://fcp.bamboohr.com/careers#top",
  "http://fcp.bamboohr.com/careers",
  "https://FCP.BAMBOOHR.COM/careers",
];
for (const url of accountUrls) {
  test(`the account survives any path on the host: ${url}`, () => {
    // Every one of these is a URL a human or a discovery run could register.
    assert.equal(parseBambooAccount(url), "fcp");
  });
}

test("the two real accounts parse", () => {
  assert.equal(parseBambooAccount("https://fcp.bamboohr.com/js/jobs2.php"), "fcp");
  assert.equal(parseBambooAccount("https://centurion.bamboohr.com/careers/1751"), "centurion");
});

const lookalikes = [
  "https://evilbamboohr.com/careers/list",
  "https://bamboohr.com.attacker.net/careers",
  "https://notbamboohr.com/careers",
  "https://bamboohr.evil.com/careers",
];
for (const url of lookalikes) {
  test(`a lookalike domain is refused: ${url}`, () => {
    // "evilbamboohr.com".endsWith("bamboohr.com") is true.
    assert.equal(parseBambooAccount(url), null);
  });
}

test("the bare vendor domain names no account", () => {
  assert.equal(parseBambooAccount("https://bamboohr.com"), null);
  assert.equal(parseBambooAccount("https://www.bamboohr.com"), null);
  assert.equal(parseBambooAccount("https://www.bamboohr.com/careers/list"), null);
});

test("a nested subdomain is not an account", () => {
  // `a.b.bamboohr.com` would build `https://a.b.bamboohr.com/careers/list`,
  // which is a different host from the one that was assessed.
  assert.equal(parseBambooAccount("https://a.b.bamboohr.com/careers"), null);
});

const malformed = ["", "not a url", "https://", "javascript:alert(1)", "mailto:a@bamboohr.com"];
for (const url of malformed) {
  test(`unusable input yields null, never a throw: ${JSON.stringify(url)}`, () => {
    assert.doesNotThrow(() => parseBambooAccount(url));
    assert.equal(parseBambooAccount(url), null);
  });
}

test("canHandle agrees with the parser", () => {
  assert.equal(bambooHrConnector.canHandle(ref("https://fcp.bamboohr.com/js/jobs2.php")), true);
  assert.equal(bambooHrConnector.canHandle(ref("https://evilbamboohr.com/careers")), false);
});

test("the registry routes a BambooHR URL here, not to generic", () => {
  assert.equal(detectConnector("https://fcp.bamboohr.com/js/jobs2.php").id, "bamboohr");
  assert.equal(detectConnector("https://centurion.bamboohr.com/careers/1751").id, "bamboohr");
});

test("one board under two URLs is one board", () => {
  assert.equal(
    dedupKey("https://fcp.bamboohr.com", "bamboohr"),
    dedupKey("https://fcp.bamboohr.com/", "bamboohr"),
  );
});

// ----------------------------------------------------------------- board rows

/** The real FCP row, trimmed. */
const REAL: BambooListRow = {
  id: "71",
  jobOpeningName: "Real Estate Financial Senior Analyst – Investments",
  departmentLabel: "Multifamily Income",
  employmentStatusLabel: "Full-Time",
  location: { city: "Chevy Chase", state: "Maryland" },
  isRemote: null,
};

const of = (patch: Partial<BambooListRow>): BambooListRow => ({ ...REAL, ...patch });
const one = (row: BambooListRow, host = "fcp.bamboohr.com") => bambooRowsToListings([row], host)[0];

test("a real row becomes a listing", () => {
  const listing = one(REAL);
  assert.ok(listing);
  assert.equal(listing.externalJobId, "71");
  assert.equal(listing.title, "Real Estate Financial Senior Analyst – Investments");
});

test("an en-dash in the title is preserved, not normalised away", () => {
  // Three real internships were rejected by en-dash handling elsewhere in this
  // corpus. The fix belongs in the classifier, not in silently rewriting what
  // the employer wrote.
  assert.ok(one(REAL).title.includes("–"));
});

test("the board URL is built, never taken from the discovered URL", () => {
  assert.equal(one(REAL).listingUrl, "https://fcp.bamboohr.com/careers/71");
});

test("the application URL is the same page", () => {
  const listing = one(REAL);
  assert.equal(listing.applicationUrl, listing.listingUrl);
});

test("the id is a real source id, not a hash", () => {
  assert.equal(one(REAL).externalJobId, "71");
  assert.notEqual(one(REAL).externalJobId!.length, 64);
});

test("a numeric id is stringified", () => {
  assert.equal(one(of({ id: 1751 })).externalJobId, "1751");
});

test("id zero is a real id, not a missing one", () => {
  const listing = one(of({ id: 0 }));
  assert.ok(listing);
  assert.equal(listing.externalJobId, "0");
});

test("the department is the division", () => {
  assert.equal(one(REAL).division, "Multifamily Income");
});

test("the employment status is carried as stated", () => {
  assert.equal(one(REAL).employmentType, "Full-Time");
  assert.equal(one(of({ employmentStatusLabel: "Contract, Part-Time" })).employmentType, "Contract, Part-Time");
});

test("city and state make the location", () => {
  assert.equal(one(REAL).location, "Chevy Chase, Maryland");
});

test("a city alone is a location", () => {
  assert.equal(one(of({ location: { city: "Toronto", state: null } })).location, "Toronto");
});

test("a stated remote flag is the location when there is no city", () => {
  assert.equal(one(of({ location: null, isRemote: true })).location, "Remote");
});

test("remote is only used when the board says so", () => {
  // An empty city is not evidence of remote work.
  assert.equal(one(of({ location: null, isRemote: null })).location, null);
  assert.equal(one(of({ location: null, isRemote: false })).location, null);
});

test("a city wins over the remote flag when both are present", () => {
  assert.equal(one(of({ location: { city: "Montreal", state: "Quebec" }, isRemote: true })).location, "Montreal, Quebec");
});

test("a whitespace-only city is not a location", () => {
  assert.equal(one(of({ location: { city: "  ", state: "  " }, isRemote: null })).location, null);
});

// ------------------------------------------------------------ the stub description

test("the description starts as title and department, never empty", () => {
  // The list endpoint carries no description. An empty one would read to the
  // quality gate as "nothing that shows a posting exists".
  assert.equal(
    one(REAL).descriptionRaw,
    "Real Estate Financial Senior Analyst – Investments - Multifamily Income",
  );
});

test("with no department the description is the title alone", () => {
  assert.equal(one(of({ departmentLabel: null })).descriptionRaw, REAL.jobOpeningName);
});

test("the stub description is short enough that enrich will replace it", () => {
  // enrich skips anything already 120 characters or longer. A stub that
  // accidentally cleared that bar would never get its real text.
  assert.ok(one(of({ jobOpeningName: "Intern", departmentLabel: null })).descriptionRaw.length < 120);
});

test("a department that is only whitespace is not a division", () => {
  const listing = one(of({ departmentLabel: "   " }));
  assert.equal(listing.division, null);
  assert.equal(listing.descriptionRaw, REAL.jobOpeningName);
});

// ------------------------------------------------------------- titles and text

test("the title's whitespace is normalised", () => {
  assert.equal(one(of({ jobOpeningName: "  Summer\n\tAnalyst  " })).title, "Summer Analyst");
});

test("the title decodes entities", () => {
  assert.equal(one(of({ jobOpeningName: "M&amp;A Intern" })).title, "M&A Intern");
});

test("a non-breaking space in the title becomes a real space", () => {
  assert.equal(one(of({ jobOpeningName: "Summer Analyst" })).title, "Summer Analyst");
});

test("an accented title survives intact", () => {
  // Centurion's board carries "Gestionnaire regional (Multi-residentiel)"
  // with real accents. Mangling them would break the employer filter the way
  // "Acme Capital L.L.C." did.
  const french = "Gestionnaire régional (Multi-résidentiel)";
  assert.equal(one(of({ jobOpeningName: french })).title, french);
});

// ------------------------------------------------------------- refused rows

test("a row with no title is dropped", () => {
  for (const name of [undefined, "", "   "]) {
    assert.equal(bambooRowsToListings([of({ jobOpeningName: name })], "fcp.bamboohr.com").length, 0, JSON.stringify(name));
  }
});

test("a row with no id is dropped", () => {
  for (const id of [undefined, null]) {
    assert.equal(bambooRowsToListings([of({ id: id as string | undefined })], "fcp.bamboohr.com").length, 0, JSON.stringify(id));
  }
});

test("an empty row list yields an empty listing list", () => {
  assert.deepEqual(bambooRowsToListings([], "fcp.bamboohr.com"), []);
});

test("a row of nothing does not throw", () => {
  assert.doesNotThrow(() => bambooRowsToListings([{}], "fcp.bamboohr.com"));
  assert.equal(bambooRowsToListings([{}], "fcp.bamboohr.com").length, 0);
});

test("the same id twice yields one listing", () => {
  // Two rows, one application. audit-duplicate-listings.ts exists because
  // this has happened for real.
  assert.equal(bambooRowsToListings([REAL, REAL], "fcp.bamboohr.com").length, 1);
});

test("a numeric and a string id for the same job are the same id", () => {
  assert.equal(bambooRowsToListings([of({ id: 71 }), of({ id: "71" })], "fcp.bamboohr.com").length, 1);
});

test("good rows survive a bad one beside them", () => {
  // One malformed row must not cost the whole board.
  const listings = bambooRowsToListings([{}, REAL, { id: "9" }], "fcp.bamboohr.com");
  assert.equal(listings.length, 1);
  assert.equal(listings[0].externalJobId, "71");
});

test("an id needing escaping is escaped into the URL", () => {
  assert.ok(one(of({ id: "a/b" })).listingUrl.includes("a%2Fb"));
});

// ------------------------------------------------------- what is never invented

test("no posting date is invented", () => {
  // Neither endpoint states one, and types.ts forbids estimating it.
  assert.equal(one(REAL).publishedAt, null);
});

test("no deadline is invented", () => {
  assert.equal(one(REAL).deadlineAt ?? null, null);
});

test("every listing from a board carries that board's account in its URL", () => {
  for (const listing of bambooRowsToListings([REAL, of({ id: "76" })], "centurion.bamboohr.com")) {
    assert.ok(listing.listingUrl.startsWith("https://centurion.bamboohr.com/careers/"));
  }
});

test("the connector offers an enrich step, because the list has no descriptions", () => {
  assert.equal(typeof bambooHrConnector.enrich, "function");
});
