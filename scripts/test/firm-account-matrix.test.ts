// The firm-account rules, case by case: which addresses can belong to a firm,
// which firm an address belongs to, and what each kind of account may do to
// each kind of row. No database, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  canManageFirmRow,
  canManageTeammate,
  checkWorkEmail,
  codeIsUsable,
  emailRegistrableDomain,
  FIRM_CODE_MAX_ATTEMPTS,
  firmMailDomains,
  firmsForDomain,
  isActiveFirmAccount,
  isFirmOwner,
  type FirmAccount,
} from "../../src/lib/firm-account";

describe("addresses that can never be a firm's", () => {
  const refused: [string, "invalid" | "personal" | "school"][] = [
    ["someone@gmail.com", "personal"],
    ["someone@googlemail.com", "personal"],
    ["someone@outlook.com", "personal"],
    ["someone@hotmail.com", "personal"],
    ["someone@yahoo.com", "personal"],
    ["someone@icloud.com", "personal"],
    ["someone@proton.me", "personal"],
    ["someone@aol.com", "personal"],
    ["student@upenn.edu", "school"],
    ["student@wharton.upenn.edu", "school"],
    ["student@ox.ac.uk", "school"],
    ["student@unimelb.edu.au", "school"],
    ["student@nus.edu.sg", "school"],
    ["no-at-sign", "invalid"],
    ["@evercore.com", "invalid"],
    ["name@", "invalid"],
    ["name@localhost", "invalid"],
    ["", "invalid"],
  ];
  for (const [email, reason] of refused) {
    test(`${email || "(empty)"} is refused as ${reason}`, () => {
      assert.deepEqual(checkWorkEmail(email), { ok: false, reason });
    });
  }
});

describe("work addresses, reduced to the domain that identifies the firm", () => {
  const accepted: [string, string][] = [
    ["analyst@evercore.com", "evercore.com"],
    ["ANALYST@EVERCORE.COM", "evercore.com"],
    ["  analyst@evercore.com  ", "evercore.com"],
    ["a@mail.gs.com", "gs.com"],
    ["a@ny.email.jpmorgan.com", "jpmorgan.com"],
    ["a@barclays.co.uk", "barclays.co.uk"],
    ["a@home.barclays", "home.barclays"],
    ["first.last+tag@lazard.com", "lazard.com"],
  ];
  for (const [email, domain] of accepted) {
    test(`${email.trim()} -> ${domain}`, () => {
      assert.deepEqual(checkWorkEmail(email), { ok: true, domain });
    });
  }
  // One parse decides both the firm and where the code is mailed, so an
  // address no two parsers could read the same way is refused outright rather
  // than interpreted. A quoted local part is legal RFC 5321 and exists here
  // only as a second '@'; the rest are shapes whose text after the last '@'
  // used to be cut at '/', '?', '#' or ':port' - naming one firm while the
  // mail went somewhere else entirely.
  const ambiguous = [
    '"a@b"@evercore.com',
    "name@evercore.com#.attacker.example",
    "name@evercore.com/x",
    "name@evercore.com?x",
    "name@evercore.com:25",
    "name@attacker.example, other@evercore.com",
    "name@evercore.com other@evercore.com",
    "name@@evercore.com",
    "name@[10.0.0.1]",
  ];
  for (const email of ambiguous) {
    test(`${email} is not a single address`, () => {
      assert.equal(emailRegistrableDomain(email), null);
      assert.deepEqual(checkWorkEmail(email), { ok: false, reason: "invalid" });
    });
  }
});

