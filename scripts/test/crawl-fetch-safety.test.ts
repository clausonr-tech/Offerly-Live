// What the crawler is allowed to fetch, and what it reads once it has.
//
// This crawler takes URLs from places it does not control - a firm's careers
// page, a board's redirect, a sitemap, a discovery pass - and then fetches
// them from inside the network the database lives on. That is the shape of a
// server-side request forgery, and `assertPublicUrl` is what stands between a
// scraped href and an internal address.
//
// robots.txt is the other half: this crawler identifies itself honestly as
// OfferlyMonitor and obeys what it is told, which is the reason a 403 from a
// CDN gets a polite retry rather than a workaround.
//
// None of it is sector-specific, and all of it runs on every source in all
// fourteen industries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl } from "../../src/lib/monitoring/safe-fetch";
import { parseRobots, isPathAllowed, ROBOTS_AGENT } from "../../src/lib/monitoring/robots";
import { extractRequirements, splitRequirements } from "../../src/lib/monitoring/requirements";

// --------------------------------------------------- addresses never fetched

const BLOCKED_SCHEMES = [
  "file:///etc/passwd",
  "ftp://example.com/jobs",
  "gopher://example.com",
  "data:text/html,<h1>hi</h1>",
  "javascript:alert(1)",
  "about:blank",
];

for (const url of BLOCKED_SCHEMES) {
  test(`scheme refused: ${url.slice(0, 40)}`, async () => {
    await assert.rejects(() => assertPublicUrl(url), `${url} was allowed`);
  });
}

const MALFORMED = ["", "   ", "not a url", "://", "http://", "https://"];

for (const url of MALFORMED) {
  test(`malformed refused: ${JSON.stringify(url)}`, async () => {
    await assert.rejects(() => assertPublicUrl(url));
  });
}

// Loopback, link-local, and the cloud metadata address. A careers page that
// redirects here is the exact attack this exists to stop.
const PRIVATE_HOSTS = [
  "http://127.0.0.1/jobs",
  "http://localhost/jobs",
  "http://0.0.0.0/jobs",
  "http://10.0.0.5/jobs",
  "http://192.168.1.1/jobs",
  "http://172.16.0.1/jobs",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/jobs",
];

for (const url of PRIVATE_HOSTS) {
  test(`private address refused: ${url}`, async () => {
    await assert.rejects(() => assertPublicUrl(url), `${url} was allowed`);
  });
}

const ODD_PORTS = [
  "http://example.com:22/jobs",
  "http://example.com:6379/jobs",
  "http://example.com:5432/jobs",
  "http://example.com:3306/jobs",
];

for (const url of ODD_PORTS) {
  test(`non-web port refused: ${url}`, async () => {
    await assert.rejects(() => assertPublicUrl(url), `${url} was allowed`);
  });
}

test("ordinary public board URLs are allowed", async () => {
  for (const url of [
    "https://job-boards.greenhouse.io/acme",
    "https://jobs.lever.co/acme",
    "http://example.com/careers",
    "https://example.com:443/careers",
  ]) {
    await assert.doesNotReject(() => assertPublicUrl(url), url);
  }
});

// ------------------------------------------------------------ robots.txt

test("a bare Disallow: allows everything", () => {
  // Cascadia Capital's real robots.txt. An empty Disallow is the permissive
  // form, and reading it as "disallow everything" would silently stop a
  // source we are welcome to read.
  const rules = parseRobots("User-agent: *\nDisallow:\n");
  assert.equal(isPathAllowed(rules, "/careers/"), true);
  assert.equal(isPathAllowed(rules, "/anything/at/all"), true);
});

test("Disallow: / blocks everything", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /\n");
  assert.equal(isPathAllowed(rules, "/careers/"), false);
});

test("a named agent's rules beat the wildcard", () => {
  // Baird names ClaudeBot and anthropic-ai under Disallow: /, and this
  // crawler is neither - it is OfferlyMonitor.
  const rules = parseRobots(
    `User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: ${ROBOTS_AGENT}\nDisallow: /private/\n\nUser-agent: *\nDisallow: /\n`,
  );
  assert.equal(isPathAllowed(rules, "/careers/"), true, "our own group permits it");
  assert.equal(isPathAllowed(rules, "/private/x"), false);
});

