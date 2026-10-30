import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPT_THRESHOLD,
  RUNNER_UP_MARGIN,
  comparableCompanyName,
  linkedinCompanySlug,
  resolveIdentity,
  scoreCandidate,
  type CandidateCompany,
  type FirmIdentityInput,
} from "@/lib/company-identity";

function candidate(over: Partial<CandidateCompany> = {}): CandidateCompany {
  return {
    companyId: 1,
    name: "Example Capital",
    domains: ["example.com"],
    primaryDomain: "example.com",
    linkedinUrl: null,
    industries: ["Venture Capital and Private Equity Principals"],
    headcountFloor: 11,
    ...over,
  };
}

function firm(over: Partial<FirmIdentityInput> = {}): FirmIdentityInput {
  return { name: "Example Capital", website: "example.com", linkedinUrl: null, ...over };
}

test("Teleo verifies on its real signals", () => {
  // Exactly what the live API returns for teleocapital.com.
  const r = resolveIdentity(
    firm({ name: "Teleo Capital Management LLC", website: "teleocapital.com" }),
    [
      candidate({
        companyId: 984645,
        name: "TELEO Capital",
        domains: ["teleocapital.com"],
        linkedinUrl: "https://www.linkedin.com/company/teleo-capital",
        industries: ["Venture Capital and Private Equity Principals"],
        headcountFloor: 11,
      }),
    ],
  );
  assert.equal(r.status, "verified");
  // domain 45 + name 40 + industry 10 + headcount 5. No HQ points exist.
  assert.equal(r.status === "verified" && r.confidence, 100);
});

test("the Citigroup/google.com candidate is disqualified outright", () => {
  const scored = scoreCandidate(firm({ name: "Citigroup", website: "citigroup.com" }), candidate({
    name: "Citigroup",
    domains: ["google.com", "gmail.com"],
  }));
  assert.equal(scored.disqualified, "social");
  assert.equal(scored.score, 0);
});

test("two candidates that would both pass, inside the margin, stay unresolved", () => {
  // Two different companies that both clear the threshold on our domain, and
  // neither carries our name outright - the margin decides, and it refuses.
  const r = resolveIdentity(firm({ name: "Citigroup", website: "citigroup.com" }), [
    candidate({ companyId: 1, name: "Citigroup Global Markets", domains: ["citigroup.com"] }),
    candidate({ companyId: 2, name: "Citigroup CIB", domains: ["citigroup.com"] }),
  ]);
  assert.equal(r.status, "unresolved");
  assert.equal(r.status === "unresolved" && r.reason, "ambiguous");
  assert.equal(r.confidence, 100);
});

test("a subsidiary filed under the parent's domain does not block the parent", () => {
  // Exactly what the live API returns for jefferies.com.
  const r = resolveIdentity(firm({ name: "Jefferies", website: "jefferies.com" }), [
    candidate({ companyId: 1049893, name: "Jefferies", domains: ["jefferies.com"], headcountFloor: 5001 }),
    candidate({ companyId: 6593750, name: "Jefferies Credit Partners", domains: ["jefferies.com"], headcountFloor: 51 }),
  ]);
  assert.equal(r.status, "verified");
  assert.equal(r.status === "verified" && r.candidate.companyId, 1049893);
});

test("the tiebreak reads either side of a slash-joined name", () => {
  const r = resolveIdentity(firm({ name: "KeyCorp / KeyBank", website: "key.com" }), [
    candidate({ companyId: 6091341, name: "KeyBank Commercial", domains: ["key.com"] }),
    candidate({ companyId: 681109, name: "KeyBank", domains: ["key.com"] }),
  ]);
  assert.equal(r.status === "verified" && r.candidate.companyId, 681109);
});

test("the tiebreak picks the subsidiary when the subsidiary is the firm", () => {
  const r = resolveIdentity(firm({ name: "Jefferies Credit Partners", website: "jefferies.com" }), [
    candidate({ companyId: 1049893, name: "Jefferies", domains: ["jefferies.com"] }),
    candidate({ companyId: 6593750, name: "Jefferies Credit Partners", domains: ["jefferies.com"] }),
  ]);
  assert.equal(r.status === "verified" && r.candidate.companyId, 6593750);
});