describe("which firm an address belongs to", () => {
  const firm = (id: string, over: Partial<Parameters<typeof firmMailDomains>[0]> = {}) => ({
    id,
    name: id,
    website: null as string | null,
    verifiedDomain: null as string | null,
    approvedEmailDomains: [] as string[],
    ...over,
  });
  const firms = [
    firm("evercore", { website: "https://www.evercore.com/" }),
    firm("gs", { website: "goldmansachs.com", approvedEmailDomains: ["gs.com"] }),
    firm("barclays", { website: "https://www.barclays.com", verifiedDomain: "home.barclays" }),
    firm("keybank", { website: "key.com" }),
    firm("cain", { website: "key.com" }),
    firm("li", { website: "https://www.linkedin.com/company/li" }),
    firm("careers", { website: "https://careers.somefirm.com" }),
    firm("ats", { website: "https://boards.greenhouse.io/somefirm" }),
  ];
  const cases: [string, string[]][] = [
    ["evercore.com", ["evercore"]],
    ["gs.com", ["gs"]],
    ["goldmansachs.com", ["gs"]],
    ["home.barclays", ["barclays"]],
    ["barclays.com", ["barclays"]],
    ["key.com", ["keybank", "cain"]],
    ["linkedin.com", []],
    ["somefirm.com", []],
    ["greenhouse.io", []],
    ["unknown.com", []],
  ];
  for (const [domain, ids] of cases) {
    test(`${domain} -> ${ids.length ? ids.join(", ") : "no firm"}`, () => {
      assert.deepEqual(firmsForDomain(domain, firms).map((f) => f.id), ids);
    });
  }
});

describe("who may change what", () => {
  const acct = (over: Partial<FirmAccount> = {}): FirmAccount => ({
    id: "me",
    accountType: "firm",
    orgApproved: true,
    orgFirmId: "f1",
    firmRole: "member",
    ...over,
  });
  const people: [string, FirmAccount, boolean, boolean][] = [
    // [label, account, may change f1's rows, is owner]
    ["approved member", acct(), true, false],
    ["approved owner", acct({ firmRole: "owner" }), true, true],
    ["unapproved owner-to-be", acct({ firmRole: "owner", orgApproved: false }), false, false],
    ["unapproved member", acct({ orgApproved: false }), false, false],
    ["unlinked firm account", acct({ orgFirmId: null, firmRole: null }), false, false],
    ["removed teammate", acct({ orgFirmId: null, orgApproved: false, firmRole: null }), false, false],
    ["student", acct({ accountType: "student", orgFirmId: null, firmRole: null }), false, false],
    ["club lead", acct({ accountType: "club_lead", orgFirmId: null }), false, false],
    ["student with a stray firm id", acct({ accountType: "student" }), false, false],
    ["other firm's owner", acct({ orgFirmId: "f2", firmRole: "owner" }), false, true],
  ];
  for (const [label, who, may, owner] of people) {
    test(`${label}: ${may ? "may" : "may not"} change firm f1's rows`, () => {
      assert.equal(canManageFirmRow(who, "f1"), may);
      assert.equal(canManageFirmRow(who, null), false);
      assert.equal(canManageFirmRow(who, undefined), false);
    });
    test(`${label}: ${owner ? "is" : "is not"} an owner`, () => {
      assert.equal(isFirmOwner(who), owner);
    });
  }

  const owner = acct({ id: "o", firmRole: "owner" });
  const teammates: [string, FirmAccount, boolean][] = [
    ["a pending colleague", acct({ id: "p", orgApproved: false }), true],
    ["an approved colleague", acct({ id: "m" }), true],
    ["themselves", owner, false],
    ["another firm's person", acct({ id: "x", orgFirmId: "f2" }), false],
    ["a student", acct({ id: "s", accountType: "student" }), false],
  ];
  for (const [label, who, may] of teammates) {
    test(`an owner ${may ? "may" : "may not"} approve or remove ${label}`, () => {
      assert.equal(canManageTeammate(owner, who), may);
    });
  }
  test("an unapproved owner-to-be manages nobody", () => {
    assert.equal(canManageTeammate(acct({ id: "o", firmRole: "owner", orgApproved: false }), acct({ id: "p", orgApproved: false })), false);
  });
});

describe("codes", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const row = (over = {}) => ({ expiresAt: new Date(now.getTime() + 60_000), attempts: 0, consumedAt: null as Date | null, ...over });
  for (let attempts = 0; attempts <= FIRM_CODE_MAX_ATTEMPTS; attempts++) {
    test(`after ${attempts} wrong guesses the code is ${attempts < FIRM_CODE_MAX_ATTEMPTS ? "still" : "no longer"} usable`, () => {
      assert.equal(codeIsUsable(row({ attempts }), now), attempts < FIRM_CODE_MAX_ATTEMPTS);
    });
  }
  test("expiry is exclusive: at the expiry instant it is dead", () => {
    assert.equal(codeIsUsable(row({ expiresAt: now }), now), false);
    assert.equal(codeIsUsable(row({ expiresAt: new Date(now.getTime() + 1) }), now), true);
  });
});
