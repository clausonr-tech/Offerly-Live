// Six just-built changes, adversarially - pure tables and end to end against a
// real (in-memory) Postgres:
//
//   1. School nicknames match (lib/school-name.ts, wired into relevance,
//      contact-similarity and draft-suggestions' free-text scan).
//   2. Role names never split one application into two (lib/role-name.ts,
//      lib/application-identity.ts, every path that adds a tracker row).
//   3. A withdrawn posting stops reminders for its tracker entry, even with a
//      Schedule deadline linked to it.
//   4. Imported calendar events are classified (lib/event-type-guess.ts), and
//      the classification drives interview prep and thank-yous.
//   5. The dashboard's "Applied yet?" list and its "I applied".
//   6. The opening-day apply prompt still appears after the countdown row was
//      ticked.
//
// Tests state CORRECT behaviour (the owner's decisions). A failing test here is
// a finding. Product questions are not asserted - see the report.
//
// Server actions import next/navigation and cannot load outside Next, so each
// is replayed step for step with the same lib calls.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed, fetch throws, and
// the database is an in-memory PGlite migrated from drizzle/*.sql.

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { after, before, describe, test } from "node:test";

import "./helpers/no-network";
import { and, eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import {
  applications,
  contacts,
  events,
  firms,
  internshipPostings,
  notifications,
  todoDismissals,
  userTopFirms,
  users,
} from "@/db/schema";
import { sameSchoolName, schoolKey, schoolSpellings } from "@/lib/school-name";
import { sameSchool as relevanceSameSchool } from "@/lib/relevance";
import { compareContact } from "@/lib/contact-similarity";
import { findConnections } from "@/lib/draft-suggestions";
import { roleKey, sameRole } from "@/lib/role-name";
import { guessEventType, type GuessedType } from "@/lib/event-type-guess";
import { openApplications, type ReminderCandidate } from "@/lib/application-reminders";
import { blockedLanguageError } from "@/lib/content-limits";
import { localParts, parseTimeZone, zonedTime } from "@/lib/time-zone";

delete process.env.DATABASE_URL;

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";
const LONDON = "Europe/London";
const HOUR = 3_600_000;

// ------------------------------------------------------------------ the clock

const RealDate = Date;
let fakeNow: number | null = null;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(fakeNow ?? RealDate.now());
    else super(...(args as [number]));
  }
  static now() {
    return fakeNow ?? RealDate.now();
  }
  static [Symbol.hasInstance](x: unknown) {
    return x instanceof RealDate;
  }
}
(globalThis as { Date: DateConstructor }).Date = ClockDate as unknown as DateConstructor;
function clock(at: Date) {
  fakeNow = at.getTime();
}
const local = (tz: string, y: number, m: number, d: number, h = 9, min = 0) => zonedTime(y, m, d, h, min, tz);
const utcDay = (iso: string) => new RealDate(`${iso}T00:00:00Z`);

// ============================================================================
// 1. SCHOOLS - pure
// ============================================================================

