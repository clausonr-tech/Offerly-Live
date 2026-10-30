/**
 * What the de-identifier actually removes before text enters the training
 * corpus - the promise the privacy policy makes about names and employers.
 *
 * The hole these pin shut: every needle was wrapped in `\b...\b`, and in
 * JavaScript `\b` is defined on ASCII [A-Za-z0-9_] even with the i flag. A
 * name or firm that starts or ends on anything else had no boundary to find
 * beside a space, a comma or the end of the string, so it never matched at
 * all: "José", "Zoë", "Émile" and any firm written with a trailing period
 * ("Goldman Sachs & Co.") were stored verbatim. The firm was also matched only
 * as the exact string saved on the contact, so a draft writing it without its
 * corporate tail kept the employer in the corpus.
 *
 * The second half of these tests is the other direction: the module prefers
 * over-redaction, but not at the price of turning ordinary words into
 * placeholder soup.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { deidentifyDeep, type Identities } from "@/lib/deidentify";

function redact(text: string, ids: Identities): string {
  return deidentifyDeep(text, ids);
}

const JOSE: Identities = { contact: { name: "José Álvarez-Reed", firm: "Goldman Sachs & Co." } };

test("an accented first name is removed", async () => {
  const out = redact("Hi José, thanks for the call.", JOSE);
  assert.ok(!out.includes("José"), out);
  assert.match(out, /Hi \[CONTACT\], thanks/);
});

test("accents are removed wherever the name sits in the sentence", async () => {
  for (const text of ["José asked me to write.", "I spoke to José.", "José, hello", "(José)", "cc: José;", "José"]) {
    const out = redact(text, JOSE);
    assert.ok(!out.includes("José"), `${text} -> ${out}`);
  }
});

test("every accented name shape is matched, not just the ones that happen to be ASCII-bounded", async () => {
  const names = ["Zoë Chen", "Émile Durand", "Renée Fox", "Søren Dahl", "Łukasz Nowak", "Ngô Thanh"];
  for (const name of names) {
    const first = name.split(" ")[0];
    const out = redact(`Dear ${first}, I admire your work.`, { contact: { name } });
    assert.ok(!out.includes(first), `${name} -> ${out}`);
  }
});

test("a hyphenated surname is removed by either half", async () => {
  assert.ok(!redact("Thanks again, Álvarez!", JOSE).includes("Álvarez"));
  assert.ok(!redact("Thanks again, Reed!", JOSE).includes("Reed"));
});

test("a firm written with its trailing period is removed", async () => {
  const out = redact("I am applying to Goldman Sachs & Co.", JOSE);
  assert.ok(!out.includes("Goldman"), out);
  assert.match(out, /\[FIRM\]/);
});

test("a firm written without its corporate tail is still removed", async () => {
  const cases: [string, string][] = [
    ["Goldman Sachs & Co.", "I would love to work at Goldman Sachs one day."],
    ["Evercore Partners LLC", "Evercore has the group I want."],
    ["Apple Inc.", "Apple's internship is the one."],
    ["Lazard Frères & Co. LLC", "my Lazard Frères interview"],
  ];
  for (const [firm, text] of cases) {
    const out = redact(text, { contact: { name: "A Analyst", firm } });
    assert.match(out, /\[FIRM\]/, `${firm} -> ${out}`);
    assert.ok(!out.includes(firm.split(" ")[0]), `${firm} -> ${out}`);
  }
});

test("the longest form of a firm wins, so no fragment is left behind", async () => {
  const out = redact("Goldman Sachs & Co. is my first choice", { contact: { firm: "Goldman Sachs & Co." } });
  assert.equal(out, "[FIRM] is my first choice");
});

test("both apostrophes are matched, whichever one was typed", async () => {
  const ids: Identities = { contact: { name: "Siobhán O'Brien" } };
  for (const written of ["O'Brien", "O’Brien"]) {
    const out = redact(`Thanks ${written}!`, ids);
    assert.ok(!out.includes("Brien"), `${written} -> ${out}`);
  }
});

test("a name inside a longer word is still left alone", async () => {
  const out = redact("The Kaiser report says José was right.", { contact: { name: "Kai José" } });
  assert.match(out, /Kaiser report/, out);
  assert.ok(!out.includes("José"), out);
});

test("a firm that strips down to an ordinary word is not matched on that word", async () => {
  // "Global Partners Ltd" must not turn every "global" in a draft into [FIRM].
  const out = redact("I want a global role in capital markets.", {
    contact: { firm: "Global Partners Ltd" },
  });
  assert.equal(out, "I want a global role in capital markets.");
  // The full name still goes.
  assert.match(redact("I applied to Global Partners Ltd.", { contact: { firm: "Global Partners Ltd" } }), /\[FIRM\]/);
});

test("short name fragments and initials are still skipped", async () => {
  const out = redact("J. de la Cruz van de Berg wrote to me", { contact: { name: "J de Cruz" } });
  assert.match(out, /de la/, out);
});

test("the sweeps and the placeholders still work as they did", async () => {
  const out = redact(
    "Email me at jose@bank.com or call (212) 555-0147, or see linkedin.com/in/jose-reed-1234",
    JOSE,
  );
  assert.match(out, /\[EMAIL\]/);
  assert.match(out, /\[PHONE\]/);
  assert.ok(!out.includes("jose@bank.com"));
});

test("nested values are redacted the same way", async () => {
  const out = deidentifyDeep(
    { subject: "Following up, José", body: ["Goldman Sachs is great", { note: "José Álvarez-Reed" }] },
    JOSE,
  );
  assert.equal(JSON.stringify(out).includes("José"), false, JSON.stringify(out));
  assert.equal(JSON.stringify(out).includes("Goldman"), false, JSON.stringify(out));
});

test("the student's own accented name is removed too", async () => {
  const out = redact("Best, Chloé", { student: { name: "Chloé Martin" } });
  assert.match(out, /Best, \[STUDENT\]/, out);
});

test("the school keeps its typed placeholder", async () => {
  const out = redact("I study at Université de Montréal", { school: "Université de Montréal" });
  assert.equal(out, "I study at [SCHOOL]");
});
