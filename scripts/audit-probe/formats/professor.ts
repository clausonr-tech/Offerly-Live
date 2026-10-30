// professor_recommendation's step 1 and its promptNote both print
// "Professor [Last name],". The note says to use "the greeting given under
// RECIPIENT" - which only exists when the student typed a title into the
// contact's name. The reviewer may not touch a greeting or a [placeholder].
import { buildDraftPrompt } from "../../../src/lib/draft-prompt";
for (const contactName of ["Professor Amy Adams", "Amy Adams", "Dr. Reyes", "amy.adams@ridgemont.edu"]) {
  const { userText, system } = buildDraftPrompt({
    studentName: "Alex Rivera", studentSchool: "Ridgemont University", studentGradYear: 2029,
    contactName, type: "professor_recommendation", boxIds: ["ask.professor"],
  });
  const greet = userText.split("\n").find((l) => /^Greeting:/.test(l.trim()));
  console.log(`contactName ${JSON.stringify(contactName).padEnd(32)} -> ${greet?.trim() ?? "NO GREETING LINE (house default: Hi {first name},)"}`);
  console.log(`   prompt still prints: ${[...(system + userText).matchAll(/"?(Dear |Greet them as "Professor )[^"\n]{0,30}/g)].map((m) => m[0].trim()).join(" | ")}`);
}
