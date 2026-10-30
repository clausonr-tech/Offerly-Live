import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  decideEnrichedEmail,
  emailDomainOf,
  isApprovedFirmEmailDomain,
  legacyEmailDisposition,
  resolveContactEmail,
  type FirmEmailDomains,
  type ProviderEmailStatus,
} from "@/lib/contact-email-gate";
import { emailLabel, shouldRenderEmail } from "@/lib/contact-email-render";

const EVERCORE: FirmEmailDomains = { primaryDomain: "evercore.com", approvedAliases: [] };
const BARCLAYS: FirmEmailDomains = { primaryDomain: "home.barclays", approvedAliases: ["barclays.com"] };
const PATTERN = { shape: "first.last" as const, domain: "evercore.com", sampleCount: 2 };

const decide = (email: string | null, status: ProviderEmailStatus, firm = EVERCORE) =>
  decideEnrichedEmail({ email, providerStatus: status, firm, employmentConfirmed: true });

// ------------------------------------------------- the full status × domain grid

test("every status on an APPROVED domain resolves to exactly one outcome", () => {
  const grid: [ProviderEmailStatus, boolean, string][] = [
    ["deliverable", true, "verified"],
    ["catch_all", true, "catch_all"],
    ["unknown", false, "UNKNOWN_DELIVERABILITY"],
    ["invalid", false, "INVALID"],
    [null, false, "UNKNOWN_DELIVERABILITY"],
  ];
  for (const [status, usable, expected] of grid) {
    const d = decide("a.b@evercore.com", status);
    assert.equal(d.usable, usable, String(status));
    assert.equal(d.usable ? d.confidence : d.reason, expected, String(status));
  }
});

test("every status on an UNAPPROVED domain is refused, deliverable included", () => {
  for (const status of ["deliverable", "catch_all", "unknown", "invalid", null] as ProviderEmailStatus[]) {
    const d = decide("a.b@greenhill.com", status);
    assert.equal(d.usable, false, String(status));
  }
});

test("personal and educational domains are named precisely, not lumped in", () => {
  const personal = decide("a@gmail.com", "deliverable");
  const edu = decide("a@wharton.upenn.edu", "deliverable");
  assert.equal(personal.usable === false && personal.reason, "PERSONAL_DOMAIN");
  assert.equal(edu.usable === false && edu.reason, "EDUCATIONAL_DOMAIN");
  assert.equal(decide("a@example.ac.uk", "deliverable").usable, false);
});

test("an approved alias is accepted; an unapproved sibling domain is not", () => {
  assert.equal(decide("a.b@barclays.com", "deliverable", BARCLAYS).usable, true);
  assert.equal(decide("a.b@home.barclays", "deliverable", BARCLAYS).usable, true);
  assert.equal(decide("a.b@narrativ.com", "deliverable", BARCLAYS).usable, false);
});

test("an unapproved parent or subsidiary domain is refused", () => {
  // key.com is KeyBank's; Cain Brothers is a separate firm on the same domain.
  const cain: FirmEmailDomains = { primaryDomain: "cainbrothers.com", approvedAliases: [] };
  assert.equal(decide("a.b@key.com", "deliverable", cain).usable, false);
});

test("lookalike and near-miss domains never pass", () => {
  for (const email of [
    "a@evercore.com.attacker.com",
    "a@fakeevercore.com",
    "a@evercore.co",
    "a@notevercore.com",
    "a@evercore.com.co",
  ]) {
    assert.equal(isApprovedFirmEmailDomain({ email, verifiedDomain: "evercore.com" }), false, email);
  }
  // A genuine subdomain of the firm IS the firm.
  assert.equal(isApprovedFirmEmailDomain({ email: "a@mail.evercore.com", verifiedDomain: "evercore.com" }), true);
});

test("case and whitespace are normalised before comparison", () => {
  assert.equal(decide("  A.B@EVERCORE.COM  ", "deliverable").usable, true);
  assert.equal(emailDomainOf("  A@B.COM "), "b.com");
});

test("malformed addresses parse to nothing rather than to something plausible", () => {
  for (const bad of ["", "   ", "no-at-sign", "a@b@c.com", "@b.com", "a@", "a@b", null, undefined]) {
    assert.equal(emailDomainOf(bad as string | null), null, JSON.stringify(bad));
  }
});

test("an internationalised domain does not accidentally match", () => {
  assert.equal(isApprovedFirmEmailDomain({ email: "a@evercore.cøm", verifiedDomain: "evercore.com" }), false);
  assert.equal(isApprovedFirmEmailDomain({ email: "a@evercorе.com", verifiedDomain: "evercore.com" }), false); // Cyrillic е
});

