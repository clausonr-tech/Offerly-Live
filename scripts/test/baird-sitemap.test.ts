// Which sitemap entries are Baird jobs.
//
// This connector exists because a 403 was misread as a refusal. Baird's
// robots.txt says `User-agent: * / Allow: /` and advertises a sitemap; the 403
// was Cloudflare on the rendered board. So the sitemap is the permitted path,
// and the question this file answers is which of its 176 URLs are jobs.
//
// The URL test is deliberately tight, because this codebase has already got it
// wrong on this exact host: discover-boards.ts once counted Baird's
// `/newsroom/news/2020/12/opening-doors-to-a-more-secure-future/` as a board
// on the strength of the word "opening".
//
// Fixtures are cut from the real sitemap measured 19 September 2026.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBairdJobUrl,
  parseBairdSitemap,
  bairdConnector,
} from "../../src/lib/monitoring/connectors/baird";
import { detectConnector } from "../../src/lib/monitoring/connectors";

const ref = (url: string) => ({ careersUrl: url, sourceType: "", lastEtag: null });

// ------------------------------------------------------------------ job URLs

test("a real job URL names its requisition and its role", () => {
  const parsed = parseBairdJobUrl(
    "https://www.bairdcareers.com/jobs/r20261002/internship-marketing-year-round/",
  );
  assert.deepEqual(parsed, {
    listingUrl: "https://www.bairdcareers.com/jobs/r20261002/internship-marketing-year-round/",
    jobId: "r20261002",
    slug: "internship-marketing-year-round",
  });
});

test("the apex host is accepted and normalised to www", () => {
  // robots.txt advertises the apex, the sitemap writes www. One posting, one
  // row - not two.
  const parsed = parseBairdJobUrl("https://bairdcareers.com/jobs/r20261002/internship-marketing/");
  assert.equal(parsed?.listingUrl, "https://www.bairdcareers.com/jobs/r20261002/internship-marketing/");
});

test("a URL without its trailing slash still parses", () => {
  assert.equal(
    parseBairdJobUrl("https://www.bairdcareers.com/jobs/r20261002/internship-marketing")?.jobId,
    "r20261002",
  );
});

test("the requisition id is lowercased, so one posting is one id", () => {
  assert.equal(
    parseBairdJobUrl("https://www.bairdcareers.com/jobs/R20261002/internship-marketing/")?.jobId,
    "r20261002",
  );
});

test("a query string and fragment are dropped from the stored URL", () => {
  const parsed = parseBairdJobUrl(
    "https://www.bairdcareers.com/jobs/r20261002/internship-marketing/?src=li#apply",
  );
  assert.equal(parsed?.listingUrl, "https://www.bairdcareers.com/jobs/r20261002/internship-marketing/");
});

const notJobs = [
  "https://www.bairdcareers.com/",
  "https://www.bairdcareers.com/jobs/",
  "https://www.bairdcareers.com/the-baird-difference/",
  "https://www.bairdcareers.com/the-baird-difference/our-culture/",
  "https://www.bairdcareers.com/internships/firmwide-intern-program/",
  "https://www.bairdcareers.com/internships/global-investment-banking-intern-program-us/",
  "https://www.bairdcareers.com/how-we-hire/",
  "https://www.bairdcareers.com/sitemap/",
  "https://www.rwbaird.com/about-baird/",
];
for (const url of notJobs) {
  test(`a real non-job page from the same sitemap is refused: ${url}`, () => {
    assert.equal(parseBairdJobUrl(url), null);
  });
}

test("the news article that fooled discovery once is still refused", () => {
  assert.equal(
    parseBairdJobUrl(
      "https://www.bairdcareers.com/newsroom/news/2020/12/opening-doors-to-a-more-secure-future/",
    ),
    null,
  );
});

test("a programme page is not an opening", () => {
  // These are category pages. Rothschild's equivalents were scraped as
  // listings, classified relevant, and would have reached students.
  assert.equal(parseBairdJobUrl("https://www.bairdcareers.com/internships/"), null);
});

const badIdShapes = [
  "https://www.bairdcareers.com/jobs/20261002/marketing/",
  "https://www.bairdcareers.com/jobs/x20261002/marketing/",
  "https://www.bairdcareers.com/jobs/r123/marketing/",
  "https://www.bairdcareers.com/jobs/rabcdef/marketing/",
  "https://www.bairdcareers.com/jobs/r20261002/",
  "https://www.bairdcareers.com/jobs/r20261002/marketing/extra/",
];
for (const url of badIdShapes) {
  test(`a path that is not the job shape is refused: ${url}`, () => {
    assert.equal(parseBairdJobUrl(url), null);
  });
}

