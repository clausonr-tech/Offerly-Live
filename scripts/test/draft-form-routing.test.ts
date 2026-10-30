/**
 * The two halves of the draft form's question routing, over EVERY valid
 * combination of the picker's boxes rather than an example of one.
 *
 *   npm run test   (or: node --import tsx --conditions=react-server --test scripts/test/draft-form-routing.test.ts)
 *
 * 1. INPUT-1 #6 - a required question with NO prompt of its own. The loop in
 *    `runGenerateDraft` used to read `if (!q.prompt) continue` before the
 *    required check, so such a question could never raise the server's error
 *    and was enforced in the browser alone. `conversationDetails` is exactly
 *    that question, so a thank-you after a coffee chat or an interview was
 *    server-side optional.
 *
 * 2. INPUT-1 #4 - one typed answer reaching the model twice. A brief slot read
 *    with `answerFor` takes the first non-empty alias, including an alias that
 *    is ALSO asked as its own prompted question - so the same sentence went in
 *    as a brief fact and again as a prompt line. `briefAnswerFor` skips the
 *    aliases the questions already carry.
 *
 * Both are asserted through the functions `runGenerateDraft` itself calls
 * (`typeFieldsFor`, `briefFromForm` in lib/draft-form-answers), not a copy of
 * their logic. No database,
 * no model, no network: the picker and the two helpers are pure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { OCCASIONS, aliasesOf, resolveSituation, situationQuestions, type Situation } from "@/lib/draft-occasions";
import { briefFromForm, typeFieldsFor } from "@/lib/draft-form-answers";

/** Every combination of boxes the picker accepts, as the form can produce them. */
const valid: { occ: string; boxes: string[]; situation: Situation }[] = [];
for (const o of OCCASIONS) {
  const ids = o.sections.flatMap((s) => s.boxes).map((b) => b.id);
  for (let mask = 1; mask < 2 ** ids.length; mask++) {
    const boxes = ids.filter((_, i) => mask & (1 << i));
    const situation = resolveSituation(o.id, boxes);
    if (!("error" in situation)) valid.push({ occ: o.id, boxes, situation });
  }
}

const questionsFor = (s: Situation, field: (n: string) => string | undefined) =>
  situationQuestions(s, (name) => s.presets[name] ?? field(name));

/** A form where nothing is typed. */
const blank = () => undefined;

test("the picker still accepts the same number of combinations", () => {
  assert.equal(valid.length, 107, `valid=${valid.length}`);
});

test("every required question is enforced on the server, prompt or no prompt", () => {
  const unenforced: string[] = [];
  for (const c of valid) {
    const questions = questionsFor(c.situation, blank);
    const required = questions.filter((q) => q.required);
    const asked = typeFieldsFor(questions, blank);
    if (required.length === 0) continue;
    if (!("error" in asked)) {
      unenforced.push(`${c.occ}[${c.boxes.join("+")}] required=[${required.map((q) => q.name).join(",")}]`);
      continue;
    }
    // The error must name one of the required questions, by the student's own label.
    if (!required.some((q) => asked.error === `Add "${q.label}" to draft this email.`)) {
      unenforced.push(`${c.occ}[${c.boxes.join("+")}] error=${asked.error}`);
    }
  }
  assert.deepEqual(unenforced, [], `${unenforced.length} combination(s) enforce a required answer only in the browser`);
});

test("the promptless required question raises the student's own label", () => {
  // The two cases the audit named: conversationDetails is required and has no
  // prompt, so these were the drafts a student could generate with the
  // question blank.
  for (const [boxes, expected] of [
    [["thanks.chat"], 'Add "What did you learn or enjoy?" to draft this email.'],
    [["thanks.interview"], 'Add "Something specific they said" to draft this email.'],
  ] as const) {
    const situation = resolveSituation("thanks", [...boxes]);
    assert.ok(!("error" in situation), `thanks[${boxes.join("+")}] did not resolve`);
    const asked = typeFieldsFor(questionsFor(situation, blank), blank);
    assert.ok("error" in asked, `thanks[${boxes.join("+")}] accepted a blank required answer`);
    assert.equal(asked.error, expected);
  }
});

test("no brief slot re-sends an answer the questions already carry", () => {
  // One alias answered at a time, which is what a student does: they see one
  // box and type one sentence. The defect was that the sentence then went to
  // the model twice - once as a brief fact and once as a prompt line - because
  // `answerFor` takes the first non-empty alias whether or not the questions
  // are already carrying it.
  const SENTENCE = "she walked me through how the desk hedges overnight risk";
  const offenders: string[] = [];
  let pairs = 0;

  for (const c of valid) {
    for (const alias of ALIASES) {
      const answered = (name: string) => (name === alias ? SENTENCE : undefined);
      const questions = questionsFor(c.situation, answered);
      // Only interesting when this combination actually asks something.
      const asked = typeFieldsFor(questions, answered);
      if ("error" in asked) continue;
      pairs++;
      const brief = briefFromForm(questions, answered);
      const promptLines = asked.typeFields.filter((f) => f.value === SENTENCE);
      if (brief.conversationDetails === SENTENCE && promptLines.length > 0) {
        offenders.push(`${c.occ}[${c.boxes.join("+")}] typed ${alias} -> brief + ${promptLines.map((p) => p.name).join(",")}`);
      }
    }
  }

  // MEASURED at the three readings of this slot: `answerFor` 8 of 24 pairs,
  // `briefAnswerFor` (the hand-off's suggestion) 6, the group rule 0.
  console.log(`  checked ${pairs} (combination x alias) pairs; ${offenders.length} send one typed answer twice`);
  assert.equal(pairs, 24, `pairs=${pairs}`);
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

/**
 * The alias group conversationDetails belongs to, copied from
 * QUESTION_ALIASES in lib/draft-occasions. Asserted against the picker's own
 * `aliasesOf` below, so this list cannot drift from it silently.
 */
const ALIASES = ["conversationDetails", "conversationDetail", "remarkPoint", "recruiterExplained"];

test("the alias group this test fills is still the picker's own", () => {
  assert.deepEqual([...aliasesOf("conversationDetails")].sort(), ALIASES.filter((a) => a !== "conversationDetails").sort());
});
