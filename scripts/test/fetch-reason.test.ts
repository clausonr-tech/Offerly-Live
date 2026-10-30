// Naming the failure, so 43% of the crawl stops being one undifferentiated
// string. See src/lib/monitoring/fetch-reason.ts for what that cost.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFetchError,
  FETCH_FAILURE_REASONS,
  shouldEscalateToRender,
  type FetchFailureReason,
} from "../../src/lib/monitoring/fetch-reason";
import { inconclusiveMessage } from "../../src/lib/monitoring/http-outcome";
import { DeadlineExpired } from "../../src/lib/monitoring/deadline";

/** As safe-fetch.ts throws them - the real message shapes, not invented ones. */
function blocked(message: string): Error {
  const err = new Error(`Refused to fetch: ${message}`);
  err.name = "BlockedAddressError";
  return err;
}
function withCode(name: string, code: string, message = "fetch failed"): Error {
  const err = Object.assign(new TypeError(message), { cause: { code } });
  err.name = name;
  return err;
}

const CASES: [unknown, FetchFailureReason, string][] = [
  // The deadline is checked first: its abort surfaces as whatever the aborted
  // operation threw, so it is indistinguishable from a timeout afterwards.
  [new DeadlineExpired(180_000), "deadline_exceeded", "our own budget, not the board"],

  // safe-fetch.ts's refusals, by its actual message shapes.
  [blocked("capitaltoday.com did not resolve"), "dns_unresolved", "the real message observed in production"],
  [blocked("example.com resolved to nothing"), "dns_unresolved", ""],
  [blocked("example.com has no IPv4 address"), "dns_unresolved", ""],
  [blocked("127.0.0.1 is a reserved address"), "ssrf_blocked", ""],
  [blocked("example.com resolves to 10.0.0.1, a reserved address"), "ssrf_blocked", ""],
  [blocked("not a valid URL (mailto:jobs@x.com)"), "invalid_url", ""],
  [blocked("scheme ftp: is not http(s)"), "invalid_url", ""],
  [blocked("port 22 is not a web port"), "invalid_url", ""],
  [blocked("more than 5 redirects"), "redirect_limit", ""],

  // Puppeteer.
  [new Error("Failed to launch the browser process! spawn ENOENT"), "browser_launch_failed", ""],
  [new Error("Protocol error (Page.navigate): Target closed"), "page_closed", ""],
  [new Error("Evaluation failed: ReferenceError: x is not defined"), "evaluate_failed", ""],
  [
    Object.assign(new Error("Navigation timeout of 20000 ms exceeded"), { name: "TimeoutError" }),
    "nav_timeout",
    "a page that never settled, not a dead host",
  ],

  // Transport.
  [withCode("TypeError", "CERT_HAS_EXPIRED"), "tls_error", ""],
  [withCode("TypeError", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"), "tls_error", "incomplete chain"],
  [withCode("TypeError", "DEPTH_ZERO_SELF_SIGNED_CERT"), "tls_error", ""],
  [withCode("TypeError", "ECONNREFUSED"), "connect_refused", ""],
  [withCode("TypeError", "EHOSTUNREACH"), "connect_refused", ""],
  [withCode("TypeError", "ECONNRESET"), "connect_reset", ""],
  [withCode("AbortError", "", "This operation was aborted"), "static_timeout", ""],
  [withCode("TypeError", "ENOTFOUND"), "dns_unresolved", ""],
];

for (const [err, expected, note] of CASES) {
  const label = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 54) : String(err);
  test(`${label} -> ${expected}${note ? ` (${note})` : ""}`, () => {
    assert.equal(classifyFetchError(err), expected);
  });
}

test("the vocabulary is closed - nothing invents a new reason", () => {
  // The stored value is grouped by in SQL. A free-form string would make the
  // bucket as unreadable as the single message it replaces.
  const odd: unknown[] = [
    undefined, null, 0, "", "a string", {}, [], new Error(""),
    { name: 123, message: {} }, Symbol("x"), () => {},
  ];
  for (const err of odd) {
    const reason = classifyFetchError(err);
    assert.ok(
      (FETCH_FAILURE_REASONS as readonly string[]).includes(reason),
      `${String(err)} produced "${reason}", which is not in the vocabulary`,
    );
  }
});

test("an unrecognised error is unclassified, not a plausible neighbour", () => {
  // If the catch-all grows that is a fact worth seeing. Hiding it inside
  // connect_refused would make the instrumentation lie.
  assert.equal(classifyFetchError(new Error("something nobody predicted")), "unclassified");
});

test("no hostname, IP or message text can reach the stored string", () => {
  // Messages here carry hostnames and resolved addresses; a message from a
  // third-party page is untrusted text.
  const reason = classifyFetchError(blocked("secret-internal.example.com resolves to 10.1.2.3, a reserved address"));
  const stored = inconclusiveMessage(0, reason);
  assert.equal(stored.includes("10.1.2.3"), false);
  assert.equal(stored.includes("secret-internal"), false);
  assert.equal(stored, "inconclusive: HTTP 0 (ssrf_blocked) - not an answer about this firm");
});

test("the message keeps the shape three weeks of rows and every audit match on", () => {
  assert.equal(
    inconclusiveMessage(0, null),
    "inconclusive: HTTP 0 - not an answer about this firm",
    "with no reason it must be byte-identical to the old message",
  );
  assert.match(inconclusiveMessage(429, "unclassified"), /^inconclusive: HTTP 429 /);
  assert.match(inconclusiveMessage(0, "dns_unresolved"), / - not an answer about this firm$/);
});

// --------------------------------------------------- escalating to a browser

test("a browser is not launched for what the network could not reach", () => {
  /**
   * The two costs compound: a host that hangs or does not exist pays the
   * static timeout, then a Chromium launch, then a navigation timeout. With
   * reasons recorded, that path averaged 41.9s and reached 53.5s, against a
   * 4.4s median for every other outcome.
   */
  for (const reason of ["dns_unresolved", "connect_refused", "invalid_url", "redirect_limit"] as const) {
    assert.equal(shouldEscalateToRender(reason), false, reason);
  }
});

test("a TLS failure DOES still get a browser", () => {
  // The obvious candidate for the never-render list, and wrong. Chromium does
  // AIA chasing to complete an incomplete certificate chain; Node's undici
  // does not. Demonstrated against incomplete-chain.badssl.com: Node reported
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE, Chromium returned HTTP 200. Refusing to
  // render these would permanently drop every firm whose server omits its
  // intermediate certificate.
  assert.equal(shouldEscalateToRender("tls_error"), true);
});

test("a stalled plain GET DOES still get a browser", () => {
  // A static fetch stalling is the canonical reason to try a real browser -
  // some defences stall a bare fetch and serve a browser normally. These are
  // the expensive case; the answer is the shorter static timeout, not giving
  // up on the page.
  assert.equal(shouldEscalateToRender("static_timeout"), true);
  assert.equal(shouldEscalateToRender("deadline_exceeded"), true);
  assert.equal(shouldEscalateToRender("connect_reset"), true);
});

test("an unnamed failure gets a browser, because not knowing is not knowing", () => {
  assert.equal(shouldEscalateToRender(null), true);
  assert.equal(shouldEscalateToRender(undefined), true);
  assert.equal(shouldEscalateToRender("unclassified"), true);
});

test("every reason in the vocabulary has a decision, and most say render", () => {
  // Guards against a new reason silently joining the refuse list by accident.
  const refused = FETCH_FAILURE_REASONS.filter((r) => !shouldEscalateToRender(r));
  assert.deepEqual(
    [...refused].sort(),
    ["connect_refused", "dns_unresolved", "invalid_url", "redirect_limit"],
    "the never-render set changed - each member must have been checked against a real browser",
  );
});
