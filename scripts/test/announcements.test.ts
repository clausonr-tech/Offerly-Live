// Reading an opening out of a careers page's prose.
//
// This is the only thing 64 of 110 monitored firms will ever yield: LionTree
// and Qatalyst have no board at all, because that is how a twenty-analyst
// boutique recruits. What changes on their pages is a sentence.
//
// It had no test file, and its call site was widened last pass - it now runs
// on every source that returns page text, not only the ones yielding no
// listings, because an announcement is about a cycle that has not opened yet
// and no board can carry a posting that does not exist. That change makes the
// noise rules load-bearing in a way they were not before: they now run against
// the prose of boards that DO parse, which is far more text than before.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAnnouncement,
  addedSentences,
  AMBIGUOUS_BELOW,
} from "../../src/lib/monitoring/announcements";

/** Enough characters to clear the 25-char floor in addedSentences. */
const FILLER =
  "We are a global investment bank with offices in New York and London serving clients worldwide.";

const page = (...sentences: string[]) => [FILLER, ...sentences].join(" ");

// ------------------------------------------------------------- the baseline

test("a first sighting is never an announcement", () => {
  // A page that has said the same thing for a year is not news, and with no
  // previous text we cannot tell the difference.
  assert.equal(
    detectAnnouncement(null, page("Applications for our Summer 2028 Analyst Program are now open.")),
    null,
  );
});

test("an empty previous page is treated as no baseline", () => {
  assert.equal(
    detectAnnouncement("", page("Applications for our Summer 2028 Analyst Program are now open.")),
    null,
  );
});

test("an unchanged page announces nothing", () => {
  const text = page("Applications for our Summer 2028 Analyst Program are now open.");
  assert.equal(detectAnnouncement(text, text), null);
});

test("a new sentence on an unchanged page is found", () => {
  const before = page();
  const after = page("Applications for our Summer 2028 Analyst Program are now open.");
  const announcement = detectAnnouncement(before, after);
  assert.ok(announcement);
  assert.equal(announcement.kind, "open_now");
});

// ------------------------------------------------------------ open vs later

const openNow = [
  "Applications for our Summer 2028 Analyst Program are now open.",
  "We are now accepting applications for our Summer 2028 Internship.",
  "Our Summer 2028 Summer Analyst programme is open for applications.",
];
for (const sentence of openNow) {
  test(`read as open now: ${sentence.slice(0, 52)}`, () => {
    const announcement = detectAnnouncement(page(), page(sentence));
    assert.ok(announcement, sentence);
    assert.equal(announcement.kind, "open_now");
  });
}

const opensLater = [
  "Applications for our Summer 2028 Analyst Program will open in September.",
  "Our Summer 2028 Internship applications open in October.",
  "The Summer 2028 Summer Analyst programme will be accepting applications from September.",
];
for (const sentence of opensLater) {
  test(`read as opens later: ${sentence.slice(0, 52)}`, () => {
    // The single most common sentence on these pages, and it must never read
    // as "open now" - that sends students to a page that cannot take them.
    const announcement = detectAnnouncement(page(), page(sentence));
    assert.ok(announcement, sentence);
    assert.equal(announcement.kind, "opens_later");
  });
}

test("a future claim is captured, not discarded", () => {
  // It is the firm saying when its own programme opens, which is the
  // strongest claim this system can hold.
  const announcement = detectAnnouncement(
    page(),
    page("Applications for our Summer 2028 Analyst Program will open in September."),
  );
  assert.ok(announcement);
  assert.equal(announcement.whenPhrase, "September");
});

// --------------------------------------------------------- the year anchoring

test("the when-year is the year BEFORE the cycle, not the cycle itself", () => {
  // Finance recruits roughly eighteen months ahead: applications for Summer
  // 2028 open in autumn 2027. Anchoring September to 2028 would store a window
  // a full year after the thing happens.
  const announcement = detectAnnouncement(
    page(),
    page("Applications for our Summer 2028 Analyst Program will open in September."),
  );
  assert.equal(announcement?.cycleYear, 2028);
  assert.equal(announcement?.whenYear, 2027);
});

