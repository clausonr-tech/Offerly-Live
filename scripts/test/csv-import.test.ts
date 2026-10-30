// parseCsvText is the block both import forms used to carry inline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvText, normalizeDate, mapContactRow } from "../../src/lib/csv-import";

const idRow = (r: Record<string, string>) => r;

test("maps every row and reports none skipped", () => {
  const out = parseCsvText("name,email\nAda,ada@x.com\nGrace,grace@x.com", idRow);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.rows.length, 2);
  assert.equal(out.skipped, 0);
  assert.equal(out.rows[0].name, "Ada");
});

test("rows the mapper rejects are counted, not dropped silently", () => {
  const out = parseCsvText("name\nAda\nSKIP\nGrace", (r) => (r.name === "SKIP" ? null : r));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.rows.length, 2);
  assert.equal(out.skipped, 1);
});

test("a file with no header row is an error, not an empty success", () => {
  // The distinction matters: empty-success renders "0 contacts found" and
  // looks like the student's file was fine but blank.
  const out = parseCsvText("", idRow);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.error, /header row/i);
});

test("blank lines do not become rows", () => {
  const out = parseCsvText("name,email\nAda,ada@x.com\n\n\n", idRow);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.rows.length, 1);
});

test("the contact mapper still works through it", () => {
  const out = parseCsvText("Name,Email\nAda Lovelace,ada@x.com", (r, h) => mapContactRow(r, h));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.rows.length, 1);
});

test("normalizeDate drops what it cannot parse rather than inventing a date", () => {
  // Returns "" rather than the original text: an unparseable value must not
  // reach the database as a date, and the empty string is how the import form
  // shows the student the cell was not understood.
  assert.equal(normalizeDate(""), "");
  assert.equal(normalizeDate("not a date"), "");
  assert.equal(normalizeDate("2026-11-15"), "2026-11-15");
  assert.equal(normalizeDate("11/15/2026"), "2026-11-15");
});
