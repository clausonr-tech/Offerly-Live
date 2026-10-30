// Which URLs are a Breezy board.
//
// The one that matters is the lookalike: "evilbreezy.hr".endsWith("breezy.hr")
// is true, so a bare endsWith would accept an attacker-controlled domain as
// this vendor and fetch it as if it were a job board.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBreezyAccount } from "../../src/lib/monitoring/connectors/breezy";
import { dedupKey } from "../../src/lib/monitoring/board-identity";

test("an account subdomain is the board", () => {
  assert.equal(parseBreezyAccount("https://acmecapital.breezy.hr"), "acmecapital");
  assert.equal(parseBreezyAccount("https://acmecapital.breezy.hr/p/some-job"), "acmecapital");
});

test("a lookalike domain is refused", () => {
  assert.equal(parseBreezyAccount("https://evilbreezy.hr/json"), null);
  assert.equal(parseBreezyAccount("https://breezy.hr.attacker.net/json"), null);
});

test("the bare vendor domain names no account", () => {
  assert.equal(parseBreezyAccount("https://breezy.hr"), null);
  assert.equal(parseBreezyAccount("https://www.breezy.hr"), null);
});

test("a non-Breezy board is left alone", () => {
  assert.equal(parseBreezyAccount("https://jobs.lever.co/seaportglobal"), null);
});

test("one board under two URLs is one board", () => {
  assert.equal(
    dedupKey("https://acmecapital.breezy.hr", "breezy"),
    dedupKey("https://acmecapital.breezy.hr/", "breezy"),
  );
});
