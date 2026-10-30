// Which URLs in Kroll's careers sitemap are actually vacancies.
//
// The regression this guards is one this codebase has already had twice, in
// both directions. A loose "does the path contain the word job" test counted a
// news article at /opening-doors-to-a-more-secure-future/; a strict one
// counted nothing at all, because Kroll nests the location and the title
// between /job/ and the requisition id. Both times the wrong answer was a
// number that decided whether to build anything.
//
// The sitemap also carries ~11 non-vacancy pages, so this runs on every check
// rather than once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKrollJobUrl, krollConnector } from "../../src/lib/monitoring/connectors/kroll";

test("a real vacancy URL yields its city, slug and requisition id", () => {
  const ref = parseKrollJobUrl("https://careers.kroll.com/en/job/amsterdam/intern-restructuring/21014771");
  assert.deepEqual(ref, {
    listingUrl: "https://careers.kroll.com/en/job/amsterdam/intern-restructuring/21014771",
    city: "amsterdam",
    slug: "intern-restructuring",
    jobId: "21014771",
  });
});

test("a multi-word city survives intact", () => {
  assert.equal(parseKrollJobUrl("https://careers.kroll.com/en/job/abu-dhabi/vice-president-compliance-consulting/21014498")?.city, "abu-dhabi");
});

test("query strings and fragments are dropped from the stored URL", () => {
  assert.equal(
    parseKrollJobUrl("https://careers.kroll.com/en/job/chicago/intern-transfer-pricing/21014746?src=li#apply")?.listingUrl,
    "https://careers.kroll.com/en/job/chicago/intern-transfer-pricing/21014746",
  );
});

test("a trailing slash is accepted", () => {
  assert.ok(parseKrollJobUrl("https://careers.kroll.com/en/job/boston/intern-real-estate-advisory/21014749/"));
});

test("the sitemap's non-vacancy pages are refused", () => {
  for (const url of [
    "https://careers.kroll.com/en",
    "https://careers.kroll.com/en/students",
    "https://careers.kroll.com/en/executive-careers",
    "https://careers.kroll.com/en/listing-page",
    "https://careers.kroll.com/en/learning-and-development",
    "https://careers.kroll.com/en/our-global-presence/emea",
  ]) {
    assert.equal(parseKrollJobUrl(url), null, `expected null for ${url}`);
  }
});

test("a job-shaped path whose id is not a number is refused", () => {
  // The news-article shape that got counted once already.
  assert.equal(
    parseKrollJobUrl("https://careers.kroll.com/en/job/london/opening-doors-to-a-more-secure-future/story"),
    null,
  );
});

test("the requisition id must be the LAST segment", () => {
  assert.equal(parseKrollJobUrl("https://careers.kroll.com/en/job/london/analyst/21014498/apply"), null);
});

test("another host on the same URL shape is refused", () => {
  assert.equal(parseKrollJobUrl("https://careers.example.com/en/job/london/intern-valuation/21014498"), null);
  // Kroll's marketing site is not its job board.
  assert.equal(parseKrollJobUrl("https://www.kroll.com/en/job/london/intern-valuation/21014498"), null);
});

test("malformed input returns null rather than throwing", () => {
  for (const url of ["", "not a url", "//careers.kroll.com/en/job/a/b/1", "javascript:alert(1)"]) {
    assert.equal(parseKrollJobUrl(url), null, `expected null for ${JSON.stringify(url)}`);
  }
});

test("canHandle claims the careers host and nothing else", () => {
  const ref = (careersUrl: string) => ({ careersUrl, sourceType: "", lastEtag: null });
  assert.ok(krollConnector.canHandle(ref("https://careers.kroll.com/en")));
  assert.ok(!krollConnector.canHandle(ref("https://www.kroll.com/en/careers")));
  assert.ok(!krollConnector.canHandle(ref("https://careers.kroll.com.evil.test/en")));
  assert.ok(!krollConnector.canHandle(ref("not a url")));
});
