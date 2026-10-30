// Do the gold examples DEMONSTRATE connection-stacking, or is the drafter doing
// it on its own? The reply grader flagged cv_recital on 12 of 16 emails, and the
// flagged sentences are all the same shape: school AND hometown AND alum status
// crammed into one opening. CONNECTION_RULES already says "work it in naturally,
// once. Do not stack several." Before changing anything, find out whether the
// examples are teaching the thing the rule forbids - that has been the answer
// three times already this session.
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";

const MARKERS: [string, RegExp][] = [
  ["alum/school", /\bfellow [A-Z][\w']+ (?:alum|student)|\balum(?:na|nus|ni)?\b|\bwhere you (?:also )?(?:studied|went)\b|\byou(?:'re| are) (?:also )?a(?: fellow)? \w+ alum/i],
  ["hometown", /\b(?:also|both) from \w+|\b\w+ native\b|\bgrew up in\b[^.]{0,40}\btoo\b/i],
  ["club", /\b(?:also|both)[^.]{0,30}\b(?:club|society|fund|team)\b/i],
  ["employer", /\b(?:also|both)[^.]{0,30}\b(?:interned|worked) at\b/i],
];

const opening = (body: string) => {
  const main = body.split("\n").slice(1).join("\n").split("\n\nBest,")[0].trim();
  return main.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
};

let stacked = 0, single = 0, none = 0;
const examples: string[] = [];
for (const [, list] of Object.entries(EMAIL_EXAMPLES)) {
  for (const e of list as { body: string }[]) {
    const op = opening(e.body);
    const hits = MARKERS.filter(([, re]) => re.test(op)).map(([n]) => n);
    if (hits.length >= 2) { stacked++; if (examples.length < 5) examples.push(`${hits.join("+")}: ${op.slice(0, 120)}`); }
    else if (hits.length === 1) single++;
    else none++;
  }
}
const total = stacked + single + none;
console.log(`gold openings, ${total} bodies:`);
console.log(`  2+ connections stacked : ${stacked} (${(stacked / total * 100).toFixed(1)}%)`);
console.log(`  exactly one connection : ${single} (${(single / total * 100).toFixed(1)}%)`);
console.log(`  none                   : ${none}`);
if (examples.length) { console.log("\nstacked examples:"); for (const x of examples) console.log("  - " + x); }
