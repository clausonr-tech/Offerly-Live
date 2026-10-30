import assert from "node:assert/strict";
import test from "node:test";

import { employersFrom, seniorityFor, titlesFor } from "@/lib/contact-sourcing-agent";

test("titles follow the business being searched, not one list for everything", () => {
  assert.ok(titlesFor("investment_banking").includes("Investment Banking"));
  assert.ok(titlesFor("private_equity").includes("Private Equity"));
  assert.ok(!titlesFor("private_equity").includes("Investment Banking"));
});

test("titles say what someone DOES, never how senior they are", () => {
  // The invariant that matters. A search on "Analyst" returns Legal Analysts
  // and Risk Analysts; a search on "Associate" returns HR Business Partners.
  // Both happened. Seniority is a separate filter and belongs there.
  const seniorityWords = /\b(Analyst|Associate|Vice President|Principal|Partner|Manager)\b/;
  for (const category of [
    "investment_banking",
    "private_equity",
    "venture_capital",
    "sales_trading",
    "real_estate",
  ] as const) {
    for (const title of titlesFor(category)) {
      assert.ok(
        !seniorityWords.test(title),
        `"${title}" (${category}) is a seniority word, not a function`,
      );
    }
  }
});

test("no known business means no title filter, rather than an invented one", () => {
  // A filter we cannot fill correctly excludes the right people silently. The
  // seniority and tenure filters still bound the search.
  assert.deepEqual(titlesFor(null), []);
});

test("seniority carries the seats that actually reply, and stops at associate", () => {
  // Vice presidents were in this list and were what came back. A VP does not
  // answer a sophomore.
  for (const c of ["investment_banking", "private_equity"] as const) {
    assert.ok(!seniorityFor(c).includes("vice_president"), c);
    assert.ok(seniorityFor(c).length > 0, c);
  }
});

test("prior employers are cleaned and bounded", () => {
  assert.deepEqual(employersFrom(["  Goldman Sachs ", "", "  ", "Evercore"]), [
    "Goldman Sachs",
    "Evercore",
  ]);
  assert.equal(employersFrom(null).length, 0);
  assert.equal(employersFrom(Array.from({ length: 20 }, (_, i) => `Firm ${i}`)).length, 8);
});

import {
  buildSearchQuery,
  splitInterests,
  type StudentDossier,
} from "@/lib/contact-sourcing-agent";

const PRIVATE_HOMETOWN = "Boise, Idaho";
const PRIVATE_INTERESTS = "college football, poker, hiking";

const dossier: StudentDossier = {
  identity: {
    name: "Alex Morgan",
    school: "University of Southern California",
    major: "Economics",
    gradYear: 2028,
    hometown: PRIVATE_HOMETOWN,
  },
  targeting: {
    sectors: ["investment_banking"],
    sectorLabels: ["Investment Banking"],
    coverage: ["Healthcare"],
    ibTiers: ["Bulge Bracket"],
    peTiers: [],
    locations: ["New York City"],
    recruitingStage: "Applying now",
  },
  background: {
    clubs: "Trojan Investing Society",
    priorExperience: ["Evercore"],
    interests: PRIVATE_INTERESTS,
    proudExperience: "Ran the club's stock pitch competition",
    workStyle: "fast-paced",
  },
  resume: {
    present: true,
    chars: 4200,
    interests: ["Distance running", "Formula 1"],
    skills: ["Excel", "Python"],
    employers: ["Evercore"],
    activities: ["Trojan Investing Society"],
  },
  linkedinUrl: "https://www.linkedin.com/in/example/",
  consent: { shareHometown: false, shareInterests: false },
};

const query = buildSearchQuery({
  dossier,
  firm: { name: "Goldman Sachs", website: "goldmansachs.com" },
  category: "investment_banking",
  limit: 5,
  existing: [{ name: "Maya Chen", linkedinUrl: "https://www.linkedin.com/in/maya/" }],
});

