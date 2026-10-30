// The pipeline's control flow, its output gate and the request path's limits.
//
//   npx tsx scripts/draft-pipeline-flow-test.ts
//
// Covers the twelve defects in docs/concepts/audit/FIX-PIPELINE.md. Lives in
// its own file rather than in draft-review-test.ts for the same reason
// draft-guard-note-test.ts does: the review's own tests are being edited in
// the same session, and these are the pipeline half.
//
// No API call and no database: the Anthropic client is a stub returning canned
// replies, and the request-path tests exercise the pure helpers the action is
// built from. The two fixes that can only be proved against a database (the
// resume-read gate and where it sits in the order of checks) are asserted
// structurally and labelled as such.
//
// The blocked-language tests use PROFANITY, not a slur. It is the same word
// list, the same `findBlockedLanguage` call and the same code path - there is
// no reason for this repository to carry a slur to prove it.

import { readFileSync } from "node:fs";
import Module from "node:module";
import type Anthropic from "@anthropic-ai/sdk";
import {
  retryFitsBudget,
  reviewTimeoutMs,
  runDraftPipeline,
  type PipelineConfigs,
} from "../src/lib/draft-pipeline";
import { buildDraftPrompt, type DraftPromptInput } from "../src/lib/draft-prompt";
import { EMAIL_TYPES } from "../src/lib/draft-templates";
import type { ModelConfig } from "../src/lib/model-registry";

/**
 * A STUB review config, not the production one.
 *
 * Every other caller reads `draftReview` from lib/model-registry, which is the
 * single source. This file cannot: it also reads client-side modules, so it has
 * to run WITHOUT --conditions=react-server, and the registry is server-only.
 * The two cannot both be satisfied here.
 *
 * That is fine for what this file tests - the pipeline's control flow needs a
 * review config, not the review config. scripts/draft-review-test.ts does run
 * under react-server and does assert against the real one.
 */
const DRAFT_REVIEW_CONFIG: ModelConfig = { model: "claude-sonnet-5", effort: "low", thinking: "disabled", maxTokens: 6000 };

// app/(app)/drafts/draft-request is a server module, and importing it outside
// Next means two modules that cannot load in plain Node: the "server-only"
// marker, which exists to throw, and `next/cache`, which reaches Next's client
// navigation code and a React runtime there isn't one of. Both are stubbed for
// the length of that import. Nothing under test is in either of them: the file
// calls `revalidatePath` once, after the row is written, which is the same
// reason scripts/test/pipeline-integration-offline.test.ts leaves it out.
type Req = (id: string) => unknown;
const realRequire = Module.prototype.require as Req;
const STUBS: Record<string, unknown> = { "server-only": {}, "next/cache": { revalidatePath: () => {} } };
(Module.prototype as { require: Req }).require = function (this: unknown, id: string) {
  return id in STUBS ? STUBS[id] : realRequire.call(this, id);
} as Req;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const draftRequest = realRequire.call(module, "../src/app/(app)/drafts/draft-request") as typeof import("../src/app/(app)/drafts/draft-request");
(Module.prototype as { require: Req }).require = realRequire;
const { capAnswer, recipientIdError, FIELD_MAX, LONG_FIELD_MAX } = draftRequest;

let passed = 0;
const failures: string[] = [];
function t(name: string, ok: boolean, got?: unknown) {
  if (ok) passed++;
  else failures.push(`${name}${got === undefined ? "" : ` -> ${JSON.stringify(got)}`}`);
}

const BLOCKED = "bullshit";

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
  brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }] },
};

