// AGENT-M. Why all three guard-full rejections said the same thing. Deterministic,
// no model: what `detailSurvived` does to the typed detail "both from Atlanta"
// when the shared-hometown fact is kept but reworded. Imports the real functions.
import { contentWords, detailScore, detailSurvived } from "../../src/lib/draft-review";
import { DETAIL_COMMON } from "../../src/lib/draft-lint";

const detail = "both from Atlanta";
console.log(`detail: ${JSON.stringify(detail)}`);
console.log(`contentWords: ${JSON.stringify(contentWords(detail))}`);
for (const w of contentWords(detail))
  console.log(`  "${w}": capitalised=${/^[A-Z]/.test(w)} inDETAIL_COMMON=${DETAIL_COMMON.has(w.toLowerCase())} -> ${(/^[A-Z]/.test(w) || /\d/.test(w) || !DETAIL_COMMON.has(w.toLowerCase())) ? "ANCHOR (weight 1, losing it rejects the whole edit)" : "ordinary (weight 0.4)"}`);

// The sentence the drafting model actually wrote, and rewordings that keep the
// SAME FACT. These are illustrative rewordings, not the reviewer's observed
// output (the harness does not persist a rejected revised body).
const variants: [string, string][] = [
  ["as drafted (the guard's baseline)", "I was glad to learn we are both from Atlanta."],
  ["folded into the intro sentence", "I'm a sophomore at Duke studying economics, and I grew up in Atlanta too."],
  ["reworded, fact intact", "It was good to hear you're from Atlanta as well - so am I."],
  ["reworded, fact intact", "Another Atlanta native here."],
  ["reworded, keeps the word both", "We're both Atlanta natives, which I was glad to learn."],
  ["fact genuinely removed", "I'm a sophomore at Duke studying economics."],
];
console.log(`\n${"variant".padEnd(38)} ${"score".padStart(6)}  anchorsLost  survived?`);
for (const [label, body] of variants) {
  const { score, anchorsLost } = detailScore(detail, body);
  console.log(`${label.padEnd(38)} ${score.toFixed(2).padStart(6)}  ${JSON.stringify(anchorsLost).padEnd(12)} ${detailSurvived(detail, body) ? "yes" : "NO -> guard rejects the whole edit"}`);
  console.log(`    ${JSON.stringify(body)}`);
}
