import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  PATTERN_MIN_SAMPLES,
  applyPattern,
  detectPattern,
  recordObservation,
  winnerOf,
  type PatternTally,
} from "@/lib/email-patterns";
import {
  canSeedPattern,
  hasCompleteUnambiguousName,
  resolveContactEmail,
  type FirmEmailDomains,
  type ProviderEmailStatus,
} from "@/lib/contact-email-gate";

const EVERCORE: FirmEmailDomains = { primaryDomain: "evercore.com", approvedAliases: [] };

// ------------------------------------------------------------ shape detection

test("the common address shapes are each detected from a name plus address", () => {
  const cases: [string, string, string][] = [
    ["John Teeter", "john.teeter@evercore.com", "first.last"],
    ["John Teeter", "johnteeter@evercore.com", "firstlast"],
    ["John Teeter", "jteeter@evercore.com", "flast"],
    ["John Teeter", "johnt@evercore.com", "firstl"],
    ["John Teeter", "teeter.john@evercore.com", "last.first"],
    ["John Teeter", "john@evercore.com", "first"],
  ];
  for (const [name, email, shape] of cases) {
    const seen = detectPattern(name, email);
    assert.equal(seen?.shape, shape, `${name} -> ${email}`);
  }
});

test("a shape round-trips: detect then apply returns the original address", () => {
  const names = ["John Teeter", "Katarina Kochansky", "Adeel Chaudhry"];
  for (const name of names) {
    for (const shape of ["first.last", "firstlast", "flast", "firstl", "last.first", "first"] as const) {
      const built = applyPattern(name, shape, "evercore.com");
      if (!built) continue;
      const seen = detectPattern(name, built);
      assert.equal(seen?.shape, shape, `${name} / ${shape} -> ${built}`);
    }
  }
});

// -------------------------------------------------------------- name handling

test("names with punctuation and accents produce sane addresses", () => {
  // Hyphens and apostrophes are STRIPPED, not preserved, and accents are
  // folded. Confirmed against real data rather than assumed: the directory
  // holds jeanbenoit.robillard@barclays.com as an address the provider itself
  // returned for "Jean-Benoît Robillard", so this is how at least one real
  // firm spells it. A firm that keeps the hyphen would need its own shape.
  const cases: [string, string][] = [
    ["Mary-Jane Watson", "maryjane.watson@evercore.com"],
    ["Jean-Benoît Robillard", "jeanbenoit.robillard@evercore.com"],
    ["Seán O'Brien", "sean.obrien@evercore.com"],
    ["José Álvarez", "jose.alvarez@evercore.com"],
    ["Renée Dubois", "renee.dubois@evercore.com"],
  ];
  for (const [name, expected] of cases) {
    const built = applyPattern(name, "first.last", "evercore.com");
    assert.equal(built, expected, name);
    // Nothing that would bounce at a mail server.
    assert.match(built!, /^[a-z0-9.@-]+$/, `${name} -> ${built}`);
  }
});

test("a suffix is not mistaken for the surname", () => {
  for (const name of ["John Teeter Jr.", "John Teeter III", "John Teeter Sr."]) {
    const built = applyPattern(name, "first.last", "evercore.com");
    assert.equal(built, "john.teeter@evercore.com", name);
  }
});

test("a middle name or initial is skipped, not concatenated", () => {
  assert.equal(applyPattern("John Robert Teeter", "first.last", "evercore.com"), "john.teeter@evercore.com");
  assert.equal(applyPattern("John R. Teeter", "first.last", "evercore.com"), "john.teeter@evercore.com");
  assert.equal(applyPattern("John R Teeter", "first.last", "evercore.com"), "john.teeter@evercore.com");
});

test("an incomplete or ambiguous name yields no address at all", () => {
  for (const name of ["Joshua O.", "Maryam Q.", "Cher", "", "   ", "J. T.", "X"]) {
    assert.equal(hasCompleteUnambiguousName(name), false, JSON.stringify(name));
  }
  for (const name of ["John Teeter", "Mary-Jane Watson", "Seán O'Brien", "José Álvarez"]) {
    assert.equal(hasCompleteUnambiguousName(name), true, name);
  }
});

