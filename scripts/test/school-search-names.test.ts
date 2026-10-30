import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";

import { buildSearchQuery, type StudentDossier } from "@/lib/contact-sourcing-agent";
import { relaxQueryForTier, searchPeopleForTier, toCrustdataRequest } from "@/lib/crustdata-client";
import { DEFAULT_TIERS } from "@/lib/contact-tiers";
import {
  businessSchoolNames,
  fallbackSchoolNames,
  onSchoolDomain,
  schoolLookupNames,
  selectSchoolSearchNames,
  type SchoolCandidate,
} from "@/lib/school-search-names";

const edu = (name: string, primaryDomain: string | null, industries = ["Higher Education"]): SchoolCandidate => ({
  name,
  primaryDomain,
  domains: primaryDomain ? [primaryDomain] : [],
  industries,
});

// What the provider's free identify lookup returned on 2026-09-23 for
// upenn.edu, for the name "University of Pennsylvania", and for "The Wharton
// School" - the three lookups a Penn student's school resolves with.
const PENN_CANDIDATES: SchoolCandidate[] = [
  edu("University of Pennsylvania", "upenn.edu"),
  edu("University of Pennsylvania Graduate School of Education", "upenn.edu"),
  edu("University of Pennsylvania School of Nursing", "upenn.edu"),
  edu("Penn Medicine, University of Pennsylvania Health System", "pennmedicine.org", ["Hospitals and Health Care"]),
  edu("University of Pennsylvania Carey Law School", "upenn.edu"),
  edu("University of Pennsylvania", "upenn.edu"),
  edu("Indiana University of Pennsylvania", "iup.edu"),
  edu("Shippensburg University of Pennsylvania", "ship.edu"),
  edu("Kutztown University of Pennsylvania", "kutztown.edu"),
  edu("Millersville University of Pennsylvania", "millersville.edu"),
  edu("West Chester University of Pennsylvania", "wcupa.edu"),
  edu("East Stroudsburg University of Pennsylvania", "esu.edu"),
  edu("The Wharton School", "upenn.edu"),
  edu("Travel and Hospitality Club at The Wharton School", null, ["Hospitality"]),
  edu("The Wharton Group", "thewhartongroup.ca"),
  edu("The Wharton Agency", "whartonins.com", ["Insurance"]),
];

test("a Penn student's names are Penn's, and none of the other Universities of Pennsylvania", () => {
  const names = selectSchoolSearchNames("upenn.edu", PENN_CANDIDATES);
  assert.ok(names.includes("University of Pennsylvania"));
  assert.ok(names.includes("The Wharton School"), "Wharton alumni are Penn alumni");
  for (const other of ["Indiana", "Shippensburg", "Kutztown", "Millersville", "West Chester", "East Stroudsburg"]) {
    assert.ok(!names.some((n) => n.startsWith(other)), `${other} is another school`);
  }
  assert.ok(!names.some((n) => n.includes("Penn Medicine")), "a hospital is not a school");
  assert.ok(!names.some((n) => n.includes("Wharton Group") || n.includes("Wharton Agency")));
  assert.equal(names.filter((n) => n === "University of Pennsylvania").length, 1, "listed once");
});

test("a subdomain is the school's, a parent domain is not", () => {
  assert.equal(onSchoolDomain("wharton.upenn.edu", "upenn.edu"), true);
  assert.equal(onSchoolDomain("UPENN.EDU", "upenn.edu"), true);
  // Baruch signs up as baruch.cuny.edu; the rest of CUNY is not Baruch.
  assert.equal(onSchoolDomain("cuny.edu", "baruch.cuny.edu"), false);
  assert.equal(onSchoolDomain("hunter.cuny.edu", "baruch.cuny.edu"), false);
  assert.equal(onSchoolDomain("notupenn.edu", "upenn.edu"), false);
});

