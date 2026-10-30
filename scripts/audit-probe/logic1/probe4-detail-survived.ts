// PROBE 4 - detailSurvived: the anchor rule and the stemmer.
//   npx tsx scripts/audit-probe/logic1/probe4-detail-survived.ts
import { contentWords, detailScore, detailSurvived } from "../../../src/lib/draft-review";
import { DETAIL_COMMON } from "../../../src/lib/draft-lint";

// ---- 4a. How much of the "weighted" design is actually weighted?
// A word is an ANCHOR unless it is lowercase, digit-free AND in DETAIL_COMMON
// (85 words). So the 0.4 weight only ever applies to those 85 words.
const DETAILS = [
  "his advice about staffing on live deals and how he moved from audit to restructuring",
  "how a restructuring group decides which capital structure is worth the time",
  "distressed credit and special situations",
  "we both grew up outside a small industrial town and both rowed in high school",
  "the WITG x WUEC panel in Huntsman Hall",
  "I want to understand how coverage bankers split work with the product groups",
  "my summer internship at a regional bank doing credit memos",
  "she said the sophomore diversity programs open in October",
  "the reference call with the summer team about the process",
  "what we talked about on the phone call about the firm's reference process",
];
console.log(`DETAIL_COMMON has ${DETAIL_COMMON.size} words. Everything else of 4+ letters is an ANCHOR.\n`);
console.log("4a  anchor share of each typed detail's content words");
let anchors = 0;
let words = 0;
for (const d of DETAILS) {
  const cw = [...new Set(contentWords(d).map((w) => w.toLowerCase()))];
  const a = cw.filter((w) => !DETAIL_COMMON.has(w) || /\d/.test(w));
  const cap = contentWords(d).filter((w) => /^[A-Z]/.test(w));
  anchors += a.length + cap.filter((w) => DETAIL_COMMON.has(w.toLowerCase())).length;
  words += cw.length;
  console.log(`  ${String(a.length).padStart(2)}/${String(cw.length).padStart(2)} anchors  "${d.slice(0, 64)}${d.length > 64 ? "…" : ""}"`);
}
console.log(`  TOTAL ${anchors}/${words} content words are anchors (${((anchors / words) * 100).toFixed(1)}%)`);
console.log(`  -> anchorsLost.length === 0 therefore means "almost every content word must still be there".`);

// ---- 4b. The stemmer is not idempotent: stem(stem(w)) !== stem(w) for a whole
// family of English plurals, so a plural in the typed detail does not match its
// own singular in the body.
console.log(`\n4b  plural-in-detail vs singular-in-body (same word, same meaning)`);
const PAIRS = ["banker", "bankers", "manager", "managers", "merger", "mergers", "trader", "traders", "meeting", "meetings",
  "briefing", "briefings", "earning", "earnings", "quarter", "quarters", "partner", "partners", "semester", "semesters",
  "application", "applications", "internship", "internships", "question", "questions", "sophomore", "sophomores"];
const broken: string[] = [];
for (let i = 0; i < PAIRS.length; i += 2) {
  const [sing, plur] = [PAIRS[i], PAIRS[i + 1]];
  const ok = detailSurvived(`your ${plur} on the desk`, `I would like to hear about the ${sing} on the desk.`);
  const okRev = detailSurvived(`your ${sing} on the desk`, `I would like to hear about the ${plur} on the desk.`);
  if (!ok || !okRev) broken.push(`${plur}/${sing}`);
  console.log(`  detail "${plur}" vs body "${sing}": ${ok ? "survives" : "LOST"}   | detail "${sing}" vs body "${plur}": ${okRev ? "survives" : "LOST"}`);
}
console.log(`  BROKEN PAIRS: ${broken.length}/${PAIRS.length / 2} -> ${broken.join(", ")}`);

// ---- 4c. A detail that loses its most specific half.
console.log(`\n4c  does a detail that loses its most specific half still pass?`);
const cases: [string, string, string][] = [
  ["anchor in the dropped half",
    "his advice about staffing on live deals and how he moved from audit to restructuring",
    "I would value your advice about staffing on live deals."],
  ["all-DETAIL_COMMON detail, specific half dropped",
    "the reference call with the summer team about the process",
    "I hope to hear about the summer process on your team."],
  ["number dropped",
    "the 2026 sophomore diversity program",
    "I am applying to the sophomore diversity program."],
  ["capitalised name dropped",
    "the WITG x WUEC panel in Huntsman Hall",
    "It was great to meet you at the WITG x WUEC panel."],
];
for (const [label, detail, body] of cases) {
  const { score, anchorsLost } = detailScore(detail, body);
  console.log(`  ${detailSurvived(detail, body) ? "PASSES " : "caught "} score=${score.toFixed(2)} anchorsLost=${JSON.stringify(anchorsLost)}  [${label}]`);
}

// ---- 4d. False accepts from the stemmer merging different words.
console.log(`\n4d  different words that the stemmer merges (a body word stands in for a detail word it has nothing to do with)`);
const MERGES: [string, string][] = [["banker", "banking"], ["trader", "trading"], ["cover", "covering"], ["closing", "closed"],
  ["intern", "interns"], ["model", "models"], ["mentor", "mentoring"], ["sector", "sectors"], ["invest", "investing"],
  ["manage", "managing"], ["process", "processed"], ["found", "founder"]];
for (const [a, b] of MERGES) {
  const survived = detailSurvived(`your ${a} work`, `I am interested in your ${b} work.`);
  console.log(`  detail "${a}" vs body "${b}": ${survived ? "MATCHED (stems collide)" : "not matched"}`);
}

// ---- 4e. Is 4b reachable? How often does the corpus use a word from the broken family?
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
const bodies = Object.values(EMAIL_EXAMPLES).flat().map((e) => e.body);
const brokenWords = new Map<string, number>();
let bodiesWithOne = 0;
for (const b of bodies) {
  const hits = new Set<string>();
  for (const raw of contentWords(b)) {
    const w = raw.toLowerCase();
    // Only genuine plurals of -er / -ing nouns, which is where the non-idempotent
    // stem lives ("business" -> "busines" is not a plural and is excluded).
    if (!/(?:ers|ings)$/.test(w) || w.length < 7) continue;
    const sing = w.slice(0, -1);
    // The pair breaks when the detail form and the body form stem differently.
    if (!detailSurvived(`your ${w} here`, `about your ${sing} here.`)) hits.add(`${w}/${sing}`);
  }
  if (hits.size) bodiesWithOne++;
  for (const h of hits) brokenWords.set(h, (brokenWords.get(h) ?? 0) + 1);
}
console.log(`\n4e  reachability on the real corpus (${bodies.length} bodies)`);
console.log(`  bodies containing at least one word whose singular/plural pair does NOT match: ${bodiesWithOne}/${bodies.length} (${((bodiesWithOne / bodies.length) * 100).toFixed(1)}%)`);
console.log(`  the pairs, most common first:`);
for (const [w, n] of [...brokenWords.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${w.padEnd(26)} ${n} bodies`);
