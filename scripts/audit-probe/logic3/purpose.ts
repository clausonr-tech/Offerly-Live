// LOGIC-3 probe: does every prompt state why the student is writing?
import { buildDraftPrompt } from "@/lib/draft-prompt";
import { emailTypeById, EMAIL_TYPES } from "@/lib/draft-templates";
import { sims } from "../../draft-occasions-sim";
const PURPOSE = /Why the student is reaching out:/;
const rows = sims().filter((s) => s.profile === "full");
const missing = rows.filter((s) => !PURPOSE.test(buildDraftPrompt(s.input).userText));
console.log(`multi-box combinations: ${rows.length}`);
console.log(`prompts WITHOUT any "Why the student is reaching out:" line: ${missing.length}`);
for (const s of missing) {
  const hasCold = [s.input.type, ...(s.input.alsoTypes ?? [])].some((t) => emailTypeById(t)?.isCold);
  console.log(`  ${s.id} lead=${s.input.type} also=${(s.input.alsoTypes ?? []).join(",")} | a cold box is checked: ${hasCold}`);
}
// And the single-box baseline: which lead types never state a purpose on their own?
const bare = EMAIL_TYPES.filter((t) => !PURPOSE.test(buildDraftPrompt({ type: t.id, contactName: "Rachel Stein", studentName: "Maya", studentSchool: "Duke", now: new Date("2026-09-20") } as never).userText));
console.log(`\nsingle-box types whose own prompt states no purpose line: ${bare.length} of ${EMAIL_TYPES.length}`);
console.log("  " + bare.map((t) => t.id).join(", "));
