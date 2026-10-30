// PROBE 5 - the category veto: can a reviewer swap one defect for another
// WITHIN a category, or multiply one, and pass?
//   npx tsx scripts/audit-probe/logic1/probe5-category-veto.ts
import { guardRevision } from "../../../src/lib/draft-review";
import { draftChecks, findingCategory } from "../../../src/lib/draft-lint";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { INPUT, SIGNATURE, show } from "./fixture";

const wrap = (para: string) => `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

${para}

Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;
const cats = (b: string) => [...new Set(draftChecks(INPUT, b).forReview.map(findingCategory))];
const findings = (b: string) => draftChecks(INPUT, b).forReview;

function swap(label: string, beforePara: string, afterPara: string) {
  const b = wrap(beforePara);
  const a = wrap(afterPara);
  console.log(`\n${label}`);
  console.log(`  before findings: ${JSON.stringify(findings(b))}`);
  console.log(`  after  findings: ${JSON.stringify(findings(a))}`);
  console.log(`  before cats: ${JSON.stringify(cats(b))}  after cats: ${JSON.stringify(cats(a))}`);
  show("  guard:", guardRevision({ subject: "s", body: b }, { subject: "s", body: a }, INPUT, []));
}

// 5a. Swap one filler phrase for a different, worse filler phrase (same category, same length).
swap("5a  filler phrase A -> filler phrase B (same category, length held)",
  "I wanted to reach out about credit work and would really value your view of it.",
  "I hope this email finds you well, and I value your view of how credit work goes.");

// 5b. Multiply the count within a category: one comma splice becomes three, at the SAME length.
swap("5b  one comma splice -> three comma splices, length held",
  "Thank you again for connecting me with Ben, we had our call this week and I learned a great deal about how the group runs its process day to day.",
  "Thank you again for connecting me with Ben, we had our call. The group sounds good, I learned a lot. It was generous of them, they answered every question I asked.");

// 5c. Make an already-long sentence longer at (near) constant word count: merge
// the sentence after it in, so the paragraph's words barely change.
const BASE52 = "I have spent the last year working on valuation and comparable company analysis for a student investment fund that manages a small amount of real money for the university endowment office, and that work is the reason I keep coming back to credit rather than to the equity side of the house.";
swap("5c  52-word sentence -> 69-word sentence, paragraph length held",
  `${BASE52} The panel was the first time anybody put that idea into words for me and it stayed.`,
  `${BASE52.slice(0, -1)} because the panel was the first time anybody put that idea into words for me and it stayed.`);

// 5d. Trade a dash for a double space (DIFFERENT categories) - the control.
swap("5d  CONTROL: dash as punctuation -> double space (different categories)",
  "No reply needed - thank you for the time.",
  "No reply needed thank you  for the time.");

// 5e. Which of the 26 FINDING_KINDS categories can the veto ever see?
// draftChecks calls fluencyIssues(text, null), so the ctx-only checks never run from here.
const seen = new Set<string>();
for (const e of Object.values(EMAIL_EXAMPLES).flat()) for (const f of draftChecks(INPUT, e.body).forReview) seen.add(findingCategory(f));
console.log(`\n5e  categories the veto actually observes across all 192 corpus bodies: ${seen.size}`);
console.log(`  ${[...seen].sort().join(", ")}`);
const ALL_CATS = ["long sentence", "clauses strung together", "also and too", "connector that isn't a cause", "split to then",
  "common ground tacked on", "student called an alum", "common ground as a discovery", "common ground doubled", "both doubled",
  "thank-you joined with and", "congratulations after the ask", "thank-you openers", "double space", "space before punctuation",
  "repeated word", "lowercase sentence start", "capital after a colon", "invented opinion", "how the student found them",
  "call asked of a recruiter", "background dropped out", "filler phrase", "comma splice", "dash as punctuation",
  "class year in the signature"];
console.log(`  never observed (${ALL_CATS.filter((c) => !seen.has(c)).length} of ${ALL_CATS.length}): ${ALL_CATS.filter((c) => !seen.has(c)).join(", ")}`);
