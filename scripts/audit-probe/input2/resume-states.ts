// INPUT-2 probe 2+3: the resume state matrix, drafter vs reviewer.
import { buildDraftPrompt, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { buildReviewPrompt, guardRevision } from "../../../src/lib/draft-review";
import { fullInput } from "./fields";

const SUMMARY = "EDUCATION\n- Duke University · BA Economics\nWORK EXPERIENCE\n- Pinecrest Capital · Intern";

// What the committed runGenerateDraft computes, reproduced exactly:
//   resumePdf = !resumeSummary && resume?.mimeType === "application/pdf" ? resume.bytes : null
//   resumeOnFile = Boolean(resume)
// and what runDraftPipeline then does:
//   promptInput = { ...rest, hasResumePdf: Boolean(resumePdf) }
function derive(summary: string | null, file: { mime: string } | null) {
  const resumePdf = !summary && file?.mime === "application/pdf" ? Buffer.from("%PDF-1.4 fake") : null;
  return { studentResumeSummary: summary, resumeOnFile: Boolean(file), resumePdf, hasResumePdf: Boolean(resumePdf) };
}

const STATES: { name: string; summary: string | null; file: { mime: string } | null }[] = [
  { name: "summary + PDF",     summary: SUMMARY, file: { mime: "application/pdf" } },
  { name: "summary only",      summary: SUMMARY, file: null },
  { name: "PDF only",          summary: null,    file: { mime: "application/pdf" } },
  { name: "Word .docx only",   summary: null,    file: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } },
  { name: "legacy .doc only",  summary: null,    file: { mime: "application/msword" } },
  { name: "nothing",           summary: null,    file: null },
];

const RESUME_LINE_HAS = "attached document";
const NO_RESUME_LINE = "Take the student's experience and clubs from STUDENT";
const ON_FILE_LINE = "The student has a resume on file.";
const NO_FILE_LINE = "The student has no resume on file.";
const ATTACHED_LINE = "The student's resume is attached to this email - mention it";

for (const st of STATES) {
  const d = derive(st.summary, st.file);
  const input: DraftPromptInput = {
    ...fullInput("cold_email"),
    studentResumeSummary: d.studentResumeSummary,
    resumeOnFile: d.resumeOnFile,
    hasResumePdf: d.hasResumePdf,
  };
  const { userText } = buildDraftPrompt(input);
  const { userText: rv } = buildReviewPrompt(input, { subject: "s", body: "Hi Zara,\n\nbody\n\nBest," }, []);
  // guard: one unknown proper noun
  const g = guardRevision(
    { subject: "s", body: "Hi Zara,\n\nI worked at a fund.\n\nBest," },
    { subject: "s", body: "Hi Zara,\n\nI worked at Pinecrest Capital.\n\nBest," },
    input,
    [],
  );
  console.log(`\n### ${st.name}`);
  console.log(`  resumePdf sent to model: ${d.resumePdf ? "YES" : "no"} | hasResumePdf=${d.hasResumePdf} | resumeOnFile=${d.resumeOnFile}`);
  console.log(`  DRAFTER: resume-summary block present: ${userText.includes("From their resume")}`);
  console.log(`  DRAFTER: "...or the attached document" line: ${userText.includes(RESUME_LINE_HAS)}`);
  console.log(`  DRAFTER: "experience from STUDENT only" line: ${userText.includes(NO_RESUME_LINE)}`);
  console.log(`  DRAFTER: attach instruction: ${userText.includes(ATTACHED_LINE) ? "ATTACHED(mention it)" : userText.includes(ON_FILE_LINE) ? "on file" : userText.includes(NO_FILE_LINE) ? "no resume on file" : "(none)"}`);
  console.log(`  REVIEWER: gets PDF block: ${d.resumePdf ? "YES" : "no"}`);
  console.log(`  REVIEWER: FACTS resume line: ${rv.includes("Student's resume:\n") ? "full summary text" : rv.includes("Student's resume: the attached PDF") ? '"the attached PDF"' : "(none)"}`);
  console.log(`  GUARD on 1 new proper noun "Pinecrest": ${g.ok ? `ACCEPTED${g.note ? " + note" : ""}` : `REJECTED (${g.reason})`}`);
}
