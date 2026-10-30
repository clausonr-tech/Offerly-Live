// The label the student saw above each box on the draft form, by field name.
//
// The blocked-language gate (lib/content-limits blockedInForm) labels its error
// with this, so a student who typed something the check refuses is told WHICH
// answer to fix. It is derived from the question definitions rather than kept
// by hand: a hand-kept list named 23 boxes and fell back to "One of your
// answers" for the other 116 - including `purpose`, the only box the "something
// else" occasion has, so its one error named nothing at all (INPUT-1 F7).
//
// Pure data, no database and no request: safe anywhere the question
// definitions already are.

import { OCCASIONS, resolveSituation, situationQuestions } from "./draft-occasions";
import { EMAIL_TYPES } from "./draft-templates";

// The form's own boxes, which belong to no email type's question list. The
// wording is the Field label in drafts/GenerateForm.tsx.
const FORM_OWN_FIELDS: Record<string, string> = {
  purpose: "What is this email for?",
  extraContext: "Anything else to include?",
};

let cached: Record<string, string> | null = null;

/**
 * Every field the draft form can submit an answer to, as name -> label.
 *
 * Built from three places, none of them a hand-kept parallel list:
 * each email type's own fields (including one hidden behind another answer,
 * which `situationQuestions` would not return), the shared brief questions the
 * occasions ask for, and the two boxes the form owns itself. A question
 * reworded by the box that asks it keeps its defining label here - the point is
 * to name the box, not to reproduce every variant of its wording.
 */
export function draftFormLabels(): Record<string, string> {
  if (cached) return cached;
  const labels: Record<string, string> = {};
  for (const type of EMAIL_TYPES) {
    for (const field of type.fields ?? []) labels[field.name] ??= field.label;
  }
  for (const occasion of OCCASIONS) {
    for (const section of occasion.sections) {
      for (const box of section.boxes) {
        const situation = resolveSituation(occasion.id, [box.id]);
        if ("error" in situation) continue;
        const read = (answers: Record<string, string>) => situationQuestions(situation, (name) => answers[name]);
        const asked = read({});
        for (const q of asked) labels[q.name] ??= q.label;
        // A question that is only asked once another one has a particular
        // answer ("Who?", after "an intro to someone specific") is invisible
        // until that answer is given, so every choice is tried once.
        for (const q of asked) {
          for (const option of q.options ?? []) {
            for (const nested of read({ [q.name]: option.value })) labels[nested.name] ??= nested.label;
          }
        }
      }
    }
  }
  cached = { ...labels, ...FORM_OWN_FIELDS };
  return cached;
}