const foreignHosts = [
  "https://evilbairdcareers.com/jobs/r20261002/marketing/",
  "https://bairdcareers.com.attacker.net/jobs/r20261002/marketing/",
  "https://careers.kroll.com/en/job/london/intern/12345/",
];
for (const url of foreignHosts) {
  test(`another host is refused: ${url}`, () => {
    assert.equal(parseBairdJobUrl(url), null);
  });
}

const malformed = ["", "not a url", "https://", "javascript:alert(1)"];
for (const url of malformed) {
  test(`unusable input yields null, never a throw: ${JSON.stringify(url)}`, () => {
    assert.doesNotThrow(() => parseBairdJobUrl(url));
    assert.equal(parseBairdJobUrl(url), null);
  });
}

// ------------------------------------------------------------------- sitemaps

const url = (loc: string, lastmod?: string) =>
  `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;

/** The real sitemap's shape, reduced. */
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${url("https://www.bairdcareers.com/", "2026-07-14T10:09:00+00:00")}
${url("https://www.bairdcareers.com/jobs/", "2025-09-03T15:52:00+00:00")}
${url("https://www.bairdcareers.com/internships/firmwide-intern-program/", "2026-08-05T10:49:00+00:00")}
${url("https://www.bairdcareers.com/jobs/r20261000/internship-business-coordinator-year-round/", "2026-09-01T00:00:00+00:00")}
${url("https://www.bairdcareers.com/jobs/r20261002/internship-marketing-year-round/", "2026-09-02T00:00:00+00:00")}
${url("https://www.bairdcareers.com/jobs/r20261009/client-specialist/")}
</urlset>`;

test("only the job entries become listings", () => {
  const { listings } = parseBairdSitemap(SITEMAP);
  assert.equal(listings.length, 3);
});

test("the requisition id is the external id", () => {
  const { listings } = parseBairdSitemap(SITEMAP);
  assert.deepEqual(
    listings.map((l) => l.externalJobId).sort(),
    ["r20261000", "r20261002", "r20261009"],
  );
});

test("the id is a real source id, not a synthesised hash", () => {
  // This is what lets posting-quality.ts verify the listing rather than
  // treating it as something recovered from markup.
  for (const listing of parseBairdSitemap(SITEMAP).listings) {
    assert.notEqual(listing.externalJobId!.length, 64);
    assert.match(listing.externalJobId!, /^r\d+$/);
  }
});

test("the slug becomes a provisional title", () => {
  const { listings } = parseBairdSitemap(SITEMAP);
  const marketing = listings.find((l) => l.externalJobId === "r20261002");
  assert.equal(marketing?.title, "Internship Marketing Year Round");
});

test("the provisional title keeps the words that decide enrichment order", () => {
  // monitor-run sorts internship-shaped titles to the front of the enrichment
  // queue by reading the title. If the slug lost the word, the real
  // internships would be enriched last or not at all.
  const { listings } = parseBairdSitemap(SITEMAP);
  const internships = listings.filter((l) => /internship/i.test(l.title));
  assert.equal(internships.length, 2);
});

test("a missing lastmod does not drop the entry", () => {
  // <lastmod> is optional in the schema. The client-specialist entry has none.
  const { listings } = parseBairdSitemap(SITEMAP);
  assert.ok(listings.some((l) => l.externalJobId === "r20261009"));
});

test("the hash lines cover the jobs and nothing else", () => {
  const { hashLines } = parseBairdSitemap(SITEMAP);
  assert.equal(hashLines.length, 3);
  assert.ok(hashLines.every((line) => line.includes("/jobs/r")));
});

test("marketing pages are kept out of the hash, so their edits do not look like board changes", () => {
  // The homepage's lastmod moves on every content edit. Hashing it would
  // report a changed board every check and run the diff for nothing.
  const { hashLines } = parseBairdSitemap(SITEMAP);
  assert.ok(!hashLines.some((line) => line.includes("the-baird-difference")));
  assert.ok(!hashLines.some((line) => line.endsWith("bairdcareers.com/|2026-07-14T10:09:00+00:00")));
});

