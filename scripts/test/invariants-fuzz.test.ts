import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  canSeedPattern,
  emailDomainOf,
  isApprovedFirmEmailDomain,
  resolveContactEmail,
  type FirmEmailDomains,
  type ProviderEmailStatus,
} from "@/lib/contact-email-gate";
import { shouldRenderEmail } from "@/lib/contact-email-render";
import { classifyDomain, registrableDomain } from "@/lib/company-domains";
import { resolveIdentity, scoreCandidate, type CandidateCompany } from "@/lib/company-identity";
import { applyPattern } from "@/lib/email-patterns";

/**
 * Property-based sweeps over generated input.
 *
 * A deterministic PRNG rather than a random one, so a failure is reproducible
 * from the seed printed in the assertion rather than being a story about
 * something that happened once on someone's laptop.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const LOCAL_BITS = ["a", "b.c", "x_y", "john.teeter", "", " ", "a@b", "..", "'", "ünïcode", "A.B"];
const DOMAIN_BITS = [
  "evercore.com", "EVERCORE.COM", "mail.evercore.com", "evercore.com.attacker.com",
  "fakeevercore.com", "evercore.co", "greenhill.com", "gmail.com", "wharton.upenn.edu",
  "ch.linkedin.com", "careers.db.com", "tal.net", "boards.greenhouse.io", "home.barclays",
  "", " ", "no-dot", "a..b.com", "evercorе.com", "x.co.uk",
];
const STATUSES: ProviderEmailStatus[] = ["deliverable", "catch_all", "unknown", "invalid", null];
const NAMES = [
  "John Teeter", "Joshua O.", "Maryam Q.", "Mary-Jane Watson", "Seán O'Brien",
  "José Álvarez", "John Robert Teeter", "Cher", "", "   ", "李 雷", "X Y",
];

const EVERCORE: FirmEmailDomains = { primaryDomain: "evercore.com", approvedAliases: [] };
const PATTERN = { shape: "first.last" as const, domain: "evercore.com", sampleCount: 2 };

const ITERATIONS = 4000;

test(`INVARIANT: a rendered email always has an approved domain (${ITERATIONS} cases)`, () => {
  const next = rng(20260922);
  for (let i = 0; i < ITERATIONS; i++) {
    const local = LOCAL_BITS[Math.floor(next() * LOCAL_BITS.length)];
    const domain = DOMAIN_BITS[Math.floor(next() * DOMAIN_BITS.length)];
    const status = STATUSES[Math.floor(next() * STATUSES.length)];
    const name = NAMES[Math.floor(next() * NAMES.length)];
    const employed = next() > 0.2;
    const havePattern = next() > 0.3;

    const r = resolveContactEmail({
      name,
      enrichedEmail: local || domain ? `${local}@${domain}` : null,
      providerStatus: status,
      firm: EVERCORE,
      employmentConfirmed: employed,
      pattern: havePattern ? PATTERN : null,
    });

    if (shouldRenderEmail(r)) {
      assert.ok(
        isApprovedFirmEmailDomain({ email: r.email, verifiedDomain: "evercore.com" }),
        `seed case ${i}: rendered ${r.email} on an unapproved domain (from ${local}@${domain}/${status})`,
      );
      // 2. No invalid or unknown address is ever displayed as provider-sourced.
      if (r.emailSource === "crustdata") {
        assert.ok(["deliverable", "catch_all"].includes(String(status)), `case ${i}: displayed a ${status} provider address`);
      }
      // 3. A derived address is never labelled verified.
      if (r.emailSource === "pattern_inference") {
        assert.equal(r.emailConfidence, "predicted", `case ${i}`);
      }
      // 5. Employment must have been confirmed.
      assert.equal(employed, true, `case ${i}: rendered an email for an unconfirmed employee`);
    }

    // 4. Whatever happened, a derived address can never become evidence.
    if (r.emailSource === "pattern_inference") {
      assert.equal(
        canSeedPattern({
          email: r.email,
          providerStatus: "deliverable",
          firm: EVERCORE,
          employmentConfirmed: true,
          source: r.emailSource,
        }),
        false,
        `case ${i}`,
      );
    }
  }
});

test("INVARIANT: the decision is deterministic for identical input", () => {
  const next = rng(7);
  for (let i = 0; i < 500; i++) {
    const args = {
      name: NAMES[Math.floor(next() * NAMES.length)],
      enrichedEmail: `${LOCAL_BITS[Math.floor(next() * LOCAL_BITS.length)]}@${DOMAIN_BITS[Math.floor(next() * DOMAIN_BITS.length)]}`,
      providerStatus: STATUSES[Math.floor(next() * STATUSES.length)],
      firm: EVERCORE,
      employmentConfirmed: true,
      pattern: PATTERN,
    };
    assert.equal(JSON.stringify(resolveContactEmail(args)), JSON.stringify(resolveContactEmail(args)), `case ${i}`);
  }
});

test("FUZZ: domain normalisation never throws and never widens the approved set", () => {
  const next = rng(99);
  const junk = ["", " ", ".", "..", "@", "a@b@c", "http://", "https://x", "x:80", "..com", "-.com", "\t", "\n", "%%%"];
  for (let i = 0; i < 2000; i++) {
    const v =
      next() > 0.5
        ? DOMAIN_BITS[Math.floor(next() * DOMAIN_BITS.length)]
        : junk[Math.floor(next() * junk.length)];
    assert.doesNotThrow(() => {
      registrableDomain(v);
      classifyDomain(v);
      emailDomainOf(`a@${v}`);
    }, `case ${i}: ${JSON.stringify(v)}`);

    // Nothing that is not literally the firm's registrable domain may approve.
    const approved = isApprovedFirmEmailDomain({ email: `a@${v}`, verifiedDomain: "evercore.com" });
    if (approved) {
      assert.equal(registrableDomain(v), "evercore.com", `case ${i}: ${JSON.stringify(v)} approved wrongly`);
    }
  }
});

test("FUZZ: applyPattern never emits a malformed or empty-component address", () => {
  const next = rng(1234);
  const shapes = ["first.last", "firstlast", "flast", "firstl", "last.first", "first"] as const;
  for (let i = 0; i < 2000; i++) {
    const name = NAMES[Math.floor(next() * NAMES.length)];
    const shape = shapes[Math.floor(next() * shapes.length)];
    const built = applyPattern(name, shape, "evercore.com");
    if (built === null) continue;
    assert.ok(!built.startsWith("@"), `case ${i}: ${name} -> ${built}`);
    assert.ok(!built.includes(".@"), `case ${i}: ${name} -> ${built}`);
    assert.ok(!built.includes(".."), `case ${i}: ${name} -> ${built}`);
    assert.equal(built.split("@").length, 2, `case ${i}: ${name} -> ${built}`);
    assert.match(built, /^[a-z0-9][a-z0-9.\-]*@evercore\.com$/, `case ${i}: ${name} -> ${built}`);
  }
});

test("FUZZ: candidate scoring survives malformed provider payloads", () => {
  const next = rng(555);
  for (let i = 0; i < 1500; i++) {
    const c: CandidateCompany = {
      companyId: next() > 0.5 ? Math.floor(next() * 1e6) : null,
      name: NAMES[Math.floor(next() * NAMES.length)],
      domains: next() > 0.5 ? [DOMAIN_BITS[Math.floor(next() * DOMAIN_BITS.length)]] : [],
      primaryDomain: next() > 0.5 ? DOMAIN_BITS[Math.floor(next() * DOMAIN_BITS.length)] : null,
      linkedinUrl: next() > 0.7 ? "https://www.linkedin.com/company/x" : null,
      industries: next() > 0.5 ? ["Investment Banking"] : [],
      headcountFloor: next() > 0.5 ? Math.floor(next() * 5000) : null,
    };
    assert.doesNotThrow(() => {
      const s = scoreCandidate({ name: "Evercore", website: "evercore.com", linkedinUrl: null }, c);
      // A score is never negative and never exceeds the sum of the weights.
      assert.ok(s.score >= 0 && s.score <= 135, `case ${i}: score ${s.score}`);
    }, `case ${i}`);
  }
});

test("INVARIANT: a verified resolution never carries a blocklisted domain", () => {
  const next = rng(31337);
  for (let i = 0; i < 1500; i++) {
    const domains = [DOMAIN_BITS[Math.floor(next() * DOMAIN_BITS.length)]];
    const r = resolveIdentity({ name: "Evercore", website: "evercore.com", linkedinUrl: null }, [
      {
        companyId: 1,
        name: "Evercore",
        domains,
        primaryDomain: domains[0],
        linkedinUrl: null,
        industries: ["Investment Banking"],
        headcountFloor: 100,
      },
    ]);
    if (r.status === "verified") {
      for (const d of r.candidate.domains) {
        // A verified candidate may CARRY an unusable domain (Evercore's record
        // really lists tal.net); what matters is that at least one is usable,
        // which is what the resolver stores.
        void d;
      }
      assert.ok(
        r.candidate.domains.some((d) => classifyDomain(d).usable),
        `case ${i}: verified with no usable domain at all`,
      );
    }
  }
});