test("a non-Latin name is refused rather than transliterated into a guess", () => {
  // Building `.@evercore.com` from a name we cannot romanise would be a
  // fabricated address that looks derived.
  const built = applyPattern("李 雷", "first.last", "evercore.com");
  assert.ok(built === null || /^[a-z0-9.@-]+$/.test(built), `got ${built}`);
  if (built) assert.ok(!built.startsWith("."), "must not produce an empty local part");
  assert.ok(!String(built).includes(".@"), "must not produce an empty component");
});

test("extra whitespace and mixed capitalisation normalise identically", () => {
  const canonical = applyPattern("John Teeter", "first.last", "evercore.com");
  for (const variant of ["  john   TEETER ", "JOHN TEETER", "john teeter"]) {
    assert.equal(applyPattern(variant, "first.last", "evercore.com"), canonical, variant);
  }
});

// ------------------------------------------------------------ evidence rules

test("one sample cannot establish a pattern; two compatible ones can", () => {
  assert.equal(PATTERN_MIN_SAMPLES, 2);
  let tally: PatternTally = {};
  tally = recordObservation(tally, "first.last", "evercore.com");
  assert.ok((winnerOf(tally)?.samples ?? 0) < PATTERN_MIN_SAMPLES);
  tally = recordObservation(tally, "first.last", "evercore.com");
  assert.equal(winnerOf(tally)?.samples, 2);
});

test("conflicting samples do not establish a pattern between them", () => {
  let tally: PatternTally = {};
  tally = recordObservation(tally, "first.last", "evercore.com");
  tally = recordObservation(tally, "flast", "evercore.com");
  // Neither shape has reached two, so nothing is confirmed.
  assert.ok((winnerOf(tally)?.samples ?? 0) < PATTERN_MIN_SAMPLES);
});

test("samples on different domains are counted separately, never merged", () => {
  let tally: PatternTally = {};
  tally = recordObservation(tally, "first.last", "evercore.com");
  tally = recordObservation(tally, "first.last", "barclays.com");
  assert.ok((winnerOf(tally)?.samples ?? 0) < PATTERN_MIN_SAMPLES, "one each is not two of either");
});

test("only a deliverable, on-domain, provider-sourced address may seed", () => {
  const base = {
    email: "a.b@evercore.com",
    firm: EVERCORE,
    employmentConfirmed: true,
    source: "crustdata" as const,
  };
  assert.equal(canSeedPattern({ ...base, providerStatus: "deliverable" }), true);
  for (const status of ["catch_all", "unknown", "invalid", null] as ProviderEmailStatus[]) {
    assert.equal(canSeedPattern({ ...base, providerStatus: status }), false, String(status));
  }
  assert.equal(canSeedPattern({ ...base, providerStatus: "deliverable", email: "a@greenhill.com" }), false);
  assert.equal(canSeedPattern({ ...base, providerStatus: "deliverable", email: "a@gmail.com" }), false);
  assert.equal(canSeedPattern({ ...base, providerStatus: "deliverable", email: "a@wharton.upenn.edu" }), false);
  assert.equal(canSeedPattern({ ...base, providerStatus: "deliverable", employmentConfirmed: false }), false);
  assert.equal(canSeedPattern({ ...base, providerStatus: "deliverable", source: "pattern_inference" }), false);
  assert.equal(canSeedPattern({ ...base, providerStatus: "deliverable", source: null }), false);
});

test("a predicted address can never feed back in as evidence", () => {
  const predicted = resolveContactEmail({
    name: "Vikram Jolly",
    enrichedEmail: null,
    providerStatus: null,
    firm: EVERCORE,
    employmentConfirmed: true,
    pattern: { shape: "first.last", domain: "evercore.com", sampleCount: 2 },
  });
  assert.equal(predicted.emailConfidence, "predicted");
  assert.equal(
    canSeedPattern({
      email: predicted.email,
      providerStatus: "deliverable",
      firm: EVERCORE,
      employmentConfirmed: true,
      source: predicted.emailSource,
    }),
    false,
  );
});

test("two employees with the same name produce the same address, which is honest", () => {
  // Not a bug to fix here - it is a fact about the firm's scheme, and the
  // PREDICTED label is what tells the student it was derived rather than looked up.
  const a = applyPattern("John Teeter", "first.last", "evercore.com");
  const b = applyPattern("John Teeter", "first.last", "evercore.com");
  assert.equal(a, b);
});
