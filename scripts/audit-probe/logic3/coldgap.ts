// LOGIC-3 probe: briefLines' cold switch is keyed on four hardcoded type ids,
// not on type.isCold. Which cold types fall through, and what do they lose?
import { buildDraftPrompt, type DraftPromptInput } from "@/lib/draft-prompt";
import { EMAIL_TYPES } from "@/lib/draft-templates";
const COVERED = new Set(["cold_email", "cold_after_meeting", "cold_not_alum", "cold_referral"]);
const cold = EMAIL_TYPES.filter((t) => t.isCold);
console.log(`types with isCold === true: ${cold.length} -> ${cold.map((t) => t.id).join(", ")}`);
console.log(`covered by briefLines' cold switch: ${cold.filter((t) => COVERED.has(t.id)).map((t) => t.id).join(", ")}`);
console.log(`NOT covered: ${cold.filter((t) => !COVERED.has(t.id)).map((t) => t.id).join(", ") || "(none)"}`);

const brief = { financeInterest: "consumer and retail M&A", wantToLearn: "how she moved from Duke into consumer coverage", specificReason: "both from Atlanta", fieldAnswers: [] };
for (const t of cold) {
  const { userText } = buildDraftPrompt({
    type: t.id, contactName: "Rachel Stein", contactFirm: "Morrow & Pike", studentName: "Maya",
    studentSchool: "Duke University", studentGradYear: 2029, alumniSchool: "Duke University",
    now: new Date("2026-09-20"), brief,
  } as DraftPromptInput);
  const has = (s: string) => (userText.includes(s) ? "yes" : "NO ");
  console.log(`\n${t.id.padEnd(22)} purpose=${has("Why the student is reaching out:")}  financeInterest=${has("consumer and retail M&A")}  wantToLearn=${has("into consumer coverage")}  commonGround=${has("both from Atlanta")}  askLine=${has("Ask for a 10")}  alumLine=${has("alumni database")}`);
}
