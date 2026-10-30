// LOGIC-3 probe: the retry is not isolated. A capacity error on the SECOND
// review call discards the first turn's problems and its rejection reason.
// No API, no DB - a fake client returning scripted replies.
import type Anthropic from "@anthropic-ai/sdk";
import { runDraftPipeline } from "@/lib/draft-pipeline";
import type { DraftPromptInput } from "@/lib/draft-prompt";
import { getSubCallConfig } from "@/lib/model-registry";

/** The review pass's config, from its single source: lib/model-registry's `draftReview`. */
const DRAFT_REVIEW_CONFIG = getSubCallConfig("draftReview", "free");

const INPUT: DraftPromptInput = {
  studentName: "Alex Rivera", studentSchool: "University of Pennsylvania", studentGradYear: 2029,
  studentPhone: "15550101234", contactName: "Rachel Stein", contactFirm: "Anchorage Capital",
  contactRole: "Vice President", type: "cold_referral", alsoTypes: ["cold_after_meeting"],
  boxIds: ["first.referred", "first.met"], now: new Date("2026-09-20T12:00:00"),
  brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }, { prompt: "Where and when they met", value: "the WITG x WUEC panel" }] },
};
const SIG = "Best,\nAlex Rivera\nUniversity of Pennsylvania ’29\n(555) 010-1234";
const DRAFT = `Hi Rachel,\n\nJeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.\n\nI'm a sophomore at the University of Pennsylvania. Would you have 15 minutes for a call? My resume is attached.\n\nThank you!\n\n${SIG}`;
const GOLDMAN = DRAFT.replace("panel.", "panel at Goldman.");
const PROBLEMS = [
  { kind: "mismatch", quote: "sales and trading", fix: "Your interest is sales and trading, but this is a credit team.", needsStudent: true },
  { kind: "flow", quote: "it was great", fix: "smoother", needsStudent: false },
];
function fakeClient(responses: unknown[]) {
  const calls: { model: string }[] = [];
  const client = { messages: { parse: async (req: { model: string }) => {
    calls.push(req);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  } } } as unknown as Anthropic;
  return { client, calls };
}
const draftResponse = { stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 },
  parsed_output: { plan: { people: [], sentences: [] }, subject: "Referred by Jeff Moreno", body: DRAFT, connectionUsed: null, gaps: [], notesForStudent: [] } };
const reviewResponse = (body: string, problems: unknown[]) => ({ stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 }, parsed_output: { problems, subject: "Referred by Jeff Moreno", body } });

async function main() {
  // A. retry runs and also fails the guard: the first turn's problems survive.
  const a = fakeClient([draftResponse, reviewResponse(GOLDMAN, PROBLEMS), reviewResponse(GOLDMAN, PROBLEMS)]);
  const ra = await runDraftPipeline(a.client, INPUT, { draft: { model: "claude-sonnet-5", maxTokens: 4096 } as never, review: DRAFT_REVIEW_CONFIG });
  console.log(`\nA retry fails the guard   : calls=${a.calls.length} applied=${ra.review?.applied} rejected=${JSON.stringify(ra.review?.rejected)} problems=${ra.review?.problems.length} notes=${JSON.stringify(ra.draft.notesForStudent)}`);
  console.log(`   usage=${JSON.stringify(ra.usage)}  timings=${JSON.stringify(ra.timings)}`);

  // B. retry THROWS a capacity error: everything the first turn found is lost.
  const b = fakeClient([draftResponse, reviewResponse(GOLDMAN, PROBLEMS), new Error("overloaded")]);
  const rb = await runDraftPipeline(b.client, INPUT, { draft: { model: "claude-sonnet-5", maxTokens: 4096 } as never, review: DRAFT_REVIEW_CONFIG });
  console.log(`\nB retry throws            : calls=${b.calls.length} applied=${rb.review?.applied} rejected=${JSON.stringify(rb.review?.rejected)} problems=${rb.review?.problems.length} error=${JSON.stringify(rb.review?.error)} notes=${JSON.stringify(rb.draft.notesForStudent)}`);
  console.log(`   usage=${JSON.stringify(rb.usage)}  (the first review's tokens are still billed)`);
  console.log(`   timings=${JSON.stringify(rb.timings)}  (reviewMs kept, reviewRetryMs null - same shape as "the guard accepted")`);

  // C. first review throws: draft ships unreviewed, no fallback ladder.
  const c = fakeClient([draftResponse, new Error("overloaded")]);
  const rc = await runDraftPipeline(c.client, INPUT, { draft: { model: "claude-sonnet-5", maxTokens: 4096 } as never, review: DRAFT_REVIEW_CONFIG });
  console.log(`\nC first review throws     : calls=${c.calls.length} error=${JSON.stringify(rc.review?.error)} reviewMs=${rc.timings.reviewMs}`);

  // D. a PERMANENT error (a 400 on our own payload) is swallowed identically.
  const d = fakeClient([draftResponse, new Error("400 invalid_request_error: output_config.format is not valid")]);
  const rd = await runDraftPipeline(d.client, INPUT, { draft: { model: "claude-sonnet-5", maxTokens: 4096 } as never, review: DRAFT_REVIEW_CONFIG });
  console.log(`\nD review 400 (our bug)    : error=${JSON.stringify(rd.review?.error)}  -> draft still ships, same code path as a capacity blip`);

  // E. the retry window at the production default, with a clock already past it.
  const e = fakeClient([draftResponse, reviewResponse(GOLDMAN, PROBLEMS)]);
  const re = await runDraftPipeline(e.client, INPUT, { draft: { model: "claude-sonnet-5", maxTokens: 4096 } as never, review: DRAFT_REVIEW_CONFIG, reviewRetryBeforeMs: 0 });
  console.log(`\nE retry window exhausted  : calls=${e.calls.length} applied=${re.review?.applied} rejected=${JSON.stringify(re.review?.rejected)} reviewRetryMs=${re.timings.reviewRetryMs}`);
  console.log(`   the log line's split omits "retry" entirely, and PipelineTimings.reviewRetryMs is null - same value as "the guard accepted first time"`);
}
main();
