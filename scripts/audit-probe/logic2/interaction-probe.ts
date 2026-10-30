// LOGIC-2: finishDraft manufactures a comma splice, and the guard's lint veto
// is evaluated on text that is not the text that ships.
import { draftChecks, findingCategory, commaSplices } from "../../../src/lib/draft-lint";
import { finishDraft, type DraftPromptInput } from "../../../src/lib/draft-prompt";

const input = {
  type: "cold_email",
  contactName: "Rachel Stein",
  contactFirm: "Marchbank Partners",
  gmailSignature: true,
  studentName: "Alex Rivera",
  studentGradYear: 2029,
  studentSchool: "Duke University",
  brief: {},
  purpose: null,
  extraContext: "",
} as unknown as DraftPromptInput;

const withEmDash =
  "Hi Rachel,\n\nThank you for the introduction to Ben — he was generous with his time, and the call was useful.\n\n" +
  "Would you have 15 minutes in the next two weeks to talk about the group?\n\nBest,\nAlex Rivera";

console.log("== 1. finishDraft's em-dash rewrite manufactures a comma splice");
const before = draftChecks(input, withEmDash).forReview;
const after = finishDraft(input, { subject: "Reaching out", body: withEmDash, notesForStudent: [] } as never);
const afterChecks = draftChecks(input, after.body).forReview;
console.log(`  as the model wrote it : ${JSON.stringify(before)}`);
console.log(`  after finishDraft     : ${JSON.stringify(afterChecks)}`);
console.log(`  the rewritten clause  : ${JSON.stringify(after.body.split("\n")[2])}`);
console.log(`  commaSplices directly : ${JSON.stringify(commaSplices(after.body))}`);

console.log("\n== 2. the guard's veto is computed on out.body, but finishDraft runs AFTER the veto");
// pipeline: preReview = finishDraft(model draft); guardRevision(preReview, out, ...) uses out.body raw;
// then, if the guard passes, the shipped body is finishDraft(out.body).
const original = finishDraft(input, { subject: "s", body: "Hi Rachel,\n\nThank you for the introduction to Ben. He was generous with his time.\n\nWould you have 15 minutes in the next two weeks to talk about the group?\n\nBest,\nAlex Rivera", notesForStudent: [] } as never);
const reviewerOutput = "Hi Rachel,\n\nThank you for the introduction to Ben — he was generous with his time.\n\nWould you have 15 minutes in the next two weeks to talk about the group?\n\nBest,\nAlex Rivera";
const cats = (b: string) => new Set(draftChecks(input, b).forReview.map(findingCategory));
const had = cats(original.body);
const guardSees = cats(reviewerOutput);
const shipped = finishDraft(input, { subject: "s", body: reviewerOutput, notesForStudent: [] } as never).body;
const shippedCats = cats(shipped);
console.log(`  categories in the original (post-finishDraft)        : ${JSON.stringify([...had])}`);
console.log(`  categories the guard sees in the revision (raw)      : ${JSON.stringify([...guardSees])}`);
console.log(`  -> veto introduced?                                  ${JSON.stringify([...guardSees].filter((c) => !had.has(c)))}`);
console.log(`  categories in the body that actually ships           : ${JSON.stringify([...shippedCats])}`);
console.log(`  -> introduced by the edit, after the veto passed      ${JSON.stringify([...shippedCats].filter((c) => !had.has(c)))}`);
console.log(`  shipped clause: ${JSON.stringify(shipped.split("\n")[2])}`);

console.log("\n== 3. the same asymmetry in the other direction: a spaced hyphen the reviewer writes");
const reviewerHyphen = "Hi Rachel,\n\nThank you for the introduction to Ben - he was generous with his time.\n\nWould you have 15 minutes in the next two weeks to talk about the group?\n\nBest,\nAlex Rivera";
console.log(`  guard sees: ${JSON.stringify([...cats(reviewerHyphen)].filter((c) => !had.has(c)))} -> whole edit thrown away`);
console.log(`  and finishDraft does NOT fix a spaced hyphen: ${JSON.stringify(finishDraft(input, { subject: "s", body: reviewerHyphen, notesForStudent: [] } as never).body.split("\n")[2])}`);

console.log("\n== 4. the ASK veto: deleting a canned courtesy line reads as 'dropped the ask'");
const { guardRevision } = require("../../../src/lib/draft-review");
const canned =
  "Hi Rachel,\n\nThank you for taking the time to interview me this morning, and for walking me through how the team staffs its summer class. " +
  "The explanation of how the infrastructure group picks its juniors was especially helpful, since I had assumed that happened much later in the year. " +
  "Today only strengthened my interest in the role, and I will watch for the invitation to the next round. " +
  "Please let me know if there is anything else you need from me.\n\nBest,\nAlex Rivera";
const cannedCut = canned.replace(" Please let me know if there is anything else you need from me.", "");
console.log(`  original has an ASK match: ${JSON.stringify(canned.match(/let me know/)?.[0] ?? null)}`);
console.log(`  guard on the edit that removes only that line: ${JSON.stringify(guardRevision({ subject: "s", body: canned }, { subject: "s", body: cannedCut }, input, []))}`);
