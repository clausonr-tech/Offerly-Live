import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  confirmEmployment,
  isAdmissibleContact,
  isCurrentEmployee,
  type EmploymentEvidence,
  type EmploymentRecord,
  type SelectedFirmIdentity,
} from "@/lib/employment";

/** Evercore, as the identify endpoint really reports it. */
const EVERCORE: SelectedFirmIdentity = { crustdataCompanyId: 682795 };
const GREENHILL_ID = 111111;
const NOW = new Date("2026-09-22T00:00:00Z");

const rec = (over: Partial<EmploymentRecord> = {}): EmploymentRecord => ({
  companyId: 682795,
  name: "Evercore",
  title: "Investment Banking Associate",
  ...over,
});
const ev = (over: Partial<EmploymentEvidence> = {}): EmploymentEvidence => ({
  current: [],
  past: [],
  ...over,
});

test("an exact current company-ID match confirms", () => {
  const v = confirmEmployment(ev({ current: [rec()] }), EVERCORE, NOW);
  assert.equal(v.status, "current");
  assert.equal(v.basis, "company_id");
  assert.equal(isCurrentEmployee(v), true);
});

test("a different current company ID does not confirm", () => {
  const v = confirmEmployment(ev({ current: [rec({ companyId: GREENHILL_ID, name: "Greenhill & Co" })] }), EVERCORE, NOW);
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "company_id_mismatch");
});

test("the firm appearing only in PAST employment does not confirm", () => {
  // The Vikram Jolly shape: Evercore is real on the profile, just not now.
  const v = confirmEmployment(
    ev({ current: [rec({ companyId: GREENHILL_ID, name: "Greenhill & Co" })], past: [rec()] }),
    EVERCORE,
    NOW,
  );
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "only_past_employment");
  assert.equal(v.matched?.companyId, 682795);
});

test("current and past roles at similarly named firms are told apart by ID, not name", () => {
  const v = confirmEmployment(
    ev({
      // Name says Evercore; the id is somebody else's.
      current: [rec({ companyId: 999, name: "Evercore Wealth Management" })],
      past: [rec()],
    }),
    EVERCORE,
    NOW,
  );
  assert.equal(v.status, "unconfirmed");
});

test("a mapped equivalent company ID confirms, and an unmapped one does not", () => {
  const mapped: SelectedFirmIdentity = { crustdataCompanyId: 682795, equivalentCompanyIds: [424242] };
  const withMapping = confirmEmployment(ev({ current: [rec({ companyId: 424242 })] }), mapped, NOW);
  assert.equal(withMapping.status, "current");
  assert.equal(withMapping.basis, "equivalent_company_id");

  const withoutMapping = confirmEmployment(ev({ current: [rec({ companyId: 424242 })] }), EVERCORE, NOW);
  assert.equal(withoutMapping.status, "unconfirmed");
});

test("a missing company ID never confirms, however right the name looks", () => {
  const v = confirmEmployment(
    ev({ current: [rec({ companyId: null, name: "Evercore", domains: ["evercore.com"] })] }),
    EVERCORE,
    NOW,
  );
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "no_company_id_on_record");
});

test("missing employment dates neither confirm nor deny on their own", () => {
  // No dates at all, but the id matches: current.
  const v = confirmEmployment(ev({ current: [rec({ startDate: null, endDate: null })] }), EVERCORE, NOW);
  assert.equal(v.status, "current");
});

test("a future start date is incoming, not current", () => {
  const v = confirmEmployment(
    ev({ current: [rec({ title: "Incoming 2027 Summer Analyst", startDate: "2027-06-01" })] }),
    EVERCORE,
    NOW,
  );
  assert.equal(v.status, "incoming");
  assert.equal(v.basis, "future_start_company_id");
  assert.equal(isCurrentEmployee(v), false);
});

test("an incoming employee is admitted only when explicitly asked for", () => {
  const v = confirmEmployment(ev({ current: [rec({ startDate: "2027-06-01" })] }), EVERCORE, NOW);
  assert.equal(isAdmissibleContact(v, { includeIncoming: false }), false);
  assert.equal(isAdmissibleContact(v, { includeIncoming: true }), true);
  // And never silently promoted.
  assert.notEqual(v.status, "current");
});

test("overlapping and multiple current employers confirm on the matching one", () => {
  const v = confirmEmployment(
    ev({ current: [rec({ companyId: GREENHILL_ID, name: "Greenhill & Co" }), rec()] }),
    EVERCORE,
    NOW,
  );
  assert.equal(v.status, "current");
  assert.equal(v.matched?.companyId, 682795);
});

test("multiple current employers, none of them the selected firm", () => {
  const v = confirmEmployment(
    ev({ current: [rec({ companyId: 1, name: "A" }), rec({ companyId: 2, name: "B" })] }),
    EVERCORE,
    NOW,
  );
  assert.equal(v.status, "unconfirmed");
});

test("a headline that says Evercore cannot override a mismatched ID", () => {
  const v = confirmEmployment(
    ev({
      current: [rec({ companyId: GREENHILL_ID, name: "Greenhill & Co" })],
      headline: "Investment Banking Associate at Evercore",
    }),
    EVERCORE,
    NOW,
  );
  assert.equal(v.status, "unconfirmed");
});

test("an @evercore.com address cannot override a mismatched ID", () => {
  // The domain is deliberately not an input to this function at all. Asserting
  // it via the record's own domains, which are equally not evidence.
  const v = confirmEmployment(
    ev({ current: [rec({ companyId: GREENHILL_ID, name: "Greenhill", domains: ["evercore.com"] })] }),
    EVERCORE,
    NOW,
  );
  assert.equal(v.status, "unconfirmed");
});

test("no employment records at all fails closed", () => {
  const v = confirmEmployment(ev(), EVERCORE, NOW);
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "no_employment_records");
});

test("a firm with no company ID of its own can confirm nothing", () => {
  const v = confirmEmployment(ev({ current: [rec()] }), { crustdataCompanyId: null }, NOW);
  assert.equal(v.status, "unconfirmed");
  assert.equal(v.basis, "no_selected_firm_id");
});

test("the response shape we cannot yet confirm degrades to unconfirmed, not to true", () => {
  // If the provider's person payload turns out NOT to carry company_id, every
  // record arrives with companyId null and every contact is rejected. That is
  // the intended failure: zero contacts, not five wrong ones.
  const noIds = ev({
    current: [rec({ companyId: null }), rec({ companyId: null, name: "Evercore Inc" })],
  });
  assert.equal(confirmEmployment(noIds, EVERCORE, NOW).status, "unconfirmed");
});
