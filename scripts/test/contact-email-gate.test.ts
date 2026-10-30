import assert from "node:assert/strict";
import test from "node:test";

import {
  canSeedPattern,
  decideEnrichedEmail,
  emailDomainOf,
  hasCompleteUnambiguousName,
  isApprovedFirmEmailDomain,
  resolveContactEmail,
  type FirmEmailDomains,
  type ProviderEmailStatus,
} from "@/lib/contact-email-gate";

const EVERCORE: FirmEmailDomains = { primaryDomain: "evercore.com", approvedAliases: [] };
const PATTERN = { shape: "first.last" as const, domain: "evercore.com", sampleCount: 2 };

function resolve(over: Partial<Parameters<typeof resolveContactEmail>[0]> = {}) {
  return resolveContactEmail({
    name: "Vikram Jolly",
    enrichedEmail: null,
    providerStatus: null,
    firm: EVERCORE,
    employmentConfirmed: true,
    pattern: PATTERN,
    ...over,
  });
}

function decide(email: string | null, providerStatus: ProviderEmailStatus) {
  return decideEnrichedEmail({
    email,
    providerStatus,
    firm: EVERCORE,
    employmentConfirmed: true,
  });
}

// ---------------------------------------------------------------- domain gate

test("1. an Evercore contact with @greenhill.com is rejected", () => {
  const d = decide("vikram.jolly@greenhill.com", "deliverable");
  assert.equal(d.usable, false);
  assert.equal(d.usable === false && d.reason, "DOMAIN_MISMATCH");
});

test("2. a deliverable @evercore.com address is accepted as verified", () => {
  const d = decide("john.teeter@evercore.com", "deliverable");
  assert.equal(d.usable, true);
  assert.equal(d.usable === true && d.confidence, "verified");
});

test("3. a catch-all @evercore.com address is labelled catch_all", () => {
  const d = decide("john.teeter@evercore.com", "catch_all");
  assert.equal(d.usable === true && d.confidence, "catch_all");
});

test("4. an invalid @evercore.com address is hidden", () => {
  const d = decide("nope@evercore.com", "invalid");
  assert.equal(d.usable, false);
  assert.equal(d.usable === false && d.reason, "INVALID");
});

test("5. an unknown @evercore.com address is hidden", () => {
  const d = decide("maybe@evercore.com", "unknown");
  assert.equal(d.usable, false);
  assert.equal(d.usable === false && d.reason, "UNKNOWN_DELIVERABILITY");
});

test("6. @wharton.upenn.edu is rejected for Evercore", () => {
  // The directory really holds clausonr@wharton.upenn.edu against Goldman Sachs.
  const d = decide("clausonr@wharton.upenn.edu", "deliverable");
  assert.equal(d.usable, false);
  assert.equal(d.usable === false && d.reason, "EDUCATIONAL_DOMAIN");
});

test("a personal address is rejected as personal, not merely mismatched", () => {
  const d = decide("vikram.jolly@gmail.com", "deliverable");
  assert.equal(d.usable === false && d.reason, "PERSONAL_DOMAIN");
});

test("a known previous employer is named as such", () => {
  const d = decideEnrichedEmail({
    email: "vikram.jolly@greenhill.com",
    providerStatus: "deliverable",
    firm: EVERCORE,
    employmentConfirmed: true,
    previousCompanies: ["Greenhill & Co"],
  });
  assert.equal(d.usable === false && d.reason, "PREVIOUS_EMPLOYER");
});

test("domain comparison is exact, so a lookalike cannot pass", () => {
  // The whole reason this is not a substring test.
  assert.equal(
    isApprovedFirmEmailDomain({
      email: "x@evercore.com.attacker.com",
      verifiedDomain: "evercore.com",
    }),
    false,
  );
  assert.equal(isApprovedFirmEmailDomain({ email: "x@notevercore.com", verifiedDomain: "evercore.com" }), false);
  assert.equal(isApprovedFirmEmailDomain({ email: "X@EverCore.COM", verifiedDomain: "evercore.com" }), true);
  // A subdomain of the firm's own domain is still the firm.
  assert.equal(isApprovedFirmEmailDomain({ email: "x@mail.evercore.com", verifiedDomain: "evercore.com" }), true);
});

test("an explicitly approved alias is accepted; an unlisted one is not", () => {
  // Real: eight Barclays contacts sit on @barclays.com while the SEC filing
  // says home.barclays. Same employer, but only because it is listed.
  const barclays: FirmEmailDomains = {
    primaryDomain: "home.barclays",
    approvedAliases: ["barclays.com"],
  };
  const asArg = (email: string) => ({
    email,
    verifiedDomain: barclays.primaryDomain,
    approvedAliases: barclays.approvedAliases,
  });
  assert.equal(isApprovedFirmEmailDomain(asArg("a.b@barclays.com")), true);
  assert.equal(isApprovedFirmEmailDomain(asArg("a.b@narrativ.com")), false);
});

