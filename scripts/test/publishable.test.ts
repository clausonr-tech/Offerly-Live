// What the crawler read must reach the student.
//
// The bug this exists to prevent: `deadlineAt` was parsed by four connectors,
// written to detected_listings.deadline_at on every run, forwarded into
// opening_signals - and then dropped by the promote step, which hard-coded
// deadlineStatus "tbd" on every row it published. 110 detected listings
// carried a real deadline and not one reached internship_postings.
//
// It was invisible because the mapping was an object literal inside a loop in
// a script: a field that was never forwarded looked identical to a field the
// source never supplied. It is a tested function now, and these are the tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishableFromDetection,
  type DetectedForPublish,
} from "../../src/lib/monitoring/publishable";

const NOW = new Date("2026-09-22T00:00:00Z");

const listing = (over: Partial<DetectedForPublish> = {}): DetectedForPublish => ({
  title: "2028 Investment Banking Summer Analyst – New York",
  location: "New York",
  descriptionRaw: "Ten weeks on the desk.",
  applicationUrl: "https://firm.example/apply/123",
  listingUrl: "https://firm.example/jobs/123",
  deadlineAt: null,
  ...over,
});

const cls = { recruitingCycle: 2028, eligibility: { gradYears: [2029] }, requirementsRaw: "GPA 3.5" };

test("a connector-supplied deadline reaches the posting", () => {
  // THE REGRESSION. Dayforce and Oracle hand this over as an API field and it
  // appears nowhere in the description text, so nothing downstream can recover
  // it by parsing. If this hop drops it, it is gone for good.
  const p = publishableFromDetection(
    listing({ deadlineAt: "2026-11-15T00:00:00.000Z" }),
    cls,
    NOW,
  );
  assert.equal(p.deadlineStatus, "confirmed");
  assert.equal(p.deadlineDateIso, "2026-11-15T00:00:00.000Z");
});

test("a connector deadline already past publishes as closed, not confirmed", () => {
  const p = publishableFromDetection(
    listing({ deadlineAt: "2026-08-01T00:00:00.000Z" }),
    cls,
    NOW,
  );
  assert.equal(p.deadlineStatus, "closed");
});

test("with no connector date, the description's own sentence is read", () => {
  const p = publishableFromDetection(
    listing({
      deadlineAt: null,
      descriptionRaw: "Title:2028 Summer Analyst Application Deadline:15 Nov 2026 11:55 PM EST",
    }),
    cls,
    NOW,
  );
  assert.equal(p.deadlineStatus, "confirmed");
  assert.equal(p.deadlineDateIso?.slice(0, 10), "2026-11-15");
});

test("the connector's own date wins over the description text", () => {
  // The source stating it as data beats us reading it out of prose.
  const p = publishableFromDetection(
    listing({
      deadlineAt: "2026-12-01T00:00:00.000Z",
      descriptionRaw: "Application Deadline:15 Nov 2026 11:55 PM EST",
    }),
    cls,
    NOW,
  );
  assert.equal(p.deadlineDateIso?.slice(0, 10), "2026-12-01");
});

test("no deadline anywhere stays tbd rather than becoming a guess", () => {
  const p = publishableFromDetection(listing(), cls, NOW);
  assert.equal(p.deadlineStatus, "tbd");
  assert.equal(p.deadlineDateIso, null);
});

test("an unparseable connector date falls through instead of publishing Invalid Date", () => {
  const p = publishableFromDetection(listing({ deadlineAt: "not a date" }), cls, NOW);
  assert.equal(p.deadlineStatus, "tbd");
  assert.equal(p.deadlineDateIso, null);
});

test("every other field the detection carries is forwarded", () => {
  const l = listing({ deadlineAt: "2026-11-15T00:00:00.000Z" });
  const p = publishableFromDetection(l, cls, NOW);
  assert.equal(p.roleTitle, l.title);
  assert.equal(p.location, l.location);
  assert.equal(p.descriptionFull, l.descriptionRaw);
  assert.equal(p.applicationUrl, l.applicationUrl);
  assert.equal(p.sourceUrl, l.listingUrl);
  assert.equal(p.programYear, cls.recruitingCycle);
  assert.deepEqual(p.eligibleGradYears, cls.eligibility.gradYears);
  assert.equal(p.requirementsFull, cls.requirementsRaw);
});

test("a detection field with no destination is not silently invented", () => {
  // The crawler never learns a recruiting contact; only a posting that
  // publishes one by hand has these. Asserted so a future change that starts
  // filling them from somewhere has to come past this test.
  const p = publishableFromDetection(listing(), cls, NOW);
  for (const f of ["recruiterName", "recruiterTitle", "recruiterEmail", "recruiterPhone"] as const) {
    assert.equal(p[f], null, f);
  }
});

test("missing eligibility is an empty list, which restricts nobody", () => {
  const p = publishableFromDetection(listing(), { recruitingCycle: 2028 }, NOW);
  assert.deepEqual(p.eligibleGradYears, []);
});
