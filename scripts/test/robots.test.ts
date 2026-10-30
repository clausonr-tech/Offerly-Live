// Honouring robots.txt at the moment of the fetch, not once by hand when a
// connector was written.
//
// This codebase already refused a Google Jobs scraper partly on robots
// grounds, refused UltiPro's board endpoint the same way, and built the Kroll
// connector around a sitemap because Kroll's robots.txt advertises the
// sitemap and disallows /api/. Every one of those was a person reading a file
// once. The generic connector, meanwhile, fetched 63 discovered careers pages
// and followed listing links off them without asking anyone anything.
//
// The rules below are the ones that decide real outcomes on real sites.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, isPathAllowed, ROBOTS_EXEMPT_HOSTS } from "../../src/lib/monitoring/robots";

const allowed = (robots: string, path: string) => isPathAllowed(parseRobots(robots), path);

test("a wildcard disallow blocks the path", () => {
  const robots = "User-agent: *\nDisallow: /api/";
  assert.equal(allowed(robots, "/api/jobs"), false);
  assert.equal(allowed(robots, "/careers"), true);
});

test("an empty Disallow means allow everything, not block everything", () => {
  // "Disallow:" with no value is the standard's empty prohibition. Read as a
  // prefix match on "" it would block every URL on the site - which would
  // silently zero out a firm that is perfectly happy to be read.
  assert.equal(allowed("User-agent: *\nDisallow:", "/anything"), true);
});

test("Allow beats Disallow for a longer match", () => {
  // The shape that matters most here: a site closes everything and opens its
  // careers section. Getting this backwards loses the exact pages we want.
  const robots = "User-agent: *\nDisallow: /\nAllow: /careers";
  assert.equal(allowed(robots, "/careers/summer-analyst"), true);
  assert.equal(allowed(robots, "/investors"), false);
});

test("a group naming us overrides the wildcard group entirely", () => {
  // Standard behaviour, and it cuts both ways: a site that names us to grant
  // access is not also bound by its blanket rule, and one that names us to
  // refuse must not be rescued by a permissive wildcard.
  const robots = [
    "User-agent: *",
    "Disallow: /",
    "",
    "User-agent: OfferlyMonitor",
    "Disallow: /private/",
  ].join("\n");
  assert.equal(allowed(robots, "/careers"), true);
  assert.equal(allowed(robots, "/private/x"), false);
});

test("consecutive user-agent lines share one group", () => {
  const robots = "User-agent: Googlebot\nUser-agent: OfferlyMonitor\nDisallow: /nope/";
  assert.equal(allowed(robots, "/nope/x"), false);
  assert.equal(allowed(robots, "/yes/x"), true);
});

test("a blank line ends a group", () => {
  // Without this, rules belonging to some other crawler's block leak into
  // ours and we stop reading pages nobody asked us to stop reading.
  const robots = "User-agent: SomeoneElse\n\nDisallow: /leaked/";
  assert.equal(allowed(robots, "/leaked/x"), true);
});

test("wildcards and end-anchors in patterns are honoured", () => {
  const robots = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?*";
  assert.equal(allowed(robots, "/files/brochure.pdf"), false);
  assert.equal(allowed(robots, "/files/brochure.pdf.html"), true);
  assert.equal(allowed(robots, "/search?q=intern"), false);
});

test("comments and junk lines are ignored", () => {
  const robots = "# a comment\nUser-agent: *   # trailing\nDisallow: /api/ # why not\nnonsense";
  assert.equal(allowed(robots, "/api/x"), false);
});

test("an empty robots.txt permits everything", () => {
  assert.equal(allowed("", "/anything"), true);
});

test("Kroll's real shape: sitemap advertised, API closed", () => {
  // The exact reasoning kroll.ts records - the sitemap path is the one the
  // site actually offers, and /api/ is not.
  const robots = "User-agent: *\nDisallow: /api/\nSitemap: https://careers.kroll.com/sitemap.xml";
  assert.equal(allowed(robots, "/api/jobs"), false);
  assert.equal(allowed(robots, "/sitemap.xml"), true);
  assert.equal(allowed(robots, "/job/london/analyst-123"), true);
});

test("vendor APIs are exempt, and the list is short and deliberate", () => {
  // Exemption is a decision on the record. If this set ever grows to include
  // an ordinary website, the enforcement has been quietly turned off.
  assert.ok(ROBOTS_EXEMPT_HOSTS.has("boards-api.greenhouse.io"));
  assert.ok(ROBOTS_EXEMPT_HOSTS.has("api.getro.com"));
  assert.ok(!ROBOTS_EXEMPT_HOSTS.has("www.goldmansachs.com"));
  assert.ok(ROBOTS_EXEMPT_HOSTS.size <= 12);
});
