// PROBE 2 - rule order in guardRevision: does an earlier rule pre-empt a later
// one that should have won (the M12 shape)?
//   npx tsx scripts/audit-probe/logic1/probe2-ordering.ts
import { guardRevision } from "../../../src/lib/draft-review";
import { draftChecks, findingCategory, privateTopicsIn } from "../../../src/lib/draft-lint";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import { INPUT, SIGNATURE, p, show } from "./fixture";

console.log("ORDER AS WRITTEN:");
[
  "0  normalise: body above the LAST line that trims to exactly \"Best,\"",
  "1  greeting (first line) changed",
  "2  the multiset of [placeholders] changed",
  "3  a number not in `known`",
  "4  a capitalised non-sentence-initial word not a substring of `known`  (<=1 allowed + note iff resumeUnread)",
  "5  a typed detail that survived the draft does not survive the edit  (exempt: private/hateful topic, or a reported private/hateful quote)",
  "6  ASK present before, absent after",
  "7  shared-school phrasing present before, absent after",
  "8  a lint CATEGORY present after but not before",
  "9  growth ceiling   after > before * 1.2",
  "10 shrink floor     after < (before - creditedRemoval) * 0.6",
  "11 subject: kept unless a spelling/wrong_person problem quotes it and every 4+ char word is known",
].forEach((l) => console.log("  " + l));

// ---------------------------------------------------------------- 2a. rule 6 pre-empts rule 10
const ASK_PRIVATE = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

I would love to hear how you kept recruiting on track through your divorce, if you have 15 minutes.

Thank you!

${SIGNATURE}`;
const ASK_REMOVED = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

Thank you!

${SIGNATURE}`;
const privateQuote = p({ quote: "how you kept recruiting on track through your divorce", needsStudent: true });
console.log(`\n2a  the private detail and the ask share one sentence (private topics: ${JSON.stringify(privateTopicsIn(ASK_PRIVATE))})`);
console.log("    the reviewer does what rule 3 of its prompt says and removes the sentence:");
show("", guardRevision({ subject: "s", body: ASK_PRIVATE }, { subject: "s", body: ASK_REMOVED }, INPUT, [privateQuote]));

// ---------------------------------------------------------------- 2b. rule 7 pre-empts rule 10
const ALUM: DraftPromptInput = { ...INPUT, alumniSchool: "University of Pennsylvania" };
const SCHOOL_PRIVATE = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

I was glad to hear you also studied at Penn, and I am sorry to hear about your cancer diagnosis last spring. Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;
const SCHOOL_REMOVED = SCHOOL_PRIVATE.replace(
  "I was glad to hear you also studied at Penn, and I am sorry to hear about your cancer diagnosis last spring. ",
  "",
);
console.log(`\n2b  the private detail and the shared school share one sentence (private topics: ${JSON.stringify(privateTopicsIn(SCHOOL_PRIVATE))})`);
show("", guardRevision({ subject: "s", body: SCHOOL_PRIVATE }, { subject: "s", body: SCHOOL_REMOVED }, ALUM,
  [p({ quote: "I am sorry to hear about your cancer diagnosis last spring", needsStudent: true })]));

// ---------------------------------------------------------------- 2c. rule 8 pre-empts rule 10
const MID = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel. I am still thinking about what you said about going through rehab while you were an analyst. I am a sophomore studying finance and would value 15 minutes of your perspective on credit work.

Thank you!

${SIGNATURE}`;
// The sentence is cut but its surrounding single space is left behind, which is
// exactly what a model returning whole prose does.
const MID_CUT = MID.replace(" I am still thinking about what you said about going through rehab while you were an analyst. ", "  ");
console.log(`\n2c  the private sentence is cut from the middle of a paragraph, leaving the join as a double space`);
console.log(`    lint categories before: ${JSON.stringify([...new Set(draftChecks(INPUT, MID).forReview.map(findingCategory))])}`);
console.log(`    lint categories after:  ${JSON.stringify([...new Set(draftChecks(INPUT, MID_CUT).forReview.map(findingCategory))])}`);
show("", guardRevision({ subject: "s", body: MID }, { subject: "s", body: MID_CUT }, INPUT,
  [p({ quote: "going through rehab while you were an analyst", needsStudent: true })]));

// ---------------------------------------------------------------- 2d. rule 0 pre-empts everything
const BASE = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel. Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;
const RESIGNED = BASE.replace("Best,", "Best regards,");
console.log(`\n2d  the reviewer rewrites the sign-off word ("Best," -> "Best regards,"). The signature is rebuilt`);
console.log(`    from the profile afterwards regardless, so nothing in it should be judged - but rule 0 no longer finds it.`);
show("", guardRevision({ subject: "s", body: BASE }, { subject: "s", body: RESIGNED }, INPUT, []));

// ---------------------------------------------------------------- 2e. rule 1 pre-empts the reviewer's own first instruction
const MISGREETED = BASE.replace("Hi Rachel,", "Hi Rachael,");
console.log(`\n2e  the reviewer fixes a misspelled recipient name in the greeting (its CHECK #1 / rule "spelling")`);
show("", guardRevision({ subject: "s", body: MISGREETED }, { subject: "s", body: BASE }, INPUT,
  [p({ kind: "spelling", quote: "Rachael", needsStudent: false })]));

// ---------------------------------------------------------------- 2f. the reason names one defect of several
const TWO_DEFECTS = BASE.replace("WITG x WUEC panel.", "WITG x WUEC panel in 2024, which Goldman Sachs also sponsored.");
console.log(`\n2f  one edit with TWO fabrications (a year and a firm). The retry prompt interpolates guard.reason verbatim:`);
show("", guardRevision({ subject: "s", body: BASE }, { subject: "s", body: TWO_DEFECTS }, INPUT, []));
console.log("    -> the retry is told to put right only the number; the invented firm is not mentioned.");