const earlyMonths = ["January", "February", "March"];
for (const month of earlyMonths) {
  test(`${month} falls inside the internship year itself`, () => {
    const announcement = detectAnnouncement(
      page(),
      page(`Applications for our Summer 2028 Analyst Program will open in ${month}.`),
    );
    assert.equal(announcement?.whenYear, 2028, month);
  });
}

const lateMonths = ["August", "September", "October", "November", "December"];
for (const month of lateMonths) {
  test(`${month} belongs to the year before the cycle`, () => {
    const announcement = detectAnnouncement(
      page(),
      page(`Applications for our Summer 2028 Analyst Program will open in ${month}.`),
    );
    assert.equal(announcement?.whenYear, 2027, month);
  });
}

test("no cycle year means no when-year, rather than a guessed one", () => {
  const announcement = detectAnnouncement(
    page(),
    page("Applications for our internship programme will open in September."),
  );
  assert.equal(announcement?.cycleYear, null);
  assert.equal(announcement?.whenYear, null);
});

test('"the fall" is kept as the firm\'s own words', () => {
  // vague stays vague: parseWindow returns null rather than guessing, and a
  // null window still leaves a dated, quotable claim.
  const announcement = detectAnnouncement(
    page(),
    page("Applications for our Summer 2028 Analyst Program will open in the fall."),
  );
  assert.equal(announcement?.whenPhrase, "the fall");
});

test('"the fall" is not read as the bare word "the"', () => {
  // The alternation order in whenPhraseIn exists for this: a case-insensitive
  // leading [A-Z][a-z]+ matched "the", which parseWindow cannot read.
  const announcement = detectAnnouncement(
    page(),
    page("Applications will open in the autumn for our Summer 2028 Analyst Program."),
  );
  assert.notEqual(announcement?.whenPhrase, "the");
});

test("a qualified month keeps its qualifier", () => {
  const announcement = detectAnnouncement(
    page(),
    page("Our Summer 2028 Internship applications open in early October."),
  );
  assert.match(announcement?.whenPhrase ?? "", /early\s+October/i);
});

// ------------------------------------------------------------ what is skipped

const closures = [
  "Applications for our Summer 2027 Analyst Program are closed.",
  "We are no longer accepting applications for the Summer 2027 Internship.",
  "Our Summer Analyst programme is closed for the season.",
  "The deadline has passed for our Summer 2027 Internship applications.",
];
for (const sentence of closures) {
  test(`a closure is never read as an opening: ${sentence.slice(0, 46)}`, () => {
    assert.equal(detectAnnouncement(page(), page(sentence)), null, sentence);
  });
}

const noise = [
  "This website uses cookies to improve your experience on our careers pages.",
  "Please review our privacy policy before applying to any of our programmes.",
  "Copyright 2026 Example Bank. All rights reserved worldwide and in perpetuity.",
  "Sign in to your candidate account to track your internship application status.",
  "Subscribe to our newsletter for updates on our internship programme openings.",
  "Follow us on social media for news about our Summer 2028 Analyst Program.",
];
for (const sentence of noise) {
  test(`page furniture is not an announcement: ${sentence.slice(0, 44)}`, () => {
    // These change on their own. With detection now running on boards that
    // parse too, the noise list sees far more text than it used to.
    assert.equal(detectAnnouncement(page(), page(sentence)), null, sentence);
  });
}

test("an ordinary new sentence with no opening language is ignored", () => {
  const announcement = detectAnnouncement(
    page(),
    page("Our people are our greatest asset and we invest heavily in their development."),
  );
  assert.equal(announcement, null);
});

test("a sentence about a past programme is not an opening", () => {
  const announcement = detectAnnouncement(
    page(),
    page("Our Summer 2027 Analyst Program welcomed one hundred and twenty students."),
  );
  assert.equal(announcement, null);
});

// ------------------------------------------------------------- confidence

test("naming the programme and the cycle scores highest", () => {
  const announcement = detectAnnouncement(
    page(),
    page("Applications for our Summer 2028 Summer Analyst Program are now open."),
  );
  assert.ok(announcement);
  assert.ok(announcement.confidence >= AMBIGUOUS_BELOW);
});

