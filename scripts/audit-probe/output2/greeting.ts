// Artifact 4: the greeting. greetingInstruction is private, so it is read off
// the prompt buildDraftPrompt actually produces (the "Greeting:" line).
import { buildDraftPrompt, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { draftChecks } from "../../../src/lib/draft-lint";
import { base } from "./base";

const instruction = (p: Partial<DraftPromptInput>) => {
  const { userText, system } = buildDraftPrompt({ ...base, ...p });
  const line = `${system}\n${userText}`.split("\n").find((l) => l.trim().startsWith("Greeting:"));
  return line?.trim() ?? "(no Greeting instruction -> house default \"Hi {first name},\")";
};

const names = [
  "Rachel Stein", "RACHEL STEIN", "marcus lee", "Dr. Amy Adams", "Dr Amy Adams",
  "Dean Martin", "Dean Amy Adams", "Professor Amy Adams", "Prof. Adams",
  "Rachel Stein, CFA", "Rachel Stein, Jr.", "Rachel (Rae) Stein", "rachel@firm.com",
  "Rachel Stein <rachel@firm.com>", "Campus Recruiting", "Evercore Recruiting Team",
  "To Whom It May Concern", "to whom it may concern", "Rachel", "", "   ",
  "Evercore", "Mr. Marcus Lee", "MS. AMY ADAMS", "Amy Adams PhD", "O'Brien",
  "Jean-Luc Picard", "Dean", "Team Lead Rachel Stein", "李 明", "Rachel  Stein",
];
for (const n of names) {
  console.log(`CASE: contactName ${JSON.stringify(n)}`);
  console.log(`  OUT: ${instruction({ contactName: n })}`);
  console.log("");
}

console.log("--- the firm-name / single-name student notes (draftChecks.forStudent) ---");
const body = (g: string) => `${g}\n\nI am a sophomore at Penn and would value fifteen minutes.\n\nBest,\nMaya Patel`;
for (const [name, firm, greeting] of [
  ["Evercore", "Evercore", "Hi Evercore,"],
  ["Rachel", "Evercore", "Hi Rachel,"],
  ["Rachel Stein", "Evercore", "Hi Rachel,"],
  ["Campus Recruiting", "Evercore", "Hello Campus Recruiting,"],
  ["Dr. Amy Adams", "Evercore", "Dear Dr. Adams,"],
  ["Goldman", "Goldman Sachs & Co.", "Hi Goldman,"],
  ["Rachel", "Evercore", "Hi Rachel"],
] as const) {
  const out = draftChecks({ ...base, contactName: name, contactFirm: firm }, body(greeting));
  console.log(`  name=${JSON.stringify(name)} firm=${JSON.stringify(firm)} greeting=${JSON.stringify(greeting)}`);
  console.log(`    forStudent: ${JSON.stringify(out.forStudent)}`);
}
