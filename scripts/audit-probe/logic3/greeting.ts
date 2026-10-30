// LOGIC-3 probe: greetingInstruction, classYearLabel, isGraduateStudent, signatureLines.
import { buildDraftPrompt, classYearLabel, isGraduateStudent, signatureLines, type DraftPromptInput } from "@/lib/draft-prompt";
const g = (name: string) => {
  const t = buildDraftPrompt({ type: "cold_email", contactName: name, studentName: "Maya", studentSchool: "Duke", now: new Date("2026-09-20") } as DraftPromptInput).userText;
  const m = /^Greeting: .*$/m.exec(t);
  return m ? m[0] : "(house default: Hi <first name>,)";
};
console.log("--- greetingInstruction");
for (const n of [
  "Rachel Stein", "RACHEL STEIN", "rachel stein", "Dr. Amy Adams", "Professor Amy Adams", "Prof Adams",
  "Dean Martin", "Dean Amy Adams", "Rachel Stein, CFA", "Rachel Stein Jr.", "Ms. Rachel Stein",
  "Rachel (Rae) Stein", "Rachel Stein <rachel@firm.com>", "To whom it may concern", "Campus Recruiting Team",
  "Morrow & Pike Careers", "Rachel", "Mary-Kate O'Brien", "Jean-Luc de la Tour", "李 明", "", "   ",
  "team lead Rachel Stein", "Rachel Stein (she/her)", "Dr Adams", "Dean", "Dr. Dre",
]) console.log(`  ${JSON.stringify(n).padEnd(36)} ${g(n)}`);

console.log("\n--- classYearLabel (now = 2026-09-20, academic year ends 2027)");
for (const y of [2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032]) console.log(`  grad ${y} -> ${classYearLabel(y, new Date("2026-09-20"))}`);
console.log("  now = 2026-05-20 (academic year ends 2026):");
for (const y of [2026, 2027, 2028, 2029, 2030]) console.log(`    grad ${y} -> ${classYearLabel(y, new Date("2026-05-20"))}`);

console.log("\n--- isGraduateStudent");
for (const major of ["Economics", "MBA", "Pre-MBA track", "Master's in Finance", "MS Finance", "M.S. in Finance", "Economics/MBA", "JD", "PhD Physics", "Mastering Data", "mba"])
  console.log(`  major ${JSON.stringify(major).padEnd(24)} -> ${isGraduateStudent({ studentMajor: major } as DraftPromptInput)}`);
console.log(`  resume EDUCATION with "· MBA" -> ${isGraduateStudent({ studentResumeSummary: "EDUCATION\n- Ravensworth Business School · MBA 2027\nWORK EXPERIENCE\n- x" } as DraftPromptInput)}`);
console.log(`  resume WORK line with "· MBA"  -> ${isGraduateStudent({ studentResumeSummary: "EDUCATION\n- Duke · BA Economics\nWORK EXPERIENCE\n- Advisor · MBA program office" } as DraftPromptInput)}`);

console.log("\n--- signatureLines");
const sig = (i: Partial<DraftPromptInput>) => JSON.stringify(signatureLines({ studentName: "Maya Okafor", ...i } as DraftPromptInput));
console.log("  undergrad          ", sig({ studentSchool: "Duke University", studentGradYear: 2029 }));
console.log("  grad (MBA major)   ", sig({ studentSchool: "Ravensworth", studentGradYear: 2027, studentMajor: "MBA" }));
console.log("  grad (MSF major)   ", sig({ studentSchool: "Ravensworth", studentGradYear: 2027, studentMajor: "MSF" }));
console.log("  grad, no grad year ", sig({ studentSchool: "Ravensworth", studentMajor: "MBA" }));
console.log("  no school          ", sig({ studentGradYear: 2029 }));
console.log("  name 'the student' ", sig({ studentName: "the student", studentSchool: "Duke", studentGradYear: 2029 }));

console.log("\n--- leading job titles and single-word titled names");
for (const n of ["VP Rachel Stein", "Managing Director Rachel Stein", "Dr. Amy", "Professor Amy", "Dean Amy", "Team Lead Rachel Stein", "Associate Rachel Stein"])
  console.log(`  ${JSON.stringify(n).padEnd(36)} ${g(n)}`);