test("a firm with no approved domain approves nothing", () => {
  const unresolved: FirmEmailDomains = { primaryDomain: null, approvedAliases: [] };
  assert.equal(decide("a@anything.com", "deliverable", unresolved).usable, false);
});

// --------------------------------------------------------------- fallback grid

test("the fallback produces the right outcome for every enrichment shape", () => {
  const cases: [string, string | null, ProviderEmailStatus, string | null, string][] = [
    ["deliverable same-firm", "a.b@evercore.com", "deliverable", "a.b@evercore.com", "verified"],
    ["catch-all same-firm", "a.b@evercore.com", "catch_all", "a.b@evercore.com", "catch_all"],
    ["unknown same-firm", "a.b@evercore.com", "unknown", "vikram.jolly@evercore.com", "predicted"],
    ["invalid same-firm", "a.b@evercore.com", "invalid", "vikram.jolly@evercore.com", "predicted"],
    ["off-domain", "vikram.jolly@greenhill.com", "deliverable", "vikram.jolly@evercore.com", "predicted"],
    ["personal", "v@gmail.com", "deliverable", "vikram.jolly@evercore.com", "predicted"],
    ["educational", "v@wharton.upenn.edu", "deliverable", "vikram.jolly@evercore.com", "predicted"],
    ["no email", null, null, "vikram.jolly@evercore.com", "predicted"],
    ["empty string", "", null, "vikram.jolly@evercore.com", "predicted"],
  ];
  for (const [label, enriched, status, expectedEmail, expectedConfidence] of cases) {
    const r = resolveContactEmail({
      name: "Vikram Jolly",
      enrichedEmail: enriched,
      providerStatus: status,
      firm: EVERCORE,
      employmentConfirmed: true,
      pattern: PATTERN,
    });
    assert.equal(r.email, expectedEmail, label);
    assert.equal(r.emailConfidence, expectedConfidence, label);
    if (r.email) assert.equal(r.emailDomainRelevant, true, label);
  }
});

test("unconfirmed employment rejects outright and never falls back to a pattern", () => {
  const r = resolveContactEmail({
    name: "Vikram Jolly",
    enrichedEmail: "vikram.jolly@evercore.com",
    providerStatus: "deliverable",
    firm: EVERCORE,
    employmentConfirmed: false,
    pattern: PATTERN,
  });
  assert.equal(r.email, null);
  assert.equal(r.rejection, "EMPLOYMENT_UNCONFIRMED");
});

test("the named real-world cases behave as specified", () => {
  const withPattern = (name: string, enriched: string | null) =>
    resolveContactEmail({
      name,
      enrichedEmail: enriched,
      providerStatus: enriched ? "deliverable" : null,
      firm: EVERCORE,
      employmentConfirmed: true,
      pattern: PATTERN,
    });

  assert.equal(withPattern("Vikram Jolly", "vikram.jolly@greenhill.com").email, "vikram.jolly@evercore.com");
  assert.equal(withPattern("Shania Tang", null).email, "shania.tang@evercore.com");
  assert.equal(withPattern("Jay Shapiro", null).email, "jay.shapiro@evercore.com");
  assert.equal(withPattern("Joshua O.", null).email, null);

  const barclays = resolveContactEmail({
    name: "Jonathan Simmons",
    enrichedEmail: "jonathan.simmons@narrativ.com",
    providerStatus: "deliverable",
    firm: BARCLAYS,
    employmentConfirmed: true,
    pattern: { shape: "first.last", domain: "barclays.com", sampleCount: 2 },
  });
  assert.equal(barclays.email, "jonathan.simmons@barclays.com");
  assert.equal(barclays.emailConfidence, "predicted");
});

// ------------------------------------------------------------- render guard

test("the renderer shows exactly the three renderable states", () => {
  assert.equal(shouldRenderEmail({ email: "a@b.com", emailConfidence: "verified", emailDomainRelevant: true }), true);
  assert.equal(shouldRenderEmail({ email: "a@b.com", emailConfidence: "catch_all", emailDomainRelevant: true }), true);
  assert.equal(shouldRenderEmail({ email: "a@b.com", emailConfidence: "predicted", emailDomainRelevant: true }), true);
  assert.equal(shouldRenderEmail({ email: "a@b.com", emailConfidence: "unavailable", emailDomainRelevant: true }), false);
});

