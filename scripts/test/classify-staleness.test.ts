// A cycle that has already happened, and what it is allowed to do.
//
// This path threw a posting away with `needsHumanReview: false` - filed,
// unqueued, unreviewable - on the strength of the least reliable extraction in
// classify.ts: a regex looking for a four-digit year within 40 characters of a
// recruiting word, run over title + division + DESCRIPTION.
//
// A description is full of years that are not cycles. "Our internship program
// began in 2015" satisfies that pattern exactly. A title year usually wins by
// being earlier in the string, so the damage was confined to postings whose
// title carries no year - Baird's "Internship - Marketing (Year-Round)" is a
// real one - and those are precisely the postings with no second chance.
//
// Dates are read from liveCycleRange() rather than hardcoded, so this file
// does not start failing when the calendar moves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyListing } from "../../src/lib/monitoring/classify";
import { liveCycleRange, isStaleCycle } from "../../src/lib/monitoring/posting-quality";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

const { min: LIVE_MIN, max: LIVE_MAX } = liveCycleRange();
const DEAD = LIVE_MIN - 1;
const FAR_FUTURE = LIVE_MAX + 1;

const listing = (patch: Partial<NormalizedListing>): NormalizedListing => ({
  externalJobId: "req-1",
  title: "Investment Banking Summer Analyst",
  division: null,
  location: "New York, NY",
  descriptionRaw:
    "Join our investment banking division for a ten week programme in New York. " +
    "Candidates should be pursuing a bachelor's degree and have strong academic credentials. " +
    "Applications are reviewed on a rolling basis and we encourage early submission.",
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  ...patch,
});

// ------------------------------------------------------- the range itself

test("the live range is at least two cycles wide", () => {
  assert.ok(LIVE_MAX > LIVE_MIN);
});

test("a dead cycle and a far-future one are both stale", () => {
  assert.equal(isStaleCycle(DEAD), true);
  assert.equal(isStaleCycle(FAR_FUTURE), true);
});

test("unknown is not stale - it is a different problem", () => {
  assert.equal(isStaleCycle(null), false);
});

for (let year = LIVE_MIN; year <= LIVE_MAX; year++) {
  test(`${year} is a live cycle`, () => {
    assert.equal(isStaleCycle(year), false);
  });
}

// ---------------------------------------------- a stale TITLE still rejects

test("a title naming a dead cycle is rejected", () => {
  const result = classifyListing(listing({ title: `${DEAD} Investment Banking Summer Analyst` }), null);
  assert.equal(result.relevant, false);
  assert.equal(result.staleCycle, true);
});

test("a rejected stale posting is now REVIEWABLE, not silently dropped", () => {
  // The change. Every other rejection path in classify.ts sets this true so an
  // admin can overturn a wrong call; this one did not, and it is driven by the
  // weakest extraction in the file.
  const result = classifyListing(listing({ title: `${DEAD} Investment Banking Summer Analyst` }), null);
  assert.equal(result.needsHumanReview, true);
});

test("a stale rejection still says why", () => {
  const result = classifyListing(listing({ title: `${DEAD} Summer Analyst` }), null);
  assert.ok(result.matchedEvidence.some((e) => e.includes(String(DEAD))));
  assert.ok(result.matchedEvidence.some((e) => /outside the live range/.test(e)));
});

test("a stale posting is still recognised as a posting", () => {
  // It is a real posting for a dead cycle, not page furniture. The two are
  // filed differently and only one is overturnable.
  const result = classifyListing(listing({ title: `${DEAD} Summer Analyst` }), null);
  assert.equal(result.isPosting, true);
});

test("a far-future title is rejected too", () => {
  const result = classifyListing(listing({ title: `${FAR_FUTURE} Summer Analyst` }), null);
  assert.equal(result.staleCycle, true);
  assert.equal(result.needsHumanReview, true);
});

test("a live title is not stale", () => {
  const result = classifyListing(listing({ title: `${LIVE_MIN} Investment Banking Summer Analyst` }), null);
  assert.equal(result.staleCycle, false);
});

// ------------------------------- a stale year in the DESCRIPTION must not reject

