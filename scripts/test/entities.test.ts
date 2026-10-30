// HTML entities, decoded once for every connector.
//
// Four connectors carried a private copy of this and the rest carried none -
// including the generic connector, which is 97.3% of all sources and reads
// titles straight out of scraped HTML. BlackRock's "Quantitative
// Master&rsquo;s Internship Program" reached the published postings table
// exactly like that, where a student sees the raw markup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities } from "../../src/lib/monitoring/entities";

const CASES: [string, string][] = [
  ["Quantitative Master&rsquo;s Internship Program", "Quantitative Master’s Internship Program"],
  ["Quantitative Master&#8217;s Internship Program", "Quantitative Master’s Internship Program"],
  ["Quantitative Master&#x2019;s Internship Program", "Quantitative Master’s Internship Program"],
  ["Sales &amp; Trading Summer Analyst", "Sales & Trading Summer Analyst"],
  ["Mergers &amp; Acquisitions", "Mergers & Acquisitions"],
  ["Off&ndash;Cycle Internship", "Off–Cycle Internship"],
  ["Analyst &mdash; New York", "Analyst — New York"],
  ["Intern&nbsp;Programme", "Intern Programme"],
  ["&ldquo;Spring Week&rdquo;", "“Spring Week”"],
  ["Risk &amp; Compliance Intern&hellip;", "Risk & Compliance Intern…"],
];

for (const [raw, want] of CASES) {
  test(`decodes: ${raw.slice(0, 44)}`, () => {
    assert.equal(decodeEntities(raw), want);
  });
}

test("text with no entities is returned untouched", () => {
  for (const t of ["2027 Investment Banking Summer Analyst", "", "   ", "Plain title"]) {
    assert.equal(decodeEntities(t), t);
  }
});

test("a bare ampersand is not mangled", () => {
  // Job titles are full of "M&A" and "Sales & Trading" written literally.
  assert.equal(decodeEntities("M&A Summer Analyst"), "M&A Summer Analyst");
  assert.equal(decodeEntities("Sales & Trading"), "Sales & Trading");
});

test("an unknown entity is left as it was found", () => {
  // Better a visible oddity than a silently deleted character.
  assert.equal(decodeEntities("Analyst &notanentity; Intern"), "Analyst &notanentity; Intern");
});

test("double-encoded entities decode", () => {
  assert.equal(decodeEntities("Sales &amp;amp; Trading"), "Sales & Trading");
});

test("a malformed numeric entity never throws or corrupts", () => {
  for (const t of ["&#;", "&#x;", "&#999999999;", "&#xFFFFFFFF;", "&#55296;"]) {
    assert.doesNotThrow(() => decodeEntities(t), t);
  }
});

test("decodeEntities never throws on degenerate input", () => {
  for (const t of ["&", "&&&", "&#", "&x;", "&".repeat(500)]) {
    assert.doesNotThrow(() => decodeEntities(t), t);
  }
});
