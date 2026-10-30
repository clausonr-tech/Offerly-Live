// Artifact 3: class year and student description.
import { classYearLabel, isGraduateStudent, buildDraftPrompt, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { base, row } from "./base";

console.log("--- classYearLabel(gradYear, now): every month against the August rollover (gradYear 2028) ---");
for (let m = 0; m < 12; m++) {
  const now = new Date(Date.UTC(2026, m, 15, 12));
  console.log(
    `  ${now.toISOString().slice(0, 10)}  2028 -> ${JSON.stringify(classYearLabel(2028, now))}` +
      `   2026 -> ${JSON.stringify(classYearLabel(2026, now))}` +
      `   2027 -> ${JSON.stringify(classYearLabel(2027, now))}`,
  );
}
console.log("");
console.log("--- classYearLabel spread, now = 2026-10-11 ---");
for (const y of [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032]) {
  console.log(`  gradYear ${y} -> ${JSON.stringify(classYearLabel(y, base.now))}`);
}
console.log("");
console.log("--- this year's grad before and after June ---");
for (const d of ["2026-05-31", "2026-06-01", "2026-06-30", "2026-07-01"]) {
  const now = new Date(`${d}T12:00:00Z`);
  console.log(`  now ${d}  gradYear 2026 -> ${JSON.stringify(classYearLabel(2026, now))}`);
}
console.log("");
console.log("--- isGraduateStudent(major / resume) ---");
const G = (p: Partial<DraftPromptInput>) => isGraduateStudent({ ...base, ...p });
for (const major of ["MBA, Finance", "Pre-MBA", "pre-MBA analyst", "BS/MS", "BS/MS Finance", "Rutgers Business School",
  "MS Finance", "M.S. in Finance", "Master of Science in Finance", "Masters in Finance", "Finance", "JD", "J.D. Power",
  "Ph.D. candidates", "MSF", "MFin", "LLM", "Economics (MBA pipeline)", "mba"]) {
  console.log(`  major ${JSON.stringify(major)} -> ${G({ studentMajor: major })}`);
}
console.log("");
const resumeMasters = "EDUCATION\nVanderbilt University · MS Finance · 2027\n\nEXPERIENCE\nSummer analyst";
const resumeBachelor = "EDUCATION\nVanderbilt University · BS Economics · 2028\n\nEXPERIENCE\nSummer analyst";
const resumeNoDot = "EDUCATION\nVanderbilt University, MS Finance, 2027\n\nEXPERIENCE\nSummer analyst";
const resumeWorkMasters = "EDUCATION\nVanderbilt University · BS Economics · 2028\n\nEXPERIENCE\nTeaching assistant · MS Finance course";
const resumeLower = "Education\nVanderbilt University · MBA · 2027\n\nExperience\nx";
for (const [label, r] of [["master's on an EDUCATION line", resumeMasters], ["bachelor's only", resumeBachelor],
  ["master's, comma-separated (no ·)", resumeNoDot], ["master's only in EXPERIENCE", resumeWorkMasters],
  ["lowercase 'Education' header", resumeLower]] as const) {
  console.log(`  ${label} -> ${G({ studentMajor: "Finance", studentResumeSummary: r })}`);
}
console.log("");
console.log("--- what the prompt then SAYS about the student (STUDENT block lines) ---");
const facts = (p: Partial<DraftPromptInput>) => {
  const { userText } = buildDraftPrompt({ ...base, ...p });
  const block = userText.split("\n").filter((l) => /^(Name|School|Year|Graduat|Major|Graduate student)/.test(l.trim()));
  return block.join(" | ");
};
row("undergrad 2028", "gradYear 2028, major Finance", facts({}));
row("grad year this year, Oct", "gradYear 2026", facts({ studentGradYear: 2026 }));
row("grad year 5 out", "gradYear 2031", facts({ studentGradYear: 2031 }));
row("grad year 6 out", "gradYear 2032", facts({ studentGradYear: 2032 }));
row("MBA 2027", "major 'MBA, Finance'", facts({ studentMajor: "MBA, Finance", studentGradYear: 2027 }));
row("MBA with a past grad year", "major MBA, gradYear 2024", facts({ studentMajor: "MBA", studentGradYear: 2024 }));
row("no grad year at all", "gradYear null", facts({ studentGradYear: null }));
row("Pre-MBA", "major 'Pre-MBA', gradYear 2028", facts({ studentMajor: "Pre-MBA" }));
row("BS/MS", "major 'BS/MS', gradYear 2028", facts({ studentMajor: "BS/MS" }));
