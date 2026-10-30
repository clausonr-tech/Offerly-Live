// Asking the Archive about a board's API endpoint, not just its web page.
//
// The third and cheapest of the three methods. Crawlers visit human pages, so
// an API endpoint is captured far less often - but when it was, the reply is
// JSON, and JSON does not care whether the board renders in JavaScript. The
// titles are simply in the bytes.
//
// Two things have to hold. The API address has to be built from the same
// parsers the connectors use, so a board this repo can read is a board this
// can ask about. And the title reader has to notice it is looking at JSON: an
// API reply has no anchors, so read as HTML it looks like an empty board -
// exactly the wrong answer for a body listing every posting in plain text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { atsApiUrl, countInternshipPostings, sectorsInHtml } from "../../src/lib/monitoring/opening-history";

// ------------------------------------------------------------ API addresses

const boards: [string, string, string][] = [
  ["Greenhouse", "https://job-boards.greenhouse.io/acme", "boards-api.greenhouse.io/v1/boards/acme/jobs"],
  ["Greenhouse, old host", "https://boards.greenhouse.io/acme", "boards-api.greenhouse.io/v1/boards/acme/jobs"],
  ["Lever", "https://jobs.lever.co/acme", "api.lever.co/v0/postings/acme"],
  ["Ashby", "https://jobs.ashbyhq.com/acme", "api.ashbyhq.com/posting-api/job-board/acme"],
  ["Workable", "https://apply.workable.com/acme/", "apply.workable.com/api/v1/widget/accounts/acme"],
  ["SmartRecruiters", "https://careers.smartrecruiters.com/Acme", "api.smartrecruiters.com/v1/companies/Acme/postings"],
  ["Recruitee", "https://acme.recruitee.com/", "acme.recruitee.com/api/offers/"],
  ["BambooHR", "https://acme.bamboohr.com/careers/list", "acme.bamboohr.com/careers/list"],
  ["Breezy", "https://acme.breezy.hr/json", "acme.breezy.hr/json"],
];
for (const [vendor, board, expected] of boards) {
  test(`an API address is built for ${vendor}`, () => {
    const api = atsApiUrl(board);
    assert.ok(api, board);
    assert.ok(api.includes(expected), `${api} should contain ${expected}`);
  });
}

test("every API address is absolute and https", () => {
  for (const [, board] of boards) {
    const api = atsApiUrl(board);
    assert.match(api!, /^https:\/\//, board);
  }
});

const noApi = [
  "https://www.example.com/careers",
  "https://acme.wd1.myworkdayjobs.com/en-US/External",
  "https://careers-acme.icims.com/jobs/search",
  "https://www.bairdcareers.com/jobs/",
  "https://jobs.dayforcehcm.com/en-US/acme/CANDIDATEPORTAL",
  "https://jobs.jobvite.com/acme/jobs",
];
for (const board of noApi) {
  test(`no API address is invented for ${board.slice(8, 46)}`, () => {
    // These vendors either publish no public API or need a token we cannot
    // read from the URL. Guessing one would spend a request on a 404.
    assert.equal(atsApiUrl(board), null, board);
  });
}

test("a lookalike domain gets no API address", () => {
  assert.equal(atsApiUrl("https://evilgreenhouse.io/acme"), null);
  assert.equal(atsApiUrl("https://jobs.lever.co.attacker.net/acme"), null);
});

test("malformed input never throws", () => {
  for (const url of ["", "not a url", "https://", "javascript:alert(1)"]) {
    assert.doesNotThrow(() => atsApiUrl(url));
    assert.equal(atsApiUrl(url), null, url);
  }
});

// --------------------------------------------------- reading an API reply

const greenhouseReply = JSON.stringify({
  jobs: [
    { id: 1, title: "2027 Investment Banking Summer Analyst", absolute_url: "https://x/1" },
    { id: 2, title: "Vice President, Compliance", absolute_url: "https://x/2" },
    { id: 3, title: "2027 Real Estate Summer Analyst", absolute_url: "https://x/3" },
  ],
  meta: { total: 3 },
});

test("an archived API reply yields its internship titles", () => {
  // Read as HTML this is an empty board: there is not one anchor in it.
  const result = countInternshipPostings(greenhouseReply);
  assert.equal(result.count, 2);
  assert.ok(result.titles.includes("2027 Investment Banking Summer Analyst"));
});

test("non-internship titles in an API reply are ignored", () => {
  assert.ok(!countInternshipPostings(greenhouseReply).titles.includes("Vice President, Compliance"));
});

test("an API reply supports the per-industry split too", () => {
  const found = sectorsInHtml(greenhouseReply);
  assert.equal(found.size, 2);
  assert.ok(found.has("investment_banking"));
  assert.ok(found.has("real_estate"));
});

const shapes: [string, string][] = [
  ["Lever, a bare array", JSON.stringify([{ text: "2027 Summer Analyst" }, { text: "Head of Ops" }])],
  ["Ashby, nested", JSON.stringify({ jobs: [{ title: "2027 Summer Analyst - M&A" }] })],
  ["BambooHR", JSON.stringify({ result: [{ jobOpeningName: "Marketing Internship (Year-Round)" }] })],
  ["Workable", JSON.stringify({ jobs: [{ title: "2027 Summer Internship, Equity Research" }] })],
  ["SmartRecruiters", JSON.stringify({ content: [{ name: "2027 Summer Analyst Programme" }] })],
];
for (const [vendor, body] of shapes) {
  test(`a ${vendor} reply is read`, () => {
    assert.ok(countInternshipPostings(body).count >= 1, body.slice(0, 60));
  });
}

test("a deeply nested reply is walked, within a bound", () => {
  const deep = JSON.stringify({ a: { b: { c: { d: { title: "2027 Summer Analyst" } } } } });
  assert.equal(countInternshipPostings(deep).count, 1);
});

test("an absurdly nested body does not run away", () => {
  // A bounded walk: a hostile or pathological body must not become a stack
  // overflow on a long-shot method.
  let body: unknown = { title: "2027 Summer Analyst" };
  for (let i = 0; i < 400; i++) body = { nest: body };
  assert.doesNotThrow(() => countInternshipPostings(JSON.stringify(body)));
});

test("an empty API reply is an empty board, not an error", () => {
  for (const body of ["[]", "{}", '{"jobs":[]}', "null"]) {
    assert.equal(countInternshipPostings(body).count, 0, body);
  }
});

// ------------------------------------------------- HTML still reads as HTML

test("an HTML board is still read through the anchor scan", () => {
  // The JSON path must not swallow the common case.
  const html = `<html><body><li><a href="/1">2027 Summer Analyst</a></li></body></html>`;
  assert.equal(countInternshipPostings(html).count, 1);
});

test("a body that merely looks JSON-ish falls back to HTML", () => {
  const html = `<html><body>{ not really json }<a href="/1">2027 Summer Analyst</a></body></html>`;
  assert.equal(countInternshipPostings(html).count, 1);
});

test("a JSON string that is not an object or array yields nothing", () => {
  // `JSON.parse('"hello"')` succeeds. It is not a board.
  assert.equal(countInternshipPostings('"2027 Summer Analyst"').count, 0);
});

test("an empty body is an empty board either way", () => {
  for (const body of ["", " ", "<html></html>"]) {
    assert.equal(countInternshipPostings(body).count, 0, JSON.stringify(body));
  }
});