/** SCHOOL_GROUPS, read from the module's source so a new group is covered too. */
function schoolGroupsFromSource(): string[][] {
  const src = readFileSync(resolvePath(process.cwd(), "src/lib/school-name.ts"), "utf8");
  const start = src.indexOf("const SCHOOL_GROUPS");
  const end = src.indexOf("\n];", start);
  assert.ok(start > 0 && end > start, "SCHOOL_GROUPS not found in src/lib/school-name.ts");
  const block = src.slice(start, end);
  const groups: string[][] = [];
  for (const m of block.matchAll(/\[((?:\s*"[^"]*"\s*,?)+)\]/g)) {
    groups.push([...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
  }
  return groups;
}
const GROUPS = schoolGroupsFromSource();
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** compareContact's school verdict, as the contact search reads it. */
const ccSchool = (mine: string, theirs: string) =>
  compareContact({ student: { school: mine }, contact: { name: "Riley Park", school: theirs } }).matches.some(
    (m) => m.kind === "school",
  );
/** The drafter's common ground, read from a background in prose. */
const fcSchool = (mine: string, background: string) =>
  findConnections({ school: mine }, { name: "Riley Park", background }).some((c) => c.kind === "school");

describe("schools: every group in SCHOOL_GROUPS folds onto its canonical name", () => {
  test("the table was read (sanity)", () => {
    assert.ok(GROUPS.length >= 40, `only ${GROUPS.length} groups read`);
    assert.deepEqual(GROUPS[0].slice(0, 2), ["university of pennsylvania", "penn"]);
  });
  for (const group of GROUPS) {
    const [canonical, ...rest] = group;
    test(`${canonical}: ${rest.length} other names, in any case, everywhere`, () => {
      for (const alias of [canonical, ...rest]) {
        for (const written of [alias, titleCase(alias), alias.toUpperCase()]) {
          assert.ok(sameSchoolName(written, canonical), `sameSchoolName(${written}, ${canonical})`);
          assert.ok(sameSchoolName(canonical, written), `symmetric: ${written}`);
          assert.ok(relevanceSameSchool(written, titleCase(canonical)), `relevance: ${written}`);
          assert.ok(ccSchool(written, titleCase(canonical)), `contact search: ${written}`);
          assert.ok(ccSchool(titleCase(canonical), written), `contact search, reversed: ${written}`);
        }
        assert.deepEqual(schoolSpellings(alias), schoolSpellings(canonical), `spellings of ${alias}`);
      }
    });
    test(`${canonical}: no name in it means another group's school`, () => {
      for (const other of GROUPS) {
        if (other === group) continue;
        for (const alias of group) {
          assert.ok(!sameSchoolName(alias, other[0]), `${alias} folded onto ${other[0]}`);
        }
      }
    });
  }
});

/** Pairs that are one school however written - including how profiles write them. */
const SAME_SCHOOL: [string, string][] = [
  ["Penn", "University of Pennsylvania"],
  ["UPenn", "Wharton"],
  ["U. Penn", "The Wharton School"],
  ["U-Penn", "Univ. of Pennsylvania"],
  ["Wharton", "university of pennsylvania"],
  ["NYU", "New York University"],
  ["NYU Stern", "Stern School of Business"],
  ["Michigan", "University of Michigan"],
  ["UMich", "Michigan Ross"],
  ["UVA", "University of Virginia"],
  ["UNC", "University of North Carolina at Chapel Hill"],
  ["UNC-Chapel Hill", "Kenan-Flagler"],
  ["Cal", "UC Berkeley"],
  ["Berkeley", "University of California, Berkeley"],
  ["UCLA", "University of California, Los Angeles"],
  ["Duke", "Duke University"],
  ["Georgetown", "Georgetown University"],
  ["Notre Dame", "University of Notre Dame"],
  ["Texas A&M", "Texas A & M University"],
  ["TAMU", "Texas A&M"],
  ["UT Austin", "The University of Texas at Austin"],
  ["WashU", "Washington University in St. Louis"],
  ["Wash U", "WUSTL"],
  ["Georgia Tech", "Georgia Institute of Technology"],
  ["Université de Montréal", "Universite de Montreal"],
  ["Penn State", "Penn State University"],
  ["Michigan State", "Michigan State University"],
  // How the profiles the contact search returns write them.
  ["Penn", "The Wharton School of the University of Pennsylvania"],
  ["University of Pennsylvania", "Wharton School of the University of Pennsylvania"],
  ["Michigan", "University of Michigan - Ann Arbor"],
  ["Penn State", "Pennsylvania State University"],
  ["Penn State", "The Pennsylvania State University"],
  ["NYU", "NYU Stern School of Business"],
];

/** Pairs that must never match (the owner's list and its neighbours). */
const DIFFERENT_SCHOOL: [string, string][] = [
  ["Penn", "Penn State"],
  ["UPenn", "Penn State University"],
  ["University of Pennsylvania", "Pennsylvania State University"],
  ["Wharton", "Smeal"],
  ["Michigan", "Michigan State"],
  ["University of Michigan", "Michigan State University"],
  ["Ross", "Broad"],
  ["Miami University", "University of Miami"],
  ["University of Miami", "Miami University (Ohio)"],
  ["University of Washington", "Washington University in St. Louis"],
  ["WashU", "University of Washington"],
  ["Foster", "Olin"],
  ["Indiana University", "Indiana University of Pennsylvania"],
  ["Penn", "Indiana University of Pennsylvania"],
  ["University of Pennsylvania", "Indiana University of Pennsylvania"],
  ["Boston College", "Boston University"],
  ["BC", "BU"],
  ["USC", "UCLA"],
  ["Northwestern", "Northeastern University"],
  ["Ohio State", "Ohio University"],
  // Ambiguous short forms, deliberately not folded.
  ["U of M", "University of Michigan"],
  ["U of M", "University of Minnesota"],
  ["UW", "University of Washington"],
  ["UW", "University of Wisconsin-Madison"],
  ["OSU", "Ohio State University"],
  ["OSU", "Oklahoma State University"],
  ["MSU", "Michigan State University"],
  ["PSU", "Penn State University"],
  ["UT", "UT Austin"],
  // Campuses and neighbours that share a word.
  ["Michigan", "Central Michigan University"],
  ["UNC", "UNC Charlotte"],
  ["Cal", "Cal Poly"],
  ["University of Texas at Austin", "UTA"],
  ["USC", "University of South Carolina"],
  ["University of Washington", "UW Madison"],
];

describe("schools: the same school, written two ways, matches everywhere", () => {
  for (const [a, b] of SAME_SCHOOL) {
    test(`${a} == ${b}`, () => {
      assert.ok(relevanceSameSchool(a, b), "relevance score (lib/relevance.ts)");
      assert.ok(ccSchool(a, b), "contact search (compareContact)");
      assert.ok(ccSchool(b, a), "contact search, reversed");
    });
  }
});

describe("schools: different schools never match, anywhere", () => {
  for (const [a, b] of DIFFERENT_SCHOOL) {
    test(`${a} != ${b}`, () => {
      assert.ok(!sameSchoolName(a, b), "sameSchoolName");
      assert.ok(!relevanceSameSchool(a, b), "relevance score");
      assert.ok(!ccSchool(a, b), "contact search (compareContact)");
      assert.ok(!ccSchool(b, a), "contact search, reversed");
      assert.ok(!fcSchool(a, `BS Finance, ${b}, 2016`), "drafter's background scan");
    });
  }
});

describe("schools: finding the student's school in a background", () => {
  const FOUND: [string, string][] = [
    ["Penn", "BA Economics, University of Pennsylvania, 2019"],
    ["Penn", "The Wharton School, class of 2019"],
    ["UPenn", "Wharton School grad, now in TMT"],
    ["Wharton", "Studied at UPenn before joining Evercore"],
    ["NYU", "NYU Stern '18, Moelis since"],
    ["NYU", "New York University (BS, Finance)"],
    ["Michigan", "University of Michigan, Ross School of Business"],
    ["Michigan", "Michigan Ross BBA 2020"],
    ["UVA", "UVA McIntire School of Commerce"],
    ["UNC", "UNC Kenan-Flagler, BSBA"],
    ["Berkeley", "UC Berkeley Haas undergrad"],
    ["UCLA", "UCLA Anderson MBA"],
    ["Harvard", "Harvard Business School MBA"],
    ["MIT", "MIT Sloan, then Blackstone"],
    ["Columbia", "Columbia Business School MBA"],
    ["Cornell", "Cornell Dyson, Applied Economics"],
    ["Georgetown", "Georgetown McDonough '17"],
    ["Notre Dame", "University of Notre Dame, Mendoza"],
    ["Boston College", "Carroll School of Management"],
    ["Duke", "Duke University, Economics"],
    ["Stanford", "Stanford GSB"],
    ["UChicago", "University of Chicago, Economics"],
    ["WashU", "Washington University in St. Louis, Olin"],
    ["Georgia Tech", "Georgia Institute of Technology"],
    ["Indiana University", "Indiana University Kelley School of Business"],
    ["LSE", "London School of Economics, MSc Finance"],
    ["CMU", "Carnegie Mellon University, Tepper"],
    ["Texas A&M", "Texas A&M University, Mays Business School"],
    ["TAMU", "Texas A&M University"],
  ];
  for (const [school, bg] of FOUND) {
    test(`${school} is found in "${bg}"`, () => {
      assert.ok(fcSchool(school, bg));
    });
  }

  const NOT_FOUND: [string, string][] = [
    ["Penn", "Penn State University, Smeal College of Business"],
    ["Penn", "BS, Indiana University of Pennsylvania"],
    ["Indiana University", "BS, Indiana University of Pennsylvania"],
    ["University of Michigan", "Michigan State University, Broad"],
    ["University of Miami", "Miami University (Ohio), Farmer School"],
    ["University of Washington", "Washington University in St. Louis"],
    ["WashU", "University of Washington, Foster"],
    ["Columbia", "Previously an analyst at CBS Corporation"],
    ["London School of Economics", "Listings team at the London Stock Exchange (LSE)"],
    ["UNC", "UNC Charlotte, Belk College of Business"],
    ["Cornell", "Brand manager at SC Johnson, then consulting"],
    ["Boston College", "Associate at BC Partners"],
    ["BU", "BU Partners"],
    ["NYU", "Worked under Jonathan Stern on the M&A team"],
    ["Michigan", "Summer at Ross Stores, then Lazard"],
    ["Rice", "Jones Day, then Evercore"],
    ["WashU", "Olin Corporation, corporate development"],
    ["Duke", "Duke Energy, corporate finance"],
    ["Brown", "Brown Brothers Harriman"],
    ["Notre Dame", "ND Capital"],
    ["Northwestern", "Northwestern Mutual"],
    ["U of M", "U of M alum"],
    ["OSU", "OSU grad"],
  ];
  for (const [school, bg] of NOT_FOUND) {
    test(`${school} is NOT found in "${bg}"`, () => {
      assert.ok(!fcSchool(school, bg));
    });
  }

  test("relevance score: same school worth 40, via the table", async () => {
    const { computeRelevanceScore } = await import("@/lib/relevance");
    const r = computeRelevanceScore(
      { school: "Penn", hometown: null, interests: null, targetGroup: null },
      { school: "University of Pennsylvania", background: null, notes: null },
    );
    assert.equal(r.score, 40);
    assert.deepEqual(r.reasons, ["Same school"]);
  });
  test("schoolKey: empty and junk are empty, and never equal", () => {
    for (const junk of [null, undefined, "", "   ", "---"]) {
      assert.ok(!sameSchoolName(junk, junk), `${String(junk)} matched itself`);
    }
    assert.equal(schoolKey("The Duke University"), schoolKey("Duke"));
  });
});

// ============================================================================
// 2. ROLES - pure
// ============================================================================

const SAME_ROLE: [string, string][] = [
  ["2027 Investment Banking Summer Analyst", "Summer Analyst, IB (2027)"],
  ["2027 Investment Banking Summer Analyst", "2027 IB SA"],
  ["2027 Investment Banking Summer Analyst", "IBD Summer Analyst 2027"],
  ["2027 Investment Banking Summer Analyst", "Summer 2027 Investment Banking Analyst"],
  ["2027 Investment Banking Summer Analyst", "INVESTMENT BANKING SUMMER ANALYST 2027"],
  ["2027 Investment Banking Summer Analyst", "  2027   investment-banking summer analyst  "],
  ["2027 Investment Banking Summer Analyst", "Investment Banking - Summer Analyst - 2027"],
  ["2027 Investment Banking Summer Analyst", "Investment Banking Summer Analysts 2027"],
  ["2027 Investment Banking Summer Analyst", "Summer Analyst - Investment Banking (IBD) 2027"],
  ["2027 Sales & Trading Summer Analyst", "S&T Summer Analyst 2027"],
  ["2027 Sales & Trading Summer Analyst", "Sales and Trading SA 2027"],
  ["2027 Sales & Trading Summer Analyst", "2027 Summer Analyst – Sales & Trading"],
  ["2027 Sales & Trading Summer Analyst", "S & T Summer Analyst 2027"],
  ["Mergers & Acquisitions Summer Analyst 2027", "M&A SA 2027"],
  ["Mergers & Acquisitions Summer Analyst 2027", "M & A Summer Analyst 2027"],
  ["Mergers and Acquisitions Summer Analyst 2027", "2027 M&A Summer Analyst"],
  ["Private Equity Summer Associate", "PE Summer Associate"],
  ["Restructuring Summer Analyst 2027", "RX Summer Analyst 2027"],
  ["Restructuring Summer Analyst 2027", "Rx SA 2027"],
  ["Equity Research Summer Analyst", "ER Summer Analyst"],
  ["Equity Capital Markets Summer Analyst", "ECM Summer Analyst"],
  ["Debt Capital Markets Summer Analyst", "DCM Summer Analyst"],
  ["Leveraged Finance Summer Analyst", "LevFin Summer Analyst"],
  ["Leveraged Finance Summer Analyst", "Lev Fin Summer Analyst"],
  ["Asset Management Summer Analyst", "AM Summer Analyst"],
  ["Asset & Wealth Management Summer Analyst", "AWM Summer Analyst"],
  ["Wealth Management Summer Intern", "WM Summer Internship"],
  ["Venture Capital Summer Associate", "VC Summer Associate"],
  ["Full-Time Investment Banking Analyst 2027", "FT IB Analyst 2027"],
  ["Investment Banking Analyst Programme", "Investment Banking Analyst Program"],
  ["Summer Analyst Program, Investment Banking", "Investment Banking Summer Analyst Program"],
  ["Off-Cycle Investment Banking Intern", "Off Cycle IB Internship"],
  ["Sophomore Summer Analyst", "Summer Analyst - Sophomore"],
  ["Investment Banking Summer Analyst - Technology, Media & Telecom", "IB Summer Analyst (Technology, Media and Telecom)"],
  ["Global Markets Summer Analyst", "Summer Analyst, Global Markets"],
  ["Corporate Banking Summer Analyst", "Summer Analyst – Corporate Banking"],
  ["Real Estate Private Equity Summer Analyst", "Real Estate PE Summer Analyst"],
  ["Public Finance Summer Analyst", "Summer Analyst, Public Finance"],
  ["Quantitative Research Intern", "Quantitative Research Internship"],
  ["Investment Banking Summer Analyst, New York", "New York - Investment Banking Summer Analyst"],
  ["2027 Summer Analyst – Investment Banking (M&A)", "M&A IB Summer Analyst 2027"],
  ["Growth Equity Summer Associate", "Summer Associate - Growth Equity"],
  ["Credit Summer Analyst", "Summer Analyst (Credit)"],
  ["Investment Banking & Capital Markets Summer Analyst", "Investment Banking and Capital Markets Summer Analyst"],
  ["Sales, Trading & Research Summer Analyst", "Sales Trading and Research Summer Analyst"],
  ["Risk Management Summer Analyst", "Summer Analyst, Risk Management"],
  ["Investment Banking Summer Analyst — São Paulo", "Investment Banking Summer Analyst - Sao Paulo"],
  // Real board titles against what a student types for the same role.
  ["2027 Summer Analyst - Investment Banking Division", "2027 IBD Summer Analyst"],
  ["2027 Summer Analyst Program - Investment Banking", "2027 IB Summer Analyst"],
  ["Quant Research Intern", "Quantitative Research Intern"],
  ["TMT Investment Banking Summer Analyst", "Technology, Media & Telecom Investment Banking Summer Analyst"],
  ["FIG Summer Analyst", "Financial Institutions Group Summer Analyst"],
];

const DIFFERENT_ROLE: [string, string][] = [
  ["2026 Investment Banking Summer Analyst", "2027 Investment Banking Summer Analyst"],
  ["2027 IB Summer Analyst", "2028 IB Summer Analyst"],
  ["Investment Banking Summer Analyst", "Investment Banking Summer Associate"],
  ["Investment Banking Analyst", "Investment Banking Associate"],
  ["IB Summer Analyst", "S&T Summer Analyst"],
  ["Summer Analyst", "Full-Time Analyst"],
  ["Investment Banking Summer Analyst", "Investment Banking Analyst"],
  ["ECM Summer Analyst", "DCM Summer Analyst"],
  ["Asset Management Summer Analyst", "Wealth Management Summer Analyst"],
  ["AM Summer Analyst", "AWM Summer Analyst"],
  ["PE Summer Associate", "Private Credit Summer Associate"],
  ["M&A Summer Analyst", "Restructuring Summer Analyst"],
  ["Sophomore Summer Analyst", "Summer Analyst"],
  ["Equity Research Summer Analyst", "Equity Capital Markets Summer Analyst"],
  ["Capital Markets Summer Analyst", "Equity Capital Markets Summer Analyst"],
  ["Investment Banking Summer Analyst", "Investment Banking Winter Analyst"],
  ["Summer Analyst 2027", "Summer Analyst 2027 - Sales & Trading"],
  ["Sales & Trading Summer Analyst", "Sales, Trading & Research Summer Analyst"],
  ["Corporate Banking Summer Analyst", "Investment Banking Summer Analyst"],
  ["Summer Analyst - St. Louis", "Sales & Trading Summer Analyst - St. Louis"],
  ["IB Summer Analyst", ""],
  ["", ""],
  ["the and of", "the and of"],
];

describe("roles: the same role, written two ways, is one role", () => {
  for (const [a, b] of SAME_ROLE) {
    test(`"${a}" == "${b}"`, () => {
      assert.equal(roleKey(a), roleKey(b));
      assert.ok(sameRole(a, b));
      assert.ok(sameRole(b, a));
    });
  }
});

describe("roles: different roles stay different", () => {
  for (const [a, b] of DIFFERENT_ROLE) {
    test(`"${a}" != "${b}"`, () => {
      assert.ok(!sameRole(a, b));
    });
  }
  test("roleKey is idempotent over its own output", () => {
    for (const [a, b] of [...SAME_ROLE, ...DIFFERENT_ROLE]) {
      for (const r of [a, b]) assert.equal(roleKey(roleKey(r)), roleKey(r), r);
    }
  });
});

// ============================================================================
// 4a. IMPORTED EVENT TYPES - pure corpus
// ============================================================================

/** Title -> the type a student would expect it filed as. A list means any of them. */
const CORPUS: [string, GuessedType | GuessedType[]][] = [
  // Interviews
  ["Evercore Superday", "interview"],
  ["Goldman Sachs Superday - NYC", "interview"],
  ["Super Day - Lazard", "interview"],
  ["JPM HireVue", "interview"],
  ["BofA HireVue", "interview"],
  ["First round interview - Moelis", "interview"],
  ["Moelis final round (virtual)", "interview"],
  ["Centerview R2", "interview"],
  ["PJT 2nd round", "interview"],
  ["Phone screen - Citi", "interview"],
  ["HR screen w/ Houlihan", "interview"],
  ["Technical interview - Jefferies", "interview"],
  ["Onsite - PJT", "interview"],
  ["Guggenheim case study", "interview"],
  ["Paper LBO test - KKR", "interview"],
  ["Modeling test - Blackstone", "interview"],
  ["Interview w/ Lazard", "interview"],
  ["Evercore interview (Zoom)", "interview"],
  ["Accepted: Evercore first round", "interview"],
  ["Goldman HireVue due", ["interview", "deadline"]],
  // Coffee chats
  ["Coffee chat w/ Evercore analyst", "coffee_chat"],
  ["Coffee with Dana Reed", "coffee_chat"],
  ["Virtual coffee - Lazard associate", "coffee_chat"],
  ["Networking call w/ Jefferies VP", "coffee_chat"],
  ["Informational interview with Jane (Lazard)", "coffee_chat"],
  ["☕ w/ Sam", "coffee_chat"],
  ["Coffee chat re: interview process", "coffee_chat"],
  // Firm and club events
  ["Lazard info session", "info_session"],
  ["Morgan Stanley webinar", "info_session"],
  ["Fall career fair", "info_session"],
  ["Recruiting dinner - Lazard", "info_session"],
  ["Goldman Sachs Diversity Summit", "info_session"],
  ["Networking night - Wall Street Club", "info_session"],
  ["Moelis firm presentation", "info_session"],
  ["Office visit - Evercore NYC", "info_session"],
  ["NYC trek", "info_session"],
  ["Evercore coffee social", "info_session"],
  ["Sophomore Coffee Chat Night - Goldman", "info_session"],
  ["Lazard info sesh", "info_session"],
  // Deadlines
  ["Evercore application deadline", "deadline"],
  ["Goldman app due", "deadline"],
  ["Apply by: Moelis SA", "deadline"],
  ["Lazard applications close", "deadline"],
  // Meetings
  ["Call with JPM recruiter", ["meeting", "interview"]],
  ["Zoom w/ Evercore analyst", ["meeting", "coffee_chat"]],
  ["1:1 with career advisor", "meeting"],
  ["Catch up with Alex (Lazard)", ["meeting", "coffee_chat"]],
  ["Lunch with Sarah from Moelis", ["meeting", "coffee_chat"]],
  // The student's own life
  ["BIO 110 lab", "personal"],
  ["ECON 101 lecture", "personal"],
  ["Accounting midterm", "personal"],
  ["Office hours", "personal"],
  ["Soccer practice", "personal"],
  ["Mom's birthday", "personal"],
  ["Study group", "personal"],
  ["Call mom", "personal"],
  ["dinner w dad", "personal"],
  ["Gym", "personal"],
  ["Dentist appt", "personal"],
  ["Flight to NYC", "personal"],
  ["Mock interview with career center", "personal"],
  ["Superday prep", "personal"],
  ["Interview prep with Dan", "personal"],
  ["STAT 110 online exam", "personal"],
  ["", "personal"],
  // Misreadings a student would hit
  ["FIN 3200 homework due", "personal"],
  ["PSET 3 due", "personal"],
  ["Rent due", "personal"],
  ["Superday travel", "personal"],
  ["Flight to NYC for Evercore superday", "personal"],
  ["Coffee chat prep", "personal"],
  ["Canceled: Evercore Superday", "personal"],
  ["Send thank-you notes after Goldman interview", "personal"],
];

describe("imported event types: a corpus of real calendar titles", () => {
  test(`the corpus has ${CORPUS.length} titles (>= 60)`, () => assert.ok(CORPUS.length >= 60));
  for (const [title, want] of CORPUS) {
    const ok = Array.isArray(want) ? want : [want];
    test(`"${title}" -> ${ok.join(" | ")}`, () => {
      const got = guessEventType(title);
      assert.ok(ok.includes(got.type), `got ${got.type} (evidence: ${JSON.stringify(got.evidence)})`);
      // The evidence is the words that decided it - present in the title - or
      // null for the plain default.
      if (got.evidence !== null) assert.ok(title.includes(got.evidence), `evidence "${got.evidence}" not in title`);
      else assert.equal(got.type, "personal");
    });
  }
});

// ============================================================================
// 5a. "Applied yet?" - pure
// ============================================================================

function cand(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    key: "posting:p1",
    firmName: "Evercore",
    role: "2027 Investment Banking Summer Analyst",
    applyUrl: "https://evercore.example.com/apply",
    deadline: utcDay("2026-11-06"),
    deadlineTime: null,
    rolling: false,
    applicationId: null,
    ...over,
  };
}

describe("pure: openApplications", () => {
  const at = local(NY, 2026, 10, 1, 12);
  test("dated ones however far out, never past; rolling; opening today; nothing undated", () => {
    const list = openApplications(
      [
        cand({ key: "far", deadline: utcDay("2027-03-01") }),
        cand({ key: "past", deadline: utcDay("2026-09-30") }),
        cand({ key: "today", deadline: utcDay("2026-10-01") }),
        cand({ key: "rolling", deadline: null, rolling: true }),
        cand({ key: "opens", deadline: null, opensToday: true }),
        cand({ key: "nothing", deadline: null }),
      ],
      at,
      NY,
    );
    assert.deepEqual(
      list.map((l) => [l.key, l.label]),
      [
        ["today", "due today"],
        ["opens", "opens today"],
        ["far", "due in 151 days"],
        ["rolling", "rolling"],
      ],
    );
  });
  test("a duplicate key is listed once", () => {
    assert.equal(openApplications([cand(), cand()], at, NY).length, 1);
  });
  test("an invalid date is not listed as dated", () => {
    const list = openApplications([cand({ deadline: new RealDate(NaN) })], at, NY);
    assert.equal(list.length, 0);
  });
  for (const [tz, h, want] of [
    [NY, 23, 0],
    [LA, 23, 0],
    [TOKYO, 0, 0],
    [LONDON, 23, 0],
  ] as [string, number, number][]) {
    test(`${tz}: ${h}:59 on the deadline day is still "due today"`, () => {
      const [l] = openApplications([cand()], local(tz, 2026, 11, 6, h, 59), tz);
      assert.equal(l?.daysLeft, want);
    });
    test(`${tz}: midnight after the deadline day, gone`, () => {
      assert.equal(openApplications([cand()], local(tz, 2026, 11, 7, 0, 0), tz).length, 0);
    });
  }
});

// ============================================================================
// DB
// ============================================================================

type Libs = typeof import("@/lib/prompt-flash") &
  typeof import("@/lib/notifications") &
  typeof import("@/lib/today-list") &
  typeof import("@/lib/today-tasks") &
  typeof import("@/lib/application-reminders-db") &
  typeof import("@/lib/application-identity") &
  typeof import("@/lib/application-outreach") &
  typeof import("@/lib/interview-prep") &
  typeof import("@/lib/thank-you-db") &
  typeof import("@/lib/discovery-matches");
let L: Libs;
type Storage = { run: <R>(store: never, fn: () => R) => R };
let workStorage: Storage;
let workUnitStorage: Storage;

function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const jar = { get: (name: string) => (name === "tz" ? { name, value: tz } : undefined) };
  return workStorage.run({ route: "/schools-roles-imports-applied" } as never, () =>
    workUnitStorage.run({ type: "private-cache", phase: "render", cookies: jar } as never, fn),
  );
}

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
  L = {
    ...(await import("@/lib/prompt-flash")),
    ...(await import("@/lib/notifications")),
    ...(await import("@/lib/today-list")),
    ...(await import("@/lib/today-tasks")),
    ...(await import("@/lib/application-reminders-db")),
    ...(await import("@/lib/application-identity")),
    ...(await import("@/lib/application-outreach")),
    ...(await import("@/lib/interview-prep")),
    ...(await import("@/lib/thank-you-db")),
    ...(await import("@/lib/discovery-matches")),
  } as Libs;
  workStorage = (await import("next/dist/server/app-render/work-async-storage.external")).workAsyncStorage as unknown as Storage;
  workUnitStorage = (await import("next/dist/server/app-render/work-unit-async-storage.external"))
    .workUnitAsyncStorage as unknown as Storage;
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  fakeNow = null;
  await h.close();
});

// ------------------------------------------------------------------ fixtures

const DL = "2026-11-06";
const ROLE = "2027 Investment Banking Summer Analyst";
type User = typeof users.$inferSelect;
type Student = { u: User; tz: string };
let seq = 0;

async function mkStudent(tz = NY): Promise<Student> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `sria-${seq}@example.edu`,
      passwordHash: "x",
      name: `Student ${seq}`,
      gradYear: 2028,
      targetInternshipYear: 2027,
      preferredCategories: ["investment_banking"],
      nicheInterests: [],
    })
    .returning();
  return { u, tz };
}

