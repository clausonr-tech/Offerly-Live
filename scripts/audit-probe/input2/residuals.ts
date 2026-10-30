import { buildDraftPrompt, signatureLines, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { draftChecks } from "../../../src/lib/draft-lint";
import { fullInput } from "./fields";

const base = fullInput("cold_email");
const { userText: off } = buildDraftPrompt(base);
console.log("1. phone, gmailSignature=false:");
console.log("   raw digits '2125550143' in prompt:", off.includes("2125550143"));
console.log("   formatted '(212) 555-0143' in prompt:", off.includes("(212) 555-0143"));
console.log("   signatureLines():", JSON.stringify(signatureLines(base)));

const on = buildDraftPrompt({ ...base, gmailSignature: true }).userText;
console.log("\n2. gmailSignature=true:");
console.log("   signature lines block present:", on.includes("Signature lines, in order"));
console.log("   contact-details fallback line:", (on.match(/Contact details,.*/) ?? ["(none)"])[0]);
console.log("   linkedinUrl still reaches prompt:", on.includes("https://linkedin.com/in/zqlinked"));

console.log("\n3. alum gate fails -> student-facing note (text from committed studentNotes):");
console.log('   "We couldn\'t confirm Zara Quimby went to your school, so this doesn\'t say they\'re an alum. \\"Cold email: not an alum\\" may fit better."');

console.log("\n4. draftChecks' view of the resume (promptInput only, resumePdf already stripped):");
for (const flags of [{ hasResumePdf: true, studentResumeSummary: null }, { hasResumePdf: false, studentResumeSummary: null }]) {
  const i = { ...base, ...flags } as DraftPromptInput;
  const r = draftChecks(i, "Hi Zara,\n\nI worked at Pinecrest Capital on a deal.\n\nBest,");
  console.log(`   hasResumePdf=${flags.hasResumePdf}: forReview=${JSON.stringify(r.forReview)} forStudent=${JSON.stringify(r.forStudent)}`);
}

console.log("\n5. no school on profile at all:");
const noSchool = buildDraftPrompt({ ...base, studentSchool: null, alumniSchool: null, detectedOverlaps: [] } as DraftPromptInput);
console.log("   signatureLines:", JSON.stringify(signatureLines({ ...base, studentSchool: null } as DraftPromptInput)));
console.log("   alum line:", (noSchool.userText.match(/.*(alumni database|isn't confirmed as the student's).*/) ?? ["(none)"])[0]);
