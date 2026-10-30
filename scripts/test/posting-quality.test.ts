// Is this a posting at all?
//
// The stage that had no test file, despite being the one the first live crawl
// needed most: it went straight to "does this say internship", so a filter
// control, a nav link and a sentence of marketing copy all matched, all scored
// above the auto-approve line, and all were one script away from students.
//
// Every rule here comes from a row that actually reached that point. The test
// this file applies is the one the file applies: structural, never semantic.
// Whether the words describe a good internship is classify.ts's job, and it
// can only be trusted once it is being handed real postings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPostingQuality } from "../../src/lib/monitoring/posting-quality";
import type { NormalizedListing } from "../../src/lib/monitoring/connectors/types";

const listing = (patch: Partial<NormalizedListing>): NormalizedListing => ({
  externalJobId: "req-1",
  title: "2027 Investment Banking Summer Analyst - New York",
  division: null,
  location: "New York, NY",
  descriptionRaw: "A".repeat(400),
  employmentType: null,
  applicationUrl: "https://example.com/jobs/1",
  listingUrl: "https://example.com/jobs/1",
  publishedAt: null,
  ...patch,
});

const verdict = (patch: Partial<NormalizedListing>) => assessPostingQuality(listing(patch));

test("a real posting passes", () => {
  const result = verdict({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

// ----------------------------------------------------------- board furniture

const furniture: [string, string][] = [
  ["a result counter", "Clear Region EMEA (Europe, Middle East and Africa) (22 Results) AEJ"],
  ["a filter control", "Clear all filters"],
  ["a region filter", "Clear Region EMEA"],
  ["a location filter", "Clear Location"],
  ["a category filter", "Clear Category"],
  ["show more", "Show more results"],
  ["view all", "View all jobs"],
  ["load more", "Load more"],
  ["a sort control", "Sort by date posted"],
  ["pagination", "Next"],
  ["a numbered page", "Page 2"],
  ["previous", "Previous"],
  ["a cookie link", "Cookie preferences"],
  ["a privacy link", "Privacy policy and terms"],
  ["an accessibility link", "Accessibility statement"],
];
for (const [name, title] of furniture) {
  test(`furniture is not a posting - ${name}`, () => {
    // Nomura's filter control was auto-approved as an internship because its
    // text contained "intern" further along.
    const result = assessPostingQuality(listing({ title }));
    assert.equal(result.ok, false, title);
    assert.ok(result.reasons.length > 0);
  });
}

test("a real posting with a number in parentheses is not a result counter", () => {
  // "(2 Locations)" and "(22 Results)" look alike and are not.
  assert.equal(verdict({ title: "2027 SREIT Operations Summer Analyst (2 Locations)" }).ok, true);
});

// ------------------------------------------------------------- marketing prose

const prose: [string, string][] = [
  ["first person plural", "Our internship opportunities are your steppingstone to a career"],
  ["addresses the reader", "You will join a team of talented bankers"],
  ["we will", "We'll help you build your career in banking"],
  ["you'll", "You'll work alongside senior bankers from day one"],
  ["join us", "Join us for an internship this summer"],
  ["discover", "Discover our internship programmes"],
  ["ends in a full stop", "Applications for our summer internship are now open."],
  ["marketing language", "Kickstart your career with our internship"],
  ["at Firm,", "At Deutsche Bank, our interns matter"],
];
for (const [name, title] of prose) {
  test(`marketing copy is not a role title - ${name}`, () => {
    // The test is grammatical rather than topical: a job title is a noun
    // phrase. It does not address the reader and does not end in a full stop.
    const result = assessPostingQuality(listing({ title }));
    assert.equal(result.ok, false, title);
  });
}

test("a title containing 'our' mid-phrase is not marketing copy", () => {
  // The rule is anchored to the START of the title for exactly this reason.
  assert.equal(verdict({ title: "Summer Analyst, Our Markets Division 2027" }).ok, true);
});

// ------------------------------------------------------------- bare programmes

const bareProgrammes = [
  "Internship Programme",
  "Internships",
  "Summer Internships",
  "Graduate Programme",
  "Campus Recruiting",
  "Early Careers",
  "Students and Graduates",
  "Apprenticeships",
  "Early Insights",
  "Insight Week",
  "Spring Weeks",
  "Placements",
];
for (const title of bareProgrammes) {
  test(`a programme family is a heading, not an opening: ${title}`, () => {
    // Rothschild's /apprenticeships and /early-insights were scraped as
    // listings, classified relevant, and would have reached students. Their
    // whole description was a copy of their title.
    const result = assessPostingQuality(listing({ title, descriptionRaw: title }));
    assert.equal(result.ok, false, title);
    assert.ok(result.reasons.some((r) => /programme family/.test(r)));
  });
}

const specificProgrammes = [
  "2027 Summer Internship - New York",
  "Internship Programme (Frankfurt)",
  "Summer Internship, Equity Research",
  "Campus Recruiting - Investment Banking Summer Associate",
  "Spring Week 2027",
  "Insight Programme - Markets, London",
];
for (const title of specificProgrammes) {
  test(`a programme word plus specificity is an opening: ${title}`, () => {
    assert.equal(assessPostingQuality(listing({ title })).ok, true, title);
  });
}

test("an ordinary job title is not held to the specificity test", () => {
  // Applied to every title it rejected real postings for being ordinary.
  // "Commercial Banking Compliance Officer" has no year, no city and no
  // parenthetical, and was filed as "not a posting" when it is plainly a
  // posting that simply is not an internship - a different record, and an
  // overturnable one.
  for (const title of [
    "Commercial Banking Compliance Officer",
    "Property Administrator",
    "Payroll Technician",
    "Front Desk Agent",
  ]) {
    assert.equal(assessPostingQuality(listing({ title })).ok, true, title);
  }
});

// ------------------------------------------------------------- title length

test("a title too short to be a role is refused", () => {
  for (const title of ["", "a", "Intern", "Apply"]) {
    assert.equal(assessPostingQuality(listing({ title })).ok, false, JSON.stringify(title));
  }
});

test("a paragraph is not a title", () => {
  const paragraph = "We are delighted to announce that ".repeat(8);
  const result = assessPostingQuality(listing({ title: paragraph }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /paragraph/.test(r)));
});

test("titles at the real-world extremes are accepted", () => {
  assert.equal(verdict({ title: "Intern, M&A" }).ok, true, "11 characters");
  assert.equal(
    verdict({
      title: "2027 Strategic Advisory: Mergers and Acquisitions Summer Analyst Program - Richmond, Virginia",
    }).ok,
    true,
  );
});

test("a title's surrounding whitespace is not counted against it", () => {
  assert.equal(verdict({ title: "   2027 Summer Analyst - New York   " }).ok, true);
});

// -------------------------------------------- the id / description pairing

/** A title naming a role but no year, parenthetical or city. */
const VAGUE = "Analyst Rotational Opportunity";

test("a listing with neither an id nor a body is not shown to be a posting", () => {
  const result = verdict({ title: VAGUE, externalJobId: null, descriptionRaw: "" });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /nothing that shows a posting exists/.test(r)));
});

test("a title naming a specific dated opening is evidence enough on its own", () => {
  // The narrowing. A generic-connector listing whose detail fetch came back a
  // client-rendered shell used to be DROPPED - unreviewable, filed beside
  // Nomura's filter control - even when its title named a dated role in a
  // named city. It now reaches the review queue instead.
  const title = "2027 Investment Banking Summer Analyst - New York";
  const result = assessPostingQuality(listing({ title, externalJobId: null, descriptionRaw: title }));
  assert.equal(result.ok, true);
});

const specificEnough = [
  "2027 Investment Banking Summer Analyst - New York",
  "Summer Analyst 2027",
  "Summer Analyst (Boston)",
  "Equity Research Intern, London",
];
for (const title of specificEnough) {
  test(`a stub with no id survives when the title is specific: ${title}`, () => {
    assert.equal(
      assessPostingQuality(listing({ title, externalJobId: null, descriptionRaw: title })).ok,
      true,
      title,
    );
  });
}

const notSpecificEnough = [
  "Summer Analyst",
  "Analyst Rotational Opportunity",
  "Graduate Opportunities",
  "Join Our Team Today",
];
for (const title of notSpecificEnough) {
  test(`a role word alone is NOT enough to rescue a stub: ${title}`, () => {
    // "Summer Analyst" on its own is exactly the nav link Deutsche Bank
    // published. A year, a parenthetical or a city is the bar.
    assert.equal(
      assessPostingQuality(listing({ title, externalJobId: null, descriptionRaw: title })).ok,
      false,
      title,
    );
  });
}

test("the narrowing publishes nothing - it only makes the row reviewable", () => {
  const title = "2027 Investment Banking Summer Analyst - New York";
  const result = assessPostingQuality(listing({ title, externalJobId: null, descriptionRaw: title }));
  assert.equal(result.ok, true);
  assert.equal(result.verifiable, false, "must still be barred from auto-approval");
});

test("the incidents this rule was credited with are caught by OTHER rules", () => {
  // Which is why narrowing it is safe: each of these fails on furniture,
  // prose or bare-programme grounds, not on the id/description pairing.
  const incidents = [
    "Clear Region EMEA (Europe, Middle East and Africa) (22 Results) AEJ",
    "Our internship opportunities are your steppingstone to a career",
    "Internship Programme",
    "Apprenticeships",
    "Early Insights",
  ];
  for (const title of incidents) {
    const result = assessPostingQuality(listing({ title, externalJobId: null, descriptionRaw: title }));
    assert.equal(result.ok, false, title);
    assert.ok(
      result.reasons.some((r) => !/nothing that shows a posting exists/.test(r)),
      `"${title}" is only caught by the id/description rule`,
    );
  }
});

test("a real id rescues a listing we could not read", () => {
  // iCIMS, Eightfold and Goldman return no description at all. Requiring one
  // would throw away 150 genuine Stifel openings for a shortcoming on our
  // side rather than theirs.
  assert.equal(verdict({ externalJobId: "req-99", descriptionRaw: "" }).ok, true);
});

test("a real body rescues a listing with no id", () => {
  assert.equal(verdict({ externalJobId: null, descriptionRaw: "B".repeat(400) }).ok, true);
});

test("a description that is only a copy of the title is a stub", () => {
  const result = assessPostingQuality(listing({ title: VAGUE, descriptionRaw: VAGUE, externalJobId: null }));
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------- verifiable

test("verifiable needs an id, a body and an address of its own", () => {
  assert.equal(verdict({}).verifiable, true);
});

const notVerifiable: [string, Partial<NormalizedListing>][] = [
  // "no id" alone is no longer enough to fail: a substantial body of the
  // firm's own prose is evidence in its own right - see below. A missing id
  // with only a SHORT body still fails.
  ["no id and only a short body", { externalJobId: null, descriptionRaw: "A".repeat(200) }],
  ["empty description", { descriptionRaw: "" }],
  ["stub description", { descriptionRaw: "2027 Investment Banking Summer Analyst - New York" }],
  ["short description", { descriptionRaw: "A".repeat(79) }],
  ["no application url", { applicationUrl: null }],
];
for (const [name, patch] of notVerifiable) {
  test(`not verifiable - ${name}`, () => {
    assert.equal(verdict(patch).verifiable, false, name);
  });
}

test("an UNENRICHED generic-connector listing is not verifiable", () => {
  // domCandidatesToListings sets externalJobId to null and the description to
  // the title, so a candidate scraped off a careers page and never followed
  // up goes to a human. That part is unchanged.
  const title = "2027 Summer Analyst - New York";
  const result = assessPostingQuality(
    listing({ externalJobId: null, title, descriptionRaw: title }),
  );
  assert.equal(result.verifiable, false);
});

test("an ENRICHED generic-connector listing is verifiable", () => {
  /**
   * The narrowing that mattered once the crawl stopped being 63 generic
   * sources and became 4,778 of them - 97.3% of every source there is.
   *
   * The generic connector's `enrich` fetches each candidate's own detail page,
   * so an enriched listing carries the firm's real prose even though no
   * applicant-tracking system ever issued it an id. D. E. Shaw's
   * "Quantitative Analyst Intern (New York) - Summer 2027" arrives with a
   * 2027 cycle, a sector, its own URL and 460 characters of description, and
   * was held from students purely for lacking a requisition number it can
   * never have.
   *
   * Requiring the id made a whole connector unpublishable by construction:
   * 23 of the first 25 listings from the new sources were queued on this
   * alone. The bar is the evidence, not its format.
   */
  const result = assessPostingQuality(
    listing({
      externalJobId: null,
      title: "Quantitative Analyst Intern (New York) - Summer 2027",
      descriptionRaw:
        "We are seeking a quantitative analyst intern to join our systematic trading group " +
        "in New York for the summer. You will work alongside researchers on live strategies, " +
        "building models and analysing market data. Candidates should be pursuing a degree in " +
        "a quantitative discipline and have strong programming skills. Applications are " +
        "reviewed on a rolling basis and we encourage early submission.",
    }),
  );
  assert.equal(result.verifiable, true);
});

test("a long body does not rescue a listing with no address of its own", () => {
  // The other two conditions still stand. Evidence of a posting means text
  // AND somewhere it lives.
  const result = assessPostingQuality(
    listing({ externalJobId: null, applicationUrl: null, descriptionRaw: "B".repeat(600) }),
  );
  assert.equal(result.verifiable, false);
});

test("verifiable is independent of ok", () => {
  // A posting with an id but no description is REAL and belongs in the review
  // queue where a person can open it - it must not be published unread,
  // because the description is also where eligibility is stated.
  const result = verdict({ descriptionRaw: "" });
  assert.equal(result.ok, true);
  assert.equal(result.verifiable, false);
});

// ------------------------------------------------------------ reasons are usable

test("a refusal always says why, quotably", () => {
  for (const title of ["Clear all filters", "Internships", "You'll love it here."]) {
    const result = assessPostingQuality(listing({ title }));
    assert.equal(result.ok, false, title);
    assert.ok(result.reasons.length > 0, title);
    for (const reason of result.reasons) {
      assert.ok(reason.length > 5, `"${reason}" is too short to quote in a review queue`);
    }
  }
});

test("a passing listing carries no reasons", () => {
  assert.deepEqual(verdict({}).reasons, []);
});

test("only one furniture reason is reported, not every match", () => {
  // The loops break on first match - a reviewer wants the reason, not a list.
  const result = assessPostingQuality(listing({ title: "Clear all filters (22 Results)" }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.length <= 3);
});

// -------------------------------------------------------------- robustness

test("nothing here throws on degenerate input", () => {
  const degenerate: Partial<NormalizedListing>[] = [
    { title: "" },
    { title: " ", descriptionRaw: "" },
    { title: "\n\t\n", descriptionRaw: "\n" },
    { externalJobId: null, applicationUrl: null, descriptionRaw: "" },
    { title: "         " },
  ];
  for (const patch of degenerate) {
    assert.doesNotThrow(() => assessPostingQuality(listing(patch)), JSON.stringify(patch));
  }
});

test("a title joined by a non-breaking space is judged as normal text", () => {
  // A scraper joining two DOM nodes produced exactly this, and it moved a
  // verdict in the classifier robustness suite.
  assert.equal(verdict({ title: "2027 Summer Analyst - New York" }).ok, true);
});

test("an en-dash title is judged as normal text", () => {
  assert.equal(verdict({ title: "Real Estate Financial Senior Analyst – Investments" }).ok, true);
});

test("a French title is not refused for being French", () => {
  // Every rule in this file was written against English. These are real
  // postings from this corpus.
  for (const title of [
    "Stage - Analyste M&A, Paris",
    "Stagiaire Corporate Finance H/F",
    "Praktikum Investment Banking (m/w/d)",
  ]) {
    assert.equal(assessPostingQuality(listing({ title })).ok, true, title);
  }
});

// ------------------------------- specificity without a hardcoded city list
//
// Found on the FIRST live non-banking crawl. Starwood Capital's "Japan
// Acquisitions Internship" was dropped as "names a programme family rather
// than a specific opening" - a real internship at a real firm, filed as page
// furniture and therefore never reviewable.
//
// The rule demanded a year, a parenthetical, a role word, or a city from a
// list of sixteen. Tokyo was on it. Japan was not. So did everywhere else on
// earth fail.

const realOpeningsAnywhere = [
  "Japan Acquisitions Internship",
  "EMEA Credit Internship",
  "Dublin Operations Internship",
  "Mumbai Wealth Management Internship",
  "APAC Markets Internship",
  "Nordics Coverage Internship",
  "Milan Advisory Internship",
  "São Paulo Research Internship",
];
for (const title of realOpeningsAnywhere) {
  test(`an opening outside the sixteen listed cities survives: ${title}`, () => {
    assert.equal(assessPostingQuality(listing({ title })).ok, true, title);
  });
}

const stillHeadings = [
  "Internships",
  "Internship Programme",
  "Summer Internships",
  "Graduate Programme",
  "Campus Recruiting",
  "Early Careers",
  "Students and Graduates",
  "Apprenticeships",
  "Early Insights",
  "Insight Week",
  "Spring Weeks",
  "Placements",
  "Early Careers Opportunities",
  "Our Internship Programmes",
  "Student Opportunities",
  "Graduate Schemes",
];
for (const title of stillHeadings) {
  test(`a heading built only of programme words is still dropped: ${title}`, () => {
    // Enumerating the qualifying words is endless - there are as many as there
    // are places and desks. Enumerating the GENERIC ones is finite.
    assert.equal(assessPostingQuality(listing({ title, descriptionRaw: title })).ok, false, title);
  });
}

test("the Rothschild category pages that prompted this rule are still caught", () => {
  for (const title of ["Apprenticeships", "Early Insights"]) {
    assert.equal(assessPostingQuality(listing({ title, descriptionRaw: title })).ok, false, title);
  }
});

test("the leniency is deliberate and one-directional", () => {
  // This rule decides DROPPED versus reviewed, and dropped is invisible.
  // Being too strict costs a real internship nobody ever sees; being too
  // loose costs a reviewer a glance at a heading.
  const borderline = "Investment Banking Internships";
  assert.equal(
    assessPostingQuality(listing({ title: borderline })).ok,
    true,
    "a title naming a division should reach a human rather than vanish",
  );
});

// ---------------------------------------------- a role with its offices after it
//
// Measured against Supabase on 20 September 2026: six listings were rejected
// as "a paragraph, not a role". Five were genuinely not roles - Deutsche
// Bank's board emits 160-character sentences of marketing copy. The sixth was
// BDO's real consulting internship, over the 140 cap by ONE character, 61 of
// which were a parenthesised list of five offices.
//
// This matters most to the sectors that post one role across many cities -
// consulting and accounting - which is the shape the cap was silently taxing.

test("a real role is not a paragraph because it lists its offices", () => {
  const title =
    "Advisory Intern, Management Consulting, People Strategy & Solutions - Summer 2027 " +
    "(Boston, Denver, Los Angeles, New York City, San Francisco)";
  assert.ok(title.length > 140, "the premise: this title really is over the cap");
  const v = assessPostingQuality(listing({ title }));
  assert.ok(
    !v.reasons.some((r) => r.includes("a paragraph, not a role")),
    `expected no paragraph rejection, got: ${v.reasons.join("; ")}`,
  );
});

test("marketing prose with no parenthetical is still rejected", () => {
  // Deutsche Bank's real board text. Nothing here is a role, and stripping
  // offices must not rescue it.
  const title =
    "Our internship opportunities are your steppingstone to a career a Deutsche Bank. " +
    "You'll receive formal training, and you'll quickly gain the confidence to take ";
  const v = assessPostingQuality(listing({ title }));
  assert.ok(v.reasons.length > 0, "expected this to be rejected");
});

test("a paragraph that happens to end in a parenthetical is still a paragraph", () => {
  // Stripping the offices must not become a way to smuggle prose past the cap.
  const title = `${"word ".repeat(40)}(New York)`;
  const v = assessPostingQuality(listing({ title }));
  assert.ok(
    v.reasons.some((r) => r.includes("a paragraph, not a role")),
    `expected a paragraph rejection, got: ${v.reasons.join("; ")}`,
  );
});

test("a short title is still measured whole", () => {
  // MIN_TITLE reads the real title: removing offices must not make a short
  // title look even shorter and start failing for a second reason.
  const v = assessPostingQuality(listing({ title: "Intern (NY)" }));
  assert.ok(!v.reasons.some((r) => r.includes("too short")), v.reasons.join("; "));
});

// ------------------------------------- links that are not jobs, from generic
//
// A connector reading an ordinary careers page has no vacancy table, so it
// takes the links it can find - and a careers page is mostly links that are
// not jobs. All three of these were live in the review queue on 20 September
// 2026, each with a title, no description, and nothing for a human to judge.
// HSBC's nav link was there six times over.

test("a breadcrumb is not a role", () => {
  const v = assessPostingQuality(listing({ title: "Home > Internship Program" }));
  assert.ok(v.reasons.some((r) => r.includes("breadcrumb")), v.reasons.join("; "));
});

test("a link to a list of jobs is not a job", () => {
  // The shapes the existing rules could not see. "Explore our opportunities"
  // is deliberately absent: the marketing-copy rule already rejects anything
  // opening with "our", so asserting the new reason there would test which
  // rule fired rather than whether the listing is kept out.
  for (const title of ["View internship programmes", "Find a programme", "Browse internship roles"]) {
    const v = assessPostingQuality(listing({ title }));
    assert.ok(v.reasons.some((r) => r.includes("list of jobs")), `${title}: ${v.reasons.join("; ")}`);
  }
});

test("every nav-link shape is rejected, whichever rule catches it", () => {
  // What actually matters: none of these reaches a reviewer.
  for (const title of [
    "View internship programmes",
    "Explore our opportunities",
    "Find a programme",
    "Browse internship roles",
  ]) {
    const v = assessPostingQuality(listing({ title }));
    assert.ok(v.reasons.length > 0, `${title} was accepted as a posting`);
  }
});

test("a mailto link is an invitation, not a posting", () => {
  const v = assessPostingQuality(
    listing({
      title: "Contact us about internship opportunities",
      listingUrl: "mailto:careers@bourne-partners.com",
    }),
  );
  assert.ok(
    v.reasons.some((r) => r.includes("email address")),
    v.reasons.join("; "),
  );
});

test("a real role with a normal URL is untouched by any of them", () => {
  // The guard on all three: none may fire on an ordinary posting.
  for (const title of [
    "2027 Investment Banking Summer Analyst",
    "Summer Analyst 2027 Boston, Massachusetts Investment Banking",
    "Quantitative Researcher Intern",
    "Private Equity Summer Associate - New York",
  ]) {
    const v = assessPostingQuality(listing({ title, listingUrl: "https://example.com/jobs/1" }));
    assert.ok(
      !v.reasons.some((r) => /breadcrumb|list of jobs|email address/.test(r)),
      `${title}: ${v.reasons.join("; ")}`,
    );
  }
});

test("a title with a hyphen or colon is not mistaken for a breadcrumb", () => {
  // The breadcrumb rule keys on > › », never on the punctuation real titles
  // use - which is most of them.
  for (const title of [
    "Internship - Marketing (Year-Round)",
    "Strategic Advisory: Summer Associate Program",
    "2027 - Global Markets - Rates Sales - Off Cycle Internship",
  ]) {
    const v = assessPostingQuality(listing({ title }));
    assert.ok(!v.reasons.some((r) => r.includes("breadcrumb")), `${title}: ${v.reasons.join("; ")}`);
  }
});

// ------------------------------------- what was filling the review queue

/**
 * The 748 open listings sitting in the review queue on 11 October 2026.
 *
 * It was not full of hard calls. It was full of links, articles and press
 * releases scraped off careers pages - and nobody had ever reviewed a row in
 * the system's history (`reviewed_by` was NULL on all 21,432), so they simply
 * accumulated. One of them, "Search for graduate and intern roles", had been
 * auto-approved and PUBLISHED to students as an internship.
 *
 * Every title below is real, taken from the stored corpus. Each rule was
 * measured against all 9,411 distinct stored titles before being added: 28
 * titles matched between them and not one was a job posting.
 */
const NOT_POSTINGS: [string, string][] = [
  ["Search internship jobs", "a search link (MSCI)"],
  ["Search for graduate and intern roles", "the one that reached students"],
  ["Search Internship Opportunities", "a search link"],
  ["View open internships in Canada Opens in new tab", "a nav link"],
  ["See internship opportunities , opens in new tab", "a nav link"],
  ["More about internships", "a link to information (Fidelity)"],
  ["Learn more about Associate internships", "a link to information"],
  ["Learn More about Summer Analyst", "a link to information"],
  ["Careers Internship Corner", "a section of a site"],
  ["Internship Corner", "a section of a site"],
  ["How to Land a Balyasny Internship", "an article about applying"],
  ["How to choose the right Fidelity internship focus area for you", "an article"],
  ["S2G Investments Closes $1 Billion Solutions Fund I to Scale Growth", "a press release"],
  ["Highland Europe raises €1.1B Fund VI to Continue Backing Founders", "a press release"],
  ["Quinbrook Closes GBP 587 Million Renewables Impact Fund II", "a press release"],
];

for (const [title, why] of NOT_POSTINGS) {
  test(`not a posting: ${title.slice(0, 54)} (${why})`, () => {
    const v = assessPostingQuality(listing({ title }));
    assert.equal(v.ok, false, `accepted as a posting; reasons: ${v.reasons.join("; ")}`);
    assert.ok(v.reasons.length > 0, "a rejection must say why");
  });
}

test("the new rules do not touch real postings", () => {
  /**
   * The danger in adding title rules is rejecting the thing you are looking
   * for. These are real published titles from the corpus, including ones that
   * contain the very words the rules match on - "Fund", "Analyst", "Program".
   */
  const REAL = [
    "2027 Investment Banking Summer Analyst Program - New York",
    "Summer Analyst, Fund Finance",
    "2027 ISG & MSIM Spring Insight Programme (Frankfurt)",
    "University Intern, Strategic Finance, Turnaround & Restructuring",
    "Wealth Management Intern",
    "6-Month Off-Cycle Internship - Corporate Finance",
    "Analyst, Fund Launches and Product Development",
    "2027 Global Markets Summer Internship Program - Singapore",
  ];
  for (const title of REAL) {
    const v = assessPostingQuality(listing({ title, descriptionRaw: "x".repeat(400) }));
    assert.equal(v.ok, true, `REJECTED a real posting: ${title} <- ${v.reasons.join("; ")}`);
  }
});
