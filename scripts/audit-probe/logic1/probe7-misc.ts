// PROBE 7 - the remaining helpers: the subject path, the shared-school rule,
// schoolCanonical/schoolKey, `loose`, and what the guard gets RIGHT.
//   npx tsx scripts/audit-probe/logic1/probe7-misc.ts
import { guardRevision } from "../../../src/lib/draft-review";
import { schoolCanonical, schoolKey } from "../../../src/lib/school-name";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import { INPUT, SIGNATURE, p, show } from "./fixture";

const BODY = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel. I am a sophomore studying finance at the University of Pennsylvania.

Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;
const SUBJ = "Referred by Jeff Moreno";
const g = (rb: string, rs = SUBJ, facts = INPUT, probs: ReturnType<typeof p>[] = []) =>
  guardRevision({ subject: SUBJ, body: BODY }, { subject: rs, body: rb }, facts, probs);

// ---- 7a. The subject gate opens on a ONE-CHARACTER reported quote.
// Every 4+ char word of the new subject is a substring of `known`, so the only
// thing standing between the reviewer and an arbitrary rewrite is the `quote` test.
const NEW_SUBJ = "Sophomore studying finance at Penn";
console.log("7a  the subject rewrite gate");
show('  no problem reported, new subject', g(BODY, NEW_SUBJ));
show('  spelling problem quoting "e" (any substring of the old subject opens the gate)',
  g(BODY, NEW_SUBJ, INPUT, [p({ kind: "spelling", quote: "e" })]));
console.log(`    -> subject returned: ${JSON.stringify(g(BODY, NEW_SUBJ, INPUT, [p({ kind: "spelling", quote: "e" })]))}`);

// ---- 7b. Shared-school rule fires on any "alum*" word, school or not.
const ALUM: DraftPromptInput = { ...INPUT, alumniSchool: "University of Pennsylvania" };
const ALUM_BODY = BODY.replace("I am a sophomore studying finance at the University of Pennsylvania.",
  "I found your name in the alumni directory for the investment club.");
const ALUM_FIXED = ALUM_BODY.replace("I found your name in the alumni directory for the investment club.",
  "I came across your name through the investment club.");
console.log("\n7b  the shared-school rule keys on `\\balum\\w*` anywhere, independently of the school word");
show("  an unrelated \"alumni directory\" reworded away", guardRevision({ subject: SUBJ, body: ALUM_BODY }, { subject: SUBJ, body: ALUM_FIXED }, ALUM, []));

// ---- 7c. schoolCanonical / schoolKey: the D19 fix, and what it does not open.
console.log("\n7c  school renderings");
for (const s of ["Penn", "University of Pennsylvania", "Penn State", "UNC", "UNC Charlotte", "Berkeley", "Michigan"]) {
  console.log(`  ${s.padEnd(26)} canonical=${JSON.stringify(schoolCanonical(s))} key=${JSON.stringify(schoolKey(s))}`);
}
show("  Penn -> the University of Pennsylvania (the D19 false positive)",
  g(BODY.replace("at the University of Pennsylvania.", "at Penn.")) );
show("  the other direction, Penn in the draft -> University of Pennsylvania in the edit",
  guardRevision({ subject: SUBJ, body: BODY.replace("at the University of Pennsylvania.", "at Penn.") },
    { subject: SUBJ, body: BODY }, INPUT, []));
show("  ...but Wharton for Penn is still blocked",
  g(BODY.replace("at the University of Pennsylvania.", "at Wharton.")));
show("  and the school's own name donates substring surface: \"Sylvan\" (inside pennSYLVANia)",
  g(BODY.replace("WITG x WUEC panel.", "WITG x WUEC panel with Sylvan.")));

// ---- 7d. `loose` is conservative: punctuation differences deny the credit.
const PRIV = `Hi Rachel,

Jeff Moreno suggested I write to you. I am sorry to hear about the divorce, that must have been hard. Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;
const CUT = PRIV.replace(" I am sorry to hear about the divorce, that must have been hard.", "");
console.log("\n7d  `loose` normalises case, curly quotes and runs of whitespace - and nothing else");
show("  quote matches exactly", guardRevision({ subject: SUBJ, body: PRIV }, { subject: SUBJ, body: CUT }, { ...INPUT, brief: {} },
  [p({ quote: "I am sorry to hear about the divorce" })]));
show("  quote differs by an em dash the reviewer substituted", guardRevision({ subject: SUBJ, body: PRIV }, { subject: SUBJ, body: CUT }, { ...INPUT, brief: {} },
  [p({ quote: "I am sorry to hear about the divorce — that must have been hard" })]));

// ---- 7e. What the guard gets right: the real protections.
console.log("\n7e  the protections, re-run");
show("  invents a firm", g(BODY.replace("WITG x WUEC panel.", "WITG x WUEC panel at Goldman Sachs.")));
show("  invents a number", g(BODY.replace("15 minutes", "25 minutes")));
show("  numbers are matched EXACTLY, not by substring (\"208\" is inside the phone \"15550101234\")",
  g(BODY.replace("15 minutes", "208 minutes")));
show("  guts the email", g(`Hi Rachel,\n\nLet me know.\n\n${SIGNATURE}`));
show("  changes the greeting", g(BODY.replace("Hi Rachel,", "Dear Ms. Stein,")));
show("  adds a [placeholder]", g(BODY.replace("for a call?", "for a call about [topic]?")));
show("  drops the ask", g(BODY.replace("Would you have 15 minutes for a call?\n\n", "")));
show("  guts the email, no typed details in the facts", guardRevision({ subject: SUBJ, body: BODY },
  { subject: SUBJ, body: `Hi Rachel,\n\nLet me know.\n\n${SIGNATURE}` }, { ...INPUT, brief: {} }, []));
show("  plain rewording", g(BODY.replace("it was great to meet you", "I was glad to meet you")));