test("an opening phrase alone is too weak to write a signal", () => {
  // "apply now" sits beside a general careers mailbox on half these pages.
  const announcement = detectAnnouncement(
    page(),
    page("We are now accepting applications through our general careers mailbox."),
  );
  if (announcement) assert.ok(announcement.confidence < AMBIGUOUS_BELOW);
});

test("a future claim with no stated month is penalised", () => {
  // Not a schedule anyone can use.
  const withMonth = detectAnnouncement(
    page(),
    page("Applications for our Summer 2028 Internship will open in September."),
  );
  const withoutMonth = detectAnnouncement(
    page(),
    page("Applications for our Summer 2028 Internship will open soon."),
  );
  assert.ok(withMonth);
  assert.ok(withoutMonth);
  assert.ok(withoutMonth.confidence < withMonth.confidence);
});

test("confidence never leaves the 0 to 1 range", () => {
  const sentences = [
    "Applications for our Summer 2028 Summer Analyst Program are now open.",
    "Applications will open soon.",
    "We are now accepting applications.",
    "Our Summer 2028 Internship applications open in October.",
  ];
  for (const sentence of sentences) {
    const announcement = detectAnnouncement(page(), page(sentence));
    if (!announcement) continue;
    assert.ok(announcement.confidence >= 0 && announcement.confidence <= 1, sentence);
  }
});

test("the strongest sentence on the page wins", () => {
  const announcement = detectAnnouncement(
    page(),
    page(
      "We are now accepting applications through our general careers mailbox.",
      "Applications for our Summer 2028 Summer Analyst Program are now open.",
    ),
  );
  assert.ok(announcement);
  assert.match(announcement.sentence, /Summer Analyst Program/);
});

// ------------------------------------------------------- the evidence itself

test("the sentence is carried verbatim, because it is the evidence", () => {
  // Same rule the classifier follows: a claim that cannot say where it came
  // from is not reviewable, and an unreviewable date is worse than none.
  const sentence = "Applications for our Summer 2028 Analyst Program are now open.";
  const announcement = detectAnnouncement(page(), page(sentence));
  assert.equal(announcement?.sentence, sentence);
});

test("a very long sentence is truncated rather than dropped", () => {
  const long = `Applications for our Summer 2028 Analyst Program are now open ${"and ".repeat(120)}.`;
  const announcement = detectAnnouncement(page(), page(long));
  if (announcement) assert.ok(announcement.sentence.length <= 300);
});

// ---------------------------------------------------- the diff is the filter

test("reflowed whitespace is not new text", () => {
  // Career sites reflow constantly and every reflow would otherwise look like
  // an announcement - which matters far more now that this runs on boards
  // that parse.
  const before = page("Applications for our Summer 2028 Analyst Program are now open.");
  const after = before.replace(/ /g, "  ").replace(/\. /g, ".\n ");
  assert.equal(detectAnnouncement(before, after), null);
});

test("a change of case is not new text", () => {
  const before = page("Applications for our Summer 2028 Analyst Program are now open.");
  assert.equal(detectAnnouncement(before, before.toUpperCase()), null);
});

