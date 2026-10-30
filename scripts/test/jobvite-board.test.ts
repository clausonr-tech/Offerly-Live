// Which URLs are a Jobvite board, and what its HTML becomes.
//
// Jobvite is the only new connector that reads MARKUP for its index - the
// board page carries no structured data at all, while the posting pages carry
// full JobPosting JSON-LD. So the index scan is the part most likely to break
// when Jobvite changes a template, and it is what most of this file exercises.
//
// Fixtures are cut from the real Starwood Capital Group board measured
// 19 September 2026, which carries two genuine internships under a "Campus"
// heading.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJobviteCompany,
  parseJobviteJobId,
  parseJobviteBoardHtml,
  jobviteConnector,
} from "../../src/lib/monitoring/connectors/jobvite";
import { detectConnector } from "../../src/lib/monitoring/connectors";

const ref = (url: string) => ({ careersUrl: url, sourceType: "", lastEtag: null });

// ------------------------------------------------------------------ companies

const companyUrls = [
  "https://jobs.jobvite.com/starwoodcapitalgroup",
  "https://jobs.jobvite.com/starwoodcapitalgroup/",
  "https://jobs.jobvite.com/starwoodcapitalgroup/jobs",
  "https://jobs.jobvite.com/careers/starwoodcapitalgroup/jobs",
  "https://jobs.jobvite.com/starwoodcapitalgroup/job/oetmzfwm",
  "https://jobs.jobvite.com/starwoodcapitalgroup/jobs?c=Campus",
  "http://jobs.jobvite.com/starwoodcapitalgroup/jobs",
];
for (const url of companyUrls) {
  test(`the company survives any path shape: ${url}`, () => {
    // Both `/co/jobs` and `/careers/co/jobs` are live; discovery recorded the
    // second, a human copying from the address bar gets the first.
    assert.equal(parseJobviteCompany(url), "starwoodcapitalgroup");
  });
}

const lookalikes = [
  "https://eviljobvite.com/acme/jobs",
  "https://jobvite.com.attacker.net/acme/jobs",
  "https://notjobvite.com/acme/jobs",
];
for (const url of lookalikes) {
  test(`a lookalike domain is refused: ${url}`, () => {
    assert.equal(parseJobviteCompany(url), null);
  });
}

test("a page name is never a company", () => {
  // `jobs.jobvite.com/jobs` is not a board, and reading it as company "jobs"
  // would register a source that can never return anything.
  assert.equal(parseJobviteCompany("https://jobs.jobvite.com/jobs"), null);
  assert.equal(parseJobviteCompany("https://jobs.jobvite.com/job"), null);
  assert.equal(parseJobviteCompany("https://jobs.jobvite.com/careers"), null);
  assert.equal(parseJobviteCompany("https://jobs.jobvite.com/careers/"), null);
});

test("the bare host names no company", () => {
  assert.equal(parseJobviteCompany("https://jobs.jobvite.com"), null);
  assert.equal(parseJobviteCompany("https://jobs.jobvite.com/"), null);
});

const malformed = ["", "not a url", "https://", "javascript:alert(1)"];
for (const url of malformed) {
  test(`unusable input yields null, never a throw: ${JSON.stringify(url)}`, () => {
    assert.doesNotThrow(() => parseJobviteCompany(url));
    assert.equal(parseJobviteCompany(url), null);
  });
}

test("canHandle agrees with the parser", () => {
  assert.equal(jobviteConnector.canHandle(ref("https://jobs.jobvite.com/acme/jobs")), true);
  assert.equal(jobviteConnector.canHandle(ref("https://eviljobvite.com/acme/jobs")), false);
});

test("the registry routes a Jobvite board here, not to generic", () => {
  assert.equal(
    detectConnector("https://jobs.jobvite.com/careers/starwoodcapitalgroup/jobs").id,
    "jobvite",
  );
});

// -------------------------------------------------------------------- job ids

test("a posting path names its id", () => {
  assert.equal(parseJobviteJobId("/starwoodcapitalgroup/job/oetmzfwm", "starwoodcapitalgroup"), "oetmzfwm");
});

