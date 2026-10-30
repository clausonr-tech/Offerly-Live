// OUTPUT-3 audit probe: what the pipeline's final findBlockedLanguage gate
// does NOT cover, run against the real runDraftPipeline with a stub client.
//   npx tsx --conditions=react-server scripts/audit-probe/output3/gate-completeness-probe.ts
// No API call, no DB: the Anthropic client is a stub returning canned replies.
// Read-only - nothing in src/ is touched.

import type Anthropic from "@anthropic-ai/sdk";
import { runDraftPipeline } from "../../../src/lib/draft-pipeline";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import { findBlockedLanguage } from "../../../src/lib/content-limits";
import { getSubCallConfig } from "../../../src/lib/model-registry";

/** The review pass's config, from its single source: lib/model-registry's `draftReview`. */
const DRAFT_REVIEW_CONFIG = getSubCallConfig("draftReview", "free");

// A real slur, used because the gate under test is a slur list. Kept in one
// constant so the probe's output can be read without it being retyped.
const SLUR = "faggot";
const PROF = "shit";

const INPUT: DraftPromptInput & { resumePdf?: Buffer | null } = {
  studentName: "Alex Rivera",
  studentSchool: "University of Pennsylvania",
  studentGradYear: 2029,
  contactName: "Rachel Stein",
  contactFirm: "Anchorage Capital",
  contactRole: "Vice President",
  type: "cold_referral",
  alsoTypes: [],
  boxIds: ["first.referred"],
  now: new Date("2026-09-20T12:00:00"),
  hasResumePdf: false,
  brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }] },
};

const SIGNATURE = "Best,\nAlex Rivera\nUniversity of Pennsylvania '29";
const DRAFT = `Hi Rachel,

Jeff Moreno suggested I write to you.

I'm a sophomore at the University of Pennsylvania and I help run our investment club. Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;

const usage = { input_tokens: 10, output_tokens: 10 };
function fakeClient(responses: unknown[]) {
  return {
    messages: {
      parse: async () => {
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  } as unknown as Anthropic;
}
const draftResponse = (out: Record<string, unknown>) => ({
  stop_reason: "end_turn",
  usage,
  parsed_output: {
    plan: { people: [], sentences: [] },
    subject: "Referred by Jeff Moreno",
    body: DRAFT,
    connectionUsed: null,
    gaps: [],
    notesForStudent: [],
    ...out,
  },
});
const reviewResponse = (body: string, problems: unknown[] = []) => ({
  stop_reason: "end_turn",
  usage,
  parsed_output: { problems, subject: "Referred by Jeff Moreno", body },
});
const DRAFT_CONFIG = { model: "claude-sonnet-5", effort: "low", thinking: "disabled", maxTokens: 4096 } as const;
const CONFIGS = { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG };
const NO_REVIEW = { draft: DRAFT_CONFIG, review: null };

const show = (label: string, v: unknown) => console.log(`  ${label}: ${JSON.stringify(v)}`);

async function main() {
  // 0. The gate works on the one string it is given.
  console.log("\n[0] control: a slur in the BODY is blocked");
  try {
    await runDraftPipeline(fakeClient([draftResponse({ body: DRAFT.replace("a call", `a ${SLUR} call`) })]), INPUT, NO_REVIEW);
    console.log("  RESULT: NOT BLOCKED - the gate is broken outright");
  } catch (err) {
    console.log(`  RESULT: blocked -> ${(err as Error).message}`);
  }
  console.log("[0b] control: a slur in the SUBJECT is blocked");
  try {
    await runDraftPipeline(fakeClient([draftResponse({ subject: `${SLUR} intro` })]), INPUT, NO_REVIEW);
    console.log("  RESULT: NOT BLOCKED");
  } catch (err) {
    console.log(`  RESULT: blocked -> ${(err as Error).message}`);
  }

  // 1. notesForStudent, written by the DRAFTING model.
  console.log("\n[1] a slur in the drafting model's notesForStudent");
  const r1 = await runDraftPipeline(
    fakeClient([draftResponse({ notesForStudent: [`I left out the ${SLUR} remark you typed about his colleague.`] })]),
    INPUT,
    NO_REVIEW,
  );
  show("notesForStudent reaching the student", r1.draft.notesForStudent);
  console.log(`  gate would have flagged this string: ${findBlockedLanguage(r1.draft.notesForStudent.join("\n"))}`);

  // 2. gaps.question, written by the drafting model.
  console.log("\n[2] a slur in gaps[].question (stored on the row; placeholder also carries it)");
  const r2 = await runDraftPipeline(
    fakeClient([draftResponse({ gaps: [{ placeholder: "[their group]", question: `what the ${SLUR} group does` }] })]),
    INPUT,
    NO_REVIEW,
  );
  show("gaps", r2.draft.gaps);

  // 3. connectionUsed.
  console.log("\n[3] a slur in connectionUsed");
  const r3 = await runDraftPipeline(fakeClient([draftResponse({ connectionUsed: `both ${SLUR} clubs` })]), INPUT, NO_REVIEW);
  show("connectionUsed", r3.draft.connectionUsed);

  // 4. plan (people roles and sentences).
  console.log("\n[4] a slur in plan.people / plan.sentences");
  const r4 = await runDraftPipeline(
    fakeClient([draftResponse({ plan: { people: [{ name: "Rachel Stein", role: `the ${SLUR} VP` }], sentences: [`open on the ${SLUR} referral`] } })]),
    INPUT,
    NO_REVIEW,
  );
  show("plan", r4.plan);

  // 5. The REVIEW's problems: p.fix on an applied edit.
  console.log("\n[5] a slur in a review problem's `fix`, edit APPLIED");
  const r5 = await runDraftPipeline(
    fakeClient([
      draftResponse({}),
      reviewResponse(DRAFT, [
        { kind: "hateful", quote: "Jeff Moreno suggested I write to you.", fix: `Took out the word "${SLUR}" you typed about him.`, needsStudent: true },
      ]),
    ]),
    INPUT,
    CONFIGS,
  );
  show("review applied", r5.review?.applied);
  show("notesForStudent", r5.draft.notesForStudent);

  // 6. The REVIEW's problems: p.quote on a REJECTED edit, where the quote is
  //    text the reviewer claims is in the draft but is not.
  console.log("\n[6] a slur in a review problem's `quote`, edit REJECTED (quote is echoed verbatim)");
  const r6 = await runDraftPipeline(
    fakeClient([
      draftResponse({}),
      // Rejected: adds an unknown capitalised word and no resume PDF to excuse it.
      reviewResponse(DRAFT.replace("our investment club", "the Pinecrest club"), [
        { kind: "private", quote: `his ${PROF}ty divorce and the ${SLUR} comment`, fix: "Took that out.", needsStudent: true },
      ]),
      reviewResponse(DRAFT.replace("our investment club", "the Pinecrest club"), [
        { kind: "private", quote: `his ${PROF}ty divorce and the ${SLUR} comment`, fix: "Took that out.", needsStudent: true },
      ]),
    ]),
    INPUT,
    CONFIGS,
  );
  show("review applied", r6.review?.applied);
  show("rejected because", r6.review?.rejected);
  show("notesForStudent", r6.draft.notesForStudent);

  console.log("\n[7] the email body in every case above (unchanged, so the gate passes):");
  console.log(`  body contains a slur: ${Boolean(findBlockedLanguage(r1.draft.body))}`);
}

void main();
