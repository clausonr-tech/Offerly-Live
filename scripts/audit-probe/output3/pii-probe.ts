// OUTPUT-3 audit probe: what happens to sensitive numbers and private facts a
// student types, on the way out to the email and to the "Before you send" notes.
//   npx tsx --conditions=react-server scripts/audit-probe/output3/pii-probe.ts
// No API call, no DB. Read-only.

import type Anthropic from "@anthropic-ai/sdk";
import { runDraftPipeline } from "../../../src/lib/draft-pipeline";
import { draftChecks, privateTopicsIn } from "../../../src/lib/draft-lint";
import { blockedLanguageError } from "../../../src/lib/content-limits";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import { getSubCallConfig } from "../../../src/lib/model-registry";

/** The review pass's config, from its single source: lib/model-registry's `draftReview`. */
const DRAFT_REVIEW_CONFIG = getSubCallConfig("draftReview", "free");

const TYPED = {
  ssn: "my ssn is 078-05-1120 if they need it for the background check",
  bank: "payroll goes to Chase account 483920175, routing 021000021",
  salary: "he told me the analyst base is 110000 plus a 40 percent bonus",
  otherPhone: "his cell is 555-010-1234, he said to text him",
  medical: "we talked about his cancer diagnosis and the chemo schedule",
  address: "he lives at 44 Linden Street, Greenwich",
};

console.log("=== 1. the input gate (blockedLanguageError) on each typed value ===");
for (const [k, v] of Object.entries(TYPED)) {
  console.log(`  ${k.padEnd(11)} ${blockedLanguageError([["What you discussed", v]]) ?? "PASSES the input gate"}`);
}

console.log("\n=== 2. privateTopicsIn (the only deterministic sensitivity check) ===");
for (const [k, v] of Object.entries(TYPED)) {
  const hits = privateTopicsIn(v);
  console.log(`  ${k.padEnd(11)} ${hits.length ? `warns: ${JSON.stringify(hits)}` : "NO WARNING"}`);
}

console.log("\n=== 3. draftChecks().forStudent when the value is in the finished BODY ===");
const base = (line: string) => `Hi Rachel,\n\n${line}\n\nWould you have 15 minutes for a call?\n\nBest,\nAlex Rivera`;
for (const [k, v] of Object.entries(TYPED)) {
  const notes = draftChecks({ contactName: "Rachel Stein", contactFirm: "Anchorage Capital", gmailSignature: false, studentGradYear: 2029, brief: {}, purpose: null, extraContext: undefined } as never, base(v)).forStudent;
  console.log(`  ${k.padEnd(11)} ${notes.length ? JSON.stringify(notes) : "NO NOTE TO THE STUDENT"}`);
}

// --- 4. the guard, when the reviewer tries to take a sensitive detail out ---
const INPUT: DraftPromptInput = {
  studentName: "Alex Rivera",
  studentSchool: "University of Pennsylvania",
  studentGradYear: 2029,
  contactName: "Rachel Stein",
  contactFirm: "Anchorage Capital",
  contactRole: "Vice President",
  type: "thank_you_chat",
  alsoTypes: [],
  boxIds: ["thanks.chat"],
  now: new Date("2026-09-20T12:00:00"),
  hasResumePdf: false,
  brief: { conversationDetails: TYPED.ssn },
};

const WITH_SSN = `Hi Rachel,

Thank you for the call on Tuesday. You mentioned the background check needs my SSN, 078-05-1120, so I am including it here.

Would you have 15 minutes for a follow-up call?

Thank you!

Best,
Alex Rivera
University of Pennsylvania '29`;
const CLEANED = WITH_SSN.replace(
  "You mentioned the background check needs my SSN, 078-05-1120, so I am including it here.",
  "You mentioned the background check, which I will handle through the portal.",
);

const usage = { input_tokens: 10, output_tokens: 10 };
const fakeClient = (responses: unknown[]) =>
  ({ messages: { parse: async () => responses.shift() } }) as unknown as Anthropic;
const draftResponse = (body: string) => ({
  stop_reason: "end_turn",
  usage,
  parsed_output: { plan: { people: [], sentences: [] }, subject: "Thank you", body, connectionUsed: null, gaps: [], notesForStudent: [] },
});
const reviewResponse = (body: string, problems: unknown[] = []) => ({ stop_reason: "end_turn", usage, parsed_output: { problems, subject: "Thank you", body } });
const CONFIGS = { draft: { model: "claude-sonnet-5", effort: "low", thinking: "disabled", maxTokens: 4096 } as const, review: DRAFT_REVIEW_CONFIG };

const CASES: [string, unknown[]][] = [
  ["reviewer removes it and reports kind 'private'", [{ kind: "private", quote: "my SSN, 078-05-1120", fix: "Took out your SSN. Never send it in an email.", needsStudent: true }]],
  ["reviewer removes it and reports kind 'other'", [{ kind: "other", quote: "my SSN, 078-05-1120", fix: "Took out your SSN.", needsStudent: true }]],
  ["reviewer removes it silently (no problem reported)", []],
];

async function main() {
  console.log("\n=== 4. the guard on an edit that removes the SSN ===");
  for (const [label, problems] of CASES) {
    const r = await runDraftPipeline(
      fakeClient([draftResponse(WITH_SSN), reviewResponse(CLEANED, problems), reviewResponse(CLEANED, problems)]),
      INPUT,
      CONFIGS,
    );
    const ships = r.draft.body.includes("078-05-1120");
    console.log(`  ${label}`);
    console.log(`    edit applied: ${r.review?.applied}  rejected because: ${JSON.stringify(r.review?.rejected ?? null)}`);
    console.log(`    SSN IN THE EMAIL THE STUDENT SENDS: ${ships ? "YES" : "no"}`);
    console.log(`    notes to the student: ${JSON.stringify(r.draft.notesForStudent)}`);
  }

  // For contrast: a medical detail, which privateTopicsIn does recognise.
  console.log("\n=== 5. contrast: a detail privateTopicsIn recognises ===");
  const medInput = { ...INPUT, brief: { conversationDetails: TYPED.medical } };
  const WITH_MED = WITH_SSN.replace("You mentioned the background check needs my SSN, 078-05-1120, so I am including it here.", "I am sorry to hear about your cancer diagnosis and hope the chemo is going well.");
  const MED_CLEAN = WITH_MED.replace("I am sorry to hear about your cancer diagnosis and hope the chemo is going well.", "I hope things are going well.");
  const r = await runDraftPipeline(fakeClient([draftResponse(WITH_MED), reviewResponse(MED_CLEAN, [])]), medInput, CONFIGS);
  console.log(`    silent removal applied: ${r.review?.applied}  rejected: ${JSON.stringify(r.review?.rejected ?? null)}`);
  console.log(`    body still mentions cancer: ${r.draft.body.includes("cancer")}`);
  console.log(`    notes: ${JSON.stringify(r.draft.notesForStudent)}`);
}
void main();