test("a school's long names are looked up, never its bare nickname", () => {
  const names = schoolLookupNames("University of Pennsylvania", "Penn");
  assert.ok(names.includes("University of Pennsylvania"));
  assert.ok(names.some((n) => /wharton school/i.test(n)));
  assert.ok(!names.includes("penn"), "a lookup on 'penn' returns everything");
  assert.ok(names.length <= 8);
  // A business school is looked for under each of the ways one is named.
  assert.ok(names.includes("University of Pennsylvania school of business"));
  assert.ok(names.includes("University of Pennsylvania college of business"));
});

test("a school the nickname table knows is also looked up by its business school's brand", () => {
  const names = schoolLookupNames("Boston University", null);
  assert.ok(names.includes("Boston University questrom"), names.join(" | "));
});

test("the fallback is the typed name and its full name, once each", () => {
  assert.deepEqual(fallbackSchoolNames("UPenn"), ["UPenn", "university of pennsylvania"]);
  assert.deepEqual(fallbackSchoolNames("University of Pennsylvania"), ["University of Pennsylvania"]);
  assert.deepEqual(fallbackSchoolNames(null), []);
});

const dossier = {
  identity: { name: "Kai", school: "University of Pennsylvania", major: null, gradYear: 2028, hometown: null },
  targeting: { sectors: [], sectorLabels: [], coverage: [], ibTiers: [], peTiers: [], locations: [], recruitingStage: null },
  background: { clubs: null, priorExperience: [], interests: null, proudExperience: null, workStyle: null },
  resume: { present: false, interests: [], employers: [], activities: [], skills: [] },
  linkedinUrl: null,
  consent: { shareHometown: false, shareInterests: false },
} as unknown as StudentDossier;

const penn = { label: "University of Pennsylvania", names: ["University of Pennsylvania", "The Wharton School"] };

function schoolCondition(request: Record<string, unknown>): unknown {
  const found: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { field?: string; conditions?: unknown[] };
    if (n.field === "education.schools.school") found.push(n);
    if (Array.isArray(n.conditions)) {
      if (n.conditions.every((c) => (c as { field?: string }).field === "education.schools.school")) {
        found.push(n);
        return;
      }
      n.conditions.forEach(walk);
    }
    for (const v of Object.values(n)) if (v && typeof v === "object" && v !== n.conditions) walk(v);
  };
  walk(request);
  return found[0] ?? null;
}

test("the provider is asked for the school's names exactly, never as a word match", () => {
  const query = buildSearchQuery({
    dossier,
    school: penn,
    firm: { name: "BlackRock", website: "blackrock.com" },
    category: null,
    limit: 5,
    existing: [],
  });
  const cond = schoolCondition(toCrustdataRequest(query)) as { op: string; conditions: { type: string; value: string }[] };
  assert.equal(cond.op, "or");
  assert.deepEqual(
    cond.conditions.map((c) => [c.type, c.value]),
    [["=", "University of Pennsylvania"], ["=", "The Wharton School"]],
  );
  assert.ok(!JSON.stringify(toCrustdataRequest(query)).includes('"(.)","value":"University of Pennsylvania"'));
});

test("the same-school tiers keep the names and the any-school tiers drop them", () => {
  const query = buildSearchQuery({
    dossier,
    school: penn,
    firm: { name: "BlackRock", website: "blackrock.com" },
    category: null,
    limit: 5,
    existing: [],
  });
  for (const tier of DEFAULT_TIERS) {
    const relaxed = relaxQueryForTier(query, tier);
    const kept = schoolCondition(toCrustdataRequest(relaxed)) !== null;
    assert.equal(kept, !tier.drop.includes("school"), tier.label);
  }
});

test("without a resolved school the typed name is still matched exactly", () => {
  const query = buildSearchQuery({
    dossier,
    firm: { name: "BlackRock", website: "blackrock.com" },
    category: null,
    limit: 5,
    existing: [],
  });
  assert.deepEqual(query.education.school, {
    label: "University of Pennsylvania",
    names: ["University of Pennsylvania"],
    businessNames: [],
  });
  const cond = schoolCondition(toCrustdataRequest(query)) as { type: string; value: string };
  assert.equal(cond.type, "=");
});

