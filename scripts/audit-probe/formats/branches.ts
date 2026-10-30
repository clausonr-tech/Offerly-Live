// Types whose first select picks WHICH EMAIL is being written. promptNotes
// branch on it (and for redirect_sequence draft-prompt.ts even filters them).
// The `format` body never branches: every step of every branch is numbered 1..n
// and handed to the drafter as the steps to follow.
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
const BRANCHY = /which email is this|what do you need to do|can you make the slot|did they (propose|name)|what did they offer|is this your last|what's happening|who are you thanking|what kind of round|how did the introduction go|what are you asking for/i;
for (const t of EMAIL_TYPES) {
  const sel = (t.fields ?? []).find((f) => f.kind === "select" && BRANCHY.test(f.label));
  if (!sel) continue;
  const branches = sel.options!.map((o) => o.value);
  // A format step is branch-aware if it says "or", "if" or "unless".
  const conditional = t.format.filter((s) => /\bif\b|\bor\b|\bunless\b|\bwhen\b/i.test(s)).length;
  const notesBranching = (t.promptNotes ?? []).filter((n) => /^(Replying|Following up later|Thanking|Emailing|Closing|Accepted|A conflict|For the (first ask|follow-up)|For a (connection|return offer|brief)|Confirming|Asking the team|If (they|the student|moving|canceling|a different|no|this|someone|other))/i.test(n)).length;
  console.log(`${t.id}`);
  console.log(`  select "${sel.label}" -> ${branches.length} branches: ${branches.join(", ")}`);
  console.log(`  format: ${t.format.length} steps, ${conditional} of them conditional; promptNotes: ${notesBranching} of ${(t.promptNotes ?? []).length} branch-labelled`);
  const unconditional = t.format.filter((s) => !/\bif\b|\bor\b|\bunless\b|\bwhen\b/i.test(s) && /^(Ask|Say|Offer|Give|Confirm|Make|Name|Attach|Mention|Reference|In the email|Close the loop|Suggest|Accept|Decline|Withdraw|Tell|Restate|Re-ask|Reply|Note|Apolog|Thank the|Lead|Put|Reassure)/i.test(s));
  for (const s of unconditional) console.log(`    unconditional step: ${s.slice(0, 110)}`);
  console.log("");
}
