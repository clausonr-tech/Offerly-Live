import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDomain,
  isUsableCompanyDomain,
  normaliseHost,
  registrableDomain,
  sameRegistrableDomain,
} from "@/lib/company-domains";

test("a LinkedIn country subdomain is blocked, which the old exact-match list missed", () => {
  // The thirteen real rows in the directory.
  for (const host of ["ch.linkedin.com", "br.linkedin.com", "ca.linkedin.com", "linkedin.com"]) {
    const v = classifyDomain(host);
    assert.equal(v.usable, false, host);
    assert.equal(v.usable === false && v.reason, "social", host);
  }
});

test("a careers subdomain is not the corporate domain", () => {
  for (const host of [
    "careers.db.com",
    "careers.point72.com",
    "careers.pnc.com",
    "careers.truist.com",
    "jobs.lsvp.com",
  ]) {
    const v = classifyDomain(host);
    assert.equal(v.usable, false, host);
    assert.equal(v.usable === false && v.reason, "recruiting_subdomain", host);
  }
});

test("legitimate nontraditional domains survive", () => {
  // A brand TLD: the registrable domain IS home.barclays, so nothing strips it.
  assert.equal(registrableDomain("home.barclays"), "home.barclays");
  assert.equal(isUsableCompanyDomain("home.barclays"), true);
  assert.equal(isUsableCompanyDomain("teleocapital.com"), true);
  assert.equal(isUsableCompanyDomain("gs.com"), true);
});

test("a firm whose NAME contains an ATS word is not an ATS", () => {
  // The old substring test flagged both of these real directory rows.
  assert.equal(isUsableCompanyDomain("greenhousefunds.com"), true);
  assert.equal(isUsableCompanyDomain("greenhousewealth.com"), true);
  // The actual applicant tracking system still is one.
  assert.equal(classifyDomain("boards.greenhouse.io").usable, false);
  assert.equal(classifyDomain("acme.myworkdayjobs.com").usable, false);
});

test("freemail is never a company domain", () => {
  for (const host of ["gmail.com", "googlemail.com", "outlook.com"]) {
    assert.equal(classifyDomain(host).usable, false, host);
  }
});

test("multi-part public suffixes resolve one label deeper", () => {
  assert.equal(registrableDomain("careers.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("www.example.com.au"), "example.com.au");
});

test("hosts normalise before anything else looks at them", () => {
  assert.equal(normaliseHost("HTTPS://WWW.Example.com/careers?x=1"), "example.com");
  assert.equal(normaliseHost("example.com:8443"), "example.com");
  assert.equal(normaliseHost("  "), null);
  assert.equal(normaliseHost("notadomain"), null);
});

test("same-organisation comparison is on the registrable domain, never a substring", () => {
  assert.equal(sameRegistrableDomain("careers.db.com", "db.com"), true);
  assert.equal(sameRegistrableDomain("www.gs.com", "gs.com"), true);
  // The trap a substring test falls into.
  assert.equal(sameRegistrableDomain("greenhousefunds.com", "greenhouse.io"), false);
  assert.equal(sameRegistrableDomain("notgs.com", "gs.com"), false);
});