test("the business school is picked out of the university's names", () => {
  const pennNames = selectSchoolSearchNames("upenn.edu", PENN_CANDIDATES);
  assert.deepEqual(businessSchoolNames(pennNames), ["The Wharton School"]);
  assert.deepEqual(
    businessSchoolNames([
      "University of Southern California",
      "USC Marshall School of Business",
      "Keck School of Medicine of the University of Southern California",
      "USC Viterbi School of Engineering",
    ]),
    ["USC Marshall School of Business"],
  );
});

function namesSent(query: ReturnType<typeof buildSearchQuery>): string[] {
  const cond = schoolCondition(toCrustdataRequest(query)) as
    | { value?: string; conditions?: { value: string }[] }
    | null;
  if (!cond) return [];
  return cond.conditions ? cond.conditions.map((c) => c.value) : [cond.value!];
}

test("business school first, then the whole university, and only then anyone else", () => {
  const query = buildSearchQuery({
    dossier,
    school: penn,
    firm: { name: "BlackRock", website: "blackrock.com" },
    category: null,
    limit: 5,
    existing: [],
  });
  const firstUniversityWide = DEFAULT_TIERS.findIndex((t) => !t.businessSchoolOnly && !t.drop.includes("school"));
  const firstOtherSchools = DEFAULT_TIERS.findIndex((t) => t.drop.includes("school"));
  const lastBusiness = DEFAULT_TIERS.map((t) => !!t.businessSchoolOnly).lastIndexOf(true);
  assert.ok(lastBusiness >= 0 && lastBusiness < firstUniversityWide, "Wharton rungs come first");
  assert.ok(firstUniversityWide < firstOtherSchools, "a Penn alum outside Wharton beats any other school");

  // The Wharton rungs send only Wharton; the university rungs send all of Penn.
  for (const tier of DEFAULT_TIERS.filter((t) => t.businessSchoolOnly)) {
    assert.deepEqual(namesSent(relaxQueryForTier(query, tier)), ["The Wharton School"], tier.label);
  }
  for (const tier of DEFAULT_TIERS.filter((t) => !t.businessSchoolOnly && !t.drop.includes("school"))) {
    assert.deepEqual(namesSent(relaxQueryForTier(query, tier)), penn.names, tier.label);
  }
});

test("a school with no business-school names skips those rungs without a call", async () => {
  const query = buildSearchQuery({
    dossier,
    school: { label: "Villanova University", names: ["Villanova University"] },
    firm: { name: "BlackRock", website: "blackrock.com" },
    category: null,
    limit: 5,
    existing: [],
  });
  assert.deepEqual(query.education.school?.businessNames, []);
  // no-network makes any fetch throw, so reaching the provider fails the test.
  for (const tier of DEFAULT_TIERS.filter((t) => t.businessSchoolOnly)) {
    const r = await searchPeopleForTier(query, tier, 5);
    assert.deepEqual(r, { contacts: [], creditsUsed: 0, totalCount: 0 }, tier.label);
  }
});

test("a later rung reaches past the people an earlier rung already returned", async () => {
  const { searchTiersExcludingSeen } = await import("@/lib/crustdata-client");
  const query = buildSearchQuery({
    dossier,
    school: penn,
    firm: { name: "BlackRock", website: "blackrock.com" },
    category: null,
    limit: 5,
    existing: [{ name: "Saved Earlier", linkedinUrl: "https://www.linkedin.com/in/saved/" }],
  });
  const excludedPerCall: string[][] = [];
  const person = (n: number) => ({ name: `P${n}`, linkedinUrl: `https://www.linkedin.com/in/p${n}/` });
  let n = 0;
  const search = searchTiersExcludingSeen(query, async (q, _tier, limit) => {
    excludedPerCall.push([...q.exclude.linkedinUrls]);
    const contacts = Array.from({ length: limit }, () => person(++n));
    return { contacts: contacts as never, creditsUsed: 0, totalCount: contacts.length };
  });
  await search(DEFAULT_TIERS[0], 2);
  await search(DEFAULT_TIERS[2], 3);
  assert.deepEqual(excludedPerCall[0], ["https://www.linkedin.com/in/saved/"]);
  assert.deepEqual(excludedPerCall[1], [
    "https://www.linkedin.com/in/saved/",
    "https://www.linkedin.com/in/p1/",
    "https://www.linkedin.com/in/p2/",
  ]);
});

