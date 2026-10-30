// The static candidate scan, and the ceiling it reports.
//
// generic-static.test.ts already covers what this scan ACCEPTS. This file is
// about what it does at its limits, because that is where the losses were:
// the scan capped at 30 candidates and said nothing about it, and the caller
// closes any stored listing absent from a fetch. A board publishing 60
// internships therefore had 30 of them recorded as ENDED - not missed, ended,
// which is worse, because a closed row looks like an answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanHtmlForCandidates,
  findCandidatesInHtml,
} from "../../src/lib/monitoring/connectors/generic";

const BASE = "https://www.example.com/careers";

/** n anchors that all look like real postings. */
function board(n: number, prefix = "Summer Analyst"): string {
  return Array.from(
    { length: n },
    (_, i) => `<li><a href="/jobs/${i}">${prefix} ${2027} - Desk ${i}</a></li>`,
  ).join("\n");
}

// ------------------------------------------------------------ the happy path

test("a small board is read whole and reports no truncation", () => {
  const scan = scanHtmlForCandidates(board(5), BASE);
  assert.equal(scan.results.length, 5);
  assert.equal(scan.truncated, false);
});

test("hrefs are resolved against the page", () => {
  const scan = scanHtmlForCandidates(board(2), BASE);
  for (const candidate of scan.results) {
    assert.ok(candidate.href.startsWith("https://www.example.com/jobs/"));
  }
});

test("the plain-list form still works for callers that want only the list", () => {
  assert.equal(findCandidatesInHtml(board(5), BASE).length, 5);
  assert.deepEqual(findCandidatesInHtml(board(5), BASE), scanHtmlForCandidates(board(5), BASE).results);
});

// ------------------------------------------------------------- the ceiling

test("a board larger than the cap is truncated, and says so", () => {
  const scan = scanHtmlForCandidates(board(250), BASE);
  assert.equal(scan.truncated, true);
  assert.ok(scan.results.length > 0);
});

test("the cap is high enough for a real board", () => {
  // The old cap was 30. Stifel's iCIMS board runs to ~150 requisitions, and
  // Baird's sitemap carries 119 jobs - both would have been cut in half.
  const scan = scanHtmlForCandidates(board(150), BASE);
  assert.equal(scan.results.length, 150);
  assert.equal(scan.truncated, false);
});

for (const n of [1, 2, 10, 30, 31, 60, 199, 200]) {
  test(`a board of ${n} postings is not truncated`, () => {
    const scan = scanHtmlForCandidates(board(n), BASE);
    // One posting falls through to the browser by design (see the >= 2 rule),
    // so it reports nothing rather than a truncation.
    assert.equal(scan.truncated, false, `${n} reported truncated`);
  });
}

test("truncation never loses what it did read", () => {
  // Reporting the ceiling must not cost the rows already found - they are
  // still real postings.
  const scan = scanHtmlForCandidates(board(400), BASE);
  assert.ok(scan.results.length >= 200);
  assert.equal(new Set(scan.results.map((r) => r.href)).size, scan.results.length);
});

test("a truncated scan still returns usable candidates", () => {
  const scan = scanHtmlForCandidates(board(300), BASE);
  for (const candidate of scan.results) {
    assert.ok(candidate.title.length >= 8);
    assert.ok(candidate.href.startsWith("https://"));
  }
});

// --------------------------------------------------- the two-candidate floor

test("a single posting falls through to the browser rather than being trusted", () => {
  const scan = scanHtmlForCandidates(board(1), BASE);
  assert.equal(scan.results.length, 0);
  assert.equal(scan.truncated, false);
});

test("two distinct postings clear the floor", () => {
  assert.equal(scanHtmlForCandidates(board(2), BASE).results.length, 2);
});

test("the same posting twice does not clear the floor", () => {
  // Two anchors, one destination - that is one posting, not two.
  const html = `<a href="/jobs/1">Summer Analyst 2027</a><a href="/jobs/1">Summer Analyst 2027</a>`;
  assert.equal(scanHtmlForCandidates(html, BASE).results.length, 0);
});

// ------------------------------------------------------- multilingual boards

test("a French board is read, where it used to yield nothing", () => {
  // The whole reason the keyword list was widened. This scan produced no
  // candidates for a French board, so no listing row existed, so no corpus
  // audit could ever have found the gap.
  const html = `
    <li><a href="/offres/1">Stage - Analyste M&amp;A, Paris</a></li>
    <li><a href="/offres/2">Stagiaire Corporate Finance H/F</a></li>
    <li><a href="/offres/3">Alternance - Chargé d'affaires</a></li>`;
  const scan = scanHtmlForCandidates(html, BASE);
  assert.equal(scan.results.length, 3);
});

test("a German board is read", () => {
  const html = `
    <li><a href="/stellen/1">Praktikum Investment Banking (m/w/d)</a></li>
    <li><a href="/stellen/2">Werkstudent Asset Management</a></li>`;
  assert.equal(scanHtmlForCandidates(html, BASE).results.length, 2);
});

test("an accented title survives the scan intact", () => {
  // Mangling it would break the employer filter the way "Acme Capital L.L.C."
  // did for Getro.
  const html = `
    <li><a href="/o/1">Estágio em Banca de Investimento</a></li>
    <li><a href="/o/2">Prácticas en Banca de Inversión</a></li>`;
  const titles = scanHtmlForCandidates(html, BASE).results.map((r) => r.title);
  assert.ok(titles.includes("Estágio em Banca de Investimento"));
  assert.ok(titles.includes("Prácticas en Banca de Inversión"));
});

// ---------------------------------------------- the word-boundary fix in situ

