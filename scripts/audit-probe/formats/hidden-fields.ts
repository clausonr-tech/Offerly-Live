// A format step can demand a fact that the student's own select answer HIDES.
// activeFields() drops the field, so the fact never reaches the prompt, while
// the numbered step still asks for it - GAP_RULES then puts a bracket in the body.
import { EMAIL_TYPES, activeFields, type EmailType } from "../../../src/lib/draft-templates";
function report(t: EmailType, choice: Record<string, string>, stepRe: RegExp) {
  const active = new Set(activeFields(t, (n) => choice[n]).map((f) => f.name));
  const hidden = (t.fields ?? []).filter((f) => !active.has(f.name)).map((f) => f.name);
  console.log(`\n### ${t.id} with ${JSON.stringify(choice)}`);
  console.log(`  fields hidden (never reach the prompt): ${hidden.join(", ") || "(none)"}`);
  console.log(`  format steps still demanding them:`);
  for (const s of t.format) if (stepRe.test(s)) console.log(`    ! ${s}`);
  console.log(`  promptNotes that contradict those steps:`);
  for (const n of t.promptNotes ?? []) if (/confirm it exactly and stop|No new pitch|accept it with no second attempt|offered nothing/i.test(n)) console.log(`    + ${n}`);
}
const T = (id: string) => EMAIL_TYPES.find((t) => t.id === id)!;
report(T("coffee_in_person_reply"), { coffeeNamed: "yes" }, /Offer two or three days|Suggest a specific spot/i);
report(T("referral_ask"), { askStage: "followup" }, /Say you've applied|Make it easy: attach the resume|naming the role and requisition/i);
report(T("offer_extension"), { extensionStage: "said_no" }, /Ask clearly for a specific new date|Give a short, honest reason|Reassure them/i);
report(T("thank_you_offered_help"), { offerType: "none" }, /Thank them for the specific offer|Make the offer easy to act on/i);
