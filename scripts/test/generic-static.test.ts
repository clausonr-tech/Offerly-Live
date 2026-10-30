// Reading a board out of SERVED HTML, so a page that a plain GET can answer
// never launches Chromium.
//
// The generic connector already tried a static fetch first and already read
// JobPosting JSON-LD from it. What it could not do was recognise a board that
// is ordinary server-rendered markup with no structured data - which is a real
// and common shape, and the entire basis of the iCIMS connector. Those pages
// were paying a browser launch to rediscover anchors already in the bytes.
//
// Every test here is about the ASYMMETRY that makes the optimisation safe:
// declining costs one wasted fetch, because the browser still runs. Firing
// wrongly puts nav links into the pipeline as if they were jobs - which this
// connector has done before, returning "Find Summer Analyst Programs" as a
// listing. So the bar to fire is deliberately high.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findCandidatesInHtml } from "../../src/lib/monitoring/connectors/generic";

const BASE = "https://careers.example.com/students";

test("a server-rendered board is read without a browser", () => {
  const html = `
    <main>
      <ul class="results">
        <li><a href="/jobs/1001">2027 Summer Analyst Program - Investment Banking</a></li>
        <li><a href="/jobs/1002">2027 Summer Analyst Program - Global Markets</a></li>
        <li><a href="/jobs/1003">Off-Cycle Internship, M&amp;A (London)</a></li>
      </ul>
    </main>`;
  const found = findCandidatesInHtml(html, BASE);
  assert.equal(found.length, 3);
  // Relative hrefs are resolved against the board, not left relative.
  assert.equal(found[0].href, "https://careers.example.com/jobs/1001");
  // Entities are decoded on the way out, the same as every other path here.
  assert.equal(found[2].title, "Off-Cycle Internship, M&A (London)");
});

test("a client-rendered shell is handed to the browser, not guessed at", () => {
  // The exact shape that broke this connector before: the real board is
  // rendered by script, and the served HTML carries only signposts.
  const html = `
    <nav><a href="/programs">Summer Analyst Programs</a></nav>
    <main>
      <h1>Careers</h1>
      <a href="/explore">Find Summer Analyst Programs</a>
      <div id="board-root"></div>
    </main>`;
  assert.deepEqual(findCandidatesInHtml(html, BASE), []);
});

test("navigation blocks are removed before anything is matched", () => {
  const html = `
    <header><a href="/a">Internships</a><a href="/b">Internship FAQ</a></header>
    <footer><a href="/c">Internship privacy notice</a></footer>
    <main><p>Nothing here yet.</p></main>`;
  assert.deepEqual(findCandidatesInHtml(html, BASE), []);
});

test("one lone match is not enough - it falls through to the browser", () => {
  // A single static posting is real but indistinguishable from a stray
  // marketing link, so it is left to the render path, which finds it anyway.
  const html = `<main><a href="/jobs/1">2027 Summer Analyst Internship</a></main>`;
  assert.deepEqual(findCandidatesInHtml(html, BASE), []);
});

test("a keyword-free Apply link takes its title from the nearby heading", () => {
  // Real boards routinely pair a generic button with the role name beside it.
  const html = `
    <main>
      <div class="card"><h3>2027 Summer Analyst, Investment Banking</h3>
        <a href="/jobs/11">Apply Now</a></div>
      <div class="card"><h3>2027 Summer Analyst, Restructuring</h3>
        <a href="/jobs/12">Apply Now</a></div>
    </main>`;
  const found = findCandidatesInHtml(html, BASE);
  assert.equal(found.length, 2);
  assert.match(found[0].title, /Summer Analyst/);
  // "Apply Now" must never become the title - it is a signpost.
  assert.ok(!found.some((c) => /^Apply/i.test(c.title)));
});

test("links back to the page itself are not postings", () => {
  const html = `
    <main>
      <a href="${BASE}#apply">Internship application details</a>
      <a href="${BASE}">Internship overview</a>
      <a href="/jobs/9">Summer Analyst Internship 2027</a>
    </main>`;
  const found = findCandidatesInHtml(html, BASE);
  assert.ok(found.every((c) => !c.href.startsWith(BASE)));
});

test("the same posting linked twice is one candidate", () => {
  const html = `
    <main>
      <a href="/jobs/5">Summer Analyst Internship</a>
      <a href="/jobs/5">Summer Analyst Internship</a>
      <a href="/jobs/6">Summer Associate Internship</a>
    </main>`;
  assert.equal(findCandidatesInHtml(html, BASE).length, 2);
});

test("unrelated boards are not mistaken for student ones", () => {
  // No keyword, no candidate - the phrase list is what makes this a student
  // crawler rather than a job crawler.
  const html = `
    <main>
      <a href="/jobs/1">Managing Director, Coverage</a>
      <a href="/jobs/2">Vice President, Leveraged Finance</a>
    </main>`;
  assert.deepEqual(findCandidatesInHtml(html, BASE), []);
});

test("an address is not a posting", () => {
  // "Email us about our internship programme" is a real line on real careers
  // pages. A mailto: link sitting next to the keyword is the single most
  // likely false positive here, and a resolved mailto: URL would be stored as
  // a listing URL a student could click.
  const html = `
    <main>
      <a href="mailto:campus@example.com">Internship enquiries</a>
      <a href="javascript:void(0)">Summer Analyst Internship filter</a>
      <a href="/jobs/7">Summer Analyst Internship 2027</a>
      <a href="/jobs/8">Summer Associate Internship 2027</a>
    </main>`;
  const found = findCandidatesInHtml(html, BASE);
  assert.equal(found.length, 2);
  assert.ok(found.every((c) => c.href.startsWith("https://")));
});
