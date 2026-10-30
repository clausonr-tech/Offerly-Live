// LOGIC-2: a privateTopicsIn false positive removes the guard's protection of a
// typed detail (draft-review.ts:511 exempts any typed detail the word list hits).
import { guardRevision } from "../../../src/lib/draft-review";
import { privateTopicsIn } from "../../../src/lib/draft-lint";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";

const base = {
  type: "cold_email", contactName: "Rachel Stein", contactFirm: "Marchbank Partners", gmailSignature: true,
  studentName: "Alex Rivera", studentGradYear: 2029, studentSchool: "Duke University", purpose: null,
} as unknown as DraftPromptInput;

const PAD =
  " I am a sophomore studying finance and I have spent this year on the valuation team of our investment club. " +
  "The work has been the most useful part of my semester so far, and it is what made me want to write to you. " +
  "I would be glad to work around whatever is easiest on your end in the next two weeks. " +
  "Any time at all that suits you works on my end, including early mornings before the market opens.";

function run(label: string, detail: string) {
  const original = `Hi Rachel,\n\n${detail}${PAD} Would you have 15 minutes in the next two weeks?\n\nBest,\nAlex Rivera`;
  const revised = `Hi Rachel,\n\n${PAD} Would you have 15 minutes in the next two weeks?\n\nBest,\nAlex Rivera`;
  const input = { ...base, brief: {}, extraContext: detail } as unknown as DraftPromptInput;
  console.log(`\n${label}`);
  console.log(`  typed detail            : ${JSON.stringify(detail)}`);
  console.log(`  privateTopicsIn(detail) : ${JSON.stringify(privateTopicsIn(detail))}`);
  console.log(`  guard on its deletion   : ${JSON.stringify(guardRevision({ subject: "s", body: original }, { subject: "s", body: revised }, input, []))}`);
}

run("A) an ordinary typed detail, deleted by the review", "Your work on the restructuring of Hertz is what got me interested in the group.");
run("B) the same detail with one domain word the list calls private", "Your work on the bankruptcy of Hertz is what got me interested in the group.");
run("C) a healthcare coverage detail", "The diagnostics company your team took public is one I have followed closely.");