test("an absolute posting URL names its id", () => {
  assert.equal(
    parseJobviteJobId("https://jobs.jobvite.com/starwoodcapitalgroup/job/oRRrlfwe", "starwoodcapitalgroup"),
    "oRRrlfwe",
  );
});

test("the /careers/ prefix does not hide the owner", () => {
  assert.equal(parseJobviteJobId("/careers/starwoodcapitalgroup/job/oetmzfwm", "starwoodcapitalgroup"), "oetmzfwm");
});

test("the company is matched case-insensitively", () => {
  assert.equal(parseJobviteJobId("/StarwoodCapitalGroup/job/oetmzfwm", "starwoodcapitalgroup"), "oetmzfwm");
});

test("another employer's posting on the same page is not this firm's opening", () => {
  // A Jobvite page can link out. Registering that posting under this firm
  // would attribute someone else's internship to them.
  assert.equal(parseJobviteJobId("/someotherfirm/job/oetmzfwm", "starwoodcapitalgroup"), null);
});

test("the board's own link is not a posting", () => {
  // `/co/jobs` contains "job" as a prefix; only a `/job/` SEGMENT is a posting.
  assert.equal(parseJobviteJobId("/starwoodcapitalgroup/jobs", "starwoodcapitalgroup"), null);
});

const nonPostings = [
  "/starwoodcapitalgroup",
  "/starwoodcapitalgroup/",
  "/starwoodcapitalgroup/job",
  "/starwoodcapitalgroup/job/",
  "#apply",
  "",
];
for (const href of nonPostings) {
  test(`a non-posting href yields no id: ${JSON.stringify(href)}`, () => {
    assert.doesNotThrow(() => parseJobviteJobId(href, "starwoodcapitalgroup"));
    assert.equal(parseJobviteJobId(href, "starwoodcapitalgroup"), null);
  });
}

// ----------------------------------------------------------------- board HTML

/** The real Starwood board, reduced to its anchors. */
const BOARD = `
<html><body>
<h2>Acquisitions</h2>
<a href="/starwoodcapitalgroup/job/o29lufwK">Acquisitions Analyst Tokyo</a>
<h2>Campus</h2>
<a href="/starwoodcapitalgroup/job/oetmzfwm">2027 SREIT Operations Summer Analyst</a>
<a href="/starwoodcapitalgroup/job/oRRrlfwe">Japan Acquisitions Internship</a>
<a href="/starwoodcapitalgroup/jobs">All jobs</a>
<a href="https://www.starwood.com/">About us</a>
</body></html>`;

const parse = (html: string, company = "starwoodcapitalgroup") => parseJobviteBoardHtml(html, company);

test("the real board yields its postings and nothing else", () => {
  const listings = parse(BOARD);
  assert.equal(listings.length, 3);
});

test("the campus internships are found", () => {
  const titles = parse(BOARD).map((l) => l.title);
  assert.ok(titles.includes("2027 SREIT Operations Summer Analyst"));
  assert.ok(titles.includes("Japan Acquisitions Internship"));
});

test("the board's own 'All jobs' link is not a listing", () => {
  assert.ok(!parse(BOARD).some((l) => l.title === "All jobs"));
});

test("an off-site marketing link is not a listing", () => {
  assert.ok(!parse(BOARD).some((l) => l.title === "About us"));
});

test("every listing gets an absolute URL on the vendor host", () => {
  for (const listing of parse(BOARD)) {
    assert.ok(listing.listingUrl.startsWith("https://jobs.jobvite.com/starwoodcapitalgroup/job/"));
  }
});

test("the id from the href is the external id", () => {
  const listing = parse(BOARD).find((l) => l.title.startsWith("2027 SREIT"));
  assert.equal(listing?.externalJobId, "oetmzfwm");
});

test("the id is a real source id, not a hash of the URL", () => {
  for (const listing of parse(BOARD)) {
    assert.notEqual(listing.externalJobId!.length, 64);
  }
});

test("markup inside the anchor is stripped from the title", () => {
  const listings = parse(`<a href="/co/job/a1"><span>Summer</span> <b>Analyst</b></a>`, "co");
  assert.equal(listings[0].title, "Summer Analyst");
});

