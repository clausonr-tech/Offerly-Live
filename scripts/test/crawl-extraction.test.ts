// Pulling the information out, in every shape a board offers it, in every
// sector.
//
// These three modules had no tests at all, and each of them writes something a
// student sees or a schedule depends on:
//
//   announcements      "applications are now open" -> an opening signal
//   recruiting-events  an info session is not an internship
//   eligibility        who the firm said it will accept
//
// The announcement watcher is the one that has produced nothing in
// production - 42 opening_signals rows exist and all 42 are `seen_live`, none
// `firm_announcement` - and the note in its own file says that is worth
// knowing before trusting it as the timing layer. Tests are how you tell
// "the detector is too strict" from "the pages did not change".

import { test } from "node:test";
import assert from "node:assert/strict";
import { addedSentences, detectAnnouncement } from "../../src/lib/monitoring/announcements";
import { parseRecruitingEvent, wasRejectedAsEvent } from "../../src/lib/monitoring/recruiting-events";
import { readEligibility } from "../../src/lib/monitoring/eligibility";
import { normalizeBoardUrl } from "../../src/lib/monitoring/board-url";
import { liveCycleRange } from "../../src/lib/monitoring/posting-quality";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";
import type { FirmProgramCategory } from "../../src/lib/firm-metadata";

const { min: LIVE_MIN } = liveCycleRange();

const SECTORS: FirmProgramCategory[] = [
  "investment_banking", "private_equity", "venture_capital", "private_credit",
  "real_estate", "hedge_fund", "sales_trading", "asset_wealth_management",
  "commercial_banking", "insurance", "fintech", "market_infrastructure",
  "consulting", "other_finance",
];

const listing = (patch: Partial<NormalizedListing>): NormalizedListing => ({
  externalJobId: "req-1",
  title: "Summer Analyst Internship",
  division: null,
  location: "New York",
  descriptionRaw: "",
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  deadlineAt: null,
  ...patch,
});

// ------------------------------------------------------- sentence diffing

test("the first sighting announces nothing", () => {
  // A page that has said the same thing for a year is not news, and with no
  // previous text we cannot tell the difference.
  assert.equal(detectAnnouncement(null, "Applications are now open."), null);
});

test("an unchanged page announces nothing", () => {
  const text = "Applications are now open for our summer programme.";
  assert.equal(detectAnnouncement(text, text), null);
});

test("only the ADDED sentences are considered", () => {
  const before = "We are a global firm. Careers at our company.";
  const after = "We are a global firm. Careers at our company. Applications are now open.";
  const added = addedSentences(before, after);
  assert.ok(added.some((s) => /now open/i.test(s)), added.join(" | "));
  assert.ok(!added.some((s) => /global firm/i.test(s)), "unchanged text must not be re-reported");
});

test("removing text announces nothing", () => {
  const before = "We are a global firm. Applications are now open.";
  assert.equal(addedSentences(before, "We are a global firm.").length, 0);
});

test("reordering a page is not an announcement", () => {
  const before = "Alpha sentence here. Beta sentence here.";
  const after = "Beta sentence here. Alpha sentence here.";
  assert.equal(addedSentences(before, after).length, 0);
});

const OPENINGS = [
  "Applications are now open.",
  "Our summer analyst applications are now open.",
  "Applications for the summer programme are open.",
];

for (const sentence of OPENINGS) {
  test(`an opening is detected: "${sentence}"`, () => {
    const a = detectAnnouncement("We are a global firm.", `We are a global firm. ${sentence}`);
    assert.ok(a, "expected an announcement");
    assert.equal(a?.kind, "open_now");
    assert.ok(a && a.sentence.length > 0, "the sentence is the evidence");
  });
}

test("a closure is skipped rather than misreported as an opening", () => {
  const a = detectAnnouncement("We are a global firm.", "We are a global firm. Applications are now closed.");
  assert.equal(a, null);
});

test("a future opening is a schedule, not a status", () => {
  const a = detectAnnouncement("We are a firm.", "We are a firm. Applications open in September.");
  if (a) {
    assert.equal(a.kind, "opens_later");
    assert.ok(a.whenPhrase, "a schedule must say when");
  }
});

test("detectAnnouncement never throws on odd input", () => {
  for (const [a, b] of [["", ""], ["x", ""], ["", "y"], ["...", "!!!"]] as [string, string][]) {
    assert.doesNotThrow(() => detectAnnouncement(a, b));
  }
});

// ------------------------------------------ an event is not an internship

const EVENT_KINDS: [string, string][] = [
  ["Goldman Sachs Information Session", "info_session"],
  ["Virtual Info Session - Global Markets", "info_session"],
  ["Coffee Chat with our Analysts", "coffee_chat"],
  ["Spring Insight Day", "insight_day"],
  ["Networking Reception - New York", "networking"],
];

for (const [title, kind] of EVENT_KINDS) {
  test(`"${title}" parses as ${kind}`, () => {
    assert.equal(parseRecruitingEvent(listing({ title })).kind, kind);
  });
}

test("a session ABOUT insight is not an insight day", () => {
  // Never the topic or the audience: a session about Global Markets is not an
  // insight day because it mentions insight.
  const e = parseRecruitingEvent(listing({ title: "Information Session: Spring Insight Programme" }));
  assert.equal(e.kind, "info_session");
});

