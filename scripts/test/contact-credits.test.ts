import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTACTS_PER_RUN,
  MONTHLY_CONTACT_CREDITS,
  isInternalAccount,
  isUnlimitedAccount,
  isUnmeteredEnvironment,
} from "@/lib/contact-credits";

test("only local development skips the allowance, never a production build", () => {
  assert.equal(isUnmeteredEnvironment({ NODE_ENV: "development" }), true);
  assert.equal(isUnmeteredEnvironment({ NODE_ENV: "production" }), false);
  assert.equal(isUnmeteredEnvironment({ NODE_ENV: "test" }), false);
  assert.equal(isUnmeteredEnvironment({}), false);
  assert.equal(isUnmeteredEnvironment({ NODE_ENV: "development", VERCEL: "1" }), false, "never on Vercel");
});

test("the owner accounts never consume contact credits", () => {
  assert.equal(isUnlimitedAccount("matuseno@usc.edu"), true);
  assert.equal(isUnlimitedAccount("alex.rivera@example.com"), true);
});

test("unlimited is a search grant, not the internal debugging view", () => {
  assert.equal(isInternalAccount("alex.rivera@example.com"), false);
});

test("the shared demo student account is unlimited, by name", () => {
  // Restored at the owner's request once its password stopped shipping in the
  // public login page - see UNLIMITED_TEST_ACCOUNTS.
  assert.equal(isUnlimitedAccount("demo@offerly.test"), true);
  assert.equal(isUnlimitedAccount("  DEMO@Offerly.Test "), true);
});

test("no other reserved test-domain address can be unlimited", () => {
  for (const email of [
    "demo2@offerly.test",
    "club@offerly.test",
    "firm@offerly.test",
    "fresh@test.local",
    "someone@example",
    "x@host.localhost",
    "y@nowhere.invalid",
  ]) {
    assert.equal(isUnlimitedAccount(email), false, email);
  }
});

test("unlimited matching ignores casing and stray whitespace", () => {
  assert.equal(isUnlimitedAccount("  MatUsEno@USC.edu "), true);
});

test("everyone else is metered", () => {
  assert.equal(isUnlimitedAccount("someone@usc.edu"), false);
  assert.equal(isUnlimitedAccount("matuseno@usc.edu.attacker.com"), false);
  assert.equal(isUnlimitedAccount("matuseno@gmail.com"), false);
  assert.equal(isUnlimitedAccount(null), false);
  assert.equal(isUnlimitedAccount(undefined), false);
  assert.equal(isUnlimitedAccount(""), false);
});

test("a click buys five contacts", () => {
  assert.equal(CONTACTS_PER_RUN, 5);
});

test("the allowance ladder: free has none (paid feature), and each paid tier buys at least the one below", () => {
  // Free went to zero when billing launched: contact sourcing is part of Pro,
  // and the free tier is the Internal Network (lib/plan-access).
  assert.equal(MONTHLY_CONTACT_CREDITS.free, 0);
  assert.ok(MONTHLY_CONTACT_CREDITS.pro > 0);
  assert.ok(MONTHLY_CONTACT_CREDITS.pro_plus >= MONTHLY_CONTACT_CREDITS.pro);
});

test("the agent's workings are shown to us and to nobody else", () => {
  assert.equal(isInternalAccount("matuseno@usc.edu"), true);
  assert.equal(isInternalAccount("MATUSENO@USC.EDU "), true);
  assert.equal(isInternalAccount("student@berkeley.edu"), false);
  assert.equal(isInternalAccount("demo@offerly.test"), false);
  assert.equal(isInternalAccount(null), false);
});