test("an Internal Audit link is no longer a candidate", () => {
  // `lower.includes("intern")` matched this on every careers page that had one.
  const html = `
    <li><a href="/jobs/1">Internal Audit Manager</a></li>
    <li><a href="/jobs/2">International Equities Desk</a></li>`;
  assert.equal(scanHtmlForCandidates(html, BASE).results.length, 0);
});

test("a real internship beside an Internal Audit link is still found", () => {
  const html = `
    <li><a href="/jobs/1">Internal Audit Manager</a></li>
    <li><a href="/jobs/2">2027 Summer Analyst - New York</a></li>
    <li><a href="/jobs/3">Marketing Internship (Year-Round)</a></li>`;
  const titles = scanHtmlForCandidates(html, BASE).results.map((r) => r.title);
  assert.equal(titles.length, 2);
  assert.ok(!titles.some((t) => t.includes("Internal Audit")));
});

// -------------------------------------------------------- chrome and signposts

test("navigation blocks are removed before anything is matched", () => {
  const html = `
    <nav><a href="/a">Find Summer Analyst Programs</a><a href="/b">All internships</a></nav>
    <footer><a href="/c">Internship FAQ</a><a href="/d">Intern stories</a></footer>`;
  assert.equal(scanHtmlForCandidates(html, BASE).results.length, 0);
});

const signposts = [
  "Find Summer Analyst Programs",
  "Explore our internships",
  "Search internship opportunities",
  "Browse intern roles",
  "View all internships",
  "Discover internship programmes",
];
for (const text of signposts) {
  test(`a signpost link is not a posting: ${text}`, () => {
    const html = `<a href="/a">${text}</a><a href="/b">${text} again</a>`;
    assert.equal(scanHtmlForCandidates(html, BASE).results.length, 0);
  });
}

test("a link back to the page itself is navigation, not a posting", () => {
  const html = `
    <a href="${BASE}">Summer Analyst 2027</a>
    <a href="${BASE}#top">Summer Analyst 2027</a>
    <a href="/jobs/2">Summer Associate 2027</a>`;
  const scan = scanHtmlForCandidates(html, BASE);
  assert.ok(!scan.results.some((r) => r.href.startsWith(BASE)));
});

const nonPageSchemes = [
  ["mailto:", `<a href="mailto:recruiting@firm.com">Email us about our internship</a>`],
  ["tel:", `<a href="tel:+15555555555">Call about internships</a>`],
  ["javascript:", `<a href="javascript:void(0)">Summer Analyst 2027</a>`],
  ["data:", `<a href="data:text/html,x">Summer Analyst 2027</a>`],
  ["fragment", `<a href="#internships">Summer Analyst 2027</a>`],
];
for (const [name, anchor] of nonPageSchemes) {
  test(`a ${name} href is not a posting`, () => {
    const html = `${anchor}${anchor.replace(/href="([^"]*)"/, 'href="$1x"')}`;
    const scan = scanHtmlForCandidates(html, BASE);
    assert.equal(scan.results.length, 0, JSON.stringify(scan.results));
  });
}

// ------------------------------------------------------------- title recovery

test("a keyword-free Apply link takes its title from the nearby heading", () => {
  const html = `
    <div><h3>2027 Investment Banking Summer Analyst</h3><a href="/jobs/1">Apply Now</a></div>
    <div><h3>2027 Summer Associate - M&amp;A</h3><a href="/jobs/2">Apply Now</a></div>`;
  const titles = scanHtmlForCandidates(html, BASE).results.map((r) => r.title);
  assert.ok(titles.some((t) => t.includes("Investment Banking Summer Analyst")));
});

test("entity-encoded titles are decoded", () => {
  const html = `
    <a href="/jobs/1">M&amp;A Summer Analyst</a>
    <a href="/jobs/2">Corporate &amp; Investment Banking Intern</a>`;
  const titles = scanHtmlForCandidates(html, BASE).results.map((r) => r.title);
  assert.ok(titles.includes("M&A Summer Analyst"));
  assert.ok(titles.includes("Corporate & Investment Banking Intern"));
});

test("a non-breaking space in a title becomes a real space", () => {
  const html = `
    <a href="/jobs/1">Summer&nbsp;Analyst 2027</a>
    <a href="/jobs/2">Summer&nbsp;Associate 2027</a>`;
  const titles = scanHtmlForCandidates(html, BASE).results.map((r) => r.title);
  assert.ok(titles.includes("Summer Analyst 2027"));
});

// --------------------------------------------------------------- malformed input

const malformed = [
  ["empty", ""],
  ["plain text", "No openings right now."],
  ["unclosed anchor", `<a href="/jobs/1">Summer Analyst 2027`],
  ["no href", `<a>Summer Analyst 2027</a><a>Summer Associate</a>`],
  ["nested markup", `<a href="/jobs/1"><span><b>Summer</b> Analyst</span></a><a href="/jobs/2">Summer Associate 2027</a>`],
  ["a whole 403 page", `<html><body><h1>403 Forbidden</h1></body></html>`],
];
for (const [name, html] of malformed) {
  test(`malformed input does not throw: ${name}`, () => {
    assert.doesNotThrow(() => scanHtmlForCandidates(html, BASE));
    const scan = scanHtmlForCandidates(html, BASE);
    assert.equal(typeof scan.truncated, "boolean");
    assert.ok(Array.isArray(scan.results));
  });
}

test("an unparseable base URL does not throw", () => {
  assert.doesNotThrow(() => scanHtmlForCandidates(board(3), "not a url"));
});

test("a scan that finds nothing is never reported as truncated", () => {
  // Truncation means "there was more". Nothing found is not that.
  for (const [, html] of malformed) {
    assert.equal(scanHtmlForCandidates(html, BASE).truncated, false);
  }
});