async function mkFirm(name: string, aliases: string[] = []) {
  seq += 1;
  const [f] = await h.db
    .insert(firms)
    .values({
      slug: `sria-${name.toLowerCase().replace(/\W+/g, "-")}-${seq}`,
      name,
      aliases,
      headquarters: "New York, NY",
      keyOffices: "New York",
      website: `sria${seq}.example.com`,
      description: "A firm.",
    })
    .returning();
  return f;
}
async function track(s: Student, firmId: string) {
  await h.db.insert(userTopFirms).values({ userId: s.u.id, firmId });
}
type PostingOpts = Partial<typeof internshipPostings.$inferInsert>;
async function mkPosting(firm: { id: string; website: string }, o: PostingOpts = {}) {
  seq += 1;
  const [p] = await h.db
    .insert(internshipPostings)
    .values({
      firmId: firm.id,
      categories: ["investment_banking"],
      roleTitle: ROLE,
      location: "New York, NY",
      programYear: 2027,
      eligibleGradYears: [2028],
      deadlineStatus: "confirmed",
      deadlineDate: utcDay(DL),
      opensAt: null,
      descriptionFull: "Ten-week summer analyst programme in investment banking.",
      sourceUrl: `https://${firm.website}/careers`,
      applicationUrl: `https://${firm.website}/apply/${seq}`,
      isActive: true,
      ...o,
    })
    .returning();
  return p;
}
async function mkApplication(s: Student, firm: string, role: string, over: Partial<typeof applications.$inferInsert> = {}) {
  const [a] = await h.db.insert(applications).values({ userId: s.u.id, firm, role, ...over }).returning();
  return a;
}
async function mkDeadlineEvent(s: Student, applicationId: string | null, eventDate: Date) {
  const [e] = await h.db
    .insert(events)
    .values({ userId: s.u.id, type: "deadline", title: "Application deadline", eventDate, applicationId })
    .returning();
  return e;
}
const trackerOf = (s: Student) => h.db.query.applications.findMany({ where: eq(applications.userId, s.u.id) });
const eventsOf = (s: Student) => h.db.query.events.findMany({ where: eq(events.userId, s.u.id) });

