// Which firm type the Firms directory opens on.
//
// The directory shows one firm type at a time from a dropdown, starting on the
// one the student recruits for. These pin down how the URL and the student's
// saved preferences combine, since a wrong answer either hides the student's
// own sector or silently drops a type someone linked to. Pure, no database.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_FIRM_TYPES,
  firmFiltersToQuery,
  parseFirmFilters,
  resolveFirmType,
} from "../../src/app/(app)/discovery/firmFilterParams";

test("no ?sectors: opens on the student's first recruiting type", () => {
  assert.equal(resolveFirmType(undefined, ["private_equity", "hedge_fund"]), "private_equity");
});

test("no ?sectors and no usable preference: every firm type", () => {
  assert.equal(resolveFirmType(undefined, null), ALL_FIRM_TYPES);
  assert.equal(resolveFirmType(undefined, []), ALL_FIRM_TYPES);
  assert.equal(resolveFirmType(undefined, ["not_a_sector"]), ALL_FIRM_TYPES);
});

test("a preference that is not a firm category is skipped, not trusted", () => {
  assert.equal(resolveFirmType(undefined, ["undecided", "real_estate"]), "real_estate");
});

test("?sectors=<type> wins over the preference", () => {
  assert.equal(resolveFirmType("venture_capital", ["private_equity"]), "venture_capital");
});

test("?sectors=all is a deliberate choice of every type, even with a preference", () => {
  assert.equal(resolveFirmType("all", ["private_equity"]), ALL_FIRM_TYPES);
});

test("an unknown ?sectors falls back to the preference rather than to nothing", () => {
  assert.equal(resolveFirmType("banana", ["private_equity"]), "private_equity");
});

test("an older multi-type link keeps its first real type", () => {
  assert.equal(resolveFirmType("banana,hedge_fund,real_estate", null), "hedge_fund");
  assert.equal(resolveFirmType(["real_estate", "hedge_fund"], null), "real_estate");
});

test("the choice round-trips through the URL, including 'all'", () => {
  for (const type of ["investment_banking", ALL_FIRM_TYPES]) {
    const query = firmFiltersToQuery({ ...parseFirmFilters({}), categories: [type] }, 100);
    const back = Object.fromEntries(new URLSearchParams(query));
    assert.equal(resolveFirmType(back.sectors, ["private_equity"]), type);
  }
});

test("'shown' is only recorded once the student pages past the first 100", () => {
  const base = parseFirmFilters({});
  assert.ok(!firmFiltersToQuery({ ...base, shown: 100 }, 100).includes("shown"));
  assert.ok(firmFiltersToQuery({ ...base, shown: 150 }, 100).includes("shown=150"));
});
