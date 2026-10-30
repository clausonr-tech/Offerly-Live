// Artifact 6: notesForStudent - the real dedupe + APP_HANDLES filter in
// runDraftPipeline. No API: the Anthropic client is a stub (same pattern as
// scripts/draft-guard-note-test.ts).
import type Anthropic from "@anthropic-ai/sdk";
import { runDraftPipeline } from "../../../src/lib/draft-pipeline";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import { getSubCallConfig } from "../../../src/lib/model-registry";

/** The review pass's config, from its single source: lib/model-registry's `draftReview`. */
const DRAFT_REVIEW_CONFIG = getSubCallConfig("draftReview", "free");

const INPUT: DraftPromptInput & { resumePdf?: Buffer | null } = {
  studentName: "Alex Rivera",
  studentSchool: "University of Pennsylvania",
  studentGradYear: 2029,
  contactName: "Rachel Stein",
  contactFirm: "Anchorage Capital",
  contactRole: "Vice President",
  type: "cold_referral",
  boxIds: ["first.referred"],
  now: new Date("2026-09-20T12:00:00"),
  hasResumePdf: true,
  resumePdf: Buffer.from("%PDF-1.4"),
  brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }] },
};
const DRAFT = `Hi Rachel,

Jeff Moreno suggested I write to you.

I'm a sophomore at the University of Pennsylvania and I help run our investment club. Would you have 15 minutes for a call?

Thank you!

Best,
Alex Rivera
University of Pennsylvania ’29`;

function fakeClient(responses: unknown[]) {
  return {
    messages: { parse: async () => { const n = responses.shift(); if (n instanceof Error) throw n; return n; } },
  } as unknown as Anthropic;
}
const usage = { input_tokens: 10, output_tokens: 10 };
const draftResponse = (notes: string[]) => ({
  stop_reason: "end_turn", usage,
  parsed_output: { plan: { people: [], sentences: [] }, subject: "Referred by Jeff Moreno", body: DRAFT, connectionUsed: null, gaps: [], notesForStudent: notes },
});
const DRAFT_CONFIG = { model: "claude-sonnet-5", effort: "low", thinking: "disabled", maxTokens: 4096 } as const;

// Real note texts: what the model, the guard and the checks actually write,
// plus the near-miss phrasings of the app-handled notes.
const CANDIDATES = [
  // should be STRIPPED (the app already does it)
  "Attach your resume to the email before you send it.",
  "Attach the resume to this email.",
  "Your resume will be attached automatically.",
  "Your Gmail signature will be added after the sign-off.",
  "Gmail adds your signature, so the email ends on Best,.",
  "I left the signature block to your email client.",
  "I didn't include your phone number in the signature.",
  "I did not include your email address.",
  // should be KEPT (same subject, different point)
  'The review added "Pinecrest", which isn\'t in what you typed - it may have come from your resume. Check it reads right before you send.',
  "Your resume lists the internship as 2024; this email calls it recent. Check which is right.",
  "The resume on file is named for someone else. Check you uploaded yours.",
  "Attach your unofficial transcript before sending.",
  'Double-check "October 5" - that date wasn\'t in what you entered.',
  "This email mentions \"laid off\". Private or sensitive details usually don't belong in a networking email.",
  "There's only one name on file for the person you're emailing, so the email opens \"Hi Rachel,\". Make sure that's their first name.",
  // the app-handled notes in phrasings the filter may miss
  "Remember to attach a copy of your resume.",
  "Don't forget your resume.",
  "Please attach your résumé.",
  "Your email signature will be added automatically, so the draft ends on Best,.",
  "I didn't add your phone number.",
  "Add your resume as an attachment.",
  // legitimate notes that the filter's words appear inside
  "Her signature block says she has moved to the London office, so check the firm name.",
  "Attach your resume to the firm's application portal, not to this email - they asked for it there.",
  // duplicates, to exercise the dedupe
  "Attach your unofficial transcript before sending.",
  "attach your unofficial transcript before sending.",
];

async function main() {
  const result = await runDraftPipeline(fakeClient([draftResponse(CANDIDATES)]), INPUT, { draft: DRAFT_CONFIG, review: null });
  const kept = new Set(result.draft.notesForStudent);
  console.log(`notes in : ${CANDIDATES.length}   notes out: ${result.draft.notesForStudent.length}\n`);
  for (const c of CANDIDATES) {
    console.log(`${kept.has(c) ? "KEPT   " : "STRIPPED"} | ${c}`);
  }
  console.log("\n--- final notes list, in order ---");
  result.draft.notesForStudent.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
}
main();