test("hometown and typed interests are in the keywords, whatever the profile toggles say", () => {
  // Owner's decision, 8 October 2026: the public-profile toggles decide what
  // other students see, not what the contact search may use. (Keywords only
  // leave Offerly through affinity searches, which are off unless
  // CONTACT_AFFINITY_SEARCH=on - see contact-sourcing-record-db.test.ts.)
  assert.ok(query.keywords.includes(PRIVATE_HOMETOWN), "hometown missing from the keywords");
  for (const typed of PRIVATE_INTERESTS.split(",").map((s) => s.trim())) {
    assert.ok(query.keywords.includes(typed), `typed interest "${typed}" missing from the keywords`);
  }
  // Free-text background beyond clubs and interests still stays local.
  assert.ok(!JSON.stringify(query).includes("Ran the club"), "free-text background leaked");
});

test("resume interests are in the keywords", () => {
  assert.ok(query.keywords.includes("Distance running"));
  assert.ok(query.keywords.includes("Formula 1"));
});

test("the outbound search carries what a people search actually needs", () => {
  assert.equal(query.employer.name, "Goldman Sachs");
  assert.equal(query.employer.domain, "goldmansachs.com");
  assert.ok(query.keywords.includes("Healthcare"));
  assert.deepEqual(query.location.cities, ["New York City"]);
  assert.equal(query.education.school?.label, "University of Southern California");
  // The major ranks results; it is never a filter (see crustdata-client).
  assert.ok(!("fieldOfStudy" in query.education));
  assert.equal(query.limit, 5);
});

test("the payload says who we are looking for, not just where", () => {
  // Without this the provider knows the firm and nothing about the seat, and
  // returns whoever it likes - including MDs who do not answer students.
  assert.ok(query.person.titleAnyOf.includes("Investment Banking"));
  assert.deepEqual(query.person.seniorityLevels, ["analyst", "associate"]);
  assert.ok(query.person.maxYearsExperience > 0);
  assert.equal(query.education.school?.label, "University of Southern California");
});

test("clubs travel in both spellings, from every source, listed once", () => {
  // The student wrote the club in their onboarding answer AND it appears on
  // their resume. One club, not two.
  assert.equal(
    query.keywords.filter((c) => c === "Trojan Investing Society").length,
    1,
    "the same club was listed twice",
  );
  // A profile that says "TIS" and a profile that spells it out are the same
  // person's club, so both spellings have to be searchable.
  assert.ok(query.keywords.includes("Trojan Investing Society"));
  assert.ok(query.keywords.includes("TIS"));
});

test("the payload admits when the seat is not the sector the student picked", () => {
  // Goldman has an investment bank and the student wants investment banking,
  // so this one matched.
  assert.equal(query.matchedStudentSector, true);

  // Blackstone has no investment bank - PJT was spun out - so an IB student
  // searching there is shown PE people. That is a defensible fallback, but it
  // is a fallback, and the flag is what lets the UI say so.
  const fallback = buildSearchQuery({
    dossier,
    firm: { name: "Blackstone", website: "blackstone.com" },
    category: "private_equity",
    limit: 5,
    existing: [],
  });
  assert.equal(fallback.matchedStudentSector, false);
  assert.deepEqual(fallback.person.seniorityLevels, ["analyst", "associate", "senior_associate"]);
});

test("people already saved at the firm are excluded, so a second click buys new names", () => {
  assert.deepEqual(query.exclude.names, ["Maya Chen"]);
  assert.deepEqual(query.exclude.linkedinUrls, ["https://www.linkedin.com/in/maya/"]);
});

