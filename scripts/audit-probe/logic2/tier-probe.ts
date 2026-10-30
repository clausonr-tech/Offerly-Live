// LOGIC-2: the two-tier proposal. (a) what gold's comma splices actually are,
// (b) a Tier-1 false positive becoming a whole-edit veto, (c) does 0%-gold ratchet?
import { commaSplices, draftChecks } from "../../../src/lib/draft-lint";
import { guardRevision } from "../../../src/lib/draft-review";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import { gold, mainText } from "./corpus";

console.log("== (a) the 5 gold bodies the comma-splice check flags, verbatim");
for (const x of gold()) {
  const s = commaSplices(mainText(x.body));
  if (s.length) {
    for (const hit of s) {
      const sent = mainText(x.body).replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).find((t) => t.includes(`, ${hit}`));
      console.log(`  ${x.id.padEnd(28)} ${JSON.stringify(hit)}\n     ${sent?.trim()}`);
    }
  }
}

const input = {
  type: "cold_email", contactName: "Rachel Stein", contactFirm: "Marchbank Partners", gmailSignature: true,
  studentName: "Alex Rivera", studentGradYear: 2029, studentSchool: "Duke University",
  brief: {}, purpose: null, extraContext: "",
} as unknown as DraftPromptInput;

console.log("\n== (b) a comma-splice FALSE POSITIVE in the revision vetoes the whole edit");
const ORIGINAL =
  "Hi Rachel,\n\nI am a sophomore at Duke studying finance, and I read the fund's latest letter over the weekend. " +
  "I came away with one question about how the team sizes a position when the thesis depends on a single retail partner. " +
  "Would you have 15 minutes in the next two weeks to talk about the group?\n\nBest,\nAlex Rivera";
const REVISED =
  "Hi Rachel,\n\nI am a sophomore at Duke studying finance, and I read the fund's latest letter over the weekend. " +
  "Having read the fund's latest letter, I came away with one question about how the team sizes a position. " +
  "Would you have 15 minutes in the next two weeks to talk about the group?\n\nBest,\nAlex Rivera";
console.log(`  lint on the original : ${JSON.stringify(draftChecks(input, ORIGINAL).forReview)}`);
console.log(`  lint on the revision : ${JSON.stringify(draftChecks(input, REVISED).forReview)}`);
console.log(`  guard                : ${JSON.stringify(guardRevision({ subject: "s", body: ORIGINAL }, { subject: "s", body: REVISED }, input, []))}`);

console.log("\n== (c) the promotion condition rewards a mis-specified check");
// Every check whose gold rate is 0.0% qualifies for Tier 1 under the stated rule.
// A check that matches NOTHING, anywhere, scores a perfect 0.0% on gold.
const NEVER = /\bI (?:noticed|saw) (?:that )?we(?:'re| are) both\b/i; // today's discovery check, in effect
const truePositives = [
  "I was glad to see that you are also from Atlanta.",
  "I noticed you went to Duke as well.",
  "I saw that we share a hometown.",
];
console.log(`  gold rate of the discovery check: ${gold().filter((x) => NEVER.test(x.body)).length}/234 = 0.0%  -> Tier-1 eligible today`);
console.log(`  and it matches ${truePositives.filter((t) => NEVER.test(t)).length}/${truePositives.length} of the defects it exists to catch`);
