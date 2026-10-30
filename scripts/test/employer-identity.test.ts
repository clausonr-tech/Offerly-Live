import assert from "node:assert/strict";
import test from "node:test";

import { comparableName, employerDomain, namesAgree } from "@/lib/crustdata-client";

test("a recruiting front-end resolves to the employer's own domain", () => {
  // These are stored in the firm directory as the firm's `website`, and were
  // sent to the provider verbatim - which matches no company at all.
  assert.equal(employerDomain("careers.db.com"), "db.com");
  assert.equal(employerDomain("careers.kroll.com"), "kroll.com");
  assert.equal(employerDomain("jobs.citi.com"), "citi.com");
});

test("a prefix is only stripped when what survives is still a hostname", () => {
  // The bug this guard exists for: stripping unconditionally turned
  // "search.jobs.barclays" into "barclays", which is not a domain and
  // silently matched nothing. Better to send it intact and let the lookup
  // fail into the name fallback.
  assert.equal(employerDomain("search.jobs.barclays"), "search.jobs.barclays");
  assert.equal(employerDomain("jobs.barclays"), "jobs.barclays");
});

test("scheme, www and path are not part of a domain", () => {
  assert.equal(employerDomain("https://www.goldmansachs.com/careers"), "goldmansachs.com");
  assert.equal(employerDomain("  CitiGroup.com  "), "citigroup.com");
  assert.equal(employerDomain(null), "");
  assert.equal(employerDomain(""), "");
});

test("a firm's legal suffix is not part of its identity", () => {
  assert.equal(comparableName("J.P. Morgan Securities LLC"), comparableName("JP Morgan Securities"));
  assert.equal(comparableName("Moelis & Company"), "moelis");
});

test("a short name inside a long one is not a match", () => {
  // Measured against the live provider: asked for "Qzxwv Nonexistent
  // Partners" it offered Partners Group, and plain containment accepted it -
  // so a firm that does not exist would have been searched as a real one.
  assert.equal(namesAgree(comparableName("Partners Group"), comparableName("Qzxwv Nonexistent Partners")), false);
  assert.equal(namesAgree("", "moelis"), false);
});

test("spelling differences still agree", () => {
  assert.equal(namesAgree(comparableName("Deutsche Bank"), comparableName("Deutsche Bank (US)")), true);
  assert.equal(namesAgree(comparableName("Moelis & Company"), comparableName("Moelis")), true);
});
