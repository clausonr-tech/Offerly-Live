// Artifact 3b: isGraduateStudent against the REAL resume-summary format
// (resume-profile.formatSummary: "EDUCATION" / "- School · detail").
import { isGraduateStudent, signatureLines, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { base } from "./base";

const G = (p: Partial<DraftPromptInput>) => isGraduateStudent({ ...base, ...p });
const resume = (edu: string[], rest = "WORK EXPERIENCE\n- Evercore · Summer Analyst · 2026") =>
  ["EDUCATION", ...edu, "", rest].join("\n");

const cases: [string, string][] = [
  ["undergrad BS", resume(["- Vanderbilt University · BS in Economics, May 2028"])],
  ["MS Finance", resume(["- Vanderbilt University · MS in Finance, May 2027"])],
  ["MBA", resume(["- Wharton · MBA, May 2027"])],
  ["Master of Science spelled out", resume(["- Vanderbilt University · Master of Science in Finance, 2027"])],
  ["'Candidate for MBA' phrasing", resume(["- Wharton · Candidate for MBA, 2027"])],
  ["school named 'Business School'", resume(["- Rutgers Business School · BS in Finance, 2028"])],
  ["employer J.D. Power in WORK EXPERIENCE", resume(["- Rutgers · BS Finance, 2028"], "WORK EXPERIENCE\n- J.D. Power · Intern · 2025")],
  ["J.D. Power on an EDUCATION line", resume(["- Rutgers · BS Finance, 2028", "- J.D. Power · Scholar, 2025"])],
  ["'Ph.D. candidates' in a club highlight", resume(["- Rutgers · BS Finance, 2028"], "CLUBS & ACTIVITIES\n- Finance Society · Member\n    - Ran a mentoring series with Ph.D. candidates")],
  ["masters only in WORK EXPERIENCE", resume(["- Rutgers · BS Finance, 2028"], "WORK EXPERIENCE\n- Vanderbilt · MS Finance teaching assistant · 2025")],
  ["next header NOT all-caps (bleed test)", "EDUCATION\n- Rutgers · BS Finance, 2028\n\nWork experience\n- Vanderbilt · MS Finance TA · 2025"],
  ["GPA line present", resume(["- Rutgers · BS Finance, 2028", "- GPA: 3.8"])],
  ["no EDUCATION section", "WORK EXPERIENCE\n- Wharton · MBA candidate · 2027"],
];
for (const [label, r] of cases) {
  console.log(`CASE: ${label}`);
  console.log(`  IN : ${JSON.stringify(r)}`);
  console.log(`  OUT: isGraduateStudent = ${G({ studentMajor: "Finance", studentResumeSummary: r })}`);
  console.log("");
}

console.log("--- the signature that follows from the BS/MS false positive ---");
for (const major of ["BS/MS", "BS/MS Finance", "Economics (MBA pipeline)", "Pre-MBA"]) {
  console.log(`  major ${JSON.stringify(major)}: grad=${G({ studentMajor: major })}  sig=${JSON.stringify(signatureLines({ ...base, studentMajor: major }))}`);
}
