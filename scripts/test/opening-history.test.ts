// The pure half of the Wayback opening-window derivation.
//
// Worth guarding specifically, because the first version of this feature was
// confidently wrong in a way that looked right: it matched the word "intern"
// anywhere in a page, which on Kroll's careers page is evergreen marketing
// prose, so the search for an opening boundary returned the year's first
// capture and produced a five-month window. Every rule below exists because
// of that.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCdxTimestamp,
  cycleYearForDate,
  countInternshipPostings,
  deriveWindow,
  type YearObservation,
} from "../../src/lib/monitoring/opening-history";

test("CDX timestamps parse as UTC", () => {
  const d = parseCdxTimestamp("20250918143000");
  assert.equal(d?.toISOString(), "2025-09-18T14:30:00.000Z");
});

test("a malformed CDX timestamp is null, not a wrong date", () => {
  for (const bad of ["", "2025", "not-a-timestamp", "202509181430"]) {
    assert.equal(parseCdxTimestamp(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("the cycle convention matches monitor-run: autumn is two cycles out", () => {
  // Finance recruits ~18 months ahead, so a posting seen in autumn 2026 is
  // for summer 2028.
  assert.equal(cycleYearForDate(new Date("2026-09-18T00:00:00Z")), 2028);
  assert.equal(cycleYearForDate(new Date("2026-04-01T00:00:00Z")), 2028);
  // Before April it is one cycle out.
  assert.equal(cycleYearForDate(new Date("2026-01-15T00:00:00Z")), 2027);
  assert.equal(cycleYearForDate(new Date("2026-03-31T00:00:00Z")), 2027);
});

test("counts internship LINKS, not the word in prose", () => {
  // The exact failure: Kroll's page carries this sentence all year.
  const prose =
    "<p>opportunities for recent graduates and interns to gain initial work experience</p>";
  assert.equal(countInternshipPostings(prose).count, 0);

  const links =
    '<a href="/1">Intern, Valuation Services</a><a href="/2">2027 Summer Analyst Programme</a>';
  assert.equal(countInternshipPostings(links).count, 2);
});

test("a repeated role counts once, and non-internship links are ignored", () => {
  const html =
    '<a href="/1">Intern, Restructuring</a><a href="/2">Intern, Restructuring</a>' +
    '<a href="/3">Vice President, Compliance</a><a href="/4">About us</a>';
  const got = countInternshipPostings(html);
  assert.equal(got.count, 1);
  assert.equal(got.sample, "Intern, Restructuring");
});

test("link text too short or too long to be a role title is ignored", () => {
  // Nav items and whole paragraphs wrapped in an anchor.
  const html = `<a href="/1">Intern</a><a href="/2">${"Summer Analyst ".repeat(20)}</a>`;
  assert.equal(countInternshipPostings(html).count, 0);
});

function obs(year: number, iso: string): YearObservation {
  return { year, firstSeen: new Date(iso), snapshotUrl: `https://web.archive.org/${year}`, matched: "Intern, X" };
}

test("one year of evidence is an anecdote and yields no window", () => {
  assert.equal(deriveWindow([obs(2025, "2025-09-12T00:00:00Z")]), null);
  assert.equal(deriveWindow([]), null);
});

test("two nearby years give a padded window, not a single date", () => {
  const w = deriveWindow(
    [obs(2024, "2024-09-12T00:00:00Z"), obs(2025, "2025-09-18T00:00:00Z")],
    new Date("2026-06-01T00:00:00Z"),
  );
  assert.ok(w, "expected a window");

  // Asserted as a PROPERTY rather than two exact strings. The window is built
  // from day-of-year, and 12 September is day 256 in a leap year and 255
  // otherwise - so pinning exact dates makes the test fail on a technicality
  // that a deliberately fuzzy +/-7 day window does not care about.
  const spanDays = (w!.opensEnd.getTime() - w!.opensStart.getTime()) / 86400000;
  assert.ok(spanDays >= 18 && spanDays <= 22, `span was ${spanDays} days, expected ~20`);

  // Both observed dates fall inside it, which is the point.
  for (const day of ["09-12", "09-18"]) {
    const start = w!.opensStart.toISOString().slice(5, 10);
    const end = w!.opensEnd.toISOString().slice(5, 10);
    assert.ok(start <= day && day <= end, `${day} should sit inside ${start}..${end}`);
  }
  // Never collapsed to a single date.
  assert.notEqual(w!.opensStart.getTime(), w!.opensEnd.getTime());
});

test("observations too far apart are refused rather than shrugged at", () => {
  // Kroll's first run: 9 May and 2 January, which produced a five-month
  // "window" that was technically evidence-derived and useless to act on.
  const w = deriveWindow(
    [obs(2024, "2024-05-09T00:00:00Z"), obs(2025, "2025-01-02T00:00:00Z")],
    new Date("2026-06-01T00:00:00Z"),
  );
  assert.equal(w, null);
});

test("the window carries its evidence, including the snapshot URLs", () => {
  const w = deriveWindow(
    [obs(2024, "2024-09-12T00:00:00Z"), obs(2025, "2025-09-18T00:00:00Z")],
    new Date("2026-06-01T00:00:00Z"),
  );
  assert.match(w!.evidence, /2024-09-12/);
  assert.match(w!.evidence, /2025-09-18/);
  assert.match(w!.evidence, /web\.archive\.org/);
  // Says plainly that it is derived rather than stated by the firm.
  assert.match(w!.evidence, /not stated by the firm/i);
});
