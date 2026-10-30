/**
 * The parser against the shape the provider actually returns.
 *
 * Written after a single live /person/search proved the inferred shape wrong:
 * the identifier is `crustdata_company_id`, not the `company_id` the filter
 * grammar uses. Everything that depends on employment - which is everything
 * that decides whether a student sees a contact at all - was failing closed
 * on every firm.
 *
 * These tests are the reason that cannot silently come back.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  EVERCORE_COMPANY_ID,
  OTHER_COMPANY_ID,
  observedEmployment,
  observedProfile,
} from "./fixtures/observed-person-search";
import { confirmEmployment, parseEmploymentEvidence } from "@/lib/employment";
import { fromCrustdataProfile } from "@/lib/crustdata-client";

const FIRM = { crustdataCompanyId: EVERCORE_COMPANY_ID };
const NOW = new Date("2026-09-22T00:00:00Z");
const verdict = (profile: unknown, firm = FIRM) =>
  confirmEmployment(parseEmploymentEvidence(profile), firm, NOW);

// ------------------------------------------------ the observed identifier

test("crustdata_company_id parses - the field the live response actually carries", () => {
  const evidence = parseEmploymentEvidence(observedProfile());
  assert.equal(evidence.current[0].companyId, EVERCORE_COMPANY_ID);
  assert.equal(evidence.past[0].companyId, OTHER_COMPANY_ID);
});

test("an exact firm-ID match on the observed shape produces `current`", () => {
  const v = verdict(observedProfile());
  assert.equal(v.status, "current");
  assert.equal(v.basis, "company_id");
  assert.equal(v.matched?.companyId, EVERCORE_COMPANY_ID);
});

test("a DIFFERENT company id is unconfirmed, not admitted", () => {
  const v = verdict(
    observedProfile({ current: [observedEmployment({ crustdata_company_id: 999999 })] }),
  );
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "company_id_mismatch");
});

test("a missing identifier stays unconfirmed - the fail-closed guarantee", () => {
  // The exact state the codebase was in before the correction: every key
  // present EXCEPT the identifier.
  const withoutId = observedEmployment();
  delete withoutId.crustdata_company_id;
  const v = verdict(observedProfile({ current: [withoutId] }));
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "no_company_id_on_record");
});

test("past employment at the firm stays past", () => {
  const v = verdict(
    observedProfile({
      current: [observedEmployment({ crustdata_company_id: OTHER_COMPANY_ID, name: "Elsewhere" })],
      past: [observedEmployment({ end_date: "2024-01-01" })],
    }),
  );
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "only_past_employment", "a former employee was admitted");
});

test("current employment with end_date: null stays current", () => {
  // `null` is what the live response carries for an ongoing role, and the
  // parser must not read it as a string or as an end.
  const evidence = parseEmploymentEvidence(observedProfile());
  assert.equal(evidence.current[0].endDate, null);
  assert.equal(verdict(observedProfile()).status, "current");
});

test("a future start date is `incoming`, never current", () => {
  const v = verdict(
    observedProfile({ current: [observedEmployment({ start_date: "2027-06-01" })] }),
  );
  assert.equal(v.status, "incoming");
  assert.equal(v.basis, "future_start_company_id");
});

// --------------------------------------------- the older spellings still work

test("company_id and companyId remain accepted", () => {
  for (const key of ["company_id", "companyId"]) {
    const record = observedEmployment();
    delete record.crustdata_company_id;
    record[key] = EVERCORE_COMPANY_ID;
    const v = verdict(observedProfile({ current: [record] }));
    assert.equal(v.status, "current", key);
    assert.equal(v.basis, "company_id", key);
  }
});

test("crustdata_company_id wins when more than one spelling is present", () => {
  const record = observedEmployment({ company_id: 999999, companyId: 888888 });
  assert.equal(
    parseEmploymentEvidence(observedProfile({ current: [record] })).current[0].companyId,
    EVERCORE_COMPANY_ID,
  );
});

test("a non-numeric identifier is refused rather than coerced", () => {
  for (const bad of ["682795", null, undefined, {}, [], true]) {
    const record = observedEmployment({ crustdata_company_id: bad });
    delete record.company_id;
    const v = verdict(observedProfile({ current: [record] }));
    assert.notEqual(v.status, "current", JSON.stringify(bad));
  }
});

// --------------------------------- company_website: diagnostic, and only that

test("company_website is parsed into the diagnostic field, normalised", () => {
  const evidence = parseEmploymentEvidence(observedProfile());
  assert.deepEqual(evidence.current[0].domains, ["evercore.com"], "https:// and www. must be stripped");
});

test("a malformed company_website becomes null, never a half-parsed host", () => {
  for (const bad of ["", "   ", "http://", "not a url", "://x", "localhost", 42, null]) {
    const record = observedEmployment({ company_website: bad });
    const evidence = parseEmploymentEvidence(observedProfile({ current: [record] }));
    assert.equal(evidence.current[0].domains, null, JSON.stringify(bad));
  }
});

test("company_website CANNOT confirm employment", () => {
  // The whole point. A profile that names the firm's own website but carries
  // the wrong id is still unconfirmed - this is the vikram.jolly@greenhill.com
  // shape, where a plausible-looking domain was the evidence.
  const record = observedEmployment({
    crustdata_company_id: 999999,
    company_website: "https://www.evercore.com",
    name: "Evercore",
  });
  const v = verdict(observedProfile({ current: [record] }));
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "company_id_mismatch");
});

test("company_website cannot substitute for a missing identifier either", () => {
  const record = observedEmployment({ company_website: "https://www.evercore.com" });
  delete record.crustdata_company_id;
  assert.equal(verdict(observedProfile({ current: [record] })).status, "unconfirmed");
});

test("an explicit company_domains array still wins when present", () => {
  const record = observedEmployment({ company_domains: ["evercore.com", "evercoreisi.com"] });
  const evidence = parseEmploymentEvidence(observedProfile({ current: [record] }));
  assert.deepEqual(evidence.current[0].domains, ["evercore.com", "evercoreisi.com"]);
});

// ------------------------------------------------- the whole profile mapping

test("fromCrustdataProfile reads the observed shape", () => {
  const mapped = fromCrustdataProfile(
    observedProfile() as Parameters<typeof fromCrustdataProfile>[0],
  );
  assert.equal(mapped.crustdataPersonId, 98765432);
  assert.equal(mapped.name, "Synthetic Person");
  assert.equal(mapped.title, "Investment Banking Analyst");
  assert.equal(mapped.currentCompany, "Evercore");
  assert.equal(mapped.currentCity, "New York");
  assert.deepEqual(mapped.schools, ["University of Southern California"]);
  assert.equal(mapped.gradYear, 2024);
  assert.equal(mapped.employment.current[0].companyId, EVERCORE_COMPANY_ID);
  assert.deepEqual(mapped.previousCompanies, ["Somewhere Else"]);
});

test("the mapped employment is what the gate then reads", () => {
  // The seam the live bug hid in: fromCrustdataProfile and
  // parseEmploymentEvidence read the same payload independently, and both
  // have to agree about which key carries the identifier.
  const mapped = fromCrustdataProfile(
    observedProfile() as Parameters<typeof fromCrustdataProfile>[0],
  );
  const v = confirmEmployment(mapped.employment, FIRM, NOW);
  assert.equal(v.status, "current", "the search mapper and the gate disagree about the id");
});

// ------------------------------------------- the professional-profile URL

test("the profile URL is read from the path the live response uses", () => {
  // social_handles.professional_network_identifier.profile_url - confirmed
  // present and a string. It keys enrichment and is one of the two stable
  // identifiers deduplication trusts, so where it lives is load-bearing.
  const mapped = fromCrustdataProfile(
    observedProfile() as Parameters<typeof fromCrustdataProfile>[0],
  );
  assert.equal(typeof mapped.linkedinUrl, "string");
  assert.equal(mapped.linkedinUrl, "https://www.linkedin.com/in/synthetic-person");
});

test("no `urn_url` is expected, and nothing depends on one", () => {
  // Observed: professional_network_identifier carries exactly one key.
  const profile = observedProfile() as Record<string, unknown>;
  const identifier = (profile.social_handles as Record<string, unknown>)
    .professional_network_identifier as Record<string, unknown>;
  assert.deepEqual(Object.keys(identifier), ["profile_url"]);
  assert.equal("urn_url" in identifier, false);
});

test("the sibling social handles are present and empty, and are not mistaken for a profile", () => {
  const profile = observedProfile() as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(profile.social_handles as object).sort(),
    ["dev_platform_identifier", "professional_network_identifier", "twitter_identifier"],
  );
  const mapped = fromCrustdataProfile(profile as Parameters<typeof fromCrustdataProfile>[0]);
  assert.ok(mapped.linkedinUrl?.includes("/in/"), "a sibling handle was read as the profile");
});

test("a profile with no social_handles yields a null URL rather than throwing", () => {
  // Fail soft, but not silently: such a contact cannot be enriched and loses
  // one of its two stable dedup keys. It is still admissible if its company
  // id matches - employment is what decides admission, not reachability.
  const mapped = fromCrustdataProfile(
    observedProfile({ omitSocialHandles: true }) as Parameters<typeof fromCrustdataProfile>[0],
  );
  assert.equal(mapped.linkedinUrl, null);
  assert.equal(mapped.crustdataPersonId, 98765432, "the stable person id still identifies them");
  assert.equal(
    confirmEmployment(mapped.employment, FIRM, NOW).status,
    "current",
    "a missing profile URL must not affect the employment verdict",
  );
});

test("every other URL-ish field is a company or school asset, not a person", () => {
  // The alternative-path scan returned only these shapes. If a person-profile
  // URL ever appears somewhere else, this is where the assumption is written
  // down.
  const profile = observedProfile() as Record<string, unknown>;
  const employment = (
    (profile.experience as Record<string, unknown>).employment_details as Record<string, unknown>
  ).current as Record<string, unknown>[];
  assert.equal(typeof employment[0].company_professional_network_profile_url, "string");
  assert.ok(
    !String(employment[0].company_professional_network_profile_url).includes("/in/"),
    "a company URL looks like a person profile",
  );
  const mapped = fromCrustdataProfile(profile as Parameters<typeof fromCrustdataProfile>[0]);
  assert.notEqual(
    mapped.linkedinUrl,
    employment[0].company_professional_network_profile_url,
    "the company's page was read as the person's",
  );
});
