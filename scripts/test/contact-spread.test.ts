import assert from "node:assert/strict";
import test from "node:test";

import { PREVIEW_SIZE, spreadAcrossFirms } from "@/lib/contact-spread";

const person = (id: string, firm: string | null, score: number) => ({
  id,
  firm,
  match: { score },
});

test("a firm cannot take two slots while another firm has none", () => {
  // The bug this exists to prevent: generating five contacts at one firm and
  // then seeing only that firm on the hub, because its five outscored every
  // single contact everywhere else.
  const rows = [
    person("gs1", "Goldman Sachs", 99),
    person("gs2", "Goldman Sachs", 98),
    person("gs3", "Goldman Sachs", 97),
    person("ms1", "Morgan Stanley", 40),
    person("jpm1", "JPMorgan", 30),
  ];

  const firms = spreadAcrossFirms(rows, 3).map((r) => r.firm);
  assert.deepEqual(firms, ["Goldman Sachs", "Morgan Stanley", "JPMorgan"]);
});

test("the strongest firms come first, and the strongest person within each", () => {
  const rows = [
    person("weak", "Citi", 10),
    person("strong", "Evercore", 90),
    person("evercore-2nd", "Evercore", 80),
  ];

  assert.deepEqual(
    spreadAcrossFirms(rows, 3).map((r) => r.id),
    ["strong", "weak", "evercore-2nd"],
  );
});

test("fewer firms than slots means a second person per firm, not a short list", () => {
  // A student working two firms should still see five contacts. Round-robin
  // that stopped after one pass would show them two.
  const rows = [
    person("a1", "Goldman Sachs", 90),
    person("a2", "Goldman Sachs", 80),
    person("a3", "Goldman Sachs", 70),
    person("b1", "JPMorgan", 85),
    person("b2", "JPMorgan", 75),
  ];

  assert.equal(spreadAcrossFirms(rows, 5).length, 5);
  assert.deepEqual(
    spreadAcrossFirms(rows, 4).map((r) => r.id),
    ["a1", "b1", "a2", "b2"],
  );
});

test("contacts with no firm share one bucket rather than one each", () => {
  // Otherwise every unattached person counts as their own firm, and a student
  // whose rows are mostly unattached gets a preview of nothing else.
  const rows = [
    person("n1", null, 95),
    person("n2", "", 94),
    person("n3", "   ", 93),
    person("gs", "Goldman Sachs", 50),
  ];

  assert.deepEqual(
    spreadAcrossFirms(rows, 3).map((r) => r.id),
    ["n1", "gs", "n2"],
  );
});

test("fewer contacts than slots returns what there is, without padding", () => {
  const rows = [person("only", "Goldman Sachs", 50)];
  assert.deepEqual(spreadAcrossFirms(rows, 5), rows);
  assert.deepEqual(spreadAcrossFirms([], 5), []);
});

test("asking for nothing terminates", () => {
  // The loop's exit is `out.length < size`; a non-positive size has to be
  // caught before it, or the `for` never runs its condition to completion on
  // an empty result set.
  assert.deepEqual(spreadAcrossFirms([person("a", "Citi", 1)], 0), []);
  assert.equal(PREVIEW_SIZE, 5);
});

test("the input is not reordered underneath the caller", () => {
  // The full sheet renders the same array, newest-first. Sorting in place
  // would silently re-order it by score.
  const rows = [
    person("a", "Citi", 10),
    person("b", "Citi", 90),
  ];
  spreadAcrossFirms(rows, 2);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a", "b"],
  );
});
