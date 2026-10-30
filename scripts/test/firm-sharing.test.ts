// Sharing with firms is opt-in, current-policy-only, and limited to the fields
// students were told about. These are the privacy rules behind Student
// matching; see lib/firm-sharing.ts and the privacy policy's firm section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasOptedInToFirmSharing, isSharingWithFirms, SHARED_PROFILE_FIELDS } from "../../src/lib/firm-sharing";
import { POLICY_VERSION } from "../../src/lib/policy";
import { EMPTY_CRITERIA, matchStudent, parseCriteria, type MatchableStudent } from "../../src/lib/firm-matching-rules";

const sharing = {
  accountType: "student",
  firmSharingOptedInAt: new Date("2026-09-23"),
  firmSharingPolicyVersion: POLICY_VERSION,
  consentedPolicyVersion: POLICY_VERSION,
  isDemo: false,
};

test("only a student who opted in under the current policy is shared", () => {
  assert.equal(isSharingWithFirms(sharing), true);
  assert.equal(isSharingWithFirms({ ...sharing, firmSharingOptedInAt: null }), false, "never opted in");
  assert.equal(isSharingWithFirms({ ...sharing, firmSharingPolicyVersion: "2026-09-12" }), false, "opted in under an old policy");
  assert.equal(isSharingWithFirms({ ...sharing, consentedPolicyVersion: "2026-09-12" }), false, "terms not re-agreed");
  assert.equal(isSharingWithFirms({ ...sharing, accountType: "firm" }), false, "not a student");
  assert.equal(isSharingWithFirms({ ...sharing, accountType: "club_lead" }), false, "not a student");
  assert.equal(isSharingWithFirms({ ...sharing, isDemo: true }), false, "demo account");
});

test("a firm can never read GPA, sponsorship, phone or anything private", () => {
  for (const field of [
    "gpaBand",
    "sponsorshipNeeded",
    "phone",
    "hometown",
    "resumeText",
    "passwordHash",
    "aboutMe",
    "motivations",
    "proudExperience",
    "workStyle",
    "challengeLearned",
    "schoolEmail",
  ]) {
    assert.equal(SHARED_PROFILE_FIELDS.includes(field), false, `${field} must not be shared`);
  }
});

const base: MatchableStudent = {
  gradYear: 2028,
  schoolId: "11111111-1111-1111-1111-111111111111",
  major: "Economics",
  degreeLevel: "Bachelor's",
  preferredCategories: ["investment_banking", "private_equity"],
  targetLocations: ["New York City"],
  shortlistedFirm: false,
};

test("empty requirements accept every sharing student", () => {
  assert.equal(matchStudent(base, EMPTY_CRITERIA).passes, true);
  assert.equal(matchStudent({ ...base, gradYear: null, major: null, preferredCategories: null }, EMPTY_CRITERIA).passes, true);
});

test("every requirement a firm sets is a hard filter", () => {
  const c = { ...EMPTY_CRITERIA };
  assert.equal(matchStudent(base, { ...c, gradYears: [2027] }).passes, false);
  assert.equal(matchStudent(base, { ...c, gradYears: [2028] }).passes, true);
  assert.equal(matchStudent(base, { ...c, schoolIds: ["22222222-2222-2222-2222-222222222222"] }).passes, false);
  assert.equal(matchStudent(base, { ...c, categories: ["hedge_fund"] }).passes, false);
  assert.equal(matchStudent(base, { ...c, categories: ["private_equity"] }).passes, true);
  assert.equal(matchStudent(base, { ...c, locations: ["Chicago"] }).passes, false);
  assert.equal(matchStudent(base, { ...c, majors: ["economics"] }).passes, true, "case-insensitive");
  assert.equal(matchStudent(base, { ...c, degreeLevels: ["PhD"] }).passes, false);
  assert.equal(matchStudent({ ...base, gradYear: null }, { ...c, gradYears: [2028] }).passes, false, "unknown year fails a set year");
});

test("a student who shortlisted the firm ranks first, and says why", () => {
  const plain = matchStudent(base, EMPTY_CRITERIA);
  const fan = matchStudent({ ...base, shortlistedFirm: true }, EMPTY_CRITERIA);
  assert.ok(fan.score > plain.score);
  assert.equal(fan.reasons[0], "Has your firm on their shortlist");
});

test("more overlap with the firm's sectors ranks higher", () => {
  const c = { ...EMPTY_CRITERIA, categories: ["investment_banking", "private_equity"] };
  const both = matchStudent(base, c);
  const one = matchStudent({ ...base, preferredCategories: ["investment_banking"] }, c);
  assert.ok(both.score > one.score);
});

test("posted requirements are cleaned to known shapes", () => {
  const c = parseCriteria({
    gradYears: ["2028", "2028", "abc", "1800"],
    schoolIds: ["11111111-1111-1111-1111-111111111111", "'; drop table users; --"],
    majors: [" Economics ", ""],
    categories: ["investment_banking", "Not A Category!"],
    locations: ["New York City"],
    degreeLevels: ["Bachelor's"],
  });
  assert.deepEqual(c.gradYears, [2028]);
  assert.deepEqual(c.schoolIds, ["11111111-1111-1111-1111-111111111111"]);
  assert.deepEqual(c.majors, ["Economics"]);
  assert.deepEqual(c.categories, ["investment_banking"]);
});

test("a student's own screens show their answer, demo or not", () => {
  const demoStudent = { ...sharing, isDemo: true };
  assert.equal(isSharingWithFirms(demoStudent), false, "firms never see a demo student");
  assert.equal(hasOptedInToFirmSharing(demoStudent), true, "but a demo student who said yes sees On");
  assert.equal(hasOptedInToFirmSharing({ ...sharing, firmSharingPolicyVersion: "2026-09-12" }), false, "an old-policy yes is not current");
  assert.equal(hasOptedInToFirmSharing({ ...sharing, firmSharingOptedInAt: null }), false);
});
