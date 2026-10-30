// PROBE 6 - GROWTH_CEILING 1.2 vs SHRINK_FLOOR 0.6 on real body lengths.
//   npx tsx scripts/audit-probe/logic1/probe6-asymmetry.ts
import { guardRevision } from "../../../src/lib/draft-review";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { INPUT, SIGNATURE, show } from "./fixture";

const above = (b: string) => {
  const lines = b.split("\n");
  const i = lines.map((l) => l.trim()).lastIndexOf("Best,");
  return (i >= 0 ? lines.slice(0, i) : lines).join("\n").trimEnd();
};
const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;

// --- 6a. The corpus's own body lengths, as the guard counts them.
const lens = Object.values(EMAIL_EXAMPLES).flat().map((e) => wc(above(e.body))).sort((a, b) => a - b);
const q = (p: number) => lens[Math.min(lens.length - 1, Math.floor(p * lens.length))];
console.log(`6a  body-above-sign-off word counts over ${lens.length} corpus bodies`);
console.log(`    min ${lens[0]}  p10 ${q(0.1)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  max ${lens[lens.length - 1]}`);

// --- 6b. What 1.2 and 0.6 permit, in words, at each length.
console.log(`\n6b  what the two multipliers permit (max accepted = floor(before*1.2); min accepted = ceil-above(before*0.6))`);
console.log(`    before | max after | +words | min after | -words | ratio del:add`);
for (const before of [50, 60, 75, 90, 109, 130, 150, 198, 250]) {
  const maxAfter = Math.floor(before * 1.2) - (before * 1.2 === Math.floor(before * 1.2) ? 0 : 0);
  const minAfter = Math.floor(before * 0.6) + (Number.isInteger(before * 0.6) ? 0 : 1);
  const add = maxAfter - before;
  const del = before - minAfter;
  console.log(
    `    ${String(before).padStart(6)} | ${String(maxAfter).padStart(9)} | ${String(`+${add}`).padStart(6)} | ${String(minAfter).padStart(9)} | ${String(`-${del}`).padStart(6)} | ${(del / add).toFixed(2)}:1`,
  );
}

// --- 6c. The boundaries verified against guardRevision itself, at 75 words.
const pad = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 7 === 0 ? "a" : "b"}`).join(" ");
function at(before: number, after: number) {
  // A body of exactly `before` words above the sign-off: greeting (2) + ask (7) + filler.
  const mk = (n: number) => `Hi Rachel,

Let me know when works. ${pad(Math.max(0, n - 7))}

${SIGNATURE}`;
  const o = mk(before);
  const r = mk(after);
  return { o, r, obc: wc(above(o)), rbc: wc(above(r)), res: guardRevision({ subject: "s", body: o }, { subject: "s", body: r }, { ...INPUT, brief: {} }, []) };
}
console.log(`\n6c  verified against guardRevision (bodies of literal word counts, no typed details)`);
for (const [before, afters] of [[75, [89, 90, 91, 45, 44]], [198, [237, 238, 119, 118]]] as [number, number[]][]) {
  for (const after of afters) {
    const { obc, rbc, res } = at(before, after);
    show(`    ${obc} -> ${rbc} words`, res as never);
  }
}

// --- 6d. The thing the growth ceiling has to pay for: the reviewer is TOLD to
// work a dropped typed detail back in, and gets no credit for the words it adds.
console.log(`\n6d  growth has no instruction credit, unlike shrink`);
const SHORT75 = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel. I am a sophomore studying finance at Penn and have spent the year on valuation work for a student fund.

Would you have 15 minutes for a call in the next few weeks? My resume is attached.

Thank you!

${SIGNATURE}`;
const RESTORED = SHORT75.replace(
  "for a student fund.",
  "for a student fund. What stuck with me was your advice about staffing on live deals and how you moved from audit to restructuring, which is the part of the job I understand least.",
);
console.log(`    ${wc(above(SHORT75))} -> ${wc(above(RESTORED))} words, restoring a typed detail the draft had dropped`);
show("", guardRevision({ subject: "s", body: SHORT75 }, { subject: "s", body: RESTORED }, {
  ...INPUT,
  brief: { ...INPUT.brief, conversationDetails: "her advice about staffing on live deals and how she moved from audit to restructuring" },
}, []) as never);
