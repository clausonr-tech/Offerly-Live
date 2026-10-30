// Artifact 1b: the assembled sign-off in the awkward profile states.
import { finishDraft, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { base } from "./base";

const run = (label: string, p: Partial<DraftPromptInput>, body = "Hi Rachel,\n\nThanks for your time.") => {
  const out = finishDraft({ ...base, ...p }, { subject: "s", body, connectionUsed: null, gaps: [] });
  console.log(`CASE: ${label}`);
  console.log(`  OUT: ${JSON.stringify(out.body)}`);
  console.log(`  ends on "Best," with nothing after: ${/\n\nBest,$/.test(out.body)}`);
  console.log("");
};

run("gmailSignature + no closing written by the model", { gmailSignature: true });
run("no name on profile (signature starts with the school)", { studentName: "" });
run('name "the student" (no name line)', { studentName: "the student" });
run("every field null, no automatic signature", { studentName: "", studentSchool: null, studentSchoolEmail: null, studentPhone: null, studentLinkedinUrl: null, studentGradYear: null });
run("graduated student (2021)", { studentGradYear: 2021 });
run("MBA student", { studentMajor: "MBA, Finance", studentGradYear: 2027 });
run("JD student", { studentMajor: "JD", studentGradYear: 2027 });
run("gmailSignature + model's own signature after a different closing", { gmailSignature: true }, "Hi Rachel,\n\nThanks.\n\nWarm regards,\nMaya Patel\nPenn '28\n(555) 555-5555");
run("model signed off with 'Thanks!' (no comma)", {}, "Hi Rachel,\n\nThanks.\n\nThanks!\nMaya Patel");
run("model signed off 'Best wishes, Maya Patel'", {}, "Hi Rachel,\n\nThanks.\n\nBest wishes, Maya Patel");
run("model put the closing and name on one line", {}, "Hi Rachel,\n\nThanks.\n\nBest, Maya");
run("model wrote 'Sincerely' with no comma", {}, "Hi Rachel,\n\nThanks.\n\nSincerely\nMaya Patel");
