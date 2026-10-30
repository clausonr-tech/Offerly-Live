// Which URLs are a Recruitee board.
//
// Written because the private equity sweep found three, one of them BC
// Partners' - carrying "French Intern | July 2026". Without a connector that
// board registers against the generic one, which launches Chromium every
// check to scrape a page whose JSON is one request away.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecruiteeAccount } from "../../src/lib/monitoring/connectors/recruitee";
import { dedupKey } from "../../src/lib/monitoring/board-identity";

test("an account subdomain is the board", () => {
  assert.equal(parseRecruiteeAccount("https://bcpartners.recruitee.com"), "bcpartners");
  assert.equal(parseRecruiteeAccount("https://bcpartners.recruitee.com/o/french-intern"), "bcpartners");
});

test("a lookalike domain is refused", () => {
  // "evilrecruitee.com".endsWith("recruitee.com") is true.
  assert.equal(parseRecruiteeAccount("https://evilrecruitee.com/api/offers/"), null);
  assert.equal(parseRecruiteeAccount("https://recruitee.com.attacker.net/"), null);
});

test("the bare vendor domain names no account", () => {
  assert.equal(parseRecruiteeAccount("https://recruitee.com"), null);
  assert.equal(parseRecruiteeAccount("https://www.recruitee.com"), null);
});

test("one board under two URLs is one board", () => {
  assert.equal(
    dedupKey("https://bcpartners.recruitee.com", "recruitee"),
    dedupKey("https://bcpartners.recruitee.com/", "recruitee"),
  );
});