const SIGNATURE = "Best,\nAlex Rivera\nUniversity of Pennsylvania ’29";
const DRAFT = `Hi Rachel,

Jeff Moreno suggested I write to you.

I'm a sophomore at the University of Pennsylvania and I help run our investment club. Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;
// An edit the guard refuses: a firm name that is in nothing the student typed.
const GUARD_FAILS = DRAFT.replace("write to you.", "write to you about Goldman.");

type StubCall = { options?: { timeout?: number; maxRetries?: number } };
function fakeClient(responses: unknown[]) {
  const calls: StubCall[] = [];
  const client = {
    messages: {
      parse: async (_req: unknown, options?: StubCall["options"]) => {
        calls.push({ options });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const usage = { input_tokens: 1000, output_tokens: 200 };
const REVIEW_USAGE = { input_tokens: 700, output_tokens: 90 };
type DraftParts = {
  body?: string;
  notes?: string[];
  gaps?: { placeholder: string; question: string }[];
  connectionUsed?: string | null;
  sentences?: string[];
  stop?: string;
};
const draftResponse = (p: DraftParts = {}) => ({
  stop_reason: p.stop ?? "end_turn",
  usage,
  parsed_output: {
    plan: { people: [], sentences: p.sentences ?? [] },
    subject: "Referred by Jeff Moreno",
    body: p.body ?? DRAFT,
    connectionUsed: p.connectionUsed ?? null,
    gaps: p.gaps ?? [],
    notesForStudent: p.notes ?? [],
  },
});
const reviewResponse = (body: string, problems: unknown[] = [], stop = "end_turn") => ({
  stop_reason: stop,
  usage: REVIEW_USAGE,
  parsed_output: { problems, subject: "Referred by Jeff Moreno", body },
});
const PROBLEMS = [
  { kind: "mismatch", quote: "sales and trading", fix: "Your interest is sales and trading, but this is a credit team.", needsStudent: true },
  { kind: "flow", quote: "it was great", fix: "smoother", needsStudent: false },
];
const DRAFT_CONFIG = { model: "claude-sonnet-5", effort: "low", thinking: "disabled", maxTokens: 4096 } as const;
const run = (responses: unknown[], configs: Partial<PipelineConfigs> = {}, input = INPUT) =>
  runDraftPipeline(fakeClient(responses).client, input, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG, ...configs });
const NOT_CHECKED = "We couldn't double-check this email";

async function main() {
  // ============================================================ 1. the output gate
  // OUTPUT-3 MEDIUM: the gate checked `${subject}\n${body}` and nothing else,
  // so three model-written strings reached the composer verbatim. Reachable
  // without the model misbehaving: the prompts tell it to narrate what it
  // removed into a note, so it keeps the word out of the email and writes it
  // into a note - and the app says it back to its own user in its own voice.

  const a1 = await run([draftResponse({ notes: [`I left out the ${BLOCKED} remark you typed about his colleague.`, "Attach your transcript."] })], { review: null });
  t("1a drafter's note with blocked language is dropped", !a1.draft.notesForStudent.some((n) => n.includes(BLOCKED)), a1.draft.notesForStudent);
  t("1a the clean note beside it survives", a1.draft.notesForStudent.some((n) => n.includes("transcript")), a1.draft.notesForStudent);
  t("1a the draft is still returned, not failed", a1.draft.body.includes("Jeff Moreno suggested I write to you."), a1.draft.body);

  // Two notes differing only in case are one note, not two (OUTPUT-2 6).
  const a1b = await run(
    [draftResponse({ notes: ["Attach your unofficial transcript before sending.", "attach your unofficial transcript before sending."] })],
    { review: null },
  );
  t("1a2 notes differing only in case are deduped", a1b.draft.notesForStudent.length === 1, a1b.draft.notesForStudent);
  t("1a2 and the one kept is the first spelling", a1b.draft.notesForStudent[0] === "Attach your unofficial transcript before sending.", a1b.draft.notesForStudent);

  // The reviewer's `fix`, rendered as a note when the edit was applied.
  const a2 = await run([
    draftResponse(),
    reviewResponse(DRAFT, [{ kind: "hateful", quote: "x", fix: `Took out the word "${BLOCKED}" you typed about him.`, needsStudent: true }]),
  ]);
  t("1b review `fix` with blocked language never reaches the notes", !a2.draft.notesForStudent.some((n) => n.includes(BLOCKED)), a2.draft.notesForStudent);
  t("1b and the problem is not left in the archived review", !JSON.stringify(a2.review).includes(BLOCKED), a2.review);

  // The rejected-edit note. It no longer echoes the reviewer's `quote` at all
  // (FIX-PIPELINE 1); the pipeline's gate on `fix` is what this case covers.
  const a3 = await run([
    draftResponse(),
    reviewResponse(GUARD_FAILS, [{ kind: "private", quote: `his ${BLOCKED} divorce`, fix: "Took that out.", needsStudent: true }]),
    reviewResponse(GUARD_FAILS, [{ kind: "private", quote: `his ${BLOCKED} divorce`, fix: "Took that out.", needsStudent: true }]),
  ]);
  t("1c rejected-edit `quote` echo with blocked language is dropped", !a3.draft.notesForStudent.some((n) => n.includes(BLOCKED)), a3.draft.notesForStudent);

  const a4 = await run(
    [draftResponse({ gaps: [{ placeholder: "[the group]", question: `Which ${BLOCKED} group was it?` }, { placeholder: "[the date]", question: "Which date?" }] , body: DRAFT.replace("a call?", "a call about [the group] on [the date]?") })],
    { review: null },
  );
  t("1e a gap whose question carries blocked language is dropped", a4.draft.gaps.length === 1 && a4.draft.gaps[0].placeholder === "[the date]", a4.draft.gaps);
  t("1e the placeholder stays in the body, so the send gate still sees it", a4.draft.body.includes("[the group]"));

  const a5 = await run([draftResponse({ connectionUsed: `your ${BLOCKED} club` })], { review: null });
  t("1f connectionUsed with blocked language becomes null", a5.draft.connectionUsed === null, a5.draft.connectionUsed);

  const a6 = await run([draftResponse({ sentences: [`open on the ${BLOCKED} referral`, "ask for fifteen minutes"] })], { review: null });
  t("1g a plan sentence with blocked language is dropped", a6.plan?.sentences.length === 1, a6.plan);

  let threw = "";
  await run([draftResponse({ body: DRAFT.replace("Jeff Moreno suggested", `Jeff ${BLOCKED} Moreno suggested`) })], { review: null }).catch((e: Error) => {
    threw = e.message;
  });
  t("1h control: blocked language in the BODY still fails the draft", /language we don't allow/.test(threw), threw);

  const a7 = await run([draftResponse({ notes: ["Double-check \"October 5\" - that date wasn't in what you entered."] })], { review: null });
  t("1i a clean note is not touched by the gate", a7.draft.notesForStudent.includes("Double-check \"October 5\" - that date wasn't in what you entered."), a7.draft.notesForStudent);

  // ============================================================ 2. resumeOnFile
  // INPUT-2 F1: `resumeOnFile: Boolean(resume)` was false for every type that
  // does not read the resume's bytes, so the prompt told the model the student
  // had no resume in the same breath as quoting their resume summary.
  const NO_RESUME_LINE = "The student has no resume on file";
  const withSummary = (resumeOnFile: boolean, type: string) =>
    buildDraftPrompt({ ...INPUT, type: type as DraftPromptInput["type"], boxIds: undefined, studentResumeSummary: "Treasurer of the investment club." , resumeOnFile }).userText;
  const typesReadingBytes = new Set(EMAIL_TYPES.filter((x) => x.attachResume || x.attachResumeIfMentioned).map((x) => x.id));
  const contradictedBefore = EMAIL_TYPES.filter((x) => !typesReadingBytes.has(x.id) && withSummary(false, x.id).includes(NO_RESUME_LINE));
  const contradictedAfter = EMAIL_TYPES.filter((x) => withSummary(true, x.id).includes(NO_RESUME_LINE));
  t("2 the old wiring contradicted itself on the types that don't read the bytes", contradictedBefore.length >= 25, contradictedBefore.length);
  t("2 computing it from existence contradicts nothing, on any type", contradictedAfter.length === 0, contradictedAfter.map((x) => x.id));
  // Structural, because the wiring itself needs a database to exercise.
  const requestSource = readFileSync("src/app/(app)/drafts/draft-request.ts", "utf8");
  t("2 resumeOnFile is no longer read off the attach flags", !/resumeOnFile: Boolean\(resume\)/.test(requestSource));
  t("2 the resume is looked up unconditionally", /const onFile = await findStudentResume\(user\.id\)/.test(requestSource));

  // ============================================================ 3. APP_HANDLES
  // OUTPUT-2 #3, MEASURED 25 in / 14 out: it kept six ordinary phrasings of
  // the notes it exists to delete, and deleted two it must keep.
  const STRIP = [
    "Attach your resume to the email before you send it.",
    "Attach the resume to this email.",
    "Your resume will be attached automatically.",
    "Your Gmail signature will be added after the sign-off.",
    "Gmail adds your signature, so the email ends on Best,.",
    "I left the signature block to your email client.",
    "I didn't include your phone number in the signature.",
    "I did not include your email address.",
    "Remember to attach a copy of your resume.",
    "Don't forget your resume.",
    "Please attach your résumé.",
    "Your email signature will be added automatically, so the draft ends on Best,.",
    "I didn't add your phone number.",
    "Add your resume as an attachment.",
  ];
  const KEEP = [
    'The review added "Pinecrest", which isn\'t in what you typed - it may have come from your resume. Check it reads right before you send.',
    "Your resume lists the internship as 2024; this email calls it recent. Check which is right.",
    "The resume on file is named for someone else. Check you uploaded yours.",
    "Attach your unofficial transcript before sending.",
    'Double-check "October 5" - that date wasn\'t in what you entered.',
    "This email mentions \"laid off\". Private or sensitive details usually don't belong in a networking email.",
    "There's only one name on file for the person you're emailing, so the email opens \"Hi Rachel,\". Make sure that's their first name.",
    "Her signature block says she has moved to the London office, so check the firm name.",
    "Attach your resume to the firm's application portal, not to this email - they asked for it there.",
  ];
  const filtered = await run([draftResponse({ notes: [...STRIP, ...KEEP] })], { review: null });
  const out = new Set(filtered.draft.notesForStudent);
  const leaked = STRIP.filter((n) => out.has(n));
  const lost = KEEP.filter((n) => !out.has(n));
  t("3 every app-handled note is stripped, however it is phrased", leaked.length === 0, leaked);
  t("3 no note about the recipient, the resume's contents or another destination is lost", lost.length === 0, lost);

  // ============================================================ 4. the retry's dead band
  // LOGIC-3 F2. The gates measured different clocks: skip on drafting alone
  // against 80 s, retry on drafting + lint + a whole review against 60 s.
  const BUDGET = 120_000;
  const band = [50_000, 60_000, 70_000, 79_000].map((draftMs) => ({
    draftMs,
    oldRule: draftMs + 10_000 < 60_000,
    newRule: retryFitsBudget({ elapsedMs: draftMs + 10_000, reviewMs: 10_000, requestBudgetMs: BUDGET }),
  }));
  t("4 the old rule refused the retry across the whole 50-80s band", band.every((b) => !b.oldRule), band);
  t("4 the budget rule allows it across the whole band", band.every((b) => b.newRule), band);
  t(
    "4 and still refuses when the budget genuinely cannot hold another review",
    !retryFitsBudget({ elapsedMs: 100_000, reviewMs: 30_000, requestBudgetMs: BUDGET }),
  );
  t(
    "4 an explicit window still overrides it, which is what the harness drives",
    retryFitsBudget({ elapsedMs: 90_000, reviewMs: 10_000, requestBudgetMs: BUDGET, reviewRetryBeforeMs: 600_000 }) &&
      !retryFitsBudget({ elapsedMs: 1, reviewMs: null, requestBudgetMs: BUDGET, reviewRetryBeforeMs: 0 }),
  );
  t(
    "4 with no budget at all the old 60s default still applies",
    retryFitsBudget({ elapsedMs: 59_000, reviewMs: null }) && !retryFitsBudget({ elapsedMs: 61_000, reviewMs: null }),
  );

  // ============================================================ 5. a throwing retry
  // LOGIC-3 F3, MEASURED: retry fails the guard -> 2 problems and 1 warning
  // kept; retry THROWS -> 0 problems, no warning, `rejected` undefined.
  const e1 = await run([draftResponse(), reviewResponse(GUARD_FAILS, PROBLEMS), new Error("overloaded")]);
  t("5 a throwing retry keeps the first turn's problems", e1.review?.problems.length === 2, e1.review);
  t("5 a throwing retry keeps the first turn's rejection reason", typeof e1.review?.rejected === "string", e1.review);
  t("5 and the student still gets the warning the first turn found", e1.draft.notesForStudent.some((n) => n.includes("credit team")), e1.draft.notesForStudent);
  t("5 the draft is left as written", e1.review?.applied === false && !e1.draft.body.includes("Goldman"), e1.draft.body);

  // ============================================================ 6. the review's timeout
  // LOGIC-3 F4: `new Anthropic()` overrides neither default, so the review
  // inherited a ten-minute timeout and two silent retries.
  const timed = fakeClient([draftResponse(), reviewResponse(DRAFT)]);
  await runDraftPipeline(timed.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG, requestBudgetMs: BUDGET });
  const reviewCall = timed.calls[1];
  t("6 the review call carries a timeout", typeof reviewCall?.options?.timeout === "number", reviewCall?.options);
  t("6 the timeout fits inside the request's budget", (reviewCall?.options?.timeout ?? Infinity) <= BUDGET, reviewCall?.options);
  t("6 and the SDK's silent retries are off", reviewCall?.options?.maxRetries === 0, reviewCall?.options);
  t("6 the ceiling shrinks as the budget is spent", reviewTimeoutMs(60_000, BUDGET) === 55_000 && reviewTimeoutMs(118_000, BUDGET) === 5_000, [reviewTimeoutMs(60_000, BUDGET), reviewTimeoutMs(118_000, BUDGET)]);
  t("6 with no budget it is bounded anyway, not the SDK's ten minutes", reviewTimeoutMs(1_000) === 120_000, reviewTimeoutMs(1_000));

  // ============================================================ 7. attribution and the 400
  // LOGIC-3 F10(b) and F10(d).
  const f1 = await run([draftResponse(), reviewResponse(DRAFT)]);
  t("7 the draft's own usage is the draft call alone", f1.draftUsage.input_tokens === 1000 && f1.draftUsage.output_tokens === 200, f1.draftUsage);
  t("7 the review's usage is reported under the model that served it", f1.reviewUsage?.model === DRAFT_REVIEW_CONFIG.model && f1.reviewUsage?.input_tokens === 700, f1.reviewUsage);
  t("7 and `usage` is still both calls together", f1.usage.input_tokens === 1700 && f1.usage.output_tokens === 290, f1.usage);
  t("7 reviewUsage is null when the review never ran", (await run([draftResponse()], { review: null })).reviewUsage === null);

  const invalid = Object.assign(new Error("output_config.format is not valid"), { status: 400 });
  const f2 = await run([draftResponse(), invalid]);
  t("7 a 400 on our own payload is distinguishable from a capacity blip", f2.review?.reviewGap === "request_invalid", f2.review);
  const f3 = await run([draftResponse(), Object.assign(new Error("overloaded"), { status: 529 })]);
  t("7 a 529 is still classified as capacity", f3.review?.reviewGap === "capacity", f3.review);
  const f4 = await run([draftResponse(), new Error("400 invalid_request_error: output_config.format is not valid")]);
  t("7 a re-wrapped 400 with no status field is classified from its message", f4.review?.reviewGap === "request_invalid", f4.review);

  // ============================================================ 8. reviewGap
  // LOGIC-3 F17: `reviewRetryMs: null` meant both "the guard accepted" and
  // "the retry window had closed", which are opposite outcomes.
  const g1 = await run([draftResponse()], { reviewSkipAfterMs: -1 });
  t("8 skipped_for_time", g1.review?.reviewGap === "skipped_for_time", g1.review);
  const g2 = await run([draftResponse(), reviewResponse(GUARD_FAILS, PROBLEMS)], { reviewRetryBeforeMs: 0 });
  t("8 retry_skipped_for_time", g2.review?.reviewGap === "retry_skipped_for_time", g2.review);
  t("8 and its timings are no longer the same shape as a clean accept", g2.timings.reviewRetryMs === null && g2.review?.applied === false);
  t("8 capacity", f3.review?.reviewGap === "capacity");
  t("8 request_invalid", f2.review?.reviewGap === "request_invalid");
  const g3 = await run([draftResponse(), reviewResponse(DRAFT, [], "max_tokens")]);
  t("8 stopped", g3.review?.reviewGap === "stopped", g3.review);
  t("8 and nothing is set when the guard accepted the edit", f1.review?.reviewGap === undefined && f1.review?.applied === true, f1.review);

  // ============================================================ 9. telling the student
  // OUTPUT-3 LOW: four routes to an unreviewed draft, none of them visible.
  const unchecked = (r: Awaited<ReturnType<typeof run>>) => r.draft.notesForStudent.some((n) => n.includes(NOT_CHECKED));
  t("9 the student is told when the review was skipped for time", unchecked(g1), g1.draft.notesForStudent);
  t("9 ... when the call failed", unchecked(f3));
  t("9 ... when the reply stopped short", unchecked(g3));
  t("9 ... and when the guard threw the edit away", unchecked(g2));
  t("9 but not when the review ran and its edit was kept", !unchecked(f1), f1.draft.notesForStudent);
  t("9 and not when the review is off, which is not the same thing", !unchecked(a1));

  // ============================================================ 10. field caps
  // INPUT-3 F3: `field()` trimmed and nothing else, so 200 KB in two fields
  // produced a 201,221-byte user message against a quota that counts drafts.
  t("10 an answer is capped", capAnswer("x".repeat(200_000)).length === FIELD_MAX, capAnswer("x".repeat(200_000)).length);
  t("10 purpose and extraContext get the longer cap", capAnswer("x".repeat(200_000), LONG_FIELD_MAX).length === LONG_FIELD_MAX);
  t("10 the caps are no larger than the one a saved body already has", LONG_FIELD_MAX <= 20_000 && FIELD_MAX <= LONG_FIELD_MAX);
  t("10 an ordinary answer is untouched, and still trimmed", capAnswer("  Same lacrosse team at Duke  ") === "Same lacrosse team at Duke");
  t("10 an empty answer is still empty", capAnswer(null) === "" && capAnswer("   ") === "");

  // ============================================================ 11. the unmetered read
  // INPUT-2 F5. Structural: the gate and its position both need a database to
  // exercise, but both are checkable here, and a regression would move them.
  const uploadAt = requestSource.indexOf("await replaceStudentResume");
  // `monthlyQuotaError(user, "resumeReviews")` until 12 October 2026, when the
  // check-then-use pair became one advisory-locked reservation. Same gate, same
  // position, no longer raceable - so this asserts the reservation AND that a
  // refused one returns before the upload, which the string match never did.
  const gateAt = requestSource.indexOf('reserveMonthlyUse(user, "resumeReviews")');
  const refusalAt = requestSource.indexOf("if (!resumeReservation.ok)");
  const followUpGateAt = requestSource.indexOf('"Add the subject line of the email this replies to."');
  t("11 the resume read passes the resume-review allowance", gateAt > 0 && gateAt < uploadAt, { gateAt, uploadAt });
  t("11 and a refused allowance returns before the bytes are read", refusalAt > gateAt && refusalAt < uploadAt, { gateAt, refusalAt, uploadAt });
  t("11 and is not spent on a request that is about to be refused", followUpGateAt > 0 && followUpGateAt < uploadAt, { followUpGateAt, uploadAt });

  // ============================================================ 12. the recipient id
  // INPUT-2 F7 / INPUT-3 F7: a malformed id reached a `uuid` column.
  t("12 a malformed contact id is a message, not a 22P02", typeof recipientIdError("contact-notauuid") === "string");
  t("12 a malformed directory id too", typeof recipientIdError("directory-x") === "string");
  t("12 a real id passes", recipientIdError("contact-3f2504e0-4f89-11d3-9a0c-0305e82c3301") === null);
  t("12 \"outside\" is not an id and is left alone", recipientIdError("outside") === null);
  t("12 an empty id does not slip through", typeof recipientIdError("contact-") === "string");

  console.log(failures.length === 0 ? `${passed}/${passed} passed` : `${passed} passed, ${failures.length} FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