test("emailDomainOf refuses anything that is not exactly one address", () => {
  assert.equal(emailDomainOf("a@b.com"), "b.com");
  assert.equal(emailDomainOf("a@b@c.com"), null);
  assert.equal(emailDomainOf("@b.com"), null);
  assert.equal(emailDomainOf("a@"), null);
  assert.equal(emailDomainOf(null), null);
});

// ------------------------------------------------------------ pattern seeding

test("7. an off-domain address cannot become a pattern seed", () => {
  assert.equal(
    canSeedPattern({
      email: "vikram.jolly@greenhill.com",
      providerStatus: "deliverable",
      firm: EVERCORE,
      employmentConfirmed: true,
      source: "crustdata",
    }),
    false,
  );
});

test("8. two deliverable same-domain samples can establish a pattern", () => {
  const seeds = ["john.teeter@evercore.com", "adeel.chaudhry@evercore.com"].filter((email) =>
    canSeedPattern({
      email,
      providerStatus: "deliverable",
      firm: EVERCORE,
      employmentConfirmed: true,
      source: "crustdata",
    }),
  );
  assert.equal(seeds.length, 2);
});

test("9. one real address establishes the shape, and what it builds is only predicted", () => {
  // A single address on the firm's domain spelled from its owner's name is the
  // firm's convention (see PATTERN_DERIVE_MIN_SAMPLES). Zero is still nothing.
  const one = resolve({ pattern: { ...PATTERN, sampleCount: 1 } });
  assert.equal(one.emailConfidence, "predicted");
  assert.equal(one.emailSource, "pattern_inference");
  const none = resolve({ pattern: { ...PATTERN, sampleCount: 0 } });
  assert.equal(none.email, null);
  assert.equal(none.emailConfidence, "unavailable");
});

test("10. predicted emails can never establish or reinforce a pattern", () => {
  assert.equal(
    canSeedPattern({
      email: "vikram.jolly@evercore.com",
      providerStatus: "deliverable",
      firm: EVERCORE,
      employmentConfirmed: true,
      source: "pattern_inference",
    }),
    false,
  );
});

test("a catch-all address may be shown but may not seed a pattern", () => {
  const shown = decide("a.b@evercore.com", "catch_all");
  assert.equal(shown.usable, true);
  assert.equal(
    canSeedPattern({
      email: "a.b@evercore.com",
      providerStatus: "catch_all",
      firm: EVERCORE,
      employmentConfirmed: true,
      source: "crustdata",
    }),
    false,
  );
});

// --------------------------------------------------------- the fallback rules

test("11. a domain-mismatched address becomes a predicted same-firm address", () => {
  const r = resolve({ enrichedEmail: "vikram.jolly@greenhill.com", providerStatus: "deliverable" });
  assert.equal(r.email, "vikram.jolly@evercore.com");
  assert.equal(r.emailConfidence, "predicted");
  assert.equal(r.emailDomainRelevant, true);
  assert.equal(r.emailSource, "pattern_inference");
  assert.equal(r.rejection, "DOMAIN_MISMATCH");
  // The provider's value is kept for diagnosis, never for display.
  assert.equal(r.rawProviderEmail, "vikram.jolly@greenhill.com");
});

test("12. an incomplete name such as Joshua O. does not receive a guessed email", () => {
  const r = resolve({ name: "Joshua O." });
  assert.equal(r.email, null);
  assert.equal(r.emailConfidence, "unavailable");
  assert.equal(hasCompleteUnambiguousName("Joshua O."), false);
  assert.equal(hasCompleteUnambiguousName("Maryam Q."), false);
  assert.equal(hasCompleteUnambiguousName("John Robert Teeter"), true);
  assert.equal(hasCompleteUnambiguousName("Cher"), false);
});

test("13. a contact without confirmed current employment gets no email at all", () => {
  const r = resolve({
    enrichedEmail: "vikram.jolly@evercore.com",
    providerStatus: "deliverable",
    employmentConfirmed: false,
  });
  assert.equal(r.email, null);
  assert.equal(r.emailConfidence, "unavailable");
  assert.equal(r.rejection, "EMPLOYMENT_UNCONFIRMED");
});

