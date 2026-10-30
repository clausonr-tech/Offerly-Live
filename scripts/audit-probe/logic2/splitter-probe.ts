// LOGIC-2: the sentence splitter and the sign-off finder.
import { commaSplices, draftChecks, fluencyIssues } from "../../../src/lib/draft-lint";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
const sentencesOf = (t: string) => t.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((x) => x.trim()).filter(Boolean);

console.log("== abbreviations split a sentence in two, and the pieces are linted as sentences");
for (const t of [
  "I am free Tuesday at 9:00 a.m. Eastern time, I will send a calendar invite.",
  "Dr. Alvarez said you would be the right person to ask, I am grateful for the introduction.",
  "I spoke with the team at Marchbank Partners Inc. They were generous with their time.",
]) {
  console.log(`  sentences: ${JSON.stringify(sentencesOf(t))}`);
  console.log(`  commaSplices: ${JSON.stringify(commaSplices(t))}  fluency: ${JSON.stringify(fluencyIssues(t, null))}`);
}

console.log('\n== the sign-off finder matches only the exact line "Best,"');
const input = { type: "cold_email", contactName: "Rachel Stein", contactFirm: null, gmailSignature: false,
  studentName: "Alex Rivera", studentGradYear: 2029, studentSchool: "Duke", brief: {}, purpose: null, extraContext: "" } as unknown as DraftPromptInput;
const SIG = "Alex Rivera\nDuke University ’29\nCalloway School of Business\n(555) 010-1234";
const text = "Hi Rachel,\n\nThank you for the introduction to Ben. The call was useful, and I am grateful for it.\n\n";
for (const close of ["Best,", "Best regards,", "Sincerely,", "Thank you,"]) {
  const body = `${text}${close}\n${SIG}`;
  console.log(`  ${close.padEnd(16)} forReview=${JSON.stringify(draftChecks(input, body).forReview)}`);
}
console.log("  (a sign-off the finder does not know leaves the signature inside the linted text)");
const bodyAlt = `${text}Sincerely,\n${SIG} - please excuse the typos`;
console.log(`  signature text linted: ${JSON.stringify(draftChecks(input, bodyAlt).forReview)}`);
