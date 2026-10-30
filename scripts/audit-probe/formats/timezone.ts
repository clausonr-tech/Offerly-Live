// The slot a recruiter offered is in the RECRUITER's time zone. The only time
// zone fact recruiter_scheduling_reply is given is the STUDENT's, and its
// format step tells the drafter to spell a time zone out next to that slot.
// call_scheduling's equivalent field asks the student for the recipient's zone;
// recruiter_scheduling_reply's does not.
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
import { buildDraftPrompt } from "../../../src/lib/draft-prompt";
for (const id of ["call_scheduling", "recruiter_scheduling_reply", "reschedule_call"] as const) {
  const t = EMAIL_TYPES.find((x) => x.id === id)!;
  console.log(`\n### ${id}`);
  for (const f of t.fields ?? [])
    if (/time|slot|window|availab/i.test(f.name))
      console.log(`  field ${f.name.padEnd(14)} hint=${JSON.stringify(f.hint ?? null).padEnd(42)} prompt=${JSON.stringify(f.prompt)}`);
}
const { userText } = buildDraftPrompt({
  studentName: "Alex Rivera", studentSchool: "Ridgemont University", studentGradYear: 2029,
  contactName: "Yvette Marchetti", contactFirm: "Halcombe Partners", type: "recruiter_scheduling_reply",
  boxIds: ["reply.scheduling"],
  brief: { fieldAnswers: [
    { prompt: "Whether the student is confirming the slot or asking for another", value: "Yes - confirm it" },
    { prompt: "The slot the recruiter offered - repeat it back with the time zone", value: "Tuesday, October 20 at 11:00 a.m." },
    { prompt: "The student's time zone - write it out with every time", value: "Pacific" },
  ] },
});
console.log("\n### every time-zone fact the drafter is handed, for a student in Pacific confirming an 11:00 slot:");
for (const l of userText.split("\n")) if (/time zone|11:00|Pacific/i.test(l)) console.log("  " + l.trim());
