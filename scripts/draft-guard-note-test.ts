// The guard's one admitted proper noun must reach the student.
//
//   npx tsx --conditions=react-server scripts/draft-guard-note-test.ts
//
// `guardRevision` (lib/draft-review) accepts ONE capitalised word it cannot
// check - and only when the resume is a PDF it was never shown - instead of
// throwing away a review edit that put a real fact back. The word is admitted
// on the strict condition that the student is told which word it was, so the
// note is the other half of that trade: without it an unverified proper noun
// goes into a student's email silently, which is worse than the rejected edit
// the allowance exists to save.
//
// This lives in its own file rather than in draft-review-test.ts because the
// guard's own tests were being edited in the same session; it is the pipeline
// half (lib/draft-pipeline) that is under test here, not the guard.
//
// No API call: the Anthropic client is a stub that returns canned replies.

import type Anthropic from "@anthropic-ai/sdk";
import { runDraftPipeline } from "../src/lib/draft-pipeline";
import { guardRevision } from "../src/lib/draft-review";
import type { DraftPromptInput } from "../src/lib/draft-prompt";
import { getSubCallConfig } from "../src/lib/model-registry";

/** The review pass's config, from its single source: lib/model-registry's `draftReview`. */
const DRAFT_REVIEW_CONFIG = getSubCallConfig("draftReview", "free");

let passed = 0;
const failures: string[] = [];
function t(name: string, ok: boolean, got?: unknown) {
  if (ok) passed++;
  else failures.push(`${name}${got === undefined ? "" : ` -> ${JSON.stringify(got)}`}`);
}

// A resume PDF and NO resume summary: the only situation in which the guard
// admits an unknown word, because it is the only one where it cannot check.
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
  hasResumePdf: true,
  resumePdf: Buffer.from("%PDF-1.4"),
  brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }] },
};

const SIGNATURE = "Best,\nAlex Rivera\nUniversity of Pennsylvania ’29";
const DRAFT = `Hi Rachel,

Jeff Moreno suggested I write to you.

I'm a sophomore at the University of Pennsylvania and I help run our investment club. Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;

// The reviewer working a real resume fact back in - the club's actual name,
// which it read in the PDF and the guard has no way to verify.
const RESTORED = DRAFT.replace("our investment club", "the Pinecrest investment club");

function fakeClient(responses: unknown[]) {
  const calls: unknown[] = [];
  const client = {
    messages: {
      parse: async (req: unknown) => {
        calls.push(req);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const usage = { input_tokens: 1000, output_tokens: 200 };
const draftResponse = (body: string) => ({
  stop_reason: "end_turn",
  usage,
  parsed_output: { plan: { people: [], sentences: [] }, subject: "Referred by Jeff Moreno", body, connectionUsed: null, gaps: [], notesForStudent: [] },
});
const reviewResponse = (body: string, problems: unknown[] = []) => ({
  stop_reason: "end_turn",
  usage,
  parsed_output: { problems, subject: "Referred by Jeff Moreno", body },
});
const DRAFT_CONFIG = { model: "claude-sonnet-5", effort: "low", thinking: "disabled", maxTokens: 4096 } as const;

async function main() {
  // The premise: the guard does admit this edit, and does name the word.
  const guard = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: RESTORED }, INPUT);
  t("guard accepts the restored resume fact", guard.ok, guard);
  const note = guard.ok ? guard.note : undefined;
  t("guard returns a note naming the admitted word", Boolean(note && note.includes("Pinecrest")), note);

  // The fix: that note reaches the student's notes on the finished draft.
  const a = fakeClient([draftResponse(DRAFT), reviewResponse(RESTORED)]);
  const result = await runDraftPipeline(a.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("the review edit was applied", result.review?.applied === true, result.review);
  t("the admitted word is in the email that goes out", result.draft.body.includes("Pinecrest"), result.draft.body);
  t(
    "the student is told which word the review added",
    result.draft.notesForStudent.some((n) => n.includes("Pinecrest")),
    result.draft.notesForStudent,
  );
  // The notes are filtered on the way out (APP_HANDLES in lib/draft-pipeline
  // drops notes telling the student to do what the app already does, and the
  // note mentions a resume). Checked here rather than assumed, because a note
  // that is silently stripped is the same bug as never adding it.
  t(
    "the note survives the notes filter and is not stripped as resume boilerplate",
    result.draft.notesForStudent.some((n) => /Pinecrest.*isn't in what you typed/.test(n)),
    result.draft.notesForStudent,
  );
  t("no duplicate copies of the note", result.draft.notesForStudent.filter((n) => n.includes("Pinecrest")).length === 1, result.draft.notesForStudent);

  // And the note is not emitted when there is nothing to admit: a plain
  // rewording must not start warning students about words nobody added.
  const reworded = DRAFT.replace("Would you have 15 minutes", "Could you spare 15 minutes");
  const b = fakeClient([draftResponse(DRAFT), reviewResponse(reworded)]);
  const clean = await runDraftPipeline(b.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("a plain rewording produces no added-word note", !clean.draft.notesForStudent.some((n) => /isn't in what you typed/.test(n)), clean.draft.notesForStudent);

  // A rejected edit must not carry a note either: the word never reached the
  // email, so there is nothing for the student to check.
  const twoNames = DRAFT.replace("our investment club", "the Pinecrest investment club at Goldman");
  const c = fakeClient([draftResponse(DRAFT), reviewResponse(twoNames), reviewResponse(twoNames)]);
  const rejected = await runDraftPipeline(c.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("two unknown words are still rejected", rejected.review?.applied === false, rejected.review);
  t("a rejected edit adds no added-word note", !rejected.draft.notesForStudent.some((n) => /isn't in what you typed/.test(n)), rejected.draft.notesForStudent);
  t("a rejected edit leaves the draft as written", !rejected.draft.body.includes("Pinecrest"));

  // With a resume summary the guard can check, so the allowance is off and the
  // edit is rejected outright - no note, no admitted word.
  const withSummary = { ...INPUT, studentResumeSummary: "Treasurer of the investment club; summer analyst at a boutique." };
  const d = fakeClient([draftResponse(DRAFT), reviewResponse(RESTORED), reviewResponse(RESTORED)]);
  const checked = await runDraftPipeline(d.client, withSummary, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("with a readable resume summary the word is rejected, not admitted", checked.review?.applied === false, checked.review);
  t("and no note is added in that case", !checked.draft.notesForStudent.some((n) => /isn't in what you typed/.test(n)), checked.draft.notesForStudent);

  console.log(failures.length === 0 ? `${passed}/${passed} passed` : `${passed} passed, ${failures.length} FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
