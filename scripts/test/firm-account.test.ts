// The firm-account rules: which addresses can belong to a firm, which firm,
// and who may change what. No database, no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canManageFirmRow,
  canManageTeammate,
  checkWorkEmail,
  codeIsUsable,
  FIRM_CODE_MAX_ATTEMPTS,
  FIRM_SESSION_DAYS,
  firmMailDomains,
  firmsForDomain,
  isActiveFirmAccount,
  isFirmOwner,
  roleForNewAccount,
} from "../../src/lib/firm-account";

test("personal and school addresses can never be a firm's", () => {
  assert.deepEqual(checkWorkEmail("someone@gmail.com"), { ok: false, reason: "personal" });
  assert.deepEqual(checkWorkEmail("someone@outlook.com"), { ok: false, reason: "personal" });
  assert.deepEqual(checkWorkEmail("student@wharton.upenn.edu"), { ok: false, reason: "school" });
  assert.deepEqual(checkWorkEmail("not-an-email"), { ok: false, reason: "invalid" });
  assert.deepEqual(checkWorkEmail("Analyst@Evercore.com "), { ok: true, domain: "evercore.com" });
  assert.deepEqual(checkWorkEmail("a@mail.gs.com"), { ok: true, domain: "gs.com" });
});

test("a firm's mail domains are its verified domain, its aliases, and a usable website - never a social or careers site", () => {
  const base = { id: "1", name: "X", verifiedDomain: null, approvedEmailDomains: [] as string[] };
  assert.deepEqual(firmMailDomains({ ...base, website: "https://www.evercore.com" }), ["evercore.com"]);
  assert.deepEqual(firmMailDomains({ ...base, website: "https://uk.linkedin.com/company/x" }), []);
  assert.deepEqual(firmMailDomains({ ...base, website: "careers.db.com" }), []);
  assert.deepEqual(
    firmMailDomains({ ...base, website: "barclays.com", verifiedDomain: "home.barclays", approvedEmailDomains: ["barclays.com"] }).sort(),
    ["barclays.com", "home.barclays"],
  );
});

test("an address matches every firm that owns its domain, and no firm that merely resembles it", () => {
  const firms = [
    { id: "a", name: "KeyBank", website: "key.com", verifiedDomain: null, approvedEmailDomains: [] },
    { id: "b", name: "Cain Brothers", website: "key.com", verifiedDomain: null, approvedEmailDomains: [] },
    { id: "c", name: "Evercore", website: "evercore.com", verifiedDomain: null, approvedEmailDomains: [] },
  ];
  // Two firms share key.com: no single answer, so Offerly links it by hand.
  assert.equal(firmsForDomain("key.com", firms).length, 2);
  assert.deepEqual(firmsForDomain("evercore.com", firms).map((f) => f.id), ["c"]);
  assert.deepEqual(firmsForDomain("notevercore.com", firms), []);
});

const firmUser = (over: Partial<Parameters<typeof isActiveFirmAccount>[0]> = {}) => ({
  id: "u1",
  accountType: "firm",
  orgApproved: true,
  orgFirmId: "f1",
  firmRole: "member",
  ...over,
});

test("only an approved firm account linked to a firm may post, and only to its own firm's rows", () => {
  assert.equal(isActiveFirmAccount(firmUser()), true);
  assert.equal(isActiveFirmAccount(firmUser({ orgApproved: false })), false);
  assert.equal(isActiveFirmAccount(firmUser({ orgFirmId: null })), false);
  assert.equal(isActiveFirmAccount(firmUser({ accountType: "student" })), false);
  assert.equal(canManageFirmRow(firmUser(), "f1"), true);
  assert.equal(canManageFirmRow(firmUser(), "f2"), false, "another firm's row");
  assert.equal(canManageFirmRow(firmUser({ orgApproved: false }), "f1"), false, "unapproved");
  assert.equal(canManageFirmRow(firmUser(), null), false);
});

test("an owner manages teammates at their own firm, never themselves or another firm's people", () => {
  const owner = firmUser({ id: "o", firmRole: "owner" });
  assert.equal(isFirmOwner(owner), true);
  assert.equal(isFirmOwner(firmUser()), false);
  assert.equal(canManageTeammate(owner, firmUser({ id: "m", orgApproved: false })), true);
  assert.equal(canManageTeammate(owner, owner), false);
  assert.equal(canManageTeammate(owner, firmUser({ id: "x", orgFirmId: "f2" })), false);
  assert.equal(canManageTeammate(firmUser({ id: "m2" }), firmUser({ id: "m3" })), false, "a member cannot");
  assert.equal(canManageTeammate(owner, { ...firmUser({ id: "s" }), accountType: "student" }), false);
});

test("the first account at a firm is its owner; later ones are members", () => {
  assert.equal(roleForNewAccount(false), "owner");
  assert.equal(roleForNewAccount(true), "member");
});

test("a code is usable once, before it expires, and for a limited number of guesses", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const later = new Date(now.getTime() + 60_000);
  assert.equal(codeIsUsable({ expiresAt: later, attempts: 0, consumedAt: null }, now), true);
  assert.equal(codeIsUsable({ expiresAt: now, attempts: 0, consumedAt: null }, now), false, "expired");
  assert.equal(codeIsUsable({ expiresAt: later, attempts: FIRM_CODE_MAX_ATTEMPTS, consumedAt: null }, now), false);
  assert.equal(codeIsUsable({ expiresAt: later, attempts: 0, consumedAt: now }, now), false, "already used");
});

test("firm sessions are shorter than a student's 30 days", () => {
  assert.ok(FIRM_SESSION_DAYS < 30);
});
