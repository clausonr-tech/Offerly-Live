import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPattern,
  detectPattern,
  learnPattern,
  nameParts,
} from "@/lib/email-patterns";

test("the shape is read off a real name and a real address", () => {
  // Every corporate address observed at Goldman and UBS took this form.
  assert.deepEqual(detectPattern("Uma Bhati", "uma.bhati@gs.com"), {
    shape: "first.last",
    domain: "gs.com",
  });
  assert.deepEqual(detectPattern("Jack Mathews", "jack.mathews@ubs.com"), {
    shape: "first.last",
    domain: "ubs.com",
  });
});

test("the learned domain is the one people actually use", () => {
  // Goldman's firm domain is goldmansachs.com; its people are at gs.com, and
  // only gs.com answers a verifier. Learning the domain matters as much as
  // learning the shape.
  assert.equal(detectPattern("Ashka Patel", "ashka.patel@gs.com")?.domain, "gs.com");
});

test("other shapes are recognised, not forced into the common one", () => {
  assert.equal(detectPattern("Jane Doe", "jdoe@acme.com")?.shape, "flast");
  assert.equal(detectPattern("Jane Doe", "j.doe@acme.com")?.shape, "f.last");
  assert.equal(detectPattern("Jane Doe", "janedoe@acme.com")?.shape, "firstlast");
  assert.equal(detectPattern("Jane Doe", "doe.jane@acme.com")?.shape, "last.first");
});

test("an address that fits no shape teaches us nothing", () => {
  // Better to learn nothing than to learn the wrong thing and apply it to
  // everyone else at the firm.
  assert.equal(detectPattern("Jane Doe", "sales@acme.com"), null);
  assert.equal(detectPattern("Jane Doe", "not-an-email"), null);
});

test("middle names, suffixes and accents do not reach the address", () => {
  assert.deepEqual(nameParts("María José García Jr."), { first: "maria", last: "garcia" });
  assert.equal(applyPattern("María José García", "first.last", "gs.com"), "maria.garcia@gs.com");
  assert.deepEqual(nameParts("Kelly McNamara Corley"), { first: "kelly", last: "corley" });
});

test("a single name cannot produce an address", () => {
  assert.equal(nameParts("Cher"), null);
  assert.equal(applyPattern("Cher", "first.last", "gs.com"), null);
});

test("one paid address fills in everybody else at the firm", () => {
  // This is the whole economic argument: buy one, derive the rest.
  const pattern = learnPattern([{ name: "Uma Bhati", email: "uma.bhati@gs.com" }]);
  assert.deepEqual(pattern, { shape: "first.last", domain: "gs.com", samples: 1 });

  assert.equal(
    applyPattern("Thirza Li", pattern!.shape, pattern!.domain),
    "thirza.li@gs.com",
  );
  assert.equal(
    applyPattern("Lauren Abbattista", pattern!.shape, pattern!.domain),
    "lauren.abbattista@gs.com",
  );
});

test("the majority wins when a firm runs two shapes, and the count says how sure we are", () => {
  const pattern = learnPattern([
    { name: "Uma Bhati", email: "uma.bhati@gs.com" },
    { name: "Alpha Wang", email: "alpha.wang@gs.com" },
    { name: "Junhee Choi", email: "junhee.choi@gs.com" },
    // An address kept from an acquisition, on the old shape.
    { name: "Old Timer", email: "otimer@gs.com" },
  ]);
  assert.equal(pattern?.shape, "first.last");
  assert.equal(pattern?.samples, 3);
});

test("nothing observed means no pattern, not an inferred one", () => {
  assert.equal(learnPattern([]), null);
  assert.equal(learnPattern([{ name: "Jane Doe", email: "info@acme.com" }]), null);
});

import {
  isPatternConfirmed,
  recordObservation,
  winnerOf,
  PATTERN_CONFIRMED_SAMPLES,
  type PatternTally,
} from "@/lib/email-patterns";

function observe(times: number, shape: Parameters<typeof recordObservation>[1], domain: string, from: PatternTally = {}) {
  let t = from;
  for (let i = 0; i < times; i++) t = recordObservation(t, shape, domain);
  return t;
}

test("a firm stops costing anything once enough records agree", () => {
  const nearly = observe(PATTERN_CONFIRMED_SAMPLES - 1, "first.last", "gs.com");
  assert.equal(isPatternConfirmed(nearly), false, "one short must keep sampling");

  const settled = observe(1, "first.last", "gs.com", nearly);
  assert.equal(isPatternConfirmed(settled), true);
  assert.equal(winnerOf(settled)?.domain, "gs.com");
});

test("a single record is never enough, however clean it looks", () => {
  // This is the Goldman failure: one record, learned from the domain whose
  // mail server never confirms, and no way to be outvoted.
  assert.equal(isPatternConfirmed(observe(1, "first.last", "goldmansachs.com")), false);
});

test("later evidence can outvote an unrepresentative first record", () => {
  let t = observe(1, "flast", "goldmansachs.com");
  assert.equal(winnerOf(t)?.domain, "goldmansachs.com");

  t = observe(4, "first.last", "gs.com", t);
  assert.equal(winnerOf(t)?.shape, "first.last");
  assert.equal(winnerOf(t)?.domain, "gs.com");
});

test("a firm running two formats keeps being sampled rather than settling", () => {
  // Ten agreeing, but only 10 of 18 - no clear majority, so keep looking.
  let t = observe(10, "first.last", "gs.com");
  t = observe(8, "flast", "gs.com", t);
  assert.equal(winnerOf(t)?.samples, 10);
  assert.equal(isPatternConfirmed(t), false, "a split firm is not settled");
});

test("nothing observed is not a confirmed pattern", () => {
  assert.equal(isPatternConfirmed({}), false);
  assert.equal(winnerOf({}), null);
});
