// LOGIC-2: are the 15 never-firing checks rare-but-right, mis-specified, or unreachable?
import { draftChecks, fluencyIssues } from "../../../src/lib/draft-lint";
import { gold, mainText } from "./corpus";

const g = gold();
const sentencesOf = (t: string) => t.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((x) => x.trim()).filter(Boolean);

console.log("== 1. lowercase sentence start: can it see a MID-TEXT lowercase start at all?");
for (const t of [
  "I am a sophomore at Duke. i would love 15 minutes to hear about your path.",
  "i am a sophomore at Duke. I would love 15 minutes to hear about your path.",
  "Thank you for the time! what stuck with me was your point about retail.",
]) {
  console.log(`  ${JSON.stringify(fluencyIssues(t, null))}\n     sentences=${JSON.stringify(sentencesOf(t))}`);
}

console.log("\n== 2. capital after a colon: only after the literal word question(s)");
for (const t of [
  "My two questions: Does the program take sophomores?",
  "One ask: Could we find 15 minutes?",
  "A quick note: The deck is attached.",
  "My question: Does the program take sophomores?",
]) console.log(`  ${JSON.stringify(fluencyIssues(t, null))}   ${t}`);

console.log('\n== 3. too many "Thank you" openers: the most any stored gold body has');
let max = 0, maxId = "";
const dist = new Map<number, number>();
for (const x of g) {
  const n = sentencesOf(mainText(x.body)).filter((s) => /^Thank you\b/.test(s)).length;
  dist.set(n, (dist.get(n) ?? 0) + 1);
  if (n > max) { max = n; maxId = x.id; }
}
console.log(`  max = ${max} (${maxId}); threshold is > 3. distribution: ${JSON.stringify([...dist].sort())}`);

console.log("\n== 4. class year in the signature: is it even reachable on the gold harness?");
const withClass = g.filter((x) => /\(\s*Class of \d{4}\s*\)/i.test(x.body));
console.log(`  gold bodies containing "(Class of NNNN)": ${withClass.length} ${withClass.map((x) => x.id).join(", ")}`);
console.log("  the corpus harness passes studentGradYear: null, so the check is switched off for all 234:");
const probe = "My name is Alex Rivera (Class of 2029) and I am studying finance.";
const base = { contactName: "Rachel", contactFirm: null, gmailSignature: false, brief: {}, purpose: null, extraContext: "" };
console.log(`   studentGradYear null -> ${JSON.stringify(draftChecks({ ...base, studentGradYear: null } as never, `Hi Rachel,\n\n${probe}\n\nBest,\nKai`).forReview)}`);
console.log(`   studentGradYear 2029 -> ${JSON.stringify(draftChecks({ ...base, studentGradYear: 2029 } as never, `Hi Rachel,\n\n${probe}\n\nBest,\nKai`).forReview)}`);

console.log("\n== 5. the three ctx-only checks can never reach forReview (draftChecks calls fluencyIssues(text, null))");
const ctxText = "I found you on LinkedIn and wanted to reach out about the summer programme.";
console.log(`  with ctx    -> ${JSON.stringify(fluencyIssues(ctxText, { ids: ["first.referred"], answered: {} }))}`);
console.log(`  as draftChecks calls it (null) -> ${JSON.stringify(fluencyIssues(ctxText, null))}`);
console.log(`  draftChecks -> ${JSON.stringify(draftChecks({ ...base, studentGradYear: null } as never, `Hi Rachel,\n\n${ctxText}\n\nBest,\nKai`).forReview)}`);

console.log("\n== 6. the rest: reachable on a constructed input?");
for (const [what, t] of [
  ['"also" and "too"', "I also studied finance, and I am from Atlanta too."],
  ['split "to then"', "I wanted to then ask about the sophomore programme."],
  ["common ground tacked on", "Your point about retail credit stayed with me all semester. I am also from Atlanta, both from the same part of town."],
  ["common ground tacked on (2)", "Your point about retail credit stayed with me all semester and I think about it often. Like me, you went to Duke."],
  ["double space", "Thank you for  the time you gave me."],
  ["space before punctuation", "Thank you for the time , and for the introduction."],
  ["repeated word", "Thank you for for the introduction."],
  ["dash as punctuation", "No reply needed - thank you again."],
  ["congratulations after the ask", "Would you have 15 minutes in the next two weeks. Congratulations again on the promotion."],
  ['4 "Thank you" openers', "Thank you for the call. Thank you for the introduction. Thank you for the note. Thank you for everything."],
] as const) {
  console.log(`  ${what.padEnd(30)} ${JSON.stringify(fluencyIssues(t, null))}`);
}
