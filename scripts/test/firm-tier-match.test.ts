import assert from "node:assert/strict";
import test from "node:test";

import { satisfiesTierPreferences } from "@/lib/match-top-firms";

// goldman-sachs is Bulge Bracket in the seeds; houlihan-lokey is Middle-Market.
const gs = { slug: "goldman-sachs", programs: [{ category: "investment_banking" }] };
const hl = { slug: "houlihan-lokey", programs: [{ category: "investment_banking" }] };
const untiered = { slug: "some-regional-bank", programs: [{ category: "investment_banking" }] };

test("a stated bank tier keeps only banks of that tier", () => {
  assert.equal(satisfiesTierPreferences(gs, ["investment_banking"], ["Bulge Bracket"], []), true);
  assert.equal(satisfiesTierPreferences(hl, ["investment_banking"], ["Bulge Bracket"], []), false);
});

test("a firm with no recorded tier cannot satisfy a stated tier", () => {
  assert.equal(
    satisfiesTierPreferences(untiered, ["investment_banking"], ["Bulge Bracket"], []),
    false,
  );
});

test("no stated tier means the sector alone qualifies a firm", () => {
  assert.equal(satisfiesTierPreferences(untiered, ["investment_banking"], [], []), true);
  assert.equal(satisfiesTierPreferences(hl, ["investment_banking"], [], []), true);
});

test("a bank tier does not prune sectors that have no tier question", () => {
  const consultancy = { slug: "bain-company", programs: [{ category: "consulting" }] };
  assert.equal(
    satisfiesTierPreferences(consultancy, ["investment_banking", "consulting"], ["Bulge Bracket"], []),
    true,
  );
});

test("a firm serving several chosen sectors qualifies on whichever one passes", () => {
  const both = {
    slug: "some-regional-bank",
    programs: [{ category: "investment_banking" }, { category: "consulting" }],
  };
  // Fails the bank-tier test, but consulting carries no tier constraint.
  assert.equal(
    satisfiesTierPreferences(both, ["investment_banking", "consulting"], ["Bulge Bracket"], []),
    true,
  );
});

test("a firm serving none of the chosen sectors never qualifies", () => {
  assert.equal(satisfiesTierPreferences(gs, ["consulting"], [], []), false);
});

import { satisfiesCoveragePreferences } from "@/lib/match-top-firms";

test("a healthcare student keeps generalist banks that carry no coverage tag", () => {
  // Goldman has a healthcare group; it is simply not a healthcare-only bank.
  assert.equal(satisfiesCoveragePreferences({ slug: "goldman-sachs" }, ["Healthcare Coverage"]), true);
});

test("a healthcare student loses a specialist that covers something else", () => {
  assert.equal(
    satisfiesCoveragePreferences({ slug: "financial-technology-partners" }, ["Healthcare Coverage"]),
    false,
  );
});

test("a healthcare student keeps the healthcare specialists", () => {
  for (const slug of ["leerink-partners", "cain-brothers", "provident-healthcare-partners"]) {
    assert.equal(satisfiesCoveragePreferences({ slug }, ["Healthcare Coverage"]), true, slug);
  }
});

test("no stated coverage interest filters nothing out", () => {
  assert.equal(satisfiesCoveragePreferences({ slug: "financial-technology-partners" }, []), true);
  assert.equal(satisfiesCoveragePreferences({ slug: "leerink-partners" }, null), true);
});
