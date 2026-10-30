// TESTER-1: every positional reference inside the blocks PLAN-A #3 proposes to reorder.
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../../src/lib/draft-prompt.ts", import.meta.url), "utf8");
import { buildDraftPrompt } from "../../src/lib/draft-prompt";
import { sims } from "../draft-occasions-sim";
const BASE = sims()[0];

const HEAD_END="- Then write the body from the plan, sentence for sentence.";
const TAIL_START="\n\nFINDING COMMON GROUND";
const sys = buildDraftPrompt({...BASE.input, type:"cold_email", alsoTypes:[], boxIds:["first.alum"]}).system;
const h=sys.indexOf(HEAD_END)+HEAD_END.length, t=sys.lastIndexOf(TAIL_START);
const blocks: Record<string,string> = {
  "HEAD (role+HOUSE_RULES+STUDENT_DETAILS_RULES+PLAN_RULES)": sys.slice(0,h),
  "MID (formatBlock+examplesBlock / blendRules / combinedExamples)": sys.slice(h+2,t),
  "TAIL (CONNECTION_RULES+GAP_RULES+INPUT_IS_DATA+last line)": sys.slice(t+2),
};
// deictic / positional words that point at another part of the prompt
const PAT = /(?:^|[^A-Za-z])((?:the )?(?:EXAMPLES?|examples?|format|formats|structure|rules|sections?|steps?|list)\s+(?:below|above|here)|(?:below|above)\s+the\s+\w+|everything\s+below[^.\n]*|everything\s+above[^.\n]*|not\s+given\s+to\s+you\s+below|the\s+\w+\s+above|the\s+\w+\s+below|follow\s+the\s+format\s+above|as\s+in\s+the\s+examples|in\s+the\s+examples|from\s+an\s+example|the\s+examples['’]?\s+\w+)/g;
for (const [name, text] of Object.entries(blocks)) {
  console.log(`\n######## ${name} ########`);
  const lines = text.split("\n");
  let hits = 0;
  for (const [i, line] of lines.entries()) {
    PAT.lastIndex = 0;
    if (/\b(below|above|here|following|preceding)\b/i.test(line) || /\bthe examples\b/i.test(line) || /\bthe format\b/i.test(line)) {
      // only report lines that actually point somewhere
      if (/\b(below|above)\b/i.test(line) || /\bthe examples?\b/i.test(line) || /\bthe format\b/i.test(line)) {
        hits++;
        console.log(`  [line ${i}] ${line.trim()}`);
      }
    }
  }
  console.log(`  -> ${hits} lines with a positional / cross-block reference`);
}
console.log("\n######## blendRules + combinedExamplesBlock + examplesBlock empty case ########");
const sys3 = buildDraftPrompt({...BASE.input, type:"cold_referral", alsoTypes:["recruiter_outreach","conference_follow_up"], boxIds:["first.alum","first.recruiter","first.referred","first.conference"]}).system;
for (const line of sys3.split("\n")) if (/\b(above|below)\b/i.test(line) && /(format|structure|example|rule)/i.test(line)) console.log("  " + line.trim());