test("an anchor with attributes after the href still parses", () => {
  const listings = parse(`<a href="/co/job/a1" class="x" data-y="z">Intern</a>`, "co");
  assert.equal(listings.length, 1);
});

test("single-quoted attributes parse", () => {
  const listings = parse(`<a href='/co/job/a1'>Intern</a>`, "co");
  assert.equal(listings.length, 1);
});

test("an uppercase tag name parses", () => {
  const listings = parse(`<A HREF="/co/job/a1">Intern</A>`, "co");
  assert.equal(listings.length, 1);
});

test("an anchor spanning newlines parses", () => {
  const listings = parse(`<a href="/co/job/a1">\n  Summer\n  Analyst\n</a>`, "co");
  assert.equal(listings[0].title, "Summer Analyst");
});

test("an entity-encoded href still resolves", () => {
  const listings = parse(`<a href="/co/job/a1&amp;x=1">Intern</a>`, "co");
  assert.equal(listings.length, 1);
});

test("the title decodes entities", () => {
  const listings = parse(`<a href="/co/job/a1">M&amp;A Intern</a>`, "co");
  assert.equal(listings[0].title, "M&A Intern");
});

test("a non-breaking space in the title becomes a real space", () => {
  const listings = parse(`<a href="/co/job/a1">Summer&nbsp;Analyst</a>`, "co");
  assert.equal(listings[0].title, "Summer Analyst");
});

test("the same posting linked twice yields one listing", () => {
  const listings = parse(
    `<a href="/co/job/a1">Intern</a><a href="/co/job/a1">Apply now</a>`,
    "co",
  );
  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, "Intern");
});

test("a text-free link does not consume the posting", () => {
  // The icon link comes first here. Marking the id seen on it would lose the
  // real titled link that follows - which is why the empty case does not add
  // to `seen`.
  const listings = parse(
    `<a href="/co/job/a1"><img src="x.png"></a><a href="/co/job/a1">Summer Analyst</a>`,
    "co",
  );
  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, "Summer Analyst");
});

test("a board with no postings yields an empty list, not a throw", () => {
  assert.doesNotThrow(() => parse("<html><body>No openings right now.</body></html>"));
  assert.equal(parse("<html><body>No openings right now.</body></html>").length, 0);
});

test("empty HTML yields an empty list", () => {
  assert.equal(parse("").length, 0);
});

test("unclosed markup does not throw", () => {
  assert.doesNotThrow(() => parse(`<a href="/co/job/a1">Intern`, "co"));
});

test("a listing's description starts as its title", () => {
  // The board page is a table of titles; enrich replaces this from the
  // posting page's JSON-LD.
  const listings = parse(BOARD);
  assert.equal(listings[0].descriptionRaw, listings[0].title);
});

test("the stub description is what monitor-run's needsDetail test looks for", () => {
  // needsDetail fires when the description equals the title. If these ever
  // diverge here, enrichment silently stops happening.
  for (const listing of parse(BOARD)) {
    assert.equal(listing.descriptionRaw.trim(), listing.title.trim());
  }
});

test("no location is invented from the board page", () => {
  // The board shows locations in a column this scan does not read. A guess
  // would look like the employer stated it.
  for (const listing of parse(BOARD)) {
    assert.equal(listing.location, null);
  }
});

test("no posting date is invented from the board page", () => {
  for (const listing of parse(BOARD)) {
    assert.equal(listing.publishedAt, null);
  }
});

test("the application URL is the posting page", () => {
  for (const listing of parse(BOARD)) {
    assert.equal(listing.applicationUrl, listing.listingUrl);
  }
});

test("the connector offers an enrich step, because the board has no descriptions", () => {
  assert.equal(typeof jobviteConnector.enrich, "function");
});

test("a company whose board links only to other firms yields nothing", () => {
  const listings = parse(`<a href="/otherfirm/job/a1">Intern</a>`, "co");
  assert.equal(listings.length, 0);
});

test("ids are case-sensitive, because Jobvite's are", () => {
  // `oRRrlfwe` and `orrrlfwe` are different postings.
  const listings = parse(
    `<a href="/co/job/oRRrlfwe">One</a><a href="/co/job/orrrlfwe">Two</a>`,
    "co",
  );
  assert.equal(listings.length, 2);
});