test("turning the profile toggles on changes nothing in the keywords", () => {
  const shared = buildSearchQuery({
    dossier: { ...dossier, consent: { shareHometown: true, shareInterests: true } },
    firm: { name: "Goldman Sachs", website: "goldmansachs.com" },
    category: "investment_banking",
    limit: 5,
    existing: [],
  });

  assert.deepEqual(shared.keywords, query.keywords.filter(Boolean), "same keywords as with the toggles off");
  assert.ok(shared.keywords.includes(PRIVATE_HOMETOWN));
  // Resume interests first, then the typed field.
  for (const k of ["Distance running", "Formula 1", "college football", "poker", "hiking"]) {
    assert.ok(shared.keywords.includes(k), k);
  }
});

test("a field with nothing to send is absent, not merely blank", () => {
  // A present-but-empty key still says "we hold this and considered sending
  // it". Absence is the only honest representation of "nothing to share".
  const noHometown = buildSearchQuery({
    dossier: { ...dossier, identity: { ...dossier.identity, hometown: null } },
    firm: { name: "Goldman Sachs", website: "goldmansachs.com" },
    category: "investment_banking",
    limit: 5,
    existing: [],
  });
  assert.ok(noHometown.keywords.every((k) => k.trim() !== ""), "a blank keyword was sent");
  assert.ok(!noHometown.keywords.includes(PRIVATE_HOMETOWN));
});

test("nothing stored means nothing in the keywords, whatever the toggles say", () => {
  const empty = buildSearchQuery({
    dossier: {
      ...dossier,
      identity: { ...dossier.identity, hometown: null },
      background: { ...dossier.background, interests: null },
      // The resume is the other source of interests, so "nothing stored" has
      // to mean nothing in either place.
      resume: { ...dossier.resume, interests: [] },
      consent: { shareHometown: true, shareInterests: true },
    },
    firm: { name: "Goldman Sachs", website: "goldmansachs.com" },
    category: "investment_banking",
    limit: 5,
    existing: [],
  });

  assert.ok(!empty.keywords.some((k) => k === PRIVATE_HOMETOWN));
  assert.ok(!empty.keywords.some((k) => k === "poker"));
});

test("interests split into separate hooks a search can use", () => {
  assert.deepEqual(splitInterests("college football, poker, hiking"), [
    "college football",
    "poker",
    "hiking",
  ]);
  assert.deepEqual(splitInterests(null), []);
  assert.equal(splitInterests("a,b,c,d,e,f,g,h,i,j").length, 8);
});

test("typed interests follow the resume's, with or without the interests toggle", () => {
  const shared = buildSearchQuery({
    dossier: { ...dossier, consent: { shareHometown: false, shareInterests: true } },
    firm: { name: "Goldman Sachs", website: "goldmansachs.com" },
    category: "investment_banking",
    limit: 5,
    existing: [],
  });

  assert.ok(shared.keywords.includes("Distance running"), "resume interests missing");
  assert.ok(shared.keywords.includes("poker"), "typed interests missing");
});

test("a student with no resume interests still has their typed interests in the keywords, toggles off", () => {
  const typedOnly = buildSearchQuery({
    dossier: {
      ...dossier,
      resume: { ...dossier.resume, interests: [] },
      consent: { shareHometown: false, shareInterests: false },
    },
    firm: { name: "Goldman Sachs", website: "goldmansachs.com" },
    category: "investment_banking",
    limit: 5,
    existing: [],
  });

  assert.ok(typedOnly.keywords.includes("poker"), "typed interests dropped when the profile toggle is off");
});

import { alumniSince } from "@/lib/contact-sourcing-agent";

test("the alumni window counts back from the click, not from the student", () => {
  // Two students searching the same firm on the same day see the same pool -
  // a freshman does not get a narrower one than a senior.
  // Local-time constructor: a "2031-01-01" string parses as UTC and lands in
  // the previous year west of Greenwich.
  assert.equal(alumniSince(new Date(2026, 8, 17)), 2006);
  assert.equal(alumniSince(new Date(2031, 0, 1)), 2011);
});

test("the payload carries that window, not a student-relative one", () => {
  assert.equal(query.education.graduatedOnOrAfter, new Date().getFullYear() - 20);
});