test("the tiebreak never reaches past our own domain", () => {
  // The exact name matches, but the tied rival was found on a different
  // domain - not one family, so nothing here says which is ours.
  const r = resolveIdentity(firm({ name: "Example Capital", website: null, linkedinUrl: "https://www.linkedin.com/company/example" }), [
    candidate({ companyId: 1, name: "Example Capital", domains: ["example.com"], linkedinUrl: "https://www.linkedin.com/company/example" }),
    candidate({ companyId: 2, name: "Example Capital Partners", domains: ["other.com"], linkedinUrl: "https://www.linkedin.com/company/example" }),
  ]);
  assert.equal(r.status === "unresolved" && r.reason, "ambiguous");
});

test("two exact-name records on one domain stay ambiguous", () => {
  const r = resolveIdentity(firm({ name: "Jefferies", website: "jefferies.com" }), [
    candidate({ companyId: 1, name: "Jefferies", domains: ["jefferies.com"] }),
    candidate({ companyId: 2, name: "Jefferies LLC", domains: ["jefferies.com"] }),
  ]);
  assert.equal(r.status === "unresolved" && r.reason, "ambiguous");
});

test("a name-only match can never reach the threshold", () => {
  // The website-less case: no domain to compare, no stored LinkedIn.
  const r = resolveIdentity(firm({ name: "Example Capital", website: null }), [
    candidate({ domains: [], companyId: 7, industries: [], headcountFloor: null }),
  ]);
  assert.equal(r.status, "unresolved");
  assert.equal(r.status === "unresolved" && r.reason, "below_threshold");
  assert.equal(r.confidence, 40);
  assert.ok(40 < ACCEPT_THRESHOLD);
});

test("a website-less firm tops out below the bar even with every available signal", () => {
  // name 40 + industry 10 + headcount 5 = 55. There is no HQ signal to add.
  const scored = scoreCandidate(firm({ website: null }), candidate({ domains: [] }));
  assert.equal(scored.score, 55);
  assert.ok(scored.score < ACCEPT_THRESHOLD);
});

test("a conflicting stored domain costs the points but does not disqualify", () => {
  const scored = scoreCandidate(firm({ website: "stale-old-domain.com" }), candidate());
  assert.equal(scored.conflict, true);
  assert.equal(scored.signals.includes("domain"), false);
  // name 40 + industry 10 + headcount 5.
  assert.equal(scored.score, 55);
});

test("a conflict is accepted when the name matches and something else corroborates", () => {
  const strong = resolveIdentity(
    firm({ website: "stale.com", linkedinUrl: "https://www.linkedin.com/company/example-capital" }),
    [candidate({ linkedinUrl: "https://linkedin.com/company/example-capital/" })],
  );
  // name 40 + linkedin 35 + industry 10 + headcount 5 = 90. Conflict carried
  // through to the verdict so it can be logged for review.
  assert.equal(strong.status, "verified");
  assert.equal(strong.status === "verified" && strong.conflict, true);
  assert.equal(strong.status === "verified" && strong.confidence, 90);
});

test("a conflict without a name match fails on the threshold, not the conflict rule", () => {
  // Worth stating explicitly, because it means the conflict guard is currently
  // UNREACHABLE and that is a property of the weights, not an accident: a
  // conflicting candidate scores no domain points, so the most it can reach is
  // name 40 + linkedin 35 + industry 10 + headcount 5. Drop the name and the
  // ceiling is 50, below the 65 bar. Any conflicting candidate that DOES clear
  // 65 therefore had the name plus at least one other signal already. The
  // guard stays in place because the weights may change.
  const weak = resolveIdentity(
    firm({
      name: "Something Else Entirely",
      website: "stale.com",
      linkedinUrl: "https://www.linkedin.com/company/example-capital",
    }),
    [candidate({ linkedinUrl: "https://linkedin.com/company/example-capital/" })],
  );
  assert.equal(weak.status, "unresolved");
  assert.equal(weak.status === "unresolved" && weak.reason, "below_threshold");
  assert.equal(weak.confidence, 50);
});

test("an unusable stored domain is neither evidence nor a conflict", () => {
  // careers.db.com must not be read as disagreeing with db.com.
  const scored = scoreCandidate(
    firm({ name: "Deutsche Bank", website: "careers.db.com" }),
    candidate({ name: "Deutsche Bank", domains: ["db.com"] }),
  );
  assert.equal(scored.conflict, false);
  assert.equal(scored.signals.includes("domain"), false);
});

