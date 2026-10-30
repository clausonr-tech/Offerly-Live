// The draft form's answers, as the server reads them: the type's own fields
// and the shared brief.
//
// Lifted out of drafts/draft-request so both halves are pure and testable
// (scripts/test/draft-form-routing.test.ts). The file they came from imports
// next/cache, so a test could not reach them there without pulling the whole
// app-router runtime in behind them.

import { aliasesOf, answerFor, type Question } from "./draft-occasions";
import type { DraftBrief } from "./generate-draft";

export type TypeField = { name: string; prompt: string; label: string; value: string };

/**
 * The type's own fields, read from its definition rather than a branch per
 * type, and the error when a required answer is blank.
 *
 * Select answers are sent as their labels, which is what they mean. Every
 * checked box's questions, each asked once, and only those that apply to the
 * options chosen; answers a box already implies come from the box.
 *
 * Pure so the ORDER of the two checks is testable. `if (!q.prompt) continue`
 * used to come first, so a required question with no prompt of its own could
 * never raise the error and was enforced in the browser alone (INPUT-1 #6) -
 * which `conversationDetails` now is, being required and promptless.
 */
export function typeFieldsFor(
  questions: Question[],
  field: (name: string) => string | undefined,
): { error: string } | { typeFields: TypeField[] } {
  const typeFields: TypeField[] = [];
  for (const q of questions) {
    const raw = answerFor(q.name, field);
    if (!raw && q.required) return { error: `Add "${q.label}" to draft this email.` };
    if (!q.prompt || !raw) continue;
    typeFields.push({ name: q.name, prompt: q.prompt, label: q.label, value: q.options?.find((o) => o.value === raw)?.label ?? raw });
  }
  return { typeFields };
}

/**
 * The shared brief, read from the form.
 *
 * Every field is optional - a blank one just means the model has less to work
 * with.
 *
 * `conversationDetails` is the one slot that cannot be read with `answerFor`.
 * It belongs to an alias group (`conversationDetail`, `remarkPoint`,
 * `recruiterExplained`), `answerFor` resolves any member of the group to the
 * one sentence the student typed, and the type's own questions resolve the
 * same way - so the sentence went to the model twice, once as a brief fact and
 * once as a prompt line (INPUT-1 #4). MEASURED over every valid combination
 * crossed with every alias: 8 of 24 pairs sent it twice.
 *
 * `briefAnswerFor` was the hand-off's suggested fix and closes only 2 of those
 * 8: it skips an alias the questions are carrying, but still returns a direct
 * answer to `conversationDetails` itself while a prompted alias is carrying
 * that same answer through `answerFor`. So the rule here is the group one - if
 * ANY member of the group is asked as a prompted question, the questions carry
 * it and the brief stays out. That takes the 8 to 0
 * (scripts/test/draft-form-routing.test.ts).
 */
/** Whether a prompted question already carries this field, under any of its alias names. */
function carriedByQuestions(name: string, questions: Question[]): boolean {
  const group = new Set([name, ...aliasesOf(name)]);
  return questions.some((q) => q.prompt && group.has(q.name));
}

export function briefFromForm(questions: Question[], field: (name: string) => string | undefined): DraftBrief {
  const oneOf = <T extends string>(name: string, options: readonly T[]): T | null => {
    const value = field(name);
    return options.includes(value as T) ? (value as T) : null;
  };
  return {
    financeInterest: field("financeInterest"),
    wantToLearn: field("wantToLearn"),
    specificReason: field("specificReason"),
    threadSubject: field("threadSubject"),
    originalSubject: field("originalSubject"),
    originalDate: field("originalDate"),
    originalAsk: field("originalAsk"),
    followUp1Date: field("followUp1Date"),
    meetingWhen: field("meetingWhen"),
    conversationDetails: carriedByQuestions("conversationDetails", questions) ? undefined : answerFor("conversationDetails", field),
    nextStepAsk: oneOf("nextStepAsk", ["who_else", "intro", "none"] as const),
    introName: field("introName"),
    introReason: field("introReason"),
    interviewTeam: field("interviewTeam"),
    personalConnection: field("personalConnection"),
  };
}