test("a dead year in the description does not throw the posting away", () => {
  // The bug. "Our internship program began in <dead year>" put a live posting
  // in the bin with no review.
  const result = classifyListing(
    listing({
      title: "Internship - Marketing (Year-Round)",
      descriptionRaw: `Our internship program began in ${DEAD} and has grown every year since. ` +
        "Interns work with the marketing team on campaigns across the firm and are based in Milwaukee.",
    }),
    null,
  );
  assert.equal(result.staleCycle, false);
});

const descriptionYears = [
  "Our internship program began in",
  "The analyst program was founded in",
  "Since",
  "Our summer programme has run since",
];
for (const phrase of descriptionYears) {
  test(`a history sentence does not make a posting stale: "${phrase} ${DEAD}"`, () => {
    const result = classifyListing(
      listing({
        title: "Internship - Marketing (Year-Round)",
        descriptionRaw: `${phrase} ${DEAD}. Interns join the marketing team for a full year placement in Milwaukee and support campaigns across the firm.`,
      }),
      null,
    );
    assert.equal(result.staleCycle, false, phrase);
  });
}

test("a dead year in the description is not reported as the cycle either", () => {
  // It no longer rejects - and it must not be PUBLISHED as the cycle, because
  // auto-approval requires a cycle and this one would carry a dead year.
  const result = classifyListing(
    listing({
      title: "Internship - Marketing (Year-Round)",
      descriptionRaw: `Our internship program began in ${DEAD} and runs every year in Milwaukee for students across all majors.`,
    }),
    null,
  );
  assert.notEqual(result.recruitingCycle, DEAD);
});

test("a posting with no trustworthy cycle goes to a human, never straight out", () => {
  const result = classifyListing(
    listing({
      title: "Internship - Marketing (Year-Round)",
      descriptionRaw: `Our internship program began in ${DEAD} and runs every year in Milwaukee for students across all majors.`,
    }),
    "investment_banking",
  );
  assert.equal(result.needsHumanReview, true);
});

test("the title still wins when it states a live cycle", () => {
  const result = classifyListing(
    listing({
      title: `${LIVE_MIN} Investment Banking Summer Analyst`,
      descriptionRaw: `Our programme began in ${DEAD}. Ten weeks in New York for penultimate-year students with strong academics.`,
    }),
    "investment_banking",
  );
  assert.equal(result.staleCycle, false);
  assert.equal(result.recruitingCycle, LIVE_MIN);
});

test("a stale title beats a live year in the description", () => {
  // The title is the authority on what the job is - the same rule every other
  // scope in this file follows.
  const result = classifyListing(
    listing({
      title: `${DEAD} Summer Analyst Programme`,
      descriptionRaw: `Applications for our ${LIVE_MIN} summer analyst programme are open.`,
    }),
    null,
  );
  assert.equal(result.staleCycle, true);
});

// ------------------------------------------------- ordinary postings unharmed

test("a normal live posting is unaffected by all of this", () => {
  const result = classifyListing(
    listing({ title: `${LIVE_MIN} Investment Banking Summer Analyst` }),
    "investment_banking",
  );
  assert.equal(result.relevant, true);
  assert.equal(result.staleCycle, false);
  assert.equal(result.recruitingCycle, LIVE_MIN);
});

test("a posting with no year anywhere is not stale", () => {
  const result = classifyListing(listing({ title: "Investment Banking Summer Analyst" }), null);
  assert.equal(result.staleCycle, false);
});

test("a comp figure is not a recruiting cycle", () => {
  const result = classifyListing(
    listing({
      title: "Investment Banking Summer Analyst",
      descriptionRaw: "The base pay scale for this internship is $125,000 to $145,000 annually in New York.",
    }),
    null,
  );
  assert.equal(result.staleCycle, false);
});

test("an address is not a recruiting cycle", () => {
  const result = classifyListing(
    listing({
      title: "Investment Banking Summer Analyst",
      descriptionRaw: "Our office is at 2015 Market Street, Philadelphia, and interns are based there for ten weeks.",
    }),
    null,
  );
  assert.equal(result.staleCycle, false);
});

test("nothing in this path throws on an empty listing", () => {
  assert.doesNotThrow(() =>
    classifyListing(listing({ title: "", descriptionRaw: "", division: null }), null),
  );
});
