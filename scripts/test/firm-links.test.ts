// Where the Apply and RSVP links may send a student. No database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { applyDestination, eventDestination, httpUrl, isUuid } from "../../src/lib/firm-links";

describe("Apply", () => {
  const cases: [string | null, string | null, string | null][] = [
    ["https://careers.example.com/apply", null, "https://careers.example.com/apply"],
    ["http://example.com", null, "http://example.com/"],
    ["https://example.com/apply", "hr@example.com", "https://example.com/apply"],
    [null, "hr@example.com", "mailto:hr@example.com"],
    ["javascript:alert(1)", "hr@example.com", "mailto:hr@example.com"],
    ["javascript:alert(1)", null, null],
    ["data:text/html,<script>alert(1)</script>", null, null],
    ["//evil.example", null, null],
    ["/discovery", null, null],
    ["", "", null],
    [null, "not-an-email", null],
    [null, "a@b.c?subject=<script>", null],
    [null, 'x"@evil.com', null],
    [null, null, null],
  ];
  for (const [url, email, expected] of cases) {
    test(`link ${JSON.stringify(url)}, email ${JSON.stringify(email)} -> ${expected ?? "back to Discovery"}`, () => {
      assert.equal(applyDestination(url, email), expected);
    });
  }
});

describe("RSVP", () => {
  test("an http(s) RSVP link is used", () => {
    assert.equal(eventDestination("https://example.com/rsvp", "demo"), "https://example.com/rsvp");
  });
  for (const bad of [null, "", "javascript:alert(1)", "ftp://x.com", "/relative"]) {
    test(`an RSVP of ${JSON.stringify(bad)} falls back to the firm's page`, () => {
      assert.equal(eventDestination(bad, "demo-capital-partners"), "/discovery/firm/demo-capital-partners");
    });
  }
  test("the firm slug is encoded, so it cannot break out of the path", () => {
    assert.equal(eventDestination(null, "../../admin"), "/discovery/firm/..%2F..%2Fadmin");
  });
});

describe("ids", () => {
  for (const [id, ok] of [
    ["80e9a9a3-59dd-48e6-bf39-d1f5f39b6b29", true],
    ["80E9A9A3-59DD-48E6-BF39-D1F5F39B6B29", true],
    ["------------------------------------", false],
    ["80e9a9a3-59dd-48e6-bf39-d1f5f39b6b2", false],
    ["80e9a9a3-59dd-48e6-bf39-d1f5f39b6b29' or 1=1", false],
    ["", false],
  ] as [string, boolean][]) {
    test(`${JSON.stringify(id)} is ${ok ? "" : "not "}an id`, () => {
      assert.equal(isUuid(id), ok);
    });
  }
  test("httpUrl trims and normalises", () => {
    assert.equal(httpUrl("  https://example.com  "), "https://example.com/");
  });
});
