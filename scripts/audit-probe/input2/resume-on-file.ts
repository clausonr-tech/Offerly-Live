// INPUT-2 probe 2b: the 28 email types that never read the resume get
// resumeOnFile=false even when the student has one.
import { buildDraftPrompt, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
import { fullInput } from "./fields";

const NO_FILE = "The student has no resume on file.";
const ON_FILE = "The student has a resume on file.";
const ATTACHED = "The student's resume is attached to this email - mention it";

// Reproduces the committed action for a student who HAS a readable PDF on file
// and whose resume has already been read into a summary.
function liveFlags(typeId: string) {
  const t = EMAIL_TYPES.find((x) => x.id === typeId)!;
  const reads = Boolean(t.attachResume) || Boolean((t as { attachResumeIfMentioned?: boolean }).attachResumeIfMentioned);
  const resume = reads ? { mimeType: "application/pdf" } : null; // readStudentResume only called when `reads`
  return { resumeOnFile: Boolean(resume), hasResumePdf: false /* summary exists, so resumePdf is null */ };
}

let bad = 0;
for (const t of EMAIL_TYPES) {
  const f = liveFlags(t.id);
  const input: DraftPromptInput = { ...fullInput(t.id as DraftPromptInput["type"]), ...f };
  const { userText } = buildDraftPrompt(input);
  const line = userText.includes(ATTACHED) ? "attached" : userText.includes(ON_FILE) ? "on file" : userText.includes(NO_FILE) ? "NO RESUME ON FILE" : "(no line)";
  const wrong = line === "NO RESUME ON FILE";
  if (wrong) bad++;
  console.log(`${wrong ? "WRONG " : "      "}${t.id.padEnd(30)} resumeOnFile=${String(f.resumeOnFile).padEnd(5)} -> "${line}"`);
}
console.log(`\n${bad} of ${EMAIL_TYPES.length} types tell the model the student has NO resume on file, for a student who has one.`);

// Does the summary still reach them?
const tc = { ...fullInput("thank_you_chat"), ...liveFlags("thank_you_chat") };
const { userText } = buildDraftPrompt(tc);
console.log(`thank_you_chat: summary block present = ${userText.includes("From their resume")}`);
console.log(`thank_you_chat: "no resume on file" present = ${userText.includes(NO_FILE)}`);