function act<T>(s: Student, now: Date, fn: () => Promise<T>): Promise<T> {
  clock(now);
  return inZone(s.tz, fn);
}
const openList = (s: Student, now: Date) => act(s, now, () => L.getOpenApplications(s.u, now));
const reminders = (s: Student, now: Date) => act(s, now, () => L.getApplicationReminders(s.u, now));
const tasks = (s: Student, now: Date) => act(s, now, () => L.getAllTasks(s.u, now));
const openingToday = (s: Student, now: Date) => act(s, now, () => L.getOpeningToday(s.u, now));
/** nudge-actions.markAppliedFromReminder, step for step. */
const iApplied = (s: Student, now: Date, key: string) =>
  act(s, now, async () => {
    if (typeof key !== "string" || key.length > 200) return false;
    return L.markReminderApplied(s.u, key, now);
  });

// ---- applications/actions.ts, replayed

/** quickAddApplication, step for step. */
async function quickAdd(s: Student, input: { firm: string; role: string; applicationUrl?: string }) {
  const blocked = blockedLanguageError([["Firm", input.firm], ["Role", input.role]]);
  if (blocked) throw new Error(blocked);
  const existing = await L.findSameApplication(s.u.id, input.firm, input.role);
  if (existing) return { alreadyTracked: true };
  const inserted = await h.db
    .insert(applications)
    .values({ userId: s.u.id, firm: input.firm, role: input.role, applicationUrl: input.applicationUrl || null, category: null })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return { alreadyTracked: true };
  return { alreadyTracked: false };
}

/** createApplication (the /applications form), step for step: redirect or insert. */
async function createApp(s: Student, firm: string, role: string, status = "not_started") {
  const same = await L.findSameApplication(s.u.id, firm, role);
  if (same) return { redirectedTo: same.id };
  const [created] = await h.db
    .insert(applications)
    .values({ userId: s.u.id, firm, role, status: status as never })
    .returning();
  return { created: created.id };
}

/** applications/import/actions.ts bulkImportApplications, step for step (the insert). */
async function csvImport(s: Student, rows: { firm: string; role: string; status: string }[]) {
  // As the action now does: a row already on the tracker (any spelling), or
  // repeated in the file, is not inserted again.
  for (const r of rows) {
    if (await L.findSameApplication(s.u.id, r.firm, r.role)) continue;
    await h.db
      .insert(applications)
      .values({ userId: s.u.id, firm: r.firm, role: r.role, status: r.status as never, notes: null, appliedDate: null });
  }
}

// ---- schedule/actions.ts, replayed

