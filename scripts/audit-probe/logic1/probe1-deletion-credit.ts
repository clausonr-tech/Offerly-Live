// PROBE 1 - soundness of the deletion credit (wordsRemovedOnInstruction).
//   npx tsx scripts/audit-probe/logic1/probe1-deletion-credit.ts
import { guardRevision } from "../../../src/lib/draft-review";
import { privateTopicsIn } from "../../../src/lib/draft-lint";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import { INPUT, SIGNATURE, p, show } from "./fixture";

const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
const above = (b: string) => b.split("\n").slice(0, b.split("\n").map((l) => l.trim()).lastIndexOf("Best,")).join("\n").trimEnd();

// A long, ordinary draft with no private topic anywhere in it.
const LONG = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

I am a sophomore at the University of Pennsylvania studying finance, and I have spent the last year working on valuation and comparable company analysis for a student investment fund that manages real money. The panel was the first time I heard somebody describe credit work as a craft rather than a spreadsheet exercise, and it has stayed with me since. I have been reading about how distressed situations are sourced and how a firm decides which capital structure is worth the time.

Would you have 15 minutes for a call in the next few weeks? My resume is attached.

Thank you!

${SIGNATURE}`;

console.log(`body above sign-off: ${wc(above(LONG))} words; private topics in it: ${JSON.stringify(privateTopicsIn(LONG))}\n`);

// --- 1a. Baseline: delete the two middle sentences with no problem reported.
const GUTTED = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

I am a sophomore at the University of Pennsylvania studying finance, and I have spent the last year working on valuation and comparable company analysis for a student investment fund that manages real money.

Would you have 15 minutes for a call in the next few weeks? My resume is attached.

Thank you!

${SIGNATURE}`;
console.log(`1a  delete 2 sentences (${wc(above(LONG))} -> ${wc(above(GUTTED))} words), nothing reported`);
show("", guardRevision({ subject: "s", body: LONG }, { subject: "s", body: GUTTED }, INPUT, []));

// --- 1b. Same deletion, but the reviewer LABELS the two deleted sentences "private".
//     Neither sentence contains any private topic. The label is never checked.
const fakeProblems = [
  p({ quote: "The panel was the first time I heard somebody describe credit work as a craft rather than a spreadsheet exercise, and it has stayed with me since." }),
  p({ quote: "I have been reading about how distressed situations are sourced and how a firm decides which capital structure is worth the time." }),
];
console.log(`\n1b  SAME deletion, the two sentences reported as kind:"private" (they contain no private topic)`);
show("", guardRevision({ subject: "s", body: LONG }, { subject: "s", body: GUTTED }, INPUT, fakeProblems));

// --- 1c. A TRIVIAL mislabelled private quote buys a deletion the reviewer was never told to make.
//     "real money" sits inside the 46-word sentence; removing that sentence is credited in full,
//     which then pays for ~18 more words removed somewhere else entirely.
const BOUGHT = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

The panel was the first time I heard somebody describe credit work as a craft rather than a spreadsheet exercise, and it has stayed with me since. I have been reading about how distressed situations are sourced.

Would you have 15 minutes for a call? My resume is attached.

Thank you!

${SIGNATURE}`;
console.log(`\n1c  ${wc(above(LONG))} -> ${wc(above(BOUGHT))} words. The 46-word sentence goes (carries the quote) AND 18 further words elsewhere.`);
show("  no report", guardRevision({ subject: "s", body: LONG }, { subject: "s", body: BOUGHT }, INPUT, []));
show('  one 2-word quote, kind:"private" -> "real money"',
  guardRevision({ subject: "s", body: LONG }, { subject: "s", body: BOUGHT }, INPUT, [p({ quote: "real money" })]));
console.log(`      ("real money" private topics: ${JSON.stringify(privateTopicsIn("real money"))})`);

// --- 1d. extra-credit double count: overlapping quotes that straddle a sentence boundary.
//     Typed details are removed from the facts here so only the length rules are in play.
const BARE: DraftPromptInput = { ...INPUT, brief: {} };
const SHORT = `Hi Rachel,

I write to you about the work. It was great to meet you at the panel. I am a sophomore studying finance. Would you have 15 minutes for a call? My resume is attached.

Thank you!

${SIGNATURE}`;
const STUMP = `Hi Rachel,

Would you have 15 minutes for a call?

${SIGNATURE}`;
const straddling = [
  p({ quote: "I write to you about the work. It was great to meet you" }),
  p({ quote: "meet you at the panel. I am a sophomore" }),
  p({ quote: "at the panel. I am a sophomore studying finance. Would you" }),
];
console.log(`\n1d  ${wc(above(SHORT))} -> ${wc(above(STUMP))} words, with 3 OVERLAPPING straddling quotes (no single sentence contains any of them)`);
show("  no report", guardRevision({ subject: "s", body: SHORT }, { subject: "s", body: STUMP }, BARE, []));
show("  3 overlapping straddling quotes", guardRevision({ subject: "s", body: SHORT }, { subject: "s", body: STUMP }, BARE, straddling));

// --- 1e. The typed-detail exemption: does the reported quote have to be real?
const withDetail: DraftPromptInput = {
  ...INPUT,
  brief: {
    ...INPUT.brief,
    conversationDetails: "his advice about staffing on live deals and how he moved from audit to restructuring",
  },
};
const DETAILED = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

What stuck with me was your advice about staffing on live deals and how you moved from audit to restructuring. I am a sophomore studying finance at Penn.

Would you have 15 minutes for a call? My resume is attached.

Thank you!

${SIGNATURE}`;
const DROPPED = DETAILED.replace(
  "What stuck with me was your advice about staffing on live deals and how you moved from audit to restructuring. I am a sophomore studying finance at Penn.",
  "I am a sophomore studying finance at Penn, and the panel is still on my mind for how it framed the work.",
);
console.log(`\n1e  the typed detail is deleted from the body`);
show("  no report", guardRevision({ subject: "s", body: DETAILED }, { subject: "s", body: DROPPED }, withDetail, []));
show('  reported kind:"private", quote = the detail itself (never in the draft, never removed)',
  guardRevision({ subject: "s", body: DETAILED }, { subject: "s", body: DROPPED }, withDetail,
    [p({ quote: "staffing on live deals and how he moved from audit to restructuring", needsStudent: false })]));

// --- 1f. The credit is unbounded, so the floor can be switched off entirely.
//     A 4th overlapping straddling quote pushes the credit past `before`, making
//     (before - onInstruction) negative: no `after` can ever be below it.
const straddling4 = [...straddling, p({ quote: "the work. It was great" })];
const BARELY = `Hi Rachel,

Let me know.

${SIGNATURE}`;
console.log(`\n1f  ${wc(above(SHORT))} -> ${wc(above(BARELY))} words, 4 overlapping straddling quotes (credit sums past the whole body)`);
show("  no report", guardRevision({ subject: "s", body: SHORT }, { subject: "s", body: BARELY }, BARE, []));
show("  4 overlapping straddling quotes", guardRevision({ subject: "s", body: SHORT }, { subject: "s", body: BARELY }, BARE, straddling4));
