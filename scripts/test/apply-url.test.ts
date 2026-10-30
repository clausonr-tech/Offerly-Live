// The link a student actually clicks.
//
// Measured on 21 September 2026: 861 of 879 published postings pointed
// "Apply" at the advert rather than the form, because most connectors set
// applicationUrl and listingUrl from one string. These tests pin the two
// halves of the fix - derive a real candidate where a board has one, and
// never overrule a connector that already knew better.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveApplyUrl, preferApplyUrl } from "../../src/lib/monitoring/apply-url";

test("each board's own application path is derived", () => {
  const cases: [string, string, string][] = [
    ["https://jobs.lever.co/acme/8f3c2b1a", "https://jobs.lever.co/acme/8f3c2b1a/apply", "lever"],
    ["https://jobs.ashbyhq.com/acme/8f3c2b1a", "https://jobs.ashbyhq.com/acme/8f3c2b1a/application", "ashby"],
    ["https://apply.workable.com/acme/j/A1B2C3/", "https://apply.workable.com/acme/j/A1B2C3/apply/", "workable"],
    ["https://acme.breezy.hr/p/9f8e7d", "https://acme.breezy.hr/p/9f8e7d/apply", "breezy"],
    ["https://acme.recruitee.com/o/summer-analyst", "https://acme.recruitee.com/o/summer-analyst/c/new", "recruitee"],
    ["https://jobs.jobvite.com/acme/job/oX1Yz2", "https://jobs.jobvite.com/acme/job/oX1Yz2/apply", "jobvite"],
  ];
  for (const [listing, expected, ats] of cases) {
    const got = deriveApplyUrl(listing);
    assert.equal(got?.url, expected, listing);
    assert.equal(got?.ats, ats, listing);
  }
});

test("Greenhouse gets the form's anchor, not a different page", () => {
  // The form is rendered on the advert. #app is Greenhouse's own anchor for
  // it, so this saves a scroll and claims nothing more.
  const got = deriveApplyUrl("https://boards.greenhouse.io/acme/jobs/4012345");
  assert.equal(got?.url, "https://boards.greenhouse.io/acme/jobs/4012345#app");
});

test("a board with no separate form yields nothing rather than a guess", () => {
  // iCIMS and the long tail: inventing a path here would replace a working
  // link with a broken one.
  assert.equal(deriveApplyUrl("https://careers-acme.icims.com/jobs/1234/summer-analyst/job"), null);
  assert.equal(deriveApplyUrl("https://www.acme.com/careers/summer-2027-analyst"), null);
});

test("a url that already points at a form is left alone", () => {
  assert.equal(deriveApplyUrl("https://jobs.lever.co/acme/8f3c2b1a/apply"), null);
  assert.equal(deriveApplyUrl("https://jobs.ashbyhq.com/acme/8f3c2b1a/application"), null);
});

test("a board url that is not a single listing is not rewritten", () => {
  // The company's whole board, not one job - appending /apply would be
  // nonsense, and the 4,913 monitored sources are mostly these.
  assert.equal(deriveApplyUrl("https://jobs.lever.co/acme"), null);
  assert.equal(deriveApplyUrl("https://boards.greenhouse.io/acme"), null);
});

test("junk input is survivable", () => {
  for (const bad of [null, undefined, "", "not a url", "mailto:careers@acme.com", "javascript:alert(1)"]) {
    assert.equal(deriveApplyUrl(bad as string | null), null, String(bad));
  }
});

test("a connector that already knows the apply url wins", () => {
  // lever.ts and ashby.ts read applyUrl from the feed. A derived guess must
  // never overrule a stated fact.
  assert.equal(
    preferApplyUrl({
      applicationUrl: "https://acme.com/special-early-careers-form",
      listingUrl: "https://jobs.lever.co/acme/8f3c2b1a",
    }),
    "https://acme.com/special-early-careers-form",
  );
});

test("a connector that just copied the listing url gets a derived one", () => {
  // greenhouse.ts, workday.ts and generic.ts all do this.
  assert.equal(
    preferApplyUrl({
      applicationUrl: "https://jobs.lever.co/acme/8f3c2b1a",
      listingUrl: "https://jobs.lever.co/acme/8f3c2b1a",
    }),
    "https://jobs.lever.co/acme/8f3c2b1a/apply",
  );
});

test("the listing url is the floor, never null", () => {
  // A posting with no apply link at all is worse than one pointing at the
  // advert, so this never hands back nothing.
  const unknown = "https://www.acme.com/careers/summer-2027-analyst";
  assert.equal(preferApplyUrl({ applicationUrl: null, listingUrl: unknown }), unknown);
  assert.equal(preferApplyUrl({ applicationUrl: unknown, listingUrl: unknown }), unknown);
});

test("TalentLink vacancies get the parameter that opens the form", () => {
  // 288 of 356 active tal.net postings lacked this, including every Morgan
  // Stanley and Nomura one. The tenants that already emit it are the proof.
  const got = deriveApplyUrl(
    "https://morganstanley.tal.net/vx/mobile-0/appcentre-ext/brand-2/candidate/so/pm/1/pl/2/opp/1234-2027-Summer-Analyst/en-GB",
  );
  assert.equal(got?.ats, "talentlink");
  assert.match(got?.url ?? "", /instant=apply/);
});

test("a TalentLink url that already applies directly is left alone", () => {
  assert.equal(
    deriveApplyUrl(
      "https://jefferies.tal.net/vx/mobile-0/appcentre-ext/brand-4/candidate/so/pm/1/pl/2/opp/1914-Analyst/en-GB?instant=apply",
    ),
    null,
  );
});

test("a TalentLink board url is not turned into an application", () => {
  assert.equal(deriveApplyUrl("https://morganstanley.tal.net/vx/lang-en-GB/mobile-0/brand-2/candidate/jobboard/"), null);
});