/** bulkImportScheduleEvents, step for step. `rows` as the import form posts them. */
async function importSchedule(s: Student, now: Date, rows: { title: string; isoDateTime: string }[]) {
  return act(s, now, async () => {
    const raw = JSON.stringify(rows);
    const blocked = blockedLanguageError([["The imported events", raw]]);
    if (blocked) return { error: blocked };
    const importedAt = new Date();
    // As the action now does: the wall-clock time is on the student's clock.
    const zone = parseTimeZone(s.tz);
    const onTheirClock = (iso: string) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
      return m ? zonedTime(+m[1], +m[2], +m[3], +m[4], +m[5], zone) : new Date(iso);
    };
    const values = rows
      .map((r) => {
        const eventDate = onTheirClock(r.isoDateTime);
        if (!r.title || Number.isNaN(eventDate.getTime())) return null;
        const guess = guessEventType(r.title);
        return {
          userId: s.u.id,
          type: guess.type,
          typeSource: "detected",
          typeDetectedAt: importedAt,
          typeDetectedFrom: guess.evidence,
          title: r.title,
          eventDate,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (values.length === 0) return { error: "Nothing valid to import." };
    await h.db.insert(events).values(values as never);
    return { imported: values.length };
  });
}
/** A row whose wall-clock string, read on the student's clock, is exactly `instant`. */
const rowAt = (title: string, instant: Date, tz: string = NY) => {
  const p = localParts(instant, tz);
  const two = (n: number) => String(n).padStart(2, "0");
  return { title, isoDateTime: `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}` };
};

/** updateEvent's type handling, step for step: a changed type is the student's. */
async function studentRetypes(s: Student, eventId: string, type: string) {
  const existing = await h.db.query.events.findFirst({ where: and(eq(events.id, eventId), eq(events.userId, s.u.id)) });
  assert.ok(existing);
  await h.db
    .update(events)
    .set({ type: type as never, typeSource: type !== existing.type ? "student" : existing.typeSource })
    .where(and(eq(events.id, eventId), eq(events.userId, s.u.id)));
}

async function mkContact(s: Student, name: string, firm: string) {
  const [c] = await h.db
    .insert(contacts)
    .values({ userId: s.u.id, name, firm, email: `${name.toLowerCase().replace(/\W+/g, ".")}@${firm.toLowerCase().replace(/\W+/g, "")}.example.com` } as never)
    .returning();
  return c;
}

// ============================================================================
// 2b. ONE APPLICATION IS ONE TRACKER ROW - every add path
// ============================================================================

/** Firm spellings a student uses for the firm on the posting. */
const DUP_CASES: [firmA: string, roleA: string, firmB: string, roleB: string][] = [
  ["Evercore", "2027 Investment Banking Summer Analyst", "Evercore Partners", "Summer Analyst, IB (2027)"],
  ["J.P. Morgan", "2027 Investment Banking Summer Analyst", "JPMorgan Chase", "IBD Summer Analyst 2027"],
  ["Goldman Sachs & Co. LLC", "2027 Sales & Trading Summer Analyst", "Goldman", "S&T SA 2027"],
  ["Morgan Stanley", "Mergers & Acquisitions Summer Analyst 2027", "MS", "M&A Summer Analyst 2027"],
  ["Moelis & Company", "Restructuring Summer Analyst 2027", "Moelis", "RX SA 2027"],
  ["Bank of America", "Leveraged Finance Summer Analyst", "BofA Securities", "LevFin Summer Analyst"],
  ["Centerview Partners", "Investment Banking Summer Analyst Programme", "CVP", "IB Summer Analyst Program"],
  ["Houlihan Lokey", "Financial Restructuring Summer Analyst", "HL", "Summer Analyst - Financial Restructuring"],
];

describe("tracker: quickAddApplication never adds the same application twice", () => {
  for (const [fa, ra, fb, rb] of DUP_CASES) {
    test(`${fa} / ${ra}  then  ${fb} / ${rb}`, async () => {
      const s = await mkStudent();
      assert.deepEqual(await quickAdd(s, { firm: fa, role: ra }), { alreadyTracked: false });
      assert.deepEqual(await quickAdd(s, { firm: fb, role: rb }), { alreadyTracked: true });
      assert.equal((await trackerOf(s)).length, 1);
    });
  }
  test("a different year is a different application", async () => {
    const s = await mkStudent();
    await quickAdd(s, { firm: "Evercore", role: "2026 IB Summer Analyst" });
    assert.deepEqual(await quickAdd(s, { firm: "Evercore", role: "2027 IB Summer Analyst" }), { alreadyTracked: false });
    assert.equal((await trackerOf(s)).length, 2);
  });
  test("a different seniority is a different application", async () => {
    const s = await mkStudent();
    await quickAdd(s, { firm: "Evercore", role: "IB Summer Analyst" });
    assert.deepEqual(await quickAdd(s, { firm: "Evercore", role: "IB Summer Associate" }), { alreadyTracked: false });
  });
  test("the same role at another firm is another application", async () => {
    const s = await mkStudent();
    await quickAdd(s, { firm: "Evercore", role: ROLE });
    assert.deepEqual(await quickAdd(s, { firm: "Lazard", role: ROLE }), { alreadyTracked: false });
  });
  test("another student's row never counts", async () => {
    const a = await mkStudent();
    const b = await mkStudent();
    await quickAdd(a, { firm: "Evercore", role: ROLE });
    assert.deepEqual(await quickAdd(b, { firm: "Evercore", role: "IB SA 2027" }), { alreadyTracked: false });
  });
  test("a firm known by its alias in the firms table (the reminders already fold it)", async () => {
    const s = await mkStudent();
    const firm = await mkFirm("Solomon Partners", ["PJ Solomon"]);
    await track(s, firm.id);
    await mkApplication(s, "PJ Solomon", "Summer Analyst, IB (2027)");
    assert.deepEqual(await quickAdd(s, { firm: "Solomon Partners", role: ROLE }), { alreadyTracked: true });
    assert.equal((await trackerOf(s)).length, 1);
  });
  test("a firm written without its generic tail (the reminders already fold it)", async () => {
    const s = await mkStudent();
    const firm = await mkFirm("Ducera Partners");
    await track(s, firm.id);
    await mkApplication(s, "Ducera", "IB Summer Analyst 2027");
    assert.deepEqual(await quickAdd(s, { firm: "Ducera Partners", role: ROLE }), { alreadyTracked: true });
  });
  // Known and accepted for now: two different spellings clicked in the same
  // instant can both pass the read before either writes. Closing it needs a
  // normalised firm/role key with its own unique index (a migration).
  test("two Track clicks racing, spelled differently: still one row", { skip: "needs a normalised-key unique index" }, async () => {
    const s = await mkStudent();
    await Promise.all([
      quickAdd(s, { firm: "Evercore", role: ROLE }),
      quickAdd(s, { firm: "Evercore Partners", role: "IB Summer Analyst 2027" }),
    ]);
    assert.equal((await trackerOf(s)).length, 1);
  });
});

describe("tracker: the /applications form opens the existing row instead", () => {
  for (const [fa, ra, fb, rb] of DUP_CASES.slice(0, 5)) {
    test(`${fb} / ${rb} opens ${fa} / ${ra}`, async () => {
      const s = await mkStudent();
      const first = await createApp(s, fa, ra);
      const second = await createApp(s, fb, rb);
      assert.equal(second.redirectedTo, first.created);
      assert.equal((await trackerOf(s)).length, 1);
    });
  }
  test("the Schedule's manual add routes through quickAdd too", async () => {
    const s = await mkStudent();
    await createApp(s, "Lazard", "Investment Banking Summer Analyst 2027");
    // addApplicationFromSchedule -> quickAddApplication
    assert.deepEqual(await quickAdd(s, { firm: "Lazard Freres", role: "2027 IB SA" }), { alreadyTracked: true });
  });
});

describe("tracker: the other paths that add a row", () => {
  test("auto-tracking a matched firm's posting does not duplicate a hand-typed entry", async () => {
    const s = await mkStudent();
    const firm = await mkFirm("Evercore");
    await track(s, firm.id);
    await mkPosting(firm, { deadlineStatus: "tbd", deadlineDate: null });
    // Sanity: auto-tracking does see the posting for a student with nothing on the tracker.
    const fresh = await mkStudent();
    await track(fresh, firm.id);
    clock(local(NY, 2026, 10, 1, 12));
    assert.equal(await inZone(NY, () => L.autoTrackForMatchedFirms(fresh.u, [firm.id])), 1);
    // The real case: they typed it themselves first.
    await mkApplication(s, "Evercore Partners", "Summer Analyst - Investment Banking (2027)");
    await inZone(NY, () => L.autoTrackForMatchedFirms(s.u, [firm.id]));
    assert.equal((await trackerOf(s)).length, 1, (await trackerOf(s)).map((a) => `${a.firm} / ${a.role}`).join("; "));
  });
  test("CSV import of a role already on the tracker under another spelling", async () => {
    const s = await mkStudent();
    await mkApplication(s, "J.P. Morgan", ROLE);
    await csvImport(s, [{ firm: "JPMorgan", role: "IB Summer Analyst 2027", status: "submitted" }]);
    assert.equal((await trackerOf(s)).length, 1);
  });
});

// ============================================================================
// 5b. "Applied yet?" and "I applied" - end to end
// ============================================================================

async function datedScenario(tz = NY, posting: PostingOpts = {}, firmName = "Evercore") {
  const s = await mkStudent(tz);
  const firm = await mkFirm(firmName);
  await track(s, firm.id);
  const p = await mkPosting(firm, posting);
  return { s, firm, p, key: `posting:${p.id}` };
}

describe("Applied yet?: what is listed", () => {
  test("a dated posting 36 days out is listed, with no reminder yet", async () => {
    const { s, key } = await datedScenario();
    const now = local(NY, 2026, 10, 1, 12);
    const list = await openList(s, now);
    assert.deepEqual(list.map((l) => [l.key, l.label]), [[key, "due in 36 days"]]);
    const r = await reminders(s, now);
    assert.ok(r.every((x) => x.flashKey === null && !x.onTodo));
  });
  test("a rolling posting is listed as rolling", async () => {
    const { s, key } = await datedScenario(NY, { deadlineStatus: "rolling", deadlineDate: null });
    const list = await openList(s, local(NY, 2026, 10, 1, 12));
    assert.deepEqual(list.map((l) => [l.key, l.label]), [[key, "rolling"]]);
  });
  test("a posting opening today is listed, flagged, with no deadline reminder of its own", async () => {
    const { s, key } = await datedScenario(NY, { deadlineStatus: "tbd", deadlineDate: null, opensAt: utcDay("2026-11-10") });
    const now = local(NY, 2026, 11, 10, 9);
    const list = await openList(s, now);
    assert.deepEqual(list.map((l) => [l.key, l.label, l.opensToday]), [[key, "opens today", true]]);
    assert.equal((await reminders(s, now)).length, 0);
    assert.equal((await tasks(s, now)).filter((t) => t.id.startsWith("deadline-")).length, 0);
  });
  test("a posting opening tomorrow is not listed", async () => {
    const { s } = await datedScenario(NY, { deadlineStatus: "tbd", deadlineDate: null, opensAt: utcDay("2026-11-11") });
    assert.equal((await openList(s, local(NY, 2026, 11, 10, 9))).length, 0);
  });
  test("a posting whose deadline has passed is not listed", async () => {
    const { s } = await datedScenario();
    assert.equal((await openList(s, local(NY, 2026, 11, 7, 0, 1))).length, 0);
  });
  test("a posting the tracker says was applied to, under another spelling, is not listed", async () => {
    const { s } = await datedScenario();
    await mkApplication(s, "Evercore Partners", "Summer Analyst, IB (2027)", { status: "submitted" });
    assert.equal((await openList(s, local(NY, 2026, 10, 1, 12))).length, 0);
  });
  test("the same role posted twice at one firm is listed once, by the sooner date", async () => {
    const { s, firm, key } = await datedScenario();
    await mkPosting(firm, { roleTitle: "Summer Analyst - IB (2027)", deadlineDate: utcDay("2026-12-01") });
    const list = await openList(s, local(NY, 2026, 10, 1, 12));
    assert.deepEqual(list.map((l) => l.key), [key]);
  });
  test("a tracker-only entry is listed only with a Schedule deadline", async () => {
    const s = await mkStudent();
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst", { status: "in_progress" });
    const b = await mkApplication(s, "PJT Partners", "Summer Analyst", { status: "not_started" });
    await mkDeadlineEvent(s, a.id, local(NY, 2026, 12, 20, 23, 59));
    const list = await openList(s, local(NY, 2026, 10, 1, 12));
    assert.deepEqual(list.map((l) => l.key), [`application:${a.id}`]);
    assert.ok(!list.some((l) => l.key === `application:${b.id}`));
  });
  for (const [tz, y, m, d, hr, min, listed] of [
    [NY, 2026, 11, 10, 0, 0, true],
    [NY, 2026, 11, 10, 23, 59, true],
    [NY, 2026, 11, 11, 0, 0, false],
    [NY, 2026, 11, 9, 23, 59, false],
    [LA, 2026, 11, 10, 23, 30, true],
    [LA, 2026, 11, 9, 20, 0, false],
    [TOKYO, 2026, 11, 10, 8, 0, true],
    [TOKYO, 2026, 11, 11, 0, 30, false],
    [LONDON, 2026, 11, 10, 0, 30, true],
  ] as [string, number, number, number, number, number, boolean][]) {
    test(`opening today, ${tz} ${m}/${d} ${hr}:${String(min).padStart(2, "0")}: ${listed ? "listed" : "not listed"}`, async () => {
      const { s } = await datedScenario(tz, { deadlineStatus: "tbd", deadlineDate: null, opensAt: utcDay("2026-11-10") });
      const list = await openList(s, local(tz, y, m, d, hr, min));
      assert.equal(list.length, listed ? 1 : 0);
      if (listed) assert.equal(list[0].label, "opens today");
    });
  }
  for (const [tz, hr, min, n] of [
    [NY, 23, 59, 1],
    [NY, 0, 0, 1],
    [LA, 23, 59, 1],
    [TOKYO, 23, 59, 1],
  ] as [string, number, number, number][]) {
    test(`deadline day, ${tz} ${hr}:${String(min).padStart(2, "0")}: listed "due today"`, async () => {
      const { s } = await datedScenario(tz);
      const list = await openList(s, local(tz, 2026, 11, 6, hr, min));
      assert.equal(list.length, n);
      assert.equal(list[0].label, "due today");
    });
  }
});

describe('Applied yet?: "I applied"', () => {
  test("a posting never tracked: put on the tracker as submitted, job closed, everything stops", async () => {
    const { s, key, p } = await datedScenario();
    const now = local(NY, 2026, 11, 3, 9);
    // The banner has filed the bell job.
    await act(s, now, async () => {
      for (let i = 0; i < 6; i++) {
        const f = await L.getPendingFlash(s.u, now);
        if (!f) break;
        for (const n of f.notifications) await L.upsertNotification({ userId: s.u.id, ...n, now });
        await L.markFlashShown(s.u.id, f.flashKey);
      }
    });
    assert.ok(await iApplied(s, now, key));
    const rows = await trackerOf(s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "submitted");
    assert.equal(rows[0].firm, "Evercore");
    assert.equal(rows[0].role, ROLE);
    assert.equal(rows[0].appliedDate, "2026-11-03");
    assert.equal(rows[0].applicationUrl, p.applicationUrl);
    const jobs = await h.db.query.notifications.findMany({
      where: and(eq(notifications.userId, s.u.id), eq(notifications.kind, "application_deadline")),
    });
    assert.ok(jobs.length >= 1);
    assert.ok(jobs.every((j) => j.doneSource === "manual"));
    const later = local(NY, 2026, 11, 5, 9);
    assert.equal((await openList(s, later)).length, 0);
    assert.equal((await reminders(s, later)).length, 0);
    assert.equal((await tasks(s, later)).filter((t) => t.id.startsWith("deadline-")).length, 0);
  });
  test("tracked under another spelling: that row is marked, no second row, its Schedule deadline is done", async () => {
    const { s, key } = await datedScenario();
    const a = await mkApplication(s, "Evercore Partners", "Summer Analyst, IB (2027)", { status: "in_progress" });
    const e = await mkDeadlineEvent(s, a.id, local(NY, 2026, 11, 6, 17));
    const now = local(NY, 2026, 11, 1, 10);
    const [item] = await openList(s, now);
    assert.equal(item.key, key);
    assert.equal(item.applicationId, a.id);
    assert.ok(await iApplied(s, now, key));
    const rows = await trackerOf(s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, a.id);
    assert.equal(rows[0].status, "submitted");
    assert.equal((await h.db.query.events.findFirst({ where: eq(events.id, e.id) }))?.completed, true);
    assert.equal((await tasks(s, now)).filter((t) => t.id === `event-${e.id}`).length, 0);
  });
  test("tracked under a firm alias from the firms table: marked, not duplicated", async () => {
    const s = await mkStudent();
    const firm = await mkFirm("Solomon Partners", ["PJ Solomon"]);
    await track(s, firm.id);
    const p = await mkPosting(firm);
    const a = await mkApplication(s, "PJ Solomon", "IB Summer Analyst 2027");
    assert.ok(await iApplied(s, local(NY, 2026, 11, 1, 10), `posting:${p.id}`));
    const rows = await trackerOf(s);
    assert.deepEqual(rows.map((r) => [r.id, r.status]), [[a.id, "submitted"]]);
  });
  test("a tracker-only entry: marked, its Schedule deadline done, it leaves the list", async () => {
    const s = await mkStudent();
    const a = await mkApplication(s, "Moelis & Company", "Summer Analyst", { status: "not_started" });
    const e = await mkDeadlineEvent(s, a.id, local(NY, 2026, 11, 20, 23, 59));
    const now = local(NY, 2026, 11, 1, 10);
    assert.ok(await iApplied(s, now, `application:${a.id}`));
    assert.equal((await trackerOf(s))[0].status, "submitted");
    assert.equal((await h.db.query.events.findFirst({ where: eq(events.id, e.id) }))?.completed, true);
    assert.equal((await openList(s, now)).length, 0);
  });
  test("a rolling posting: works, and the weekly reminder stops", async () => {
    const { s, key } = await datedScenario(NY, { deadlineStatus: "rolling", deadlineDate: null });
    const now = local(NY, 2026, 10, 1, 12);
    assert.equal((await reminders(s, now)).length, 1);
    assert.ok(await iApplied(s, now, key));
    assert.equal((await reminders(s, local(NY, 2026, 10, 8, 12))).length, 0);
    assert.equal((await openList(s, local(NY, 2026, 10, 8, 12))).length, 0);
  });
  test("a posting opening today: works, and the opening-day apply prompt stops too", async () => {
    const { s, key } = await datedScenario(NY, { deadlineStatus: "tbd", deadlineDate: null, opensAt: utcDay("2026-11-10") });
    const am9 = local(NY, 2026, 11, 10, 9);
    assert.equal((await openingToday(s, am9)).length, 1);
    assert.ok(await iApplied(s, am9, key));
    assert.equal((await trackerOf(s))[0]?.status, "submitted");
    const later = local(NY, 2026, 11, 10, 14);
    assert.equal((await openList(s, later)).length, 0);
    assert.equal((await openingToday(s, later)).length, 0, "the 'Apply to Evercore' prompt is still up after 'I applied'");
    assert.equal((await tasks(s, later)).filter((t) => t.id.startsWith("apply-")).length, 0);
  });
  test("ticking the opening-day 'Apply to X' row is NOT 'I applied': it only dismisses that row", async () => {
    const { s, key } = await datedScenario(NY, { deadlineStatus: "tbd", deadlineDate: null, opensAt: utcDay("2026-11-10") });
    const am9 = local(NY, 2026, 11, 10, 9);
    const row = (await tasks(s, am9)).find((t) => t.id.startsWith("apply-"));
    assert.equal(row?.id, "apply-evercore-2026-11-10");
    // completeTask, step for step (the apply branch).
    await act(s, am9, async () => {
      await L.closeNotificationByKey(s.u.id, L.applyNotificationKey("evercore", "2026-11-10"), "manual");
      await L.recordCompleted(s.u.id, [row!], "manual", am9);
      await h.db.insert(todoDismissals).values({ userId: s.u.id, taskId: row!.id }).onConflictDoNothing();
    });
    assert.equal((await trackerOf(s)).length, 0, "ticking the row wrote a tracker entry");
    assert.equal((await tasks(s, am9)).filter((t) => t.id.startsWith("apply-")).length, 0);
    assert.deepEqual((await openList(s, am9)).map((l) => l.key), [key], "it left the Applied yet? list");
  });
  test("the applied date is the student's own day: Los Angeles 10pm is not UTC's tomorrow", async () => {
    const { s, key } = await datedScenario(LA);
    const pm10 = local(LA, 2026, 11, 4, 22);
    assert.ok(await iApplied(s, pm10, key));
    assert.equal((await trackerOf(s))[0].appliedDate, "2026-11-04");
  });
  test("the applied date is the student's own day: Tokyo 8am is not UTC's yesterday", async () => {
    const { s, key } = await datedScenario(TOKYO);
    assert.ok(await iApplied(s, local(TOKYO, 2026, 11, 4, 8), key));
    assert.equal((await trackerOf(s))[0].appliedDate, "2026-11-04");
  });
  test("11:59pm on the deadline day, Los Angeles: still works", async () => {
    const { s, key } = await datedScenario(LA);
    assert.ok(await iApplied(s, local(LA, 2026, 11, 6, 23, 59), key));
  });
  test("twice: the second click does nothing, still one row", async () => {
    const { s, key } = await datedScenario();
    const now = local(NY, 2026, 11, 1, 10);
    assert.ok(await iApplied(s, now, key));
    assert.equal(await iApplied(s, now, key), false);
    assert.equal((await trackerOf(s)).length, 1);
  });
  test("another student's key does nothing to either of them", async () => {
    const a = await datedScenario();
    const b = await mkStudent();
    assert.equal(await iApplied(b, local(NY, 2026, 11, 1, 10), a.key), false);
    assert.equal((await trackerOf(a.s)).length + (await trackerOf(b)).length, 0);
  });
  test("a junk or over-long key does nothing", async () => {
    const { s } = await datedScenario();
    for (const k of ["", "posting:", "application:not-a-uuid", "x".repeat(201), "posting:' OR 1=1 --"]) {
      assert.equal(await iApplied(s, local(NY, 2026, 11, 1, 10), k), false, k);
    }
    assert.equal((await trackerOf(s)).length, 0);
  });
  test("after 'I applied', adding the same role by hand under another spelling is 'already tracked'", async () => {
    const { s, key } = await datedScenario();
    assert.ok(await iApplied(s, local(NY, 2026, 11, 1, 10), key));
    assert.deepEqual(await quickAdd(s, { firm: "Evercore Partners", role: "IB SA 2027" }), { alreadyTracked: true });
    assert.equal((await trackerOf(s)).length, 1);
  });
});

describe("6. the opening-day apply prompt after the countdown row was ticked", () => {
  test("ticking the countdown row does not stop the opening-day prompt", async () => {
    const { s } = await datedScenario(NY, { deadlineStatus: "tbd", deadlineDate: null, opensAt: utcDay("2026-11-10") });
    await h.db.insert(todoDismissals).values({ userId: s.u.id, taskId: "outreach-evercore-2026-11-10" });
    const am9 = local(NY, 2026, 11, 10, 9);
    assert.equal((await openingToday(s, am9)).length, 1);
    assert.equal((await tasks(s, am9)).filter((t) => t.id === "apply-evercore-2026-11-10").length, 1);
  });
});

// ============================================================================
// 3. WITHDRAWN POSTINGS stop the tracker entry's reminders
// ============================================================================

// withdrawnRoles matches a tracker entry's firm by NAME across the whole firms
// table, so each test here uses a firm name no other test uses.
describe("withdrawn postings", () => {
  const now = local(NY, 2026, 11, 1, 10);
  async function withSchedule(s: Student, firm: string, role: string) {
    const a = await mkApplication(s, firm, role, { status: "not_started" });
    await mkDeadlineEvent(s, a.id, local(NY, 2026, 11, 6, 23, 59));
    return a;
  }
  test("control: a tracker entry with a Schedule deadline and no posting is reminded", async () => {
    const s = await mkStudent();
    await withSchedule(s, "Ashgrove Capital", "IB Summer Analyst 2027");
    assert.equal((await openList(s, now)).length, 1);
    assert.equal((await reminders(s, now)).length, 1);
  });
  test("isActive=false, tracked firm, role spelled differently: silent", async () => {
    const { s, p } = await datedScenario(NY, {}, "Brightwater Partners");
    await h.db.update(internshipPostings).set({ isActive: false }).where(eq(internshipPostings.id, p.id));
    await withSchedule(s, "Brightwater", "IB Summer Analyst 2027");
    assert.equal((await openList(s, now)).length, 0);
    assert.equal((await reminders(s, now)).length, 0);
    assert.equal((await tasks(s, now)).filter((t) => t.id.startsWith("deadline-")).length, 0);
  });
  test("deadlineStatus 'closed': silent", async () => {
    const { s, p } = await datedScenario(NY, {}, "Clearbrook Advisors");
    await h.db.update(internshipPostings).set({ deadlineStatus: "closed" }).where(eq(internshipPostings.id, p.id));
    await withSchedule(s, "Clearbrook Advisors", "2027 IB SA");
    assert.equal((await openList(s, now)).length, 0);
  });
  test("a firm not on their list, its name written exactly: silent", async () => {
    const s = await mkStudent();
    const firm = await mkFirm("Dunmore Sachs");
    await mkPosting(firm, { isActive: false });
    await withSchedule(s, "dunmore sachs", "IB Summer Analyst 2027");
    assert.equal((await openList(s, now)).length, 0);
  });
  test("a firm not on their list, written the way students write it ('Goldman'): silent", async () => {
    const s = await mkStudent();
    const firm = await mkFirm("Goldman Sachs");
    await mkPosting(firm, { isActive: false });
    await withSchedule(s, "Goldman", "IB Summer Analyst 2027");
    assert.equal((await openList(s, now)).length, 0);
    assert.equal((await reminders(s, now)).length, 0);
  });
  test("a firm not on their list, 'JPMorgan' for 'J.P. Morgan': silent", async () => {
    const s = await mkStudent();
    const firm = await mkFirm("J.P. Morgan");
    await mkPosting(firm, { deadlineStatus: "closed" });
    await withSchedule(s, "JPMorgan", "Investment Banking Summer Analyst 2027");
    assert.equal((await openList(s, now)).length, 0);
  });
  test("last cycle's closed posting of the same title does not silence this cycle's entry", async () => {
    const s = await mkStudent();
    const firm = await mkFirm("Harborview Partners");
    await track(s, firm.id);
    // Last year's, taken down; this year's not open yet.
    await mkPosting(firm, { roleTitle: "Investment Banking Summer Analyst", programYear: 2026, eligibleGradYears: [2027], isActive: false });
    await mkPosting(firm, { roleTitle: "Investment Banking Summer Analyst", deadlineStatus: "tbd", deadlineDate: null, opensAt: utcDay("2026-12-01") });
    await withSchedule(s, "Harborview Partners", "Investment Banking Summer Analyst");
    assert.equal((await openList(s, now)).length, 1, "last year's withdrawn posting silenced this year's application");
  });
  test("a withdrawn 2026 role does not silence the 2027 entry", async () => {
    const { s, p } = await datedScenario(NY, {}, "Tailwind Advisors");
    await h.db.update(internshipPostings).set({ isActive: false, roleTitle: "2026 IB Summer Analyst" }).where(eq(internshipPostings.id, p.id));
    await withSchedule(s, "Tailwind Advisors", "2027 IB Summer Analyst");
    assert.equal((await openList(s, now)).length, 1);
  });
  test("a withdrawn role at another firm does not silence this one", async () => {
    const s = await mkStudent();
    const other = await mkFirm("Southlane Partners");
    await track(s, other.id);
    await mkPosting(other, { isActive: false });
    await withSchedule(s, "Northlane Capital", ROLE);
    assert.equal((await openList(s, now)).length, 1);
  });
  test("reposted (active again): reminders resume, from the posting", async () => {
    const { s, p, key } = await datedScenario(NY, {}, "Redfern Partners");
    await withSchedule(s, "Redfern Partners", "IB SA 2027");
    await h.db.update(internshipPostings).set({ isActive: false }).where(eq(internshipPostings.id, p.id));
    assert.equal((await openList(s, now)).length, 0);
    await h.db.update(internshipPostings).set({ isActive: true }).where(eq(internshipPostings.id, p.id));
    assert.deepEqual((await openList(s, now)).map((l) => l.key), [key]);
  });
  test("'I applied' on the entry after its posting was withdrawn does nothing", async () => {
    const { s, p } = await datedScenario(NY, {}, "Kestrel Advisors");
    const a = await withSchedule(s, "Kestrel Advisors", "IB SA 2027");
    await h.db.update(internshipPostings).set({ isActive: false }).where(eq(internshipPostings.id, p.id));
    assert.equal(await iApplied(s, now, `application:${a.id}`), false);
    assert.equal((await trackerOf(s))[0].status, "not_started");
  });
});

// ============================================================================
// 4b. IMPORTED EVENTS - end to end
// ============================================================================

describe("imported calendar: what each entry becomes, and what it sets off", () => {
  // Imported on Thursday 1 October 2026 at 1pm New York.
  const IMPORTED = local(NY, 2026, 10, 1, 13);
  const SUPERDAY = local(NY, 2026, 10, 5, 14);
  let s: Student;
  let byTitle: Map<string, typeof events.$inferSelect>;
  before(async () => {
    s = await mkStudent(NY);
    const evercore = await mkFirm("Evercore");
    await track(s, evercore.id);
    await mkContact(s, "Dana Reed", "Lazard");
    const r = await importSchedule(s, IMPORTED, [
      rowAt("Evercore Superday", SUPERDAY),
      rowAt("Superday travel", local(NY, 2026, 10, 4, 18)),
      rowAt("Coffee chat with Dana Reed", local(NY, 2026, 10, 1, 10)),
      rowAt("ECON 101 lecture", local(NY, 2026, 10, 1, 9)),
      rowAt("Gym", local(NY, 2026, 10, 1, 7)),
      rowAt("Investment Club weekly meeting", local(NY, 2026, 10, 1, 8)),
      rowAt("Evercore coffee social", local(NY, 2026, 10, 1, 9, 30)),
      rowAt("Coffee chat prep", local(NY, 2026, 10, 1, 8, 30)),
      rowAt("PSET 3 due", local(NY, 2026, 10, 2, 23, 59)),
      rowAt("JPM HireVue", local(NY, 2026, 10, 3, 12)),
      rowAt("Lazard info session", local(NY, 2026, 10, 1, 6)),
      rowAt("", local(NY, 2026, 10, 1, 6)),
      { title: "Bad date", isoDateTime: "not a date" },
    ]);
    assert.deepEqual(r, { imported: 11 });
    byTitle = new Map((await eventsOf(s)).map((e) => [e.title, e]));
  });

  test("each entry is filed as a detected type, with when and from which words", () => {
    const superday = byTitle.get("Evercore Superday")!;
    assert.equal(superday.type, "interview");
    assert.equal(superday.typeSource, "detected");
    assert.equal(superday.typeDetectedFrom, "Superday");
    assert.equal(superday.typeDetectedAt?.toISOString(), IMPORTED.toISOString());
    assert.equal(byTitle.get("Coffee chat with Dana Reed")?.type, "coffee_chat");
    assert.equal(byTitle.get("ECON 101 lecture")?.type, "personal");
    assert.equal(byTitle.get("Gym")?.type, "personal");
    assert.equal(byTitle.get("Lazard info session")?.type, "info_session");
  });
  test("the imported superday gets interview prep", async () => {
    const n = await act(s, IMPORTED, () => L.getInterviewPrepNudges(s.u, IMPORTED));
    assert.ok(n.some((x) => x.title === "Evercore Superday"));
    assert.equal(n.find((x) => x.title === "Evercore Superday")?.firmName, "Evercore");
  });
  test("one superday, one prep prompt - the trip to it is not a second interview", async () => {
    const n = await act(s, IMPORTED, () => L.getInterviewPrepNudges(s.u, IMPORTED));
    assert.deepEqual(
      n.filter((x) => /superday/i.test(x.title)).map((x) => x.title),
      ["Evercore Superday"],
    );
  });
  test("the HireVue gets prep, and never a thank-you", async () => {
    const n = await act(s, IMPORTED, () => L.getInterviewPrepNudges(s.u, IMPORTED));
    assert.ok(n.some((x) => x.title === "JPM HireVue"));
    const later = local(NY, 2026, 10, 3, 18);
    const t = await act(s, later, () => L.getThankYouPrompts(s.u.id, later));
    assert.ok(!t.some((x) => x.title === "JPM HireVue"));
  });
  test("the imported coffee chat is owed a thank-you, to that contact", async () => {
    const t = await act(s, IMPORTED, () => L.getThankYouPrompts(s.u.id, IMPORTED));
    const chat = t.find((x) => x.title === "Coffee chat with Dana Reed");
    assert.ok(chat, `prompts: ${t.map((x) => x.title).join(", ")}`);
    assert.equal(chat.occasion, "chat");
    assert.equal(chat.contact?.name, "Dana Reed");
  });
  test("the lecture, the gym and the info session stay silent", async () => {
    const t = await act(s, IMPORTED, () => L.getThankYouPrompts(s.u.id, IMPORTED));
    for (const title of ["ECON 101 lecture", "Gym", "Lazard info session"]) {
      assert.ok(!t.some((x) => x.title === title), title);
    }
    const n = await act(s, IMPORTED, () => L.getInterviewPrepNudges(s.u, IMPORTED));
    assert.ok(!n.some((x) => x.title === "ECON 101 lecture"));
  });
  test("a club meeting is not a conversation to thank anyone for", async () => {
    const t = await act(s, IMPORTED, () => L.getThankYouPrompts(s.u.id, IMPORTED));
    assert.ok(!t.some((x) => x.title === "Investment Club weekly meeting"), `filed as ${byTitle.get("Investment Club weekly meeting")?.type}`);
  });
  test("a firm's coffee social is an event, not a one-to-one to thank someone for", async () => {
    const t = await act(s, IMPORTED, () => L.getThankYouPrompts(s.u.id, IMPORTED));
    assert.ok(!t.some((x) => x.title === "Evercore coffee social"), `filed as ${byTitle.get("Evercore coffee social")?.type}`);
  });
  test("preparing for a coffee chat is not a coffee chat", async () => {
    const t = await act(s, IMPORTED, () => L.getThankYouPrompts(s.u.id, IMPORTED));
    assert.ok(!t.some((x) => x.title === "Coffee chat prep"), `filed as ${byTitle.get("Coffee chat prep")?.type}`);
  });
  test("a problem set is not an application deadline on the to-do list", async () => {
    const ts = await tasks(s, IMPORTED);
    const row = ts.find((t) => t.title === "PSET 3 due");
    assert.ok(!row || !/application deadline/i.test(row.detail ?? ""), `row: ${row?.detail}`);
  });
  test("after the superday: an interview thank-you", async () => {
    const after = local(NY, 2026, 10, 5, 18);
    const t = await act(s, after, () => L.getThankYouPrompts(s.u.id, after));
    const sd = t.find((x) => x.title === "Evercore Superday");
    assert.ok(sd);
    assert.equal(sd.occasion, "interview");
  });
  test("the auto-tagger leaves every detected non-interview alone", async () => {
    await act(s, IMPORTED, () => L.getInterviewPrepNudges(s.u, IMPORTED));
    const now = new Map((await eventsOf(s)).map((e) => [e.title, e]));
    for (const [title, e] of byTitle) {
      if (e.type === "interview") continue;
      assert.equal(now.get(title)?.type, e.type, `${title} re-filed`);
    }
  });
});

describe("imported calendar: the student's own re-filing is final", () => {
  test("a detected interview re-filed as personal: no prep, no thank-you, never re-tagged", async () => {
    const s = await mkStudent();
    const at = local(NY, 2026, 10, 1, 13);
    await importSchedule(s, at, [rowAt("Goldman Superday", local(NY, 2026, 10, 3, 10))]);
    const [e] = await eventsOf(s);
    assert.equal(e.type, "interview");
    await studentRetypes(s, e.id, "personal");
    for (let d = 0; d < 3; d++) {
      const when = local(NY, 2026, 10, 1 + d, 20);
      assert.equal((await act(s, when, () => L.getInterviewPrepNudges(s.u, when))).length, 0);
    }
    const [again] = await eventsOf(s);
    assert.deepEqual([again.type, again.typeSource], ["personal", "student"]);
    const after = local(NY, 2026, 10, 3, 18);
    assert.equal((await act(s, after, () => L.getThankYouPrompts(s.u.id, after))).length, 0);
  });
  test("a detected meeting re-filed as personal: no thank-you", async () => {
    const s = await mkStudent();
    const at = local(NY, 2026, 10, 1, 13);
    await importSchedule(s, at, [rowAt("Team sync", local(NY, 2026, 10, 1, 9))]);
    const [e] = await eventsOf(s);
    await studentRetypes(s, e.id, "personal");
    assert.equal((await act(s, at, () => L.getThankYouPrompts(s.u.id, at))).length, 0);
  });
  test("a detected personal entry re-filed as an interview: prepped for", async () => {
    const s = await mkStudent();
    const at = local(NY, 2026, 10, 1, 13);
    await importSchedule(s, at, [rowAt("Evercore - Dana (2pm)", local(NY, 2026, 10, 3, 14))]);
    const [e] = await eventsOf(s);
    assert.equal(e.type, "personal");
    await studentRetypes(s, e.id, "interview");
    assert.equal((await act(s, at, () => L.getInterviewPrepNudges(s.u, at))).length, 1);
  });
  // Whether saving a detected type unchanged makes it the student's (final) is
  // a product question - only that the type survives the save is asserted.
  test("a detected type saved unchanged keeps its type", async () => {
    const s = await mkStudent();
    await importSchedule(s, local(NY, 2026, 10, 1, 13), [rowAt("Coffee with Dana Reed", local(NY, 2026, 10, 2, 9))]);
    const [e] = await eventsOf(s);
    await studentRetypes(s, e.id, e.type);
    assert.equal((await eventsOf(s))[0].type, "coffee_chat");
  });
});

describe("imported calendar: times are the student's own", () => {
  test("a 9am New York superday is stored as 9am New York, not 9am UTC", async () => {
    const s = await mkStudent(NY);
    // The import form posts the wall-clock time the browser read: "YYYY-MM-DDTHH:mm".
    await importSchedule(s, local(NY, 2026, 10, 1, 13), [{ title: "Evercore Superday", isoDateTime: "2026-10-05T09:00" }]);
    const [e] = await eventsOf(s);
    assert.equal(e.eventDate.toISOString(), local(NY, 2026, 10, 5, 9).toISOString());
  });
  test("so its thank-you is not due before the superday has even begun", async () => {
    const s = await mkStudent(NY);
    await importSchedule(s, local(NY, 2026, 10, 1, 13), [{ title: "Evercore Superday", isoDateTime: "2026-10-05T09:00" }]);
    const am830 = local(NY, 2026, 10, 5, 8, 30);
    const t = await act(s, am830, () => L.getThankYouPrompts(s.u.id, am830));
    assert.equal(t.length, 0, "thank-you owed at 8:30am for a 9am superday");
  });
  test("a hateful title blocks the whole import", async () => {
    const s = await mkStudent();
    const r = await importSchedule(s, local(NY, 2026, 10, 1, 13), [{ title: "fucking superday", isoDateTime: "2026-10-05T09:00" }]);
    assert.ok("error" in r);
    assert.equal((await eventsOf(s)).length, 0);
  });
});