test("the renderer fails closed on anything it does not recognise", () => {
  const bad: Parameters<typeof shouldRenderEmail>[0][] = [
    { email: "a@b.com", emailConfidence: "verified" }, // relevance flag missing
    { email: "a@b.com", emailConfidence: "verified", emailDomainRelevant: false },
    { email: "a@b.com", emailConfidence: "verified", emailDomainRelevant: null },
    { email: "a@b.com", emailConfidence: "unknown", emailDomainRelevant: true },
    { email: "a@b.com", emailConfidence: "invalid", emailDomainRelevant: true },
    { email: "a@b.com", emailConfidence: null, emailDomainRelevant: true },
    { email: null, emailConfidence: "verified", emailDomainRelevant: true },
    { email: "   ", emailConfidence: "verified", emailDomainRelevant: true },
    {},
  ];
  for (const c of bad) assert.equal(shouldRenderEmail(c), false, JSON.stringify(c));
  // A truthy non-boolean must not slip through a loose check.
  assert.equal(
    shouldRenderEmail({ email: "a@b.com", emailConfidence: "verified", emailDomainRelevant: 1 as unknown as boolean }),
    false,
  );
});

test("UNVERIFIED is never a label", () => {
  assert.equal(emailLabel("verified"), null);
  assert.equal(emailLabel("catch_all"), "CATCH-ALL");
  assert.equal(emailLabel("predicted"), "PREDICTED");
  for (const c of ["unavailable", "unknown", "invalid", null, undefined, "confirmed", "inferred"]) {
    assert.notEqual(emailLabel(c as string), "UNVERIFIED");
  }
});

// -------------------------------------------------------------- legacy rows

test("legacy confidence words map without inventing certainty", () => {
  const keep = (conf: string) =>
    legacyEmailDisposition({ email: "a.b@evercore.com", emailConfidence: conf, firm: EVERCORE });
  assert.equal(keep("confirmed")?.confidence, "verified");
  assert.equal(keep("inferred")?.confidence, "predicted");
  assert.equal(keep("unverified")?.confidence, "unknown");
  // `unknown` is kept but NOT renderable - the old word covered invalid too.
  assert.equal(keep("unverified")?.domainRelevant, false);
  assert.equal(keep("confirmed")?.domainRelevant, true);
});

test("legacy off-domain rows quarantine with the raw value preserved", () => {
  const d = legacyEmailDisposition({
    email: "vikram.jolly@greenhill.com",
    emailConfidence: "confirmed",
    firm: EVERCORE,
  });
  assert.equal(d?.action, "quarantine");
  assert.equal(d?.email, null);
  assert.equal(d?.rawProvider, "vikram.jolly@greenhill.com");
  assert.equal(d?.action === "quarantine" && d.reason, "DOMAIN_MISMATCH");
});

test("re-running the migration is idempotent and does not lose the first raw value", () => {
  const first = legacyEmailDisposition({ email: "a@greenhill.com", emailConfidence: "confirmed", firm: EVERCORE });
  // Second pass: email already cleared, raw already stored.
  const second = legacyEmailDisposition({
    email: null,
    emailConfidence: "unavailable",
    emailRawProvider: first?.rawProvider ?? null,
    firm: EVERCORE,
  });
  assert.equal(second, null, "a row with no email needs no further action");
  // And a row re-run while still holding its raw keeps the ORIGINAL raw.
  const again = legacyEmailDisposition({
    email: "a@greenhill.com",
    emailConfidence: "confirmed",
    emailRawProvider: "a@greenhill.com",
    firm: EVERCORE,
  });
  assert.equal(again?.rawProvider, "a@greenhill.com");
});

test("a legacy row with null confidence is not assumed good", () => {
  const d = legacyEmailDisposition({ email: "a.b@evercore.com", emailConfidence: null, firm: EVERCORE });
  assert.equal(d?.confidence, "unknown");
  assert.equal(d?.domainRelevant, false);
});

test("REGRESSION: no enrichment AND unconfirmed employment must not derive an address", () => {
  // Found by the fuzzer. decideEnrichedEmail checks for a missing address
  // BEFORE it checks employment, so this combination reported
  // NO_EMAIL_RETURNED - and the fallback, which only refused when the reason
  // was literally EMPLOYMENT_UNCONFIRMED, went ahead and built a PREDICTED
  // @evercore.com address for someone we could not place at Evercore.
  for (const enriched of [null, "", "a@greenhill.com", "a@evercore.com"]) {
    const r = resolveContactEmail({
      name: "Vikram Jolly",
      enrichedEmail: enriched,
      providerStatus: enriched ? "deliverable" : null,
      firm: EVERCORE,
      employmentConfirmed: false,
      pattern: PATTERN,
    });
    assert.equal(r.email, null, JSON.stringify(enriched));
    assert.equal(r.emailConfidence, "unavailable", JSON.stringify(enriched));
    assert.equal(r.emailDomainRelevant, false, JSON.stringify(enriched));
    assert.equal(r.rejection, "EMPLOYMENT_UNCONFIRMED", JSON.stringify(enriched));
    assert.equal(shouldRenderEmail(r), false, JSON.stringify(enriched));
  }
});
