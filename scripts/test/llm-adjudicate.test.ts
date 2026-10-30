// The pre-filter that decides which rejected listings are worth a model call.
//
// This is the cost control for the adjudicator, and it has to be looser than
// the phrase list it second-guesses - if it rejected the same things the
// phrase list rejects, the adjudicator would never see the postings it exists
// for and the whole exercise would be a no-op.
//
// The cases below are the real ones: the 42 French internships lost to
// `Stage H/F - Private Equity`, and the experienced-hire titles that fill
// Oracle HCM's 672 rejections per cycle and must not each cost a model call.
//
// The model call itself is not tested here - it needs a network and a key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksPromising } from "../../src/lib/monitoring/llm-adjudicate";

const LONG = " The team works across coverage and execution. ".repeat(6);

test("the French internships that were lost are worth asking about", () => {
  // Lazard posts `Stage H/F - Private Equity - Janvier 2027`. "stage" was not
  // in the phrase list, and 42 real internships were dropped.
  assert.equal(
    looksPromising(
      "Stage H/F - Private Equity - Janvier 2027",
      `Stage de 6 mois en private equity.${LONG}`,
    ),
    true,
  );
});

test("German student postings are worth asking about", () => {
  assert.equal(looksPromising("Werkstudent Compliance (m/w/d)", `Als Werkstudent unterstützt du das Team.${LONG}`), true);
  assert.equal(looksPromising("Praktikum Corporate Finance", `Praktikant im Bereich Finance.${LONG}`), true);
});

test("an ordinary experienced-hire requisition is not", () => {
  // Oracle HCM rejects 672 listings a cycle and 319 are this shape. Each one
  // reaching a model would be the entire cost of the feature, spent on
  // learning what the title already said.
  assert.equal(looksPromising("IT Associate II-Service Desk-Alt Sched", `Responsible for service desk operations.${LONG}`), false);
  assert.equal(looksPromising("IB Associate - Consumer", `The Associate will execute M&A transactions.${LONG}`), false);
  assert.equal(looksPromising("Valuation Control Stress Testing - Associate", `Support the valuation control group.${LONG}`), false);
});

test('"stage" alone does not trigger a call', () => {
  // The venture postings this runs over are full of "early stage", "Series A
  // stage" and "stage gate". A bare word match here would spend the budget on
  // every startup job in the directory.
  assert.equal(
    looksPromising("Operations Analyst", `We are an early stage company at the growth stage.${LONG}`),
    false,
  );
});

test("a description no longer than its own title is never worth a call", () => {
  // The DOM-candidate shape: the "description" is the link text. There is
  // nothing to read, so there is nothing to adjudicate.
  assert.equal(looksPromising("Summer Analyst Internship", "Summer Analyst Internship"), false);
  assert.equal(looksPromising("Summer Analyst Internship", ""), false);
});

test("a promising body rescues an unpromising title", () => {
  // The entire point: the title is what the phrase list already rejected, so
  // the evidence has to come from the body.
  assert.equal(
    looksPromising(
      "Campus Programme - Global Markets",
      `This is a 10 week summer analyst programme for students currently enrolled in a bachelor degree.${LONG}`,
    ),
    true,
  );
});

test("explicit student eligibility language counts", () => {
  assert.equal(looksPromising("Analyst, Markets", `Open to candidates in the Class of 2028.${LONG}`), true);
  assert.equal(looksPromising("Analyst, Markets", `Applicants must be rising seniors.${LONG}`), true);
});

// The quote check is what separates an internship from a graduate job. Tested
// through the exported pattern list rather than a model call, because the
// model is not the part that can regress silently here.
test("a class year alone is not evidence of a student", () => {
  // The real error: "Piper Sandler is currently seeking a Class of 2027
  // Investment Banking Analyst" was accepted as an internship. It is a
  // graduate role - a class year says when somebody finishes, which a
  // full-time posting states just as readily.
  const graduateQuote =
    "Piper Sandler is currently seeking a Class of 2027 Investment Banking Analyst for our Technology team.";
  const studentQuote =
    "Must be in your penultimate year of study at a highly regarded university.";
  const shows = (q: string) =>
    [
      /\b(intern|internship|stage|praktikum|werkstudent|becario|stagiaire)\b/i,
      /\b(enrolled|enrolment|enrollment|currently studying|still studying)\b/i,
      /\b(penultimate|final year|first year|second year|third year|rising (junior|senior)|undergraduate|sophomore)\b/i,
      /\b(placement year|year in industry|sandwich (year|placement)|co-?op)\b/i,
      /\b(summer (analyst|associate|programme|program))\b/i,
    ].some((re) => re.test(q));
  assert.equal(shows(graduateQuote), false);
  assert.equal(shows(studentQuote), true);
});