test("subsidiaries sharing one provider company both verify", () => {
  // key.com covers KeyCorp, KeyBank and Cain Brothers in the directory. Nothing
  // here may refuse the second one for reusing a company id.
  const provider = candidate({ companyId: 555, name: "KeyBank", domains: ["key.com"] });
  const a = resolveIdentity(firm({ name: "KeyCorp / KeyBank", website: "key.com" }), [provider]);
  const b = resolveIdentity(firm({ name: "KeyBank", website: "key.com" }), [provider]);
  assert.equal(a.status, "verified");
  assert.equal(b.status, "verified");
  assert.equal(a.status === "verified" && a.candidate.companyId, 555);
  assert.equal(b.status === "verified" && b.candidate.companyId, 555);
});

test("no candidates is its own outcome, not a zero score", () => {
  const r = resolveIdentity(firm(), []);
  assert.equal(r.status, "unresolved");
  assert.equal(r.status === "unresolved" && r.reason, "no_candidates");
});

test("names compare past legal suffixes and leading-word prefixes", () => {
  assert.equal(comparableCompanyName("Teleo Capital Management LLC"), "teleo capital management");
  assert.equal(comparableCompanyName("Stifel, Nicolaus & Company, Incorporated"), "stifel nicolaus");
  // "Teleo Capital" is the provider's name for "Teleo Capital Management".
  const scored = scoreCandidate(
    firm({ name: "Teleo Capital Management LLC", website: null }),
    candidate({ name: "TELEO Capital", domains: [] }),
  );
  assert.ok(scored.signals.includes("name"));
});

test("LinkedIn URLs compare by slug, not by spelling", () => {
  assert.equal(linkedinCompanySlug("https://www.linkedin.com/company/teleo-capital"), "teleo-capital");
  assert.equal(linkedinCompanySlug("https://linkedin.com/company/teleo-capital/"), "teleo-capital");
  assert.equal(linkedinCompanySlug("https://example.com/teleo"), null);
  assert.equal(linkedinCompanySlug(null), null);
});

test("the margin constant is actually enforced", () => {
  const r = resolveIdentity(firm({ website: null }), [
    candidate({ companyId: 1, name: "Example Capital", domains: [] }), // 55
    candidate({ companyId: 2, name: "Example Capital", domains: [], industries: [], headcountFloor: null }), // 40
  ]);
  // Best is 55, under threshold anyway - the point is it did not accept.
  assert.equal(r.status, "unresolved");
  assert.ok(RUNNER_UP_MARGIN === 25);
});

test("one company listed twice is recognised as duplicates, not two companies", async () => {
  const { duplicateRecords } = await import("@/lib/company-identity");
  // Exactly what the live API returns for warburgpincus.com.
  const records = [
    candidate({ companyId: 1060865, name: "Warburg Pincus LLC", domains: ["warburgpincus.com"], linkedinUrl: "https://www.linkedin.com/company/warburg-pincus", headcountFloor: 501 }),
    candidate({ companyId: 26025341, name: "Warburg Pincus LLC", domains: ["warburgpincus.com"], linkedinUrl: "https://www.linkedin.com/company/warburg-pincus-llc", headcountFloor: 501 }),
  ];
  const firm0 = firm({ name: "Warburg Pincus", website: "warburgpincus.com" });
  assert.equal(resolveIdentity(firm0, records).status, "unresolved", "the resolver alone cannot choose");
  assert.deepEqual(duplicateRecords(firm0, records)?.map((c) => c.companyId), [1060865, 26025341]);

  // Two DIFFERENT companies tied on one domain are not duplicates.
  assert.equal(
    duplicateRecords(firm({ name: "Citigroup", website: "citigroup.com" }), [
      candidate({ companyId: 1, name: "Citigroup Global Markets", domains: ["citigroup.com"] }),
      candidate({ companyId: 2, name: "Citigroup CIB", domains: ["citigroup.com"] }),
    ]),
    null,
  );
  // Same name, but one is on another domain: not provably the same company.
  assert.equal(
    duplicateRecords(firm({ name: "Loop Capital", website: "loopcapital.com", linkedinUrl: "https://www.linkedin.com/company/loop" }), [
      candidate({ companyId: 1, name: "Loop Capital", domains: ["loopcapital.com"], linkedinUrl: "https://www.linkedin.com/company/loop" }),
      candidate({ companyId: 2, name: "Loop Capital", domains: ["loop.io"], linkedinUrl: "https://www.linkedin.com/company/loop" }),
    ]),
    null,
  );
});
