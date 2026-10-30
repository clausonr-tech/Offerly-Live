// Making a stored posting readable.
//
// Descriptions crawled before the connector kept its structure arrive as one
// unbroken line - the Leerink PhD posting is 3,092 characters with zero
// newlines and zero bullets. The firm's own list markup is gone and cannot be
// recovered, so these pin what CAN be done with the punctuation that remains,
// and what must not be done to prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPosting } from "../../src/lib/posting-format";

const fmt = (description: string, firmName = "Acme Partners") =>
  formatPosting({ description, requirements: null, firmName });

test("a heading inside a clause does not cut the text there", () => {
  // The reported bug: a panel whose body opened "of full-time equity research
  // professionals", because the bare word matched mid-sentence.
  const out = fmt(
    "The intern joins a team of full-time equity research professionals and supports their responsibilities across the summer.",
  );
  for (const s of out.sections) {
    for (const b of s.blocks) {
      if (b.type === "paragraph") assert.ok(!/^of /.test(b.text), `body starts mid-clause: ${b.text.slice(0, 40)}`);
    }
  }
});

test("a colon-form heading is honoured even with no punctuation before it", () => {
  // "Location: New York Salary Range: $135,000" - the fields run together,
  // which is exactly how the stored text looks.
  const out = fmt("Location: New York Salary Range: $135,000 per year. The program runs ten weeks.");
  const comp = out.sections.find((s) => s.heading === "Compensation");
  assert.ok(comp, "Compensation section should be found");
  assert.match(comp.blocks.map((b) => (b.type === "paragraph" ? b.text : "")).join(" "), /135,000/);
});

test("a duties section becomes bullets", () => {
  const out = fmt(
    "Responsibilities: Assist in the preparation of client presentations. Prepare valuation and financial model analyses. Review business plans and analyze financial statements. Perform due diligence processes.",
  );
  const duties = out.sections.find((s) => s.heading === "Responsibilities");
  assert.ok(duties, "Responsibilities section should be found");
  const list = duties.blocks.find((b) => b.type === "list");
  assert.ok(list && list.type === "list", "duties should render as a list");
  assert.ok(list.items.length >= 3, `expected several bullets, got ${list.items.length}`);
});

test("prose is never turned into bullets", () => {
  // A company description broken into a list reads as nonsense. It is grouped
  // into paragraphs so the eye has somewhere to rest, and nothing more.
  const out = fmt(
    "About the firm: Acme Partners is a leading investment bank. The firm advises on mergers and acquisitions. It is a broker-dealer registered with the SEC. It employs two thousand people. It was founded in 1985. It has offices worldwide.",
  );
  const about = out.sections.find((s) => s.heading === "About the firm");
  assert.ok(about, "About the firm section should be found");
  assert.ok(!about.blocks.some((b) => b.type === "list"), "prose must not be bulleted");
  assert.ok(about.blocks.length >= 2, "long prose should be split into paragraphs");
});

test("the same heading never opens twice", () => {
  const out = fmt("About the firm: Acme is a bank. It does about the firm things. About us: more text here.");
  const headings = out.sections.map((s) => s.heading).filter(Boolean);
  assert.equal(new Set(headings).size, headings.length, `repeated heading: ${headings.join(", ")}`);
});