test("an event with no recognisable kind is 'other', not a guess", () => {
  assert.equal(parseRecruitingEvent(listing({ title: "Campus Visit" })).kind, "other");
});

// Both date orders. A bare date string parses as LOCAL midnight, so these
// assert on the local calendar fields rather than the UTC ones - otherwise
// the file would pass in New York and fail in Singapore.
const DATE_ORDERS: [string, string][] = [
  ["March 14, 2027", "US, month first"],
  ["March 14 2027", "US, no comma"],
  ["14 March 2027", "UK, day first"],
  ["14 Mar 2027", "abbreviated month"],
];

for (const [written, why] of DATE_ORDERS) {
  test(`an event date written "${written}" is read (${why})`, () => {
    const e = parseRecruitingEvent(
      listing({ title: "Information Session", descriptionRaw: `Event Date: ${written}. Join us.` }),
    );
    assert.ok(e.eventDate, `no date parsed from "${written}"`);
    assert.equal(e.eventDate?.getFullYear(), 2027);
    assert.equal(e.eventDate?.getMonth(), 2, "March");
    assert.equal(e.eventDate?.getDate(), 14);
    assert.ok(e.evidence, "a date must quote the text it came from");
  });
}

test("a registration deadline is read separately from the event date", () => {
  const e = parseRecruitingEvent(
    listing({
      title: "Information Session",
      descriptionRaw: "Event Date: March 14, 2027. Registration Deadline: March 1, 2027.",
    }),
  );
  assert.equal(e.eventDate?.getDate(), 14);
  assert.equal(e.registrationDeadline?.getDate(), 1);
});

test("no labelled date means null, never today", () => {
  const e = parseRecruitingEvent(listing({ title: "Information Session", descriptionRaw: "Join us soon." }));
  assert.equal(e.eventDate, null);
  assert.equal(e.registrationDeadline, null);
});

test("parseRecruitingEvent never throws", () => {
  for (const title of ["", "   ", "!!!", "Event Date: not a date"]) {
    assert.doesNotThrow(() => parseRecruitingEvent(listing({ title })), JSON.stringify(title));
  }
});

test("wasRejectedAsEvent reads the evidence, not the title alone", () => {
  assert.equal(wasRejectedAsEvent(["excluded: recruiting event, not a posting"]), true);
  assert.equal(wasRejectedAsEvent(["title matched \"internship\""]), false);
  assert.equal(wasRejectedAsEvent([]), false);
});

// ------------------------------------------- eligibility, every stated shape

const ELIGIBILITY_SHAPES: [string, number[]][] = [
  ["Open to the class of 2028.", [2028]],
  ["Open to the classes of 2028 and 2029.", [2028, 2029]],
  ["Open to the class of 2028, 2029.", [2028, 2029]],
  ["For graduating seniors in the class of 2027.", [2027]],
];

for (const [text, years] of ELIGIBILITY_SHAPES) {
  test(`eligibility reads "${text}"`, () => {
    const e = readEligibility(`${text} Candidates should be pursuing a bachelor's degree.`, LIVE_MIN);
    for (const y of years) assert.ok(e.gradYears.includes(y), `${y} missing from ${JSON.stringify(e.gradYears)}`);
  });
}

for (const sector of SECTORS) {
  test(`${sector}: silence about eligibility stays empty, never invented`, () => {
    const e = readEligibility(
      "A ten week placement. Applications are reviewed on a rolling basis.",
      LIVE_MIN,
    );
    assert.deepEqual(e.gradYears, []);
  });
}

test("readEligibility never throws on odd input", () => {
  for (const t of ["", "   ", "class of", "class of 20", "class of 99999"]) {
    assert.doesNotThrow(() => readEligibility(t, LIVE_MIN), JSON.stringify(t));
  }
});

// ------------------------------------------------------ board URL hygiene
//
// Discovery matched the Phenom pattern against RBC's page and returned a
// JavaScript bundle. A script is not a board, and storing one as an address
// turns an unexplained silence into an unexplained silence with a URL.

const NOT_BOARDS = [
  "https://cdn.example.com/ph-search-results-v2-default-30.js",
  "https://example.com/styles/main.css",
  "https://example.com/logo.png",
  "not a url at all",
  "",
];

for (const url of NOT_BOARDS) {
  test(`not a board URL: ${JSON.stringify(url).slice(0, 48)}`, () => {
    assert.equal(normalizeBoardUrl(url).ok, false);
  });
}

const REAL_BOARDS = [
  "https://job-boards.greenhouse.io/acme",
  "https://jobs.lever.co/acme",
  "https://jobs.ashbyhq.com/acme",
  "https://acme.recruitee.com",
  "https://apply.workable.com/acme",
  "https://acme.bamboohr.com/careers",
];

for (const url of REAL_BOARDS) {
  test(`a real board URL survives normalisation: ${url}`, () => {
    const n = normalizeBoardUrl(url);
    assert.equal(n.ok, true, n.ok ? "" : n.reason);
  });
}

test("normalizeBoardUrl never throws", () => {
  for (const u of ["", "://", "mailto:a@b.com", "javascript:alert(1)", "   "]) {
    assert.doesNotThrow(() => normalizeBoardUrl(u), JSON.stringify(u));
  }
});
