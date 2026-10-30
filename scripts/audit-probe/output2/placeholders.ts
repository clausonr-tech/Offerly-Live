// Artifact 5: gaps and [bracketed placeholders] through finishDraft, plus the
// em-dash and //n rewrites. Composer.tsx finds unfilled gaps with /\[[^\]\n]{2,}\]/g
// on subject+body and blocks sending, so what finishDraft does to a bracket matters.
import { finishDraft, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { base } from "./base";

const BRACKET = /\[[^\]\n]{2,}\]/g;
const run = (label: string, body: string, p: Partial<DraftPromptInput> = {}, subject = "Quick question") => {
  const out = finishDraft({ ...base, ...p }, { subject, body, connectionUsed: null, gaps: [{ placeholder: "[their group]", question: "Which group?" }] });
  console.log(`CASE: ${label}`);
  console.log(`  IN  body: ${JSON.stringify(body)}`);
  console.log(`  OUT body: ${JSON.stringify(out.body)}`);
  console.log(`  OUT subject: ${JSON.stringify(out.subject)}`);
  console.log(`  brackets in: ${JSON.stringify(body.match(BRACKET))}  brackets out: ${JSON.stringify(out.body.match(BRACKET))}`);
  console.log(`  gaps: ${JSON.stringify(out.gaps)}  notes: ${JSON.stringify(out.notesForStudent)}`);
  console.log("");
};

run("plain placeholder in the body", "Hi Rachel,\n\nI am interested in [their group].\n\nBest,\nMaya");
run("placeholder with an em dash inside", "Hi Rachel,\n\nCould we talk [date — time]?\n\nBest,\nMaya");
run("placeholder with an en dash inside", "Hi Rachel,\n\nCould we talk [date – time]?\n\nBest,\nMaya");
run("placeholder with a digit range em dash", "Hi Rachel,\n\nI worked there [2023—2025].\n\nBest,\nMaya");
run("placeholder split by //n", "Hi Rachel,\n\nI am interested in [their//nGroup].\n\nBest,\nMaya");
run("placeholder before a //n break", "Hi Rachel,\n\nI am interested in [their group].//nI had two questions.\n\nBest,\nMaya");
run("placeholder inside the model's signature", "Hi Rachel,\n\nThanks.\n\nBest,\nMaya Patel\n[phone number]\nPenn '28");
run("placeholder after the sign-off", "Hi Rachel,\n\nThanks.\n\nBest,\nMaya\n\nP.S. I applied to [the role].");
run("placeholder after the sign-off, gmailSignature", "Hi Rachel,\n\nThanks.\n\nBest,\nMaya\n\nP.S. I applied to [the role].", { gmailSignature: true });
run("placeholder in the LAST body line, no closing", "Hi Rachel,\n\nI applied to [the role].");
run("placeholder in the subject", "Hi Rachel,\n\nThanks.\n\nBest,\nMaya", {}, "Question about [their group]");
run("placeholder in the subject with an em dash", "Hi Rachel,\n\nThanks.\n\nBest,\nMaya", {}, "[date — time] confirmation");
run("placeholder spanning a newline (Composer can't see it)", "Hi Rachel,\n\nI am interested in [their\ngroup].\n\nBest,\nMaya");
run("one-character placeholder", "Hi Rachel,\n\nI am in [x].\n\nBest,\nMaya");
run("double brackets", "Hi Rachel,\n\nI am in [[their group]].\n\nBest,\nMaya");
run("placeholder that looks like a closing line", "Hi Rachel,\n\nThanks.\n\n[Best, Maya]");
console.log("--- the em-dash / //n rewrites on their own ---");
for (const body of [
  "Hi Rachel,\n\nM&A.//nI had two questions.\n\nBest,\nMaya",
  "Hi Rachel,\n\nSee https://x.com//next for details.\n\nBest,\nMaya",
  "Hi Rachel,\n\nI worked 2023—2025 there.\n\nBest,\nMaya",
  "Hi Rachel,\n\nI worked 2023 — 2025 there.\n\nBest,\nMaya",
  "Hi Rachel,\n\n— one point\n— another\n\nBest,\nMaya",
  "Hi Rachel,\n\nThe team—the whole team—was great.\n\nBest,\nMaya",
  "Hi Rachel,\n\nThe team – the whole team – was great.\n\nBest,\nMaya",
  "Hi Rachel,\n\nTrailing dash //\nnext line.\n\nBest,\nMaya",
  "Hi Rachel,\n\nlowercase after //nhere.\n\nBest,\nMaya",
]) {
  const out = finishDraft(base, { subject: "s", body, connectionUsed: null, gaps: [] });
  console.log(`  IN : ${JSON.stringify(body)}`);
  console.log(`  OUT: ${JSON.stringify(out.body)}`);
}