test("Stephens' real robots.txt permits the careers page", () => {
  const rules = parseRobots(
    "User-agent: *\nDisallow: /cpresources/\nDisallow: /vendor/\nDisallow: /.env\nDisallow: /cache/\n",
  );
  assert.equal(isPathAllowed(rules, "/careers"), true);
  assert.equal(isPathAllowed(rules, "/vendor/thing"), false);
  assert.equal(isPathAllowed(rules, "/.env"), false);
});

test("the longest matching rule wins", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /careers/\nAllow: /careers/students/\n");
  assert.equal(isPathAllowed(rules, "/careers/other"), false);
  assert.equal(isPathAllowed(rules, "/careers/students/apply"), true);
});

test("comments and blank lines do not confuse the parser", () => {
  const rules = parseRobots("# a comment\n\nUser-agent: *   # trailing\nDisallow: /x/  # why\n");
  assert.equal(isPathAllowed(rules, "/x/y"), false);
  assert.equal(isPathAllowed(rules, "/y"), true);
});

test("an empty or unparseable robots.txt allows everything", () => {
  for (const text of ["", "   ", "nonsense without colons", "\n\n\n"]) {
    assert.equal(isPathAllowed(parseRobots(text), "/careers"), true, JSON.stringify(text));
  }
});

test("parseRobots never throws", () => {
  for (const t of ["", "User-agent:", "Disallow: /", "a".repeat(10000)]) {
    assert.doesNotThrow(() => parseRobots(t));
  }
});

// ------------------------------------------------------- requirements text

// Every one of these appears in the stored corpus. The last five were
// invisible to the extractor until 20 September 2026 - 67 postings whose
// requirements section could not be found, and therefore whose eligibility
// was read off the whole body instead of the section that states it.
const REQ_HEADINGS = [
  "Qualifications",
  "Requirements",
  "What we look for",
  "Who you are",
  "What you bring",
  "Desired qualifications",
  "The ideal candidate",
];

for (const heading of REQ_HEADINGS) {
  test(`requirements found under "${heading}"`, () => {
    const body =
      `About the role, which runs for ten weeks. ${heading}: Pursuing a bachelor's degree in ` +
      `finance or economics with a strong academic record. Applications close soon.`;
    const r = extractRequirements(body);
    assert.ok(r && r.length > 0, `nothing extracted under "${heading}"`);
    assert.ok(
      !new RegExp(`^${heading}\\s*:?`, "i").test(r ?? ""),
      "the heading itself must not be part of the text",
    );
  });
}

test("no heading means no requirements, never a guess at the whole body", () => {
  assert.equal(extractRequirements("A ten week placement working with the team."), null);
});

test("extractRequirements never throws", () => {
  for (const t of ["", "   ", "Qualifications:", "a".repeat(20000)]) {
    assert.doesNotThrow(() => extractRequirements(t), JSON.stringify(t.slice(0, 20)));
  }
});

test("bullets split into separate requirements", () => {
  const parts = splitRequirements(
    "• Pursuing a bachelor's degree in a relevant field • Strong analytical and quantitative skills • Excellent written communication ability",
  );
  assert.ok(parts.length >= 3, JSON.stringify(parts));
});

test("fragments too short to be requirements are dropped", () => {
  const parts = splitRequirements("• Yes • No • Pursuing a bachelor's degree in a relevant field");
  assert.ok(!parts.includes("Yes"), JSON.stringify(parts));
  assert.ok(!parts.includes("No"), JSON.stringify(parts));
});

test("splitRequirements is capped and never returns a runaway list", () => {
  const many = Array.from(
    { length: 200 },
    (_, i) => `• Requirement number ${i} with enough length to count as one`,
  ).join(" ");
  assert.ok(splitRequirements(many).length <= 20);
});

test("splitRequirements handles null and empty without throwing", () => {
  assert.deepEqual(splitRequirements(null), []);
  assert.deepEqual(splitRequirements(""), []);
});
