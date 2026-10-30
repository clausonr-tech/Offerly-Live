// cold_email's step 3 is unconditional: "Say you found them through your
// school's alumni database". briefLines only supplies that fact when
// alumniSchool is set; without it, it says the opposite. cold_email carries no
// fields and no promptNotes, so the format step is the only thing left standing.
import { buildDraftPrompt } from "../../../src/lib/draft-prompt";
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
const t = EMAIL_TYPES.find((x) => x.id === "cold_email")!;
console.log(`cold_email: ${t.fields?.length ?? 0} fields, ${t.promptNotes?.length ?? 0} promptNotes`);
console.log(`step 3: ${t.format[2]}`);
for (const alumniSchool of ["Ridgemont University", null]) {
  const { userText } = buildDraftPrompt({
    studentName: "Alex Rivera", studentSchool: "Ridgemont University", studentGradYear: 2029,
    contactName: "Rachel Stein", contactFirm: "Halcombe Partners", type: "cold_email",
    boxIds: ["first.alum"], alumniSchool,
  });
  console.log(`\n### alumniSchool = ${JSON.stringify(alumniSchool)}`);
  for (const l of userText.split("\n")) if (/alumni database|alum|how the student found/i.test(l)) console.log("  " + l.trim());
}
