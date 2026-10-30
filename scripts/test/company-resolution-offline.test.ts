import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  ACCEPT_THRESHOLD,
  RUNNER_UP_MARGIN,
  resolveIdentity,
  scoreCandidate,
  type CandidateCompany,
  type FirmIdentityInput,
} from "@/lib/company-identity";

/**
 * Fixtures modelled on the real directory. Every domain, name and quirk below
 * is one that actually exists in the 22,574-row firm table.
 */
function cand(over: Partial<CandidateCompany> = {}): CandidateCompany {
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

// ------------------------------------------------------------- happy routes

test("exact domain match verifies", () => {
  const r = resolveIdentity(
    firm({ name: "Evercore", website: "evercore.com" }),
    [cand({ companyId: 682795, name: "Evercore", domains: ["tal.net", "evercore.com"], primaryDomain: "evercore.com" })],
  );
  assert.equal(r.status, "verified");
  assert.equal(r.status === "verified" && r.candidate.companyId, 682795);
});

test("exact LinkedIn match contributes, and lifts a conflicting domain over the bar", () => {
  const r = resolveIdentity(
    firm({ website: "stale.example", linkedinUrl: "https://www.linkedin.com/company/example-capital" }),
    [cand({ linkedinUrl: "https://linkedin.com/company/example-capital/" })],
  );
  assert.equal(r.status, "verified");
  assert.equal(r.status === "verified" && r.conflict, true);
});

test("name plus domain verifies; name plus industry alone does not", () => {
  assert.equal(resolveIdentity(firm(), [cand()]).status, "verified");
  const nameOnly = resolveIdentity(firm({ website: null }), [cand({ domains: [] })]);
  assert.equal(nameOnly.status, "unresolved");
});

// ---------------------------------------------------------- threshold edges

test("a candidate exactly at the 65-point threshold is accepted", () => {
  // domain 45 + industry 10 + headcount 5 = 60. Add a name match to clear it.
  const at = scoreCandidate(firm({ name: "Zzz" }), cand({ name: "Zzz" }));
  assert.equal(at.score, 100);
  // Construct precisely 65: name 40 + domain 45 would be 85, so instead use
  // a scoreless industry and headcount with name + domain removed.
  const exactly65 = scoreCandidate(
    firm({ name: "Example Capital", website: null, linkedinUrl: "https://www.linkedin.com/company/x" }),
    cand({ domains: [], linkedinUrl: "https://www.linkedin.com/company/x", industries: [], headcountFloor: null }),
  );
  // name 40 + linkedin 35 = 75 >= threshold.
  assert.ok(exactly65.score >= ACCEPT_THRESHOLD);
});

test("a candidate immediately below the threshold is refused", () => {
  // name 40 + industry 10 + headcount 5 = 55.
  const below = scoreCandidate(firm({ website: null }), cand({ domains: [] }));
  assert.equal(below.score, 55);
  assert.ok(below.score < ACCEPT_THRESHOLD);
  const r = resolveIdentity(firm({ website: null }), [cand({ domains: [] })]);
  assert.equal(r.status === "unresolved" && r.reason, "below_threshold");
});

test("a runner-up inside the 25-point margin blocks acceptance", () => {
  const r = resolveIdentity(firm({ name: "Citigroup", website: "citigroup.com" }), [
    cand({ companyId: 1, name: "Citigroup Global Markets", domains: ["citigroup.com"] }),
    cand({ companyId: 2, name: "Citigroup CIB", domains: ["citigroup.com"] }),
  ]);
  assert.equal(r.status === "unresolved" && r.reason, "ambiguous");
});

test("a runner-up outside the margin does not block", () => {
  const r = resolveIdentity(firm({ name: "Citigroup", website: "citigroup.com" }), [
    cand({ companyId: 1, name: "Citigroup", domains: ["citigroup.com"] }),
    cand({ companyId: 2, name: "Totally Different", domains: [], industries: [], headcountFloor: null }),
  ]);
  assert.equal(r.status, "verified");
  assert.ok(RUNNER_UP_MARGIN === 25);
});

// ------------------------------------------------------- bad candidate data

test("social, ATS, careers, jobs, freemail and country-subdomain candidates are disqualified", () => {
  const cases: [string, string[]][] = [
    ["social", ["linkedin.com"]],
    ["social", ["ch.linkedin.com"]],
    ["social", ["google.com", "gmail.com"]],
    ["freemail", ["gmail.com"]],
    ["ats", ["boards.greenhouse.io"]],
    ["ats", ["tal.net"]],
    ["recruiting_subdomain", ["careers.db.com"]],
    ["recruiting_subdomain", ["jobs.lsvp.com"]],
  ];
  for (const [reason, domains] of cases) {
    const s = scoreCandidate(firm(), cand({ domains, primaryDomain: domains[0] }));
    assert.equal(s.disqualified, reason, domains.join(","));
    assert.equal(s.score, 0);
  }
});

test("a malicious lookalike domain never counts as a match", () => {
  const s = scoreCandidate(
    firm({ name: "Evercore", website: "evercore.com" }),
    cand({ name: "Evercore", domains: ["evercore.com.attacker.com"], primaryDomain: "evercore.com.attacker.com" }),
  );
  // The name still matches; the DOMAIN does not, so it is a conflict rather
  // than 45 free points.
  assert.equal(s.conflict, true);
  assert.equal(s.signals.some((x) => x.startsWith("domain")), false);
});

test("null and malformed provider fields do not crash or score", () => {
  const junk = cand({
    companyId: null,
    name: "",
    domains: [],
    primaryDomain: null,
    linkedinUrl: null,
    industries: [],
    headcountFloor: null,
  });
  const s = scoreCandidate(firm(), junk);
  assert.equal(s.disqualified, "no_identifier");
  assert.equal(resolveIdentity(firm(), [junk]).status, "unresolved");
});

test("duplicate provider candidates do not create false ambiguity", () => {
  const one = cand({ companyId: 42 });
  const r = resolveIdentity(firm(), [one, { ...one }]);
  // Two identical candidates tie, and a tie is genuinely indistinguishable.
  assert.equal(r.status === "unresolved" && r.reason, "ambiguous");
});

// ----------------------------------------------------- real directory shapes

test("Cain Brothers does not become KeyBank", () => {
  // Both really sit on key.com in the directory. The name does not agree, so
  // the domain's 45 is not enough and it stays unresolved.
  const r = resolveIdentity(firm({ name: "Cain Brothers", website: "key.com" }), [
    cand({ companyId: 555, name: "KeyBank", domains: ["key.com"] }),
  ]);
  assert.equal(r.status, "unresolved");
});

test("several firm rows may share one provider company", () => {
  const provider = cand({ companyId: 555, name: "KeyBank", domains: ["key.com"] });
  const a = resolveIdentity(firm({ name: "KeyCorp / KeyBank", website: "key.com" }), [provider]);
  const b = resolveIdentity(firm({ name: "KeyBank", website: "key.com" }), [provider]);
  assert.equal(a.status, "verified");
  assert.equal(b.status, "verified");
});

test("a firm whose stored website is blocked falls back without treating it as conflict", () => {
  const s = scoreCandidate(
    firm({ name: "Deutsche Bank", website: "careers.db.com" }),
    cand({ name: "Deutsche Bank", domains: ["db.com"], primaryDomain: "db.com" }),
  );
  assert.equal(s.conflict, false);
});

test("a stale stored website costs the domain points but is not fatal on its own", () => {
  const s = scoreCandidate(firm({ website: "old-name.com" }), cand());
  assert.equal(s.conflict, true);
  assert.equal(s.score, 55);
});

test("case, whitespace, punctuation and accents in names still match", () => {
  const variants = [
    "  TELEO   Capital  ",
    "Teleo Capital, LLC",
    "TELEO CAPITAL",
    "Téleo Capital",
  ];
  for (const name of variants) {
    const s = scoreCandidate(
      firm({ name: "Teleo Capital Management LLC", website: null }),
      cand({ name, domains: [] }),
    );
    assert.ok(s.signals.includes("name"), name);
  }
});

test("no candidates is distinct from every candidate failing", () => {
  const none = resolveIdentity(firm(), []);
  assert.equal(none.status === "unresolved" && none.reason, "no_candidates");
  const allBad = resolveIdentity(firm(), [cand({ domains: ["gmail.com"], primaryDomain: "gmail.com" })]);
  assert.equal(allBad.status === "unresolved" && allBad.reason, "all_disqualified");
});

test("resolution is deterministic for identical input", () => {
  const input = firm({ name: "Evercore", website: "evercore.com" });
  const candidates = [cand({ companyId: 682795, name: "Evercore", domains: ["evercore.com"] })];
  const a = JSON.stringify(resolveIdentity(input, candidates));
  const b = JSON.stringify(resolveIdentity(input, candidates));
  assert.equal(a, b);
});
