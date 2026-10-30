import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPosting } from "../../src/lib/posting-format";

const text = (f: ReturnType<typeof formatPosting>) =>
  f.sections
    .flatMap((s) => s.blocks)
    .map((b) => (b.type === "list" ? b.items.join(" | ") : b.text))
    .join(" ");

const section = (f: ReturnType<typeof formatPosting>, heading: string) =>
  f.sections.find((s) => s.heading === heading);

test("the Title/Deadline preamble is dropped - the card already shows both", () => {
  const f = formatPosting({
    description:
      "Title:2028 Equities Summer Intern – New York Application Deadline:15 Nov 2026 11:55 PM EST Job description We are hiring.",
    firmName: "Evercore",
  });
  const body = text(f);
  assert.ok(!body.includes("Application Deadline"), body);
  assert.ok(!body.includes("Nov 2026"), body);
  assert.ok(body.includes("We are hiring."));
});

test("a deadline with no time is still consumed whole", () => {
  const f = formatPosting({
    description: "Title:Analyst Application Deadline:3 Jan 2027 Job description Body text here.",
  });
  assert.ok(!text(f).includes("Jan 2027"), text(f));
});

test("double-encoded entities do not reach the student", () => {
  const f = formatPosting({ description: "Job description Applications are open!&amp;#160;Apply now." });
  const body = text(f);
  assert.ok(!body.includes("&#160;"), body);
  assert.ok(!body.includes("&amp;"), body);
});

test("known headings become sections", () => {
  const f = formatPosting({
    description:
      "Job description We run a ten week programme. Responsibilities Support the desk. What are the Specific Qualifications? Strong communication.",
  });
  assert.ok(section(f, "The role"), "expected a role section");
  assert.ok(section(f, "Responsibilities"), "expected a responsibilities section");
  assert.ok(section(f, "Qualifications"), "expected a qualifications section");
  assert.equal(f.structured, true);
});

test("firm background and equal-opportunity text are boilerplate, and sort last", () => {
  const f = formatPosting({
    description:
      "Job description The role. About Evercore Evercore is a firm. Inclusion and Equal Opportunity Employment: We do not discriminate.",
    firmName: "Evercore",
  });
  assert.equal(section(f, "About the firm")?.kind, "boilerplate");
  assert.equal(section(f, "Equal opportunity")?.kind, "boilerplate");
  assert.equal(f.hasBoilerplate, true);
  // Primary content must come first, whatever order the firm wrote it in.
  const kinds = f.sections.map((s) => s.kind);
  assert.deepEqual(kinds, [...kinds].sort((a, b) => (a === "primary" ? -1 : 1) - (b === "primary" ? -1 : 1)));
});

test("requirements are located in the description, not printed twice", () => {
  const req = "Pursuing an undergraduate degree with a graduation date between December 2028 and June 2029.";
  const f = formatPosting({
    description: `Job description We are hiring. ${req} About Evercore Evercore is a firm.`,
    requirements: req,
    firmName: "Evercore",
  });
  assert.ok(section(f, "Requirements"), "expected a requirements section");
  const body = text(f);
  const occurrences = body.split("graduation date").length - 1;
  assert.equal(occurrences, 1, `requirements duplicated:\n${body}`);
});

test("a requirements span that runs into firm background is cut at the boilerplate", () => {
  const f = formatPosting({
    description: "Job description Hiring. Must be an undergraduate. About Evercore Evercore is a firm.",
    requirements: "Must be an undergraduate. About Evercore Evercore is a firm.",
    firmName: "Evercore",
  });
  const reqText = section(f, "Requirements")!
    .blocks.map((b) => (b.type === "list" ? b.items.join(" ") : b.text))
    .join(" ");
  assert.ok(reqText.includes("undergraduate"), reqText);
  assert.ok(!reqText.includes("premier"), reqText);
  assert.ok(!reqText.includes("Evercore is a firm"), reqText);
});

test("bullets are produced where a delimiter survived", () => {
  const f = formatPosting({
    description: "Job description Role.\nResponsibilities\n• Support the desk\n• Build models\n• Attend meetings",
  });
  const list = section(f, "Responsibilities")!.blocks.find((b) => b.type === "list");
  assert.ok(list && list.type === "list");
  assert.deepEqual(list.items, ["Support the desk", "Build models", "Attend meetings"]);
});

test("bullets are NOT invented when the source has no delimiter", () => {
  // Four requirements run together with nothing between them. Any rule that
  // splits this also splits "New York", so it must stay one paragraph.
  const run =
    "Pursuing an undergraduate degree with a graduation date between December 2028 and June 2029 Relevant internship experience preferred Strong communications skills";
  const f = formatPosting({ description: `Job description Role. Requirements ${run}` });
  const blocks = section(f, "Requirements")!.blocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "paragraph");
});

test("an unrecognised posting still returns readable prose rather than nothing", () => {
  const f = formatPosting({ description: "We are looking for a summer analyst to join the team." });
  assert.equal(f.structured, false);
  assert.equal(f.sections.length, 1);
  assert.ok(text(f).includes("summer analyst"));
});

test("degenerate input never throws", () => {
  for (const d of ["", "   ", "Title:", "&#;", "\n\n\n", "a".repeat(20_000)]) {
    assert.doesNotThrow(() => formatPosting({ description: d, requirements: d, firmName: d }));
  }
});

test("the cookie line is lifted off the salary and kept for the bottom of the listing", () => {
  const f = formatPosting({
    description:
      "Job description We are hiring. Expected Base Salary Range: $115,000 – $115,000 View cookie / data protection and privacy policy",
    firmName: "Evercore",
  });
  assert.equal(f.privacyNote, "View cookie / data protection and privacy policy");
  const pay = section(f, "Compensation");
  assert.ok(pay, "compensation section kept");
  const payText = pay.blocks.map((b) => (b.type === "list" ? b.items.join(" ") : b.text)).join(" ");
  assert.equal(payText, "$115,000 – $115,000");
  assert.ok(!text(f).includes("cookie"), text(f));
});

test("the cookie line is lifted from mid-text too, and absent postings carry no note", () => {
  const f = formatPosting({
    description: "Job description Role text. View cookie / data protection and privacy policy Job Level Intern",
  });
  assert.equal(f.privacyNote, "View cookie / data protection and privacy policy");
  assert.ok(!text(f).includes("cookie"), text(f));
  assert.equal(formatPosting({ description: "Job description Role text." }).privacyNote, null);
});

test("a cookie line the crawl cut off partway is still lifted", () => {
  const f = formatPosting({ description: "Job description Role text. View cookie / data protec" });
  assert.equal(f.privacyNote, "View cookie / data protection and privacy policy");
  assert.equal(text(f), "Role text.");
});
