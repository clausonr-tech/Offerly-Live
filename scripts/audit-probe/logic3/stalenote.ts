// LOGIC-3 probe: the pipeline's two-pass finishDraft carries a pre-review date
// warning forward even when the review deleted the date.
import { finishDraft, type DraftPromptInput } from "@/lib/draft-prompt";
const INPUT = {
  type: "cold_email", contactName: "Rachel Stein", studentName: "Maya Okafor",
  studentSchool: "Duke University", studentSchoolEmail: "maya.okafor@duke.edu",
  studentGradYear: 2029, now: new Date("2026-09-20T12:00:00"),
} as DraftPromptInput;

// Round 1: the drafting model invented "October 17".
const first = finishDraft(INPUT, {
  subject: "Duke student reaching out",
  body: "Would October 17 work for a short call?\n\nBest,\nMaya Okafor",
  connectionUsed: null, gaps: [],
});
console.log("pre-review notes :", JSON.stringify(first.notesForStudent));

// Round 2: exactly what draft-pipeline.ts:337 does, with a reviewed body that
// no longer contains the date.
const revised = finishDraft(INPUT, { ...first, subject: first.subject, body: "Would a short call work in the next week or two?\n\nBest,\nMaya Okafor" });
const dedupe = (n: string[]) => [...new Set(n)];
const merged = dedupe([...first.notesForStudent, ...revised.notesForStudent]);
console.log("post-review body :", JSON.stringify(revised.body.split("\n")[0]));
console.log("notes shipped    :", JSON.stringify(merged));
console.log(merged.some((n) => n.includes("October 17")) ? "\nSTALE: the warning names a date that is no longer in the email." : "\nclean");