test("a job's lastmod DOES move the hash", () => {
  const moved = SITEMAP.replace("2026-09-02T00:00:00+00:00", "2026-09-19T00:00:00+00:00");
  const before = parseBairdSitemap(SITEMAP).hashLines.sort().join("\n");
  const after = parseBairdSitemap(moved).hashLines.sort().join("\n");
  assert.notEqual(before, after);
});

test("a marketing page's lastmod does NOT move the hash", () => {
  const moved = SITEMAP.replace("2026-07-14T10:09:00+00:00", "2026-09-19T00:00:00+00:00");
  const before = parseBairdSitemap(SITEMAP).hashLines.sort().join("\n");
  const after = parseBairdSitemap(moved).hashLines.sort().join("\n");
  assert.equal(before, after);
});

test("reordering the sitemap does not move the hash", () => {
  // A board that reorders has not changed in any way that matters.
  const lines = SITEMAP.split("\n");
  const reordered = [lines[0], lines[1], ...lines.slice(2, -1).reverse(), lines[lines.length - 1]].join("\n");
  const before = parseBairdSitemap(SITEMAP).hashLines.sort().join("\n");
  const after = parseBairdSitemap(reordered).hashLines.sort().join("\n");
  assert.equal(before, after);
});

test("the same job twice yields one listing", () => {
  const doubled = SITEMAP.replace(
    "</urlset>",
    `${url("https://bairdcareers.com/jobs/r20261002/internship-marketing-year-round/")}</urlset>`,
  );
  assert.equal(parseBairdSitemap(doubled).listings.length, 3);
});

test("an empty sitemap yields nothing, not a throw", () => {
  assert.doesNotThrow(() => parseBairdSitemap("<urlset></urlset>"));
  assert.equal(parseBairdSitemap("<urlset></urlset>").listings.length, 0);
});

test("malformed XML yields nothing, not a throw", () => {
  for (const xml of ["", "not xml", "<urlset><url><loc>", "<html><body>403</body></html>"]) {
    assert.doesNotThrow(() => parseBairdSitemap(xml));
    assert.equal(parseBairdSitemap(xml).listings.length, 0, JSON.stringify(xml));
  }
});

test("an entity-encoded loc still parses", () => {
  const xml = `<urlset>${url("https://www.bairdcareers.com/jobs/r20261002/marketing/?a=1&amp;b=2")}</urlset>`;
  assert.equal(parseBairdSitemap(xml).listings.length, 1);
});

test("whitespace around the loc is tolerated", () => {
  const xml = `<urlset><url>\n  <loc>\n  https://www.bairdcareers.com/jobs/r20261002/marketing/\n  </loc>\n</url></urlset>`;
  assert.equal(parseBairdSitemap(xml).listings.length, 1);
});

test("the description starts empty, because the sitemap carries no text", () => {
  // Kroll does the same. enrich fills it from the detail page's JSON-LD; an
  // invented description would be worse than none.
  for (const listing of parseBairdSitemap(SITEMAP).listings) {
    assert.equal(listing.descriptionRaw, "");
  }
});

test("no location, date or deadline is invented from a URL", () => {
  for (const listing of parseBairdSitemap(SITEMAP).listings) {
    assert.equal(listing.location, null);
    assert.equal(listing.publishedAt, null);
    assert.equal(listing.deadlineAt, null);
  }
});

test("the application URL is the posting page", () => {
  for (const listing of parseBairdSitemap(SITEMAP).listings) {
    assert.equal(listing.applicationUrl, listing.listingUrl);
    assert.ok(listing.listingUrl.startsWith("https://www.bairdcareers.com/jobs/r"));
  }
});

// ------------------------------------------------------------------- routing

test("canHandle covers both hosts", () => {
  assert.equal(bairdConnector.canHandle(ref("https://www.bairdcareers.com/jobs/")), true);
  assert.equal(bairdConnector.canHandle(ref("https://bairdcareers.com/")), true);
  assert.equal(bairdConnector.canHandle(ref("https://evilbairdcareers.com/")), false);
  assert.equal(bairdConnector.canHandle(ref("not a url")), false);
});

test("the registry routes Baird here, not to the generic connector that got a 403", () => {
  assert.equal(detectConnector("https://www.bairdcareers.com/jobs/").id, "baird");
  assert.equal(
    detectConnector("https://www.bairdcareers.com/our-teams/global-investment-banking/").id,
    "baird",
  );
});

test("the connector offers an enrich step, because the sitemap has no text", () => {
  assert.equal(typeof bairdConnector.enrich, "function");
});
