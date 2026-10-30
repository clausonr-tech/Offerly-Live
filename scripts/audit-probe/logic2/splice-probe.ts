// LOGIC-2: commaSplices false positives and false negatives.
import { commaSplices } from "../../../src/lib/draft-lint";
import { gold, mainText } from "./corpus";

const INTRODUCTORY = /^(?:since|this|that|these|those|last|next|at|in|on|if|when|after|before|as|given|because|while|although|though|for|with|over|during|once|earlier|later|today|yesterday|however|still|so|then|whatever|whenever|until|unless|now|back|by|from|besides|following|honestly|meanwhile|otherwise|instead|overall|personally|ideally)\b/i;
const SUBORDINATE = /\b(?:if|when|because|since|while|although|though|as|after|before|once|until|whenever|whether|the more|so that)\b/i;

const FP: string[] = [
  "To answer your question, I am a sophomore studying finance at Duke.",
  "Thanks to your introduction, I had a call with Ben on Tuesday.",
  "Reading your note again this morning, I was glad to hear the news.",
  "Beyond the internship itself, I am curious how the team staffs its juniors.",
  "Along with my resume, I attached the writing sample you asked about.",
  "Apart from the timing, I am flexible about the format of the call.",
  "Having read the fund's latest letter, I came away with one question.",
  "Speaking with Elias last week, I realised how much the coverage has changed.",
  "Of all the conversations I had this fall, I think about yours most.",
  "Like many students in the club, I built my first model last spring.",
];

const FN: string[] = [
  "This summer I built a screening model from scratch, I learned more from it than from any class.",
  "That conversation stayed with me, I have been reading the group's letters since.",
  "In September I started the write-ups you suggested, they are the reason I had an opinion to defend.",
  "At the conference you mentioned the infrastructure team, I have been following it ever since.",
  "So the process is now behind me, I wanted to say thank you properly.",
  "Last week I spoke with Ben, he was generous with his time.",
  "I have been working as a research assistant this year, I enjoy it a great deal.",
  "I will send the model over before Friday, it is almost finished.",
  "I read the letter when it came out, it changed how I think about retail.",
  "Thank you for the note, I am glad the conference was useful for you as well.",
];

const TP: string[] = [
  "Thank you again for connecting me with Ben, we had our call this week.",
  "Your point about customer concentration stuck with me, it reframed how I read retail.",
];

function show(label: string, cases: string[], expectFlag: boolean) {
  console.log(`\n== ${label} (expect ${expectFlag ? "a finding" : "no finding"})`);
  for (const s of cases) {
    const got = commaSplices(s);
    const ok = (got.length > 0) === expectFlag;
    const before = s.slice(0, s.indexOf(","));
    console.log(`${ok ? "as expected " : "MISBEHAVES "} ${JSON.stringify(got)}  intro=${INTRODUCTORY.test(before)} sub=${SUBORDINATE.test(before.split(",").pop()!.trim())}\n    ${s}`);
  }
}

show("FALSE POSITIVES: introductory phrase whose first word is not on the list", FP, false);
show("FALSE NEGATIVES: a real splice in a sentence the exclusion lists wave through", FN, true);
show("CONTROL: real splices", TP, true);

// How blind the exclusion lists make the check, over the gold corpus.
let sentences = 0, introStart = 0, subInLast = 0, either = 0;
for (const g of gold()) {
  const ss = mainText(g.body).replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((s) => s.trim()).filter(Boolean);
  for (const s of ss) {
    if (!s.includes(",")) continue;
    sentences++;
    const before = s.slice(0, s.indexOf(","));
    const i = INTRODUCTORY.test(before);
    const u = SUBORDINATE.test(before.split(",").pop()!.trim());
    if (i) introStart++;
    if (u) subInLast++;
    if (i || u) either++;
  }
}
console.log(`\n== exclusion reach over gold: ${sentences} comma-bearing sentences`);
console.log(`   INTRODUCTORY matches the opening: ${introStart} (${(100 * introStart / sentences).toFixed(1)}%)`);
console.log(`   SUBORDINATE matches the last segment before the first comma: ${subInLast} (${(100 * subInLast / sentences).toFixed(1)}%)`);
console.log(`   either, so the check is suppressed there: ${either} (${(100 * either / sentences).toFixed(1)}%)`);