test("14. a legacy cached mismatch is not returned to the frontend", () => {
  // What the stored Evercore row looks like today, replayed through the gate.
  const r = resolve({ enrichedEmail: "jinny.lai@jpmchase.com", providerStatus: "deliverable" });
  assert.notEqual(r.email, "jinny.lai@jpmchase.com");
  assert.equal(r.emailDomainRelevant, true);
  assert.equal(r.emailConfidence, "predicted");
});

// ------------------------------------------------- missing-enrichment fallback

test("15. no email returned + confirmed pattern + complete name produces predicted", () => {
  const r = resolve({ name: "Shania Tang", enrichedEmail: null, providerStatus: null });
  assert.equal(r.email, "shania.tang@evercore.com");
  assert.equal(r.emailConfidence, "predicted");
  assert.equal(r.rejection, "NO_EMAIL_RETURNED");
});

test("16. an empty business-email array produces a predicted email", () => {
  // An empty array reaches this function as "no address", same as no match.
  const r = resolve({ name: "Jay Shapiro", enrichedEmail: "", providerStatus: null });
  assert.equal(r.email, "jay.shapiro@evercore.com");
  assert.equal(r.emailConfidence, "predicted");
});

test("17. only invalid or unknown addresses returned produces a predicted email", () => {
  const fromInvalid = resolve({ enrichedEmail: "vikram.jolly@evercore.com", providerStatus: "invalid" });
  assert.equal(fromInvalid.email, "vikram.jolly@evercore.com");
  assert.equal(fromInvalid.emailConfidence, "predicted");
  assert.equal(fromInvalid.rejection, "INVALID");

  const fromUnknown = resolve({ enrichedEmail: "vikram.jolly@evercore.com", providerStatus: "unknown" });
  assert.equal(fromUnknown.emailConfidence, "predicted");
  assert.equal(fromUnknown.rejection, "UNKNOWN_DELIVERABILITY");
});

test("18. no email returned + no sample produces no email", () => {
  const r = resolve({ name: "Shania Tang", pattern: { ...PATTERN, sampleCount: 0 } });
  assert.equal(r.email, null);
  assert.equal(r.emailConfidence, "unavailable");
});

test("a name-matching address on the firm's domain may teach the shape, even unconfirmed", async () => {
  const { canLearnPattern, preferFirmAddress } = await import("@/lib/contact-email-gate");
  const learn = (email: string, providerStatus: ProviderEmailStatus, name = "Nayantara Menon") =>
    canLearnPattern({ name, email, providerStatus, firm: EVERCORE, employmentConfirmed: true });
  // Brookfield's case: "unknown" because the server will not confirm mailboxes.
  assert.equal(learn("nayantara.menon@evercore.com", "unknown"), true);
  assert.equal(learn("nayantara.menon@evercore.com", "invalid"), false, "invalid teaches nothing");
  assert.equal(learn("nayantara.menon@greenhill.com", "deliverable"), false, "another firm's domain");
  assert.equal(learn("research-team@evercore.com", "deliverable"), false, "not spelled from the name");
  // The current employer's address is judged before an old employer's.
  const all = [
    { email: "nmenon@prosek.com", status: "deliverable" },
    { email: "nayantara.menon@evercore.com", status: "unknown" },
  ];
  assert.equal(preferFirmAddress(all, EVERCORE, all[0])?.email, "nayantara.menon@evercore.com");
  assert.equal(preferFirmAddress([all[0]], EVERCORE, all[0])?.email, "nmenon@prosek.com");
});

test("19. no email returned + incomplete name produces no email", () => {
  const r = resolve({ name: "Joshua O.", enrichedEmail: null, providerStatus: null });
  assert.equal(r.email, null);
  assert.equal(r.emailConfidence, "unavailable");
});

test("20. a pattern-generated address is always predicted, never verified", () => {
  for (const status of ["invalid", "unknown", null] as ProviderEmailStatus[]) {
    const r = resolve({ enrichedEmail: "x@greenhill.com", providerStatus: status });
    assert.notEqual(r.emailConfidence, "verified");
    if (r.email) assert.equal(r.emailConfidence, "predicted");
  }
});

test("21. a pattern whose domain is not approved for the firm is not applied", () => {
  const r = resolve({
    pattern: { shape: "first.last", domain: "greenhill.com", sampleCount: 5 },
  });
  assert.equal(r.email, null);
  assert.equal(r.rejection, "UNAPPROVED_FIRM_DOMAIN");
});

test("22. a usable provider address is preferred over the pattern", () => {
  const r = resolve({ name: "John Robert Teeter", enrichedEmail: "john.teeter@evercore.com", providerStatus: "deliverable" });
  assert.equal(r.email, "john.teeter@evercore.com");
  assert.equal(r.emailConfidence, "verified");
  assert.equal(r.emailSource, "crustdata");
  assert.equal(r.rejection, null);
});