test("punctuation churn is not new text", () => {
  const before = page("Applications for our Summer 2028 Analyst Program are now open.");
  const after = before.replace(/,/g, " -").replace(/'/g, "’");
  assert.equal(detectAnnouncement(before, after), null);
});

test("removing text does not announce anything", () => {
  const before = page("Applications for our Summer 2028 Analyst Program are now open.");
  assert.equal(detectAnnouncement(before, page()), null);
});

// ------------------------------------------------------------ addedSentences

test("added sentences are only the new ones", () => {
  const before = "This is a sentence that is quite long enough to count here.";
  const after = `${before} And here is a second sentence that is also long enough.`;
  const added = addedSentences(before, after);
  assert.equal(added.length, 1);
  assert.match(added[0], /second sentence/);
});

test("a fragment shorter than the floor is not a sentence", () => {
  // Short fragments are navigation and labels, not prose.
  const added = addedSentences("", "Apply. Jobs. News. Home.");
  assert.equal(added.length, 0);
});

test("a block longer than the ceiling is not a sentence", () => {
  const added = addedSentences("", "x".repeat(500));
  assert.equal(added.length, 0);
});

test("bullet separators split sentences", () => {
  const added = addedSentences(
    "",
    "Applications are open for our Summer 2028 programme • Interns join in June each year",
  );
  assert.ok(added.length >= 2);
});

test("identical text yields nothing added", () => {
  const text = "This is a sentence that is quite long enough to count here.";
  assert.deepEqual(addedSentences(text, text), []);
});

test("addedSentences does not throw on empty input", () => {
  assert.doesNotThrow(() => addedSentences("", ""));
  assert.deepEqual(addedSentences("", ""), []);
});

// -------------------------------------------------------------- robustness

const degenerate: [string | null, string][] = [
  [null, ""],
  ["", ""],
  ["a", "b"],
  ["\n\n\n", "\t\t\t"],
  ["previous text here that is long enough to be a sentence.", ""],
  ["x".repeat(10000), "y".repeat(10000)],
  ["  ", "  "],
];
for (const [before, after] of degenerate) {
  test(`degenerate input does not throw: ${JSON.stringify(String(before).slice(0, 14))}`, () => {
    assert.doesNotThrow(() => detectAnnouncement(before, after));
  });
}

test("an announcement always carries every field it promises", () => {
  const announcement = detectAnnouncement(
    page(),
    page("Applications for our Summer 2028 Summer Analyst Program will open in September."),
  );
  assert.ok(announcement);
  assert.ok(["open_now", "opens_later"].includes(announcement.kind));
  assert.equal(typeof announcement.sentence, "string");
  assert.equal(typeof announcement.confidence, "number");
  assert.ok(announcement.cycleYear === null || typeof announcement.cycleYear === "number");
  assert.ok(announcement.whenYear === null || typeof announcement.whenYear === "number");
});

test("open_now never carries a whenPhrase", () => {
  // A live sighting says it had opened BY now and nothing about when.
  const announcement = detectAnnouncement(
    page(),
    page("Applications for our Summer 2028 Analyst Program are now open."),
  );
  assert.equal(announcement?.kind, "open_now");
  assert.equal(announcement?.whenPhrase, null);
});

// ------------------------------------------------- phrasings added 19 Sep

const subjectFirst = [
  "Our Summer 2028 Summer Analyst programme is open for applications.",
  "The Summer 2028 Internship is now open for applications.",
  "Our Summer 2028 Analyst Program is open for submissions.",
];
for (const sentence of subjectFirst) {
  test(`the subject-first form is read: ${sentence.slice(0, 48)}`, () => {
    // Every original pattern put "applications" first. A careers page writes
    // it the other way round just as often, and that sentence - naming the
    // programme AND the cycle, the highest-confidence shape there is - was
    // read as nothing at all.
    const announcement = detectAnnouncement(page(), page(sentence));
    assert.ok(announcement, sentence);
    assert.equal(announcement.kind, "open_now");
  });
}

const invited = [
  "Applications are invited for our Summer 2028 Analyst Program.",
  "Applications are now invited for the Summer 2028 Internship.",
];
for (const sentence of invited) {
  test(`the British phrasing is read: ${sentence.slice(0, 48)}`, () => {
    const announcement = detectAnnouncement(page(), page(sentence));
    assert.ok(announcement, sentence);
  });
}

test("the new phrasings still lose to a closure on the same page", () => {
  assert.equal(
    detectAnnouncement(
      page(),
      page("Our Summer 2028 Summer Analyst programme is open for applications but the deadline has passed."),
    ),
    null,
  );
});

test("the new phrasings do not fire on unrelated prose", () => {
  for (const sentence of [
    "Our offices are open for visitors throughout the working week in London.",
    "The trading floor is open for business at seven in the morning each day.",
  ]) {
    assert.equal(detectAnnouncement(page(), page(sentence)), null, sentence);
  }
});
