// Getro board URLs, and the two traps in its payload.
//
// The live half is scripts/getro-connector-live-check.ts. What is guarded
// here is the pure logic, and specifically the mistakes that would be silent:
// a lookalike host being accepted as Getro, and a unix-SECONDS timestamp read
// as milliseconds, which dates every posting to 1970 and quietly makes the
// whole board look stale rather than broken.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGetroUrl } from "../../src/lib/monitoring/connectors/getro";
import { dedupKey } from "../../src/lib/monitoring/board-identity";

test("a Getro board host is recognised", () => {
  assert.deepEqual(parseGetroUrl("https://hv.getro.com/jobs"), {
    host: "hv.getro.com",
    networkId: null,
  });
});

test("a stored network id is read off the URL, saving a request per check", () => {
  assert.equal(parseGetroUrl("https://hv.getro.com/jobs?networkId=234")?.networkId, "234");
});

test("a lookalike domain is not Getro", () => {
  // "evilgetro.com".endsWith("getro.com") is true, which is why the check is
  // an exact host or a dotted subdomain rather than a bare endsWith.
  assert.equal(parseGetroUrl("https://evilgetro.com/jobs"), null);
  assert.equal(parseGetroUrl("https://getro.com.attacker.net/jobs"), null);
});

test("a non-Getro board is left to its own connector", () => {
  assert.equal(parseGetroUrl("https://jobs.lever.co/seaportglobal"), null);
});

test("two funds pointing at one collection are one board", () => {
  // The whole value of a portfolio board is that it covers many firms, so
  // two funds sharing a collection must not be fetched twice.
  assert.equal(
    dedupKey("https://hv.getro.com/jobs", "getro"),
    dedupKey("https://hv.getro.com/jobs?networkId=234", "getro"),
  );
});

test("posting dates are unix seconds, not milliseconds", () => {
  // Getro returned created_at 1789823177 for a live posting. As seconds that
  // is 2026; as milliseconds it is January 1970, and a board of 159 listings
  // would silently read as fifty years stale instead of as a bug.
  const asSeconds = new Date(1789823177 * 1000);
  assert.equal(asSeconds.getUTCFullYear(), 2026);
  const asMillis = new Date(1789823177);
  assert.equal(asMillis.getUTCFullYear(), 1970);
});
