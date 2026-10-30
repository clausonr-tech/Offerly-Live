// ONE reading of a typed email address, for the two questions that used to
// answer it differently: which firm does this address belong to, and who
// receives the code that proves the inbox.
//
// The audit's finding was a parser differential. The firm was taken from the
// text after the LAST '@' and run through a URL host normaliser, which cuts
// the host at the first '/', '?' or '#' and drops a ':port' - while the whole
// typed string went to the mail provider verbatim. So
// `someone@realfirm.com#.attacker.example` was judged to be AT realfirm.com
// and the code was addressed to a domain the attacker controls, and
// `me@personal.example, anyone@realfirm.com` was attributed by its last
// segment. Nothing here touches a database or the network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  checkWorkEmail,
  emailRegistrableDomain,
  parseMailbox,
} from "../../src/lib/firm-account";

describe("one address, parsed once", () => {
  // Every shape whose firm attribution and whose mail routing could disagree.
  const differential = [
    "name@realfirm.com#.attacker.example",
    "name@realfirm.com/anything",
    "name@realfirm.com?anything",
    "name@realfirm.com:2525",
    "http://name@realfirm.com",
    "name@personal.example, other@realfirm.com",
    "name@personal.example;other@realfirm.com",
    "name@personal.example other@realfirm.com",
    '"a@b"@realfirm.com',
    "name@@realfirm.com",
    "name@realfirm.com@attacker.example",
    "<name@realfirm.com>",
    "Name <name@realfirm.com>",
    "name@[10.0.0.1]",
    "name%other@realfirm.com",
    "attacker!other@realfirm.com",
    "name@realfirm.com\nbcc: other@attacker.example",
    "name@-realfirm.com",
    "name@realfirm-.com",
    "name@realfirm..com",
    ".name@realfirm.com",
    "name.@realfirm.com",
    "name@realfirm",
    "name@localhost",
    "@realfirm.com",
    "name@",
    "no-at-sign",
    "",
  ];
  for (const raw of differential) {
    test(`${JSON.stringify(raw)} is refused, not interpreted`, () => {
      assert.equal(parseMailbox(raw), null);
      assert.equal(emailRegistrableDomain(raw), null);
      // Refused as a work address too, so nothing is attributed to a firm and
      // no code is ever addressed to it.
      assert.deepEqual(checkWorkEmail(raw), { ok: false, reason: "invalid" });
    });
  }

  // The addresses real people type keep working, and come back canonical.
  const accepted: [string, string, string][] = [
    // [typed, canonical address, firm-identifying domain]
    ["analyst@evercore.com", "analyst@evercore.com", "evercore.com"],
    ["  ANALYST@Evercore.COM  ", "analyst@evercore.com", "evercore.com"],
    ["first.last+summer2027@lazard.com", "first.last+summer2027@lazard.com", "lazard.com"],
    ["o'brien@evercore.com", "o'brien@evercore.com", "evercore.com"],
    ["a_b-c@mail.gs.com", "a_b-c@mail.gs.com", "gs.com"],
    ["a@ny.email.jpmorgan.com", "a@ny.email.jpmorgan.com", "jpmorgan.com"],
    ["a@barclays.co.uk", "a@barclays.co.uk", "barclays.co.uk"],
    ["a@home.barclays", "a@home.barclays", "home.barclays"],
    // A trailing dot on the domain is a legal way to write the root; the
    // address is the same address.
    ["a@evercore.com.", "a@evercore.com", "evercore.com"],
    // An internationalised address at a real firm is a person we must not
    // lock out, so non-ASCII is carried through rather than refused.
    ["jose@müller-partners.de", "jose@müller-partners.de", "müller-partners.de"],
  ];
  for (const [raw, email, domain] of accepted) {
    test(`${raw.trim()} -> ${email} at ${domain}`, () => {
      const mailbox = parseMailbox(raw);
      assert.ok(mailbox, "a single address");
      assert.equal(mailbox.email, email);
      assert.equal(emailRegistrableDomain(raw), domain);
    });
  }

  test("the address that is mailed is the address that was attributed", () => {
    for (const [raw] of accepted) {
      const mailbox = parseMailbox(raw);
      assert.ok(mailbox);
      // Re-parsing what we would hand the mail provider gives the same
      // mailbox and the same firm domain: there is no second reading left for
      // the two to disagree about.
      assert.deepEqual(parseMailbox(mailbox.email), mailbox);
      assert.equal(emailRegistrableDomain(mailbox.email), emailRegistrableDomain(raw));
    }
  });

  test("personal and school addresses are still told apart by their own reasons", () => {
    assert.deepEqual(checkWorkEmail("someone@gmail.com"), { ok: false, reason: "personal" });
    assert.deepEqual(checkWorkEmail("student@wharton.upenn.edu"), { ok: false, reason: "school" });
    // And the delimiter shapes cannot be used to dress one up as the other.
    assert.deepEqual(checkWorkEmail("someone@gmail.com#.realfirm.com"), { ok: false, reason: "invalid" });
  });

  test("length is bounded on both sides of the '@'", () => {
    assert.ok(parseMailbox(`${"a".repeat(64)}@evercore.com`));
    assert.equal(parseMailbox(`${"a".repeat(65)}@evercore.com`), null);
    assert.equal(parseMailbox(`a@${"b".repeat(64)}.com`), null, "a label is at most 63");
    assert.equal(parseMailbox(`${"a".repeat(60)}@${`${"b".repeat(60)}.`.repeat(4)}com`), null, "254 in all");
  });
});