function seniorityOf(request: Record<string, unknown>): { levels: string[] | null; yearsCap: boolean } {
  const s = JSON.stringify(request);
  const m = s.match(/"field":"experience\.employment_details\.current\.seniority_level","type":"in","value":(\[[^\]]*\])/);
  return { levels: m ? JSON.parse(m[1]) : null, yearsCap: s.includes('"years_of_experience_raw"') };
}

test("seniority widens bottom to top at the student's school, never associates alone", () => {
  const query = buildSearchQuery({
    dossier,
    school: penn,
    firm: { name: "Blackstone", website: "blackstone.com" },
    category: "private_equity",
    limit: 5,
    existing: [],
  });
  const at = (label: string) => {
    const tier = DEFAULT_TIERS.find((t) => t.label === label);
    assert.ok(tier, label);
    return seniorityOf(toCrustdataRequest(relaxQueryForTier(query, tier!)));
  };
  assert.deepEqual(at("same school, any city or graduation year").levels, ["Entry Level", "Senior"]);
  assert.deepEqual(at("same school, up to vice president").levels, [
    "Entry Level",
    "Senior",
    "Experienced Manager",
    "Director",
    "Vice President",
  ]);
  const any = at("same school, any seniority");
  assert.equal(any.levels, null, "no seniority filter: MDs and partners count");
  assert.equal(any.yearsCap, false, "an MD's twenty-plus years must not exclude them");

  const order = DEFAULT_TIERS.map((t) => t.label);
  assert.ok(order.indexOf("same school, any city or graduation year") < order.indexOf("same school, up to vice president"));
  assert.ok(order.indexOf("same school, up to vice president") < order.indexOf("same school, any seniority"));
  assert.ok(order.indexOf("same school, any seniority") < order.indexOf("any school, same city"));
});

test("a school whose LinkedIn pages use another domain than its email: Indiana", async () => {
  const { schoolDomains } = await import("@/lib/school-search-names");
  // Live data, 2026-09-25. Students sign up with indiana.edu.
  const ind = (name: string, primary: string, all: string[], industry = "Higher Education"): SchoolCandidate => ({
    name, primaryDomain: primary, domains: all, industries: [industry],
  });
  const candidates = [
    ind("Indiana University Bloomington Staff Council", "indiana.edu", ["indiana.edu"]),
    ind("Indiana University Luddy School of Informatics, Computing, and Engineering", "indiana.edu", ["indiana.edu", "iu.edu"]),
    ind("Center for Innovative Teaching and Learning - Indiana University Bloomington", "indiana.edu", ["indiana.edu"]),
    ind("Indiana University Bloomington", "iu.edu", ["indiana.edu", "iu.edu"]),
    ind("Indiana University - Kelley School of Business", "iu.edu", ["iu.edu"]),
    ind("Purdue University", "purdue.edu", ["purdue.edu"]),
  ];
  const domains = schoolDomains("indiana.edu", candidates, "Indiana University Bloomington");
  assert.ok(domains.includes("iu.edu"), "the main page's other domain is the school's");
  const names = selectSchoolSearchNames(domains, candidates, "Indiana University-Bloomington");
  assert.equal(names[0], "Indiana University Bloomington", "the school itself first");
  assert.equal(names[1], "Indiana University - Kelley School of Business", "then its business school");
  assert.ok(names.indexOf("Indiana University Bloomington Staff Council") > names.indexOf("Indiana University Luddy School of Informatics, Computing, and Engineering"), "councils rank below schools");
  assert.ok(!names.includes("Purdue University"));
});
