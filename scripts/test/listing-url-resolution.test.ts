/**
 * A stored listing_url must be an address a student can open.
 *
 * Measured 12 October 2026: 3,492 stored listings carried a relative or
 * unopenable `listing_url`. 3,488 came from `eightfold`, which passed the
 * API's `positionUrl` path straight through; the other four were
 * `javascript:void(0)` anchors the generic connector's DOM scan picked up.
 *
 * The publish gate in posting-quality.ts had already grown an absolute-URL
 * check to stop them reaching a student as dead links - which withheld the
 * real listings along with the broken addresses. These assert the fix at the
 * source, so the gate stops being the only thing standing between a student
 * and a dead link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { resolvedPublicHttpUrl } from "@/lib/safe-url";

const BOARD = "https://citi.eightfold.ai/careers?domain=citi.com";

test("a path resolves against the board it was found on", () => {
  assert.equal(
    resolvedPublicHttpUrl("/careers/job/859023561218", BOARD),
    "https://citi.eightfold.ai/careers/job/859023561218",
    "the exact shape of all 3,488",
  );
  assert.equal(
    resolvedPublicHttpUrl("job/42", "https://boards.example.com/careers/"),
    "https://boards.example.com/careers/job/42",
  );
});

test("an address that is already absolute is left alone", () => {
  assert.equal(
    resolvedPublicHttpUrl("https://careers.example.com/job/7", BOARD),
    "https://careers.example.com/job/7",
    "a different host is still a real address - resolution must not rewrite it",
  );
});

test("what is not an address comes back null, not a string that looks populated", () => {
  for (const junk of [
    "javascript:void(0)",
    "javascript:;",
    "mailto:careers@example.com",
    "data:text/html,<p>hi</p>",
    "   ",
    "",
    null,
    undefined,
  ]) {
    assert.equal(
      resolvedPublicHttpUrl(junk, BOARD),
      null,
      `accepted ${JSON.stringify(junk)} as a listing address`,
    );
  }
});

test("the rules publicHttpUrl already enforces still apply after resolving", () => {
  // Resolution must not become a way around the checks for a URL a student
  // may be sent to - credentials, non-web ports, bare IPs, private suffixes.
  assert.equal(resolvedPublicHttpUrl("http://user:pw@example.com/j", BOARD), null);
  assert.equal(resolvedPublicHttpUrl("http://example.com:22/j", BOARD), null);
  assert.equal(resolvedPublicHttpUrl("http://127.0.0.1/j", BOARD), null);
  assert.equal(resolvedPublicHttpUrl("http://board.localhost/j", BOARD), null);
});

test("no base is not an excuse to accept a path", () => {
  // A connector that forgets to pass the board URL must fail closed, not
  // store the path it was given.
  assert.equal(resolvedPublicHttpUrl("/careers/job/1", null), null);
});

/**
 * Asserted against the source because there is nothing to assert against at
 * runtime: handing a path straight through compiles and runs, and the damage
 * only shows up as a dead link weeks later. The same shape as the script that
 * forgot DATABASE_URL and read a dead database for three weeks.
 */
test("the two connectors that got this wrong route through the resolver", () => {
  const root = process.cwd();
  const eightfold = fs.readFileSync(
    path.join(root, "src/lib/monitoring/connectors/eightfold.ts"),
    "utf8",
  );
  assert.match(
    eightfold,
    /resolvedPublicHttpUrl\(\s*p\.positionUrl\s*,\s*ref\.origin\s*\)/,
    "eightfold passes positionUrl through unresolved again",
  );

  const generic = fs.readFileSync(
    path.join(root, "src/lib/monitoring/connectors/generic.ts"),
    "utf8",
  );
  assert.match(
    generic,
    /resolvedPublicHttpUrl\(\s*c\.href\s*,\s*baseUrl\s*\)/,
    "the generic DOM scan stores hrefs without checking them again",
  );
  assert.doesNotMatch(
    generic,
    /listingUrl:\s*c\.href/,
    "the raw href is back in the listing",
  );
});

test("a relative address cannot leave the board's own host", () => {
  /**
   * `//evil.example/apply` is protocol-relative: resolving it against an https
   * base yields `https://evil.example/apply`, which passes every rule
   * `publicHttpUrl` applies - it is a perfectly well-formed public URL, just
   * not this firm's. `/\evil.example/apply` does the same thing, and that
   * exact trick is documented 170 lines above in `inAppPath`'s own comment as
   * a 10 October 2026 security-review finding.
   *
   * The harm is at the publish boundary, not the fetch one: a crawled
   * `positionUrl` like this used to be WITHHELD (`hasPublishableUrls` ran
   * `publicHttpUrl` on the raw relative string, `new URL` threw, null), and
   * resolving it first turns it into a working external "Apply" link shown to
   * a student under the firm's name.
   *
   * An input that is already absolute may legitimately name another host - an
   * ATS on its own domain - so the rule is about RELATIVE inputs only.
   */
  for (const escape of [
    "//evil.example/apply",
    "/\\evil.example/apply",
    "//evil.example:8080/x",
    "\\\\evil.example/apply",
  ]) {
    assert.equal(
      resolvedPublicHttpUrl(escape, BOARD),
      null,
      `a relative input escaped to another host: ${escape}`,
    );
  }
  // An absolute address on another host is still fine: ATSes live elsewhere.
  assert.equal(
    resolvedPublicHttpUrl("https://boards.greenhouse.io/firm/jobs/1", BOARD),
    "https://boards.greenhouse.io/firm/jobs/1",
  );
  // And a genuine same-host path still resolves.
  assert.equal(
    resolvedPublicHttpUrl("/careers/job/1", BOARD),
    "https://citi.eightfold.ai/careers/job/1",
  );
});

test("a fragment is not an address", () => {
  // `#` resolved to the board index plus a hash - a URL that passes every
  // check and takes a student to the page they were already on.
  for (const frag of ["#", "#apply", "  #  "]) {
    assert.equal(resolvedPublicHttpUrl(frag, BOARD), null, `accepted ${JSON.stringify(frag)}`);
  }
});
