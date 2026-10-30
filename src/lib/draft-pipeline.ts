// Drafting an email end to end: the draft call, the automatic checks, the
// review call and its guard.
//
// Takes an Anthropic client and model configs rather than owning quota,
// routing or the database, so the app runs it inside runAiFeature
// (lib/generate-draft) and the live evaluation script runs it directly.
// Deliberately not "server-only" for that reason; nothing in it reads a secret.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// From lib/model-params, not lib/model-registry: this file must stay
// importable without --conditions=react-server (its flow test runs that way
// and reads client-side modules), and the registry is server-only. The
// parameter translations are not.
import { thinkingFor, type ModelConfig } from "./model-params";
import { buildDraftPrompt, finishDraft, type DraftPromptInput, type RawDraft, type SystemTiers } from "./draft-prompt";
import { parseWith } from "./fast-mode";
import { streamDraftCall, type PipelineEvent } from "./draft-stream";
import { draftChecks } from "./draft-lint";
import { findBlockedLanguage } from "./content-limits";
import { buildReviewPrompt, reviewOutputSchema, studentNotesFromReview, type ReviewProblem } from "./draft-review";
// The guard entry point. `applyReviewEdit` IS `guardRevision` on the fast path:
// it runs the whole-edit guard unchanged and returns its verdict. Only when
// that rejects, and only when the span flag is on (OFF by default), does it
// try to keep the spans of the edit that pass on their own.
import { applyReviewEdit } from "./draft-span-guard";


const draftOutputSchema = z.object({
  // First, so the model settles who's who and what goes where before writing a
  // sentence of the body. See PLAN_RULES in draft-prompt.
  plan: z.object({
    people: z.array(z.object({ name: z.string(), role: z.string() })),
    sentences: z.array(z.string()),
  }),
  subject: z.string(),
  body: z.string(),
  // What genuine overlap the email leaned on, so the student can sanity-check
  // it before sending. Null when there wasn't one - which is a valid outcome
  // and better than a manufactured connection.
  connectionUsed: z.string().nullable(),
  /**
   * What the draft still needs from the student.
   *
   * The model marks a gap instead of inventing the fact - the same rule as the
   * resume rewrite. `placeholder` is the exact bracketed text left in the body
   * so the UI can find it; `question` is what to ask.
   */
  gaps: z.array(z.object({ placeholder: z.string(), question: z.string() })),
  /** What the student should know before sending: what was softened or left out, files to attach. */
  notesForStudent: z.array(z.string()),
});

type FinishedDraft = RawDraft & { notesForStudent: string[] };

type ReviewOutcome = {
  problems: ReviewProblem[];
  /** Whether the edited email replaced the draft. */
  applied: boolean;
  /** Why the guard threw the edit away, when it did. */
  rejected?: string;
  /**
   * How much of the edit was kept, when the per-span guard was on and the edit
   * did not pass whole. Counts only, never text, and present only on the span
   * path - so the one log line below answers "is the span arm firing, and how
   * timid is it" without a second measurement run.
   */
  spans?: { accepted: number; total: number };
  /** The edit the guard threw away, kept so a rejection can be diagnosed (never shown to the student). */
  revisedBody?: string;
  /** The review didn't run or didn't finish (skipped for time, or the call failed), so the draft went out unreviewed. */
  error?: string;
  /**
   * Why the review produced nothing, as one of a fixed set rather than free
   * text, so "how many drafts shipped unreviewed last week, and why" is a
   * count rather than a regex over log lines (LOGIC-3 F17).
   *
   * `error` and `rejected` carry the detail but neither can be grouped:
   * `error` is sometimes the SDK's message and sometimes ours, and
   * `reviewRetryMs: null` means both "the guard accepted first time" and "the
   * retry window had closed", which are opposite outcomes.
   *
   *  - `skipped_for_time` - drafting used the review's share of the budget.
   *  - `retry_skipped_for_time` - the guard rejected the edit and there was no
   *    room for the second turn that usually rescues it.
   *  - `capacity` - the model was busy or unreachable; the next draft is fine.
   *  - `request_invalid` - the review request itself was refused. Not transient:
   *    every draft ships unreviewed until it is fixed.
   *  - `stopped` - the reply hit max_tokens, was a refusal, or did not parse.
   */
  reviewGap?: "skipped_for_time" | "retry_skipped_for_time" | "capacity" | "request_invalid" | "stopped";
};

/**
 * Where the wait went, phase by phase.
 *
 * The draft and the review are two model calls in series, so a total alone
 * can't say which of them a change moved - or which is worth changing. Logged
 * per draft and handed back so the live evaluation and the archive can keep
 * the same split.
 */
export type PipelineTimings = {
  /** The draft call: request sent to parsed reply. */
  draftMs: number;
  /** The automatic checks the reviewer is handed. Expected to be ~0, which is the point: gating the review call on them has to be worth more than it costs. */
  lintMs: number;
  /** The review call. Null when the review was off, skipped for time, or never got as far as a request. */
  reviewMs: number | null;
  /** The second review call, when the guard threw the first edit away. Null when there wasn't one. */
  reviewRetryMs: number | null;
  /** The whole pipeline, including the deterministic fixes and the final gates. */
  totalMs: number;
};

export type PipelineResult = {
  draft: FinishedDraft;
  /** The draft as the drafting model wrote it (finished), before any review edit. */
  preReview: { subject: string; body: string };
  review: ReviewOutcome | null;
  plan: RawDraft["plan"];
  /** Both calls together. */
  usage: { input_tokens: number; output_tokens: number };
  /**
   * The draft call alone.
   *
   * What the student's `ai_usage` row should record: that row's `model` column
   * names the model the DRAFT's fallback walk landed on, so its token columns
   * have to be the draft call's or the three columns describe different calls.
   * They did not - the review's Sonnet tokens were summed in under the draft
   * model's name, so any cost computed from the table was wrong by the
   * review's share, at the wrong rate (LOGIC-3 F10d).
   */
  draftUsage: { input_tokens: number; output_tokens: number };
  /**
   * The review calls, under the model that actually served them. Null when the
   * review was off or never reached a request.
   *
   * Handed back and logged rather than written to `ai_usage`: a durable row of
   * its own needs a `draftReview` value in the `ai_feature` enum and a change
   * to what counts against the daily allowance, neither of which belongs in
   * this file. See docs/concepts/audit/FIX-PIPELINE.md.
   */
  reviewUsage: { model: string; input_tokens: number; output_tokens: number } | null;
  timings: PipelineTimings;
};

export type PipelineConfigs = {
  draft: ModelConfig;
  review: ModelConfig | null;
  /**
   * The host's own time limit for the request this pipeline is running inside
   * (the route's `maxDuration`, in milliseconds). Every time gate below is cut
   * from it, so they all measure the same clock.
   *
   * This exists because they did not. The skip gate measured drafting alone
   * against 80 s while the retry gate measured drafting PLUS lint PLUS a whole
   * review against 60 s, so with a ~10 s review the retry was unreachable for
   * any draft between ~50 s and 80 s - a 30 s dead band, 37.5% of the range in
   * which the review is allowed to run at all, and the band where the retry
   * matters most (it rescues 15 of 19 first-turn guard rejections, MEASURED in
   * docs/concepts/MEASURE-1.md). LOGIC-3 F2.
   *
   * Absent, the gates fall back to their old fixed defaults.
   */
  requestBudgetMs?: number;
  /**
   * Skip the review when drafting alone took longer than this, so the whole
   * request still finishes inside the host's time limit. A draft that arrives
   * unreviewed beats one that never arrives.
   */
  reviewSkipAfterMs?: number;
  /**
   * When the guard throws a review edit away, the reviewer gets one more try,
   * told why - but only if there is room for it.
   *
   * With `requestBudgetMs` set, "room" means the budget still holds a second
   * review of the length the first one actually took, plus the wrap-up
   * reserve; the first call's own duration is the best estimate available and
   * it costs nothing to use. This field overrides that with a flat ceiling on
   * the request's age, which is what the evaluation harness drives
   * (`--retry-before`); with neither, the old 60 second default applies.
   *
   * Note for anyone changing these numbers: the production retry window has
   * never been exercised by a measurement. Every retry figure in the repo was
   * taken with `--retry-before=600000`, ten times the old default, and
   * `reviewRetrySkippedForTime` is recorded as DEGENERATE.
   */
  reviewRetryBeforeMs?: number;
  /**
   * Report what the pipeline is doing as it does it, so the composer can show
   * the email being written instead of a timer (lib/draft-stream,
   * app/api/drafts/generate).
   *
   * Passing this is the ONLY thing that changes how the draft call is made:
   * with it the call streams, without it the pipeline is byte-for-byte what it
   * was. Every gate below runs the same either way - the events carry
   * PROVISIONAL text to the browser, and what gets saved is still only ever
   * the fully reviewed, fully checked draft this function returns.
   */
  onEvent?: (event: PipelineEvent) => void;
};

export type { PipelineEvent } from "./draft-stream";

function requestConfig(cfg: ModelConfig) {
  return {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    // Through thinkingFor, not rebuilt here. This line used to read
    // `...(cfg.thinking ? { thinking: { type: cfg.thinking } } : {})`, which is
    // the fourth place found bypassing the registry's own helpers in two days -
    // after a hardcoded review config, a hardcoded model in
    // help-knowledge-learn, and helpMessageParams dropping effort and thinking
    // on the floor. The registry's ModelConfig comment asks for exactly this:
    // "Always build the request parameter through thinkingFor()".
    ...thinkingFor(cfg),
  };
}

// Both system prompts are the same across drafts of a type (the drafting
// prompt's examples) or across every draft (the reviewer's rules), and each is
// thousands of tokens, so they are marked for the prompt cache.
function cachedSystem(text: string) {
  return [{ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }];
}

/**
 * The drafting system prompt as three cached blocks instead of one.
 *
 * The text is byte-for-byte what it was as a single string - the only change is
 * where the cache may cut it (`scripts/draft-tiers-test.ts` holds that to all
 * 148 prompts a student can produce), which is why this needed no quality
 * measurement: a breakpoint cannot change what a model writes.
 *
 * One breakpoint at the end of the whole prompt, which is what this used to be,
 * caches nothing between two students: it spreads over 102 distinct keys
 * (MEASURED, draft-tiers-test), one per mix of boxes. A breakpoint per tier adds
 * two shorter prefixes that far more requests share - the rules every draft
 * begins with (1 key, ~1,634 est tok) and the format for this type (53 keys) -
 * and keeps the last one, so a repeat of the same mix still hits the whole
 * prompt exactly as before. Writes bill only the bytes past the highest cache
 * hit, so the extra breakpoints cost nothing on a cold request.
 *
 * Empty blocks are dropped: a text content block with no text is not a valid
 * API block, and `custom` is one prompt shape away from producing one.
 */
function cachedTiers(tiers: SystemTiers) {
  return [tiers.invariant, tiers.perType, tiers.perRequest]
    .filter((text) => text.length > 0)
    .map((text) => ({ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }));
}

function pdfBlock(pdf: Buffer) {
  return {
    type: "document" as const,
    source: { type: "base64" as const, media_type: "application/pdf" as const, data: pdf.toString("base64") },
  };
}

// Case- and space-insensitive, keeping the first spelling: the same note
// arrives from the drafter, the review and `draftChecks`, and two of them
// lowercasing it differently used to show the student the sentence twice
// (OUTPUT-2 6).
const dedupe = (notes: string[]) => {
  const seen = new Set<string>();
  return notes.filter((n) => {
    const key = n.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Notes telling the student to do what the app already does: the composer
// reminds them to attach their resume, an automatic email signature is the
// student's own setting, and the contact lines under the sign-off are written
// by finishDraft. Nearly every live draft carried one of these.
//
// Matched on what a note is ABOUT, not on how it is phrased. The old pattern
// was a list of phrasings and it failed both ways (MEASURED, OUTPUT-2 §6: 25
// notes in, 14 out): it kept six ordinary ways of saying "attach your resume"
// and "your signature is automatic", and it deleted two notes it should never
// have touched - one about the RECIPIENT's signature block, and the one case
// where the student really does have to attach the resume by hand, to a firm's
// portal rather than to this email.
//
// Three subjects, each written with the exception that proves it is the
// subject being matched and not the words.

/** A resume, however it is spelled. */
const RESUME = /\br[e\u00e9]sum[e\u00e9]/i;
/** Putting it on an email. */
const ATTACHING = /\battach(?:e[sd]|ing|ment)?\b|\bforget\b|\benclos/i;
/**
 * Somewhere that is not this email. The app attaches to the email it drafted
 * and nothing else, so "attach it to the firm's portal, not to this email" is
 * a real instruction and has to survive.
 */
const SOMEWHERE_ELSE = /\bportal\b|\bwebsite\b|\bapplication\b|\bjob board\b|\bform\b|\bseparately\b|\binstead\b|\bnot (?:to )?th(?:is|e) email\b/i;
/**
 * The STUDENT's own signature. A note about someone else's signature block is
 * about the recipient - "her signature block says she has moved to the London
 * office" is the firm name needing a check, not boilerplate.
 */
const OWN_SIGNATURE = /\b(?:your|my)\b[^.]{0,24}\bsignature\b|\bsignature\b[^.]{0,30}\b(?:your|my)\b/i;
/**
 * The contact lines the app puts under the sign-off, as an omission. Only as
 * an omission: a note comparing a phone number against what the student typed
 * is a real check and is kept.
 */
const CONTACT_OMITTED =
  /\b(?:did(?:n't| not)|have(?:n't| not)|was(?:n't| not)|is(?:n't| not))\b[^.]{0,30}\b(?:includ(?:e|ed)|add(?:ed)?|put)\b[^.]{0,24}\b(?:your|the)\b[^.]{0,24}\b(?:phone|email|number|address|linkedin|contact)\b/i;

/** Whether this note tells the student to do something the app has already done. */
function appHandles(note: string): boolean {
  if (RESUME.test(note) && ATTACHING.test(note) && !SOMEWHERE_ELSE.test(note)) return true;
  if (OWN_SIGNATURE.test(note)) return true;
  return CONTACT_OMITTED.test(note);
}

/**
 * Why the review produced nothing, from the error it threw.
 *
 * Classified here rather than with ai-runner's `isCapacityError` because this
 * module is deliberately not "server-only" (the CLI evaluation imports it) and
 * ai-runner is. The distinction is the whole point: a 5xx or a dropped
 * connection is the model being busy and the next draft will be fine, while a
 * 4xx is OUR payload being wrong, which degrades every draft to unreviewed
 * until someone fixes it (LOGIC-3 F10b).
 */
function classifyReviewError(err: unknown): "capacity" | "request_invalid" {
  const status =
    typeof err === "object" && err !== null && "status" in err ? (err as { status?: unknown }).status : undefined;
  if (typeof status === "number") return status >= 500 || status === 429 ? "capacity" : "request_invalid";
  // No `status`: the SDK's own errors carry one, so this is either a transport
  // failure or a plain Error. Read a leading status code out of the message
  // before falling back to "busy" - the stub-client tests throw plain Errors,
  // and so does anything that re-wraps an API error.
  const message = err instanceof Error ? err.message : String(err);
  const leading = /^\s*(\d{3})\b/.exec(message);
  if (leading) {
    const code = Number(leading[1]);
    return code >= 500 || code === 429 ? "capacity" : "request_invalid";
  }
  return "capacity";
}

/**
 * What the pipeline keeps clear at the tail of the budget: the deterministic
 * fixes, the final gates, and the caller writing the row. The fixes are
 * MEASURED at ~0 ms (`lintMs` in every log line); five seconds is slack for
 * the caller, not a measurement of it.
 */
const WRAP_UP_RESERVE_MS = 5_000;
/**
 * How long a review is assumed to take before one has been timed on this
 * request. MEASURED mean 10.1-10.2 s across three arms and 13.8 s on a second
 * rig (docs/concepts/MEASURE-1.md); 18 s is the slower figure plus headroom,
 * because guessing high only ever skips a review, and guessing low loses the
 * whole draft to the host's time limit.
 */
const ASSUMED_REVIEW_MS = 18_000;

/**
 * What is left of the request's budget for one more model call, with the
 * wrap-up reserve held back. Infinity when no budget was given, which is every
 * caller that is not a route (the tests and the CLI evaluation).
 */
function budgetLeftMs(elapsedMs: number, requestBudgetMs?: number): number {
  if (requestBudgetMs === undefined) return Number.POSITIVE_INFINITY;
  return requestBudgetMs - elapsedMs - WRAP_UP_RESERVE_MS;
}

/** A ceiling on one review call, so a slow review degrades the draft instead of killing the request. */
export function reviewTimeoutMs(elapsedMs: number, requestBudgetMs?: number): number {
  // Never below five seconds: a timeout the call cannot possibly meet is the
  // same as no review, with a wasted request on top. Never above two minutes,
  // so a caller that passes no budget is still bounded by something other than
  // the SDK's ten-minute default.
  return Math.max(5_000, Math.min(budgetLeftMs(elapsedMs, requestBudgetMs), 120_000));
}

/**
 * Whether there is room for the review's second turn.
 *
 * Cut from the same budget as the skip gate, which is the whole fix: the
 * question is no longer "is the request younger than a number unrelated to the
 * skip gate's" but "does what is left of the budget hold another review as long
 * as the one just timed". With the old pair - skip gate on drafting alone
 * against 80 s, retry gate on drafting plus lint plus a whole review against
 * 60 s - a ~10 s review made the retry unreachable for every draft between
 * ~50 s and 80 s (LOGIC-3 F2).
 *
 * `reviewRetryBeforeMs` overrides with a flat ceiling on the request's age,
 * which is what the evaluation harness drives; with neither, the old 60 second
 * default applies, so a caller that passes no budget behaves as before.
 */
export function retryFitsBudget(opts: {
  elapsedMs: number;
  /** How long the first review call took, when it has been timed. */
  reviewMs: number | null;
  requestBudgetMs?: number;
  reviewRetryBeforeMs?: number;
}): boolean {
  if (opts.reviewRetryBeforeMs !== undefined) return opts.elapsedMs < opts.reviewRetryBeforeMs;
  if (opts.requestBudgetMs === undefined) return opts.elapsedMs < 60_000;
  return budgetLeftMs(opts.elapsedMs, opts.requestBudgetMs) >= (opts.reviewMs ?? ASSUMED_REVIEW_MS);
}

export async function runDraftPipeline(
  client: Anthropic,
  input: DraftPromptInput & { resumePdf?: Buffer | null },
  configs: PipelineConfigs,
): Promise<PipelineResult> {
  const started = Date.now();
  const { resumePdf, ...rest } = input;
  const promptInput: DraftPromptInput = { ...rest, hasResumePdf: Boolean(resumePdf) };
  const { systemTiers, userText } = buildDraftPrompt(promptInput);

  const draftCallAt = Date.now();
  const draftRequest = {
    ...requestConfig(configs.draft),
    output_config: {
      format: zodOutputFormat(draftOutputSchema),
      ...(configs.draft.effort ? { effort: configs.draft.effort } : {}),
    },
    system: cachedTiers(systemTiers),
    messages: [
      {
        role: "user" as const,
        // The resume goes in as the PDF itself, the same way the resume
        // review reads it, rather than as text nobody has extracted.
        content: resumePdf ? [pdfBlock(resumePdf), { type: "text" as const, text: userText }] : userText,
      },
    ],
  };
  const onEvent = configs.onEvent;
  // parse() throws on JSON cut off mid-string (a reply that hit max_tokens)
  // before stop_reason can be checked, and its message means nothing to a student.
  // parseWith: the paid tier's draft config runs fast mode (lib/fast-mode).
  // streamDraftCall is the same request over the streaming endpoint, reporting
  // the plan, the subject and the body as they arrive; it returns the same
  // parsed message, so everything after this line is identical either way.
  const response = await (onEvent
    ? streamDraftCall<z.infer<typeof draftOutputSchema>>(client, configs.draft, draftRequest, onEvent)
    : parseWith(client, configs.draft)(draftRequest)
  ).catch((err: unknown) => {
    if (err instanceof Error && /parse structured output/i.test(err.message)) {
      console.error("[draft] unparseable model output", err.message);
      throw new Error("The draft came back incomplete. Please try again.");
    }
    throw err;
  });
  const draftMs = Date.now() - draftCallAt;

  if (response.stop_reason === "max_tokens") {
    throw new Error("The draft ran too long to finish. Try again, or trim the details you entered.");
  }
  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to draft this email. Try adjusting the details.");
  }
  if (!response.parsed_output) {
    throw new Error("Failed to generate a draft. Please try again.");
  }

  const draftUsage = { input_tokens: response.usage.input_tokens ?? 0, output_tokens: response.usage.output_tokens ?? 0 };
  // Tracked apart from the draft's rather than added to it: `usage` below is
  // still both calls together, but the caller needs the split to put the
  // review's tokens anywhere but the draft model's row (LOGIC-3 F10d).
  const reviewTokens = { input_tokens: 0, output_tokens: 0 };
  const first = finishDraft(promptInput, response.parsed_output);
  const preReview = { subject: first.subject, body: first.body };
  // The deterministic fixes have run, so this is the first text the student
  // sees that will not shift under them character by character. Still
  // provisional: the review has not run, and nothing has been saved.
  onEvent?.({ type: "draft-finished", subject: first.subject, body: first.body });
  let draft: FinishedDraft = first;
  let review: ReviewOutcome | null = null;
  let lintMs = 0;
  let reviewMs: number | null = null;
  let reviewRetryMs: number | null = null;
  const draftedMs = Date.now() - started;

  const retryHasTime = () =>
    retryFitsBudget({
      elapsedMs: Date.now() - started,
      reviewMs,
      requestBudgetMs: configs.requestBudgetMs,
      reviewRetryBeforeMs: configs.reviewRetryBeforeMs,
    });
  /** Set when the guard rejected the edit and there was no room for the second turn. */
  let retrySkippedForTime = false;

  if (configs.review && configs.reviewSkipAfterMs !== undefined && draftedMs > configs.reviewSkipAfterMs) {
    review = { problems: [], applied: false, error: `skipped: drafting took ${draftedMs}ms`, reviewGap: "skipped_for_time" };
    onEvent?.({ type: "review-skipped", reason: "there wasn't time left to check it" });
  } else if (configs.review) {
    onEvent?.({ type: "review-started" });
    // The review never costs the student their draft: any failure, including a
    // capacity error, leaves the draft as written.
    try {
      const lintAt = Date.now();
      const automaticChecks = draftChecks(promptInput, first.body).forReview;
      lintMs = Date.now() - lintAt;
      const prompt = buildReviewPrompt(
        promptInput,
        { ...preReview, plan: response.parsed_output.plan },
        automaticChecks,
      );
      const reviewConfig = configs.review;
      const messages: Anthropic.MessageParam[] = [
        {
          role: "user",
          // The reviewer checks experience against the same resume the
          // drafter read. Without it, real experience from an unread PDF
          // looks invented and gets cut.
          content: resumePdf ? [pdfBlock(resumePdf), { type: "text" as const, text: prompt.userText }] : prompt.userText,
        },
      ];
      const callReview = async () => {
        const callAt = Date.now();
        const reviewed = await client.messages.parse(
          {
            ...requestConfig(reviewConfig),
            output_config: {
              format: zodOutputFormat(reviewOutputSchema),
              ...(reviewConfig.effort ? { effort: reviewConfig.effort } : {}),
            },
            system: cachedSystem(prompt.system),
            messages,
          },
          // The skip gate bounds the draft; nothing bounded the review, and the
          // SDK's own defaults are a ten minute timeout and two silent retries.
          // A 50 s review after a 79 s draft put the request at 129 s against a
          // 120 s maxDuration and the student got NOTHING - the exact outcome
          // the skip gate's comment exists to prevent (LOGIC-3 F4). Bounded by
          // what is actually left of the budget, and `maxRetries: 0` because a
          // retry inside the timeout spends the student's remaining time on the
          // same call: the review already degrades to an unreviewed draft, and
          // that is the better trade at this point in the request.
          { timeout: reviewTimeoutMs(Date.now() - started, configs.requestBudgetMs), maxRetries: 0 },
        );
        if (reviewMs === null) reviewMs = Date.now() - callAt;
        else reviewRetryMs = Date.now() - callAt;
        reviewTokens.input_tokens += reviewed.usage.input_tokens ?? 0;
        reviewTokens.output_tokens += reviewed.usage.output_tokens ?? 0;
        const ok = reviewed.parsed_output && reviewed.stop_reason !== "max_tokens" && reviewed.stop_reason !== "refusal";
        return { out: ok ? reviewed.parsed_output : null, stop: reviewed.stop_reason };
      };

      // How this pipeline finishes a body before it ships, handed to the guard
      // so it judges the string the student actually receives rather than the
      // reviewer's raw one (lib/draft-review's `finish` parameter, LOGIC-2 F4).
      const finishBody = (body: string) => finishDraft(promptInput, { ...first, body }).body;

      let { out, stop } = await callReview();
      let guard = out ? applyReviewEdit(preReview, out, promptInput, out.problems, finishBody) : null;
      // One slip - a dropped shared school, an added word - used to cost every
      // other fix in the edit: the guard throws the whole edit away and the
      // unedited draft goes out. Tell the reviewer what was wrong and let it
      // try once more, keeping the rest of its edit (5 October 2026: a review
      // that removed an invented opinion and fixed the common ground was thrown
      // away for dropping "a fellow Duke alum").
      // Asked once: "is there room" and "was it skipped for want of room" must
      // not disagree because the clock moved between them.
      const roomForRetry = retryHasTime();
      if (out && guard && !guard.ok && !roomForRetry) retrySkippedForTime = true;
      if (out && guard && !guard.ok && roomForRetry) {
        messages.push(
          { role: "assistant", content: JSON.stringify(out) },
          {
            role: "user",
            content:
              `That edit can't be used: it ${guard.reason}. Return the whole edit again with only that put right, ` +
              "keeping every other fix you made.",
          },
        );
        // Caught around the retry ALONE. In the one `try` it shared with the
        // first call, a transient 529 on the second turn jumped to the outer
        // catch and overwrote `review`, so the first turn's problems, its
        // rejection reason and its student warning all vanished - strictly
        // worse than never retrying, and MEASURED side by side (LOGIC-3 F3:
        // retry fails the guard -> 2 problems and 1 warning kept; retry throws
        // -> 0 problems, no warning, `rejected` undefined).
        const retry = await callReview().catch((err: unknown) => {
          console.warn("[draft] review retry failed; keeping what the first turn found", err);
          return { out: null, stop: null };
        });
        if (retry.out) {
          const retryGuard = applyReviewEdit(preReview, retry.out, promptInput, retry.out.problems, finishBody);
          if (retryGuard.ok) ({ out, stop, guard } = { out: retry.out, stop: retry.stop, guard: retryGuard });
        }
      }

      if (!out || !guard) {
        review = { problems: [], applied: false, error: `review stopped: ${stop}`, reviewGap: "stopped" };
        onEvent?.({ type: "review-skipped", reason: "the check didn't finish, so this is the draft as written" });
      } else {
        if (guard.ok) {
          // `guard.body` and not `out.body`: on the span path the body that was
          // judged is the ASSEMBLED one, and shipping the reviewer's raw body
          // instead would ship the spans the guard just refused.
          const revised = finishDraft(promptInput, { ...first, subject: guard.subject, body: guard.body });
          draft = { ...revised, notesForStudent: dedupe([...first.notesForStudent, ...revised.notesForStudent]) };
        }
        review = {
          problems: out.problems,
          applied: guard.ok,
          ...(guard.spans ? { spans: { accepted: guard.spans.accepted, total: guard.spans.total } } : {}),
          ...(guard.ok ? {} : { rejected: guard.reason, revisedBody: out.body }),
          ...(retrySkippedForTime ? { reviewGap: "retry_skipped_for_time" as const } : {}),
        };
        draft = {
          ...draft,
          notesForStudent: dedupe([
            ...draft.notesForStudent,
            ...studentNotesFromReview(out.problems, guard.ok),
            // The guard admits one proper noun it cannot check - a word that may
            // have come from a resume PDF it was never shown - instead of
            // throwing away an edit that restored a real fact (guardRevision,
            // lib/draft-review). Telling the student which word that was is the
            // entire reason admitting it is acceptable, so this note is not
            // optional: without it the word goes into their email silently.
            ...(guard.ok && guard.note ? [guard.note] : []),
          ]),
        };
        onEvent?.({ type: "review-finished", applied: guard.ok, problems: out.problems });
      }
    } catch (err) {
      const reviewGap = classifyReviewError(err);
      if (reviewGap === "request_invalid") {
        // Loud and its own shape, because this one does not go away. A 4xx on
        // our own payload degrades EVERY draft to unreviewed until someone
        // changes the code, and it used to look exactly like a capacity blip
        // (LOGIC-3 F10b). The pipeline still ships the draft - losing the
        // student's email to our bug would be worse - but it says so.
        console.error(
          "[draft] REVIEW REQUEST REJECTED - not a capacity problem. Every draft ships unreviewed until this is fixed.",
          err,
        );
      } else {
        console.warn("[draft] review unavailable; keeping the draft as written", err);
      }
      review = { problems: [], applied: false, error: err instanceof Error ? err.message : String(err), reviewGap };
      onEvent?.({ type: "review-skipped", reason: "the check couldn't run, so this is the draft as written" });
    }
  }

  // Checked on the email that actually goes out, so a detail the review already
  // removed doesn't still produce a warning.
  draft = {
    ...draft,
    notesForStudent: dedupe([...draft.notesForStudent, ...draftChecks(promptInput, draft.body).forStudent]).filter(
      (n) => !appHandles(n),
    ),
  };

  // The email was not checked against the student's own facts, and until now
  // nothing told them so. The review is skipped past the time gate, cancelled
  // by a failed call, dropped on a max_tokens or refused reply, and thrown away
  // whole when the guard rejects its edit - four routes to the same silence
  // (OUTPUT-3, LOW). Added after the app-handled filter because this note is
  // the app reporting on itself, which is exactly what that filter is for.
  if (review && review.applied !== true) {
    draft = {
      ...draft,
      notesForStudent: [
        ...draft.notesForStudent,
        "We couldn't double-check this email against your profile and what you typed. Read it over before you send it.",
      ],
    };
  }

  // One line per draft, and never its content: enough to watch how often the
  // review runs, what it finds and how often its edit is kept or thrown away.
  const outcome = !review
    ? "review off"
    : review.applied
      ? `review applied${review.spans ? ` (spans ${review.spans.accepted}/${review.spans.total})` : ""}`
      : review.rejected
        ? `review rejected (${review.rejected})`
        : `review not applied (${review.error})`;
  const totalMs = Date.now() - started;
  const reviewUsage =
    reviewTokens.input_tokens > 0 || reviewTokens.output_tokens > 0
      // Reaching this branch means a review spent tokens, which means it had a
      // config. Asserted rather than defaulted: naming another model here
      // would mislabel the usage row, and the usage row is what the plan
      // quotas are counted from.
      ? { model: configs.review!.model, ...reviewTokens }
      : null;
  const split = [
    `draft ${draftMs}ms`,
    `lint ${lintMs}ms`,
    `review ${reviewMs === null ? "-" : `${reviewMs}ms`}`,
    ...(reviewRetryMs === null ? [] : [`retry ${reviewRetryMs}ms`]),
  ].join(", ");
  console.info(
    `[draft-review] ${[input.type, ...(input.alsoTypes ?? [])].join("+")} · ${outcome} · ${review?.problems.length ?? 0} problems, ` +
      `${review?.problems.filter((p) => p.needsStudent).length ?? 0} for the student · ${totalMs}ms (${split})` +
      // The enumerated gap, so "how many drafts shipped unreviewed, and why" is
      // a count over one token rather than a regex over free text, and
      // "the retry had no time" stops looking like "the guard accepted"
      // (LOGIC-3 F17). The review's own cost rides here too, under the model
      // that served it, because the ai_usage row cannot say it (F10d).
      ` · gap=${review?.reviewGap ?? "-"}` +
      (reviewUsage ? ` · review ${reviewUsage.model} ${reviewUsage.input_tokens}in/${reviewUsage.output_tokens}out` : ""),
  );

  // Never hand back an email with a slur or profanity in it, whatever was typed
  // or the models wrote (lib/content-limits).
  //
  // The EMAIL is fatal. It is the artifact the student asked for and the thing
  // that goes to a real person; there is no version of it worth keeping with a
  // slur in it, and no part of it can be dropped without handing back an email
  // nobody wrote.
  if (findBlockedLanguage(`${draft.subject}\n${draft.body}`)) {
    throw new Error("The draft came back with language we don't allow. Please try again.");
  }

  // Everything ELSE the pipeline hands back is model-written too, and this gate
  // used to cover the subject and the body alone. Three of those strings reach
  // the composer verbatim - the drafter's `notesForStudent`, and the reviewer's
  // `fix` and `quote` as studentNotesFromReview renders them - so the app could
  // print a slur back at its own user in its own voice while the email itself
  // was clean (OUTPUT-3, MEDIUM, demonstrated end to end).
  //
  // Reachable with every component behaving as designed: the prompts instruct
  // the model to narrate what it removed into a note, and a homoglyph slur
  // clears the input check, so the model obeys the house rule, keeps the word
  // out of the body, and writes it into a note in plain ASCII.
  //
  // These are DROPPED, not fatal, and the asymmetry with the email is the
  // decision: the email is already clean, so failing the request would cost the
  // student a draft off their monthly allowance and both model calls behind it
  // over one advisory sentence the app can simply not show. Dropping is also
  // what the sibling feature does with a model-written suggestion
  // (lib/draft-suggestions-ai).
  const dropped: string[] = [];
  const gated = <T,>(items: T[], text: (item: T) => string, what: string): T[] =>
    items.filter((item) => {
      if (!findBlockedLanguage(text(item))) return true;
      dropped.push(what);
      return false;
    });

  draft = {
    ...draft,
    // The note goes. Nothing else about the draft changes.
    notesForStudent: gated(draft.notesForStudent, (n) => n, "note"),
    // The gap goes, and the bracketed placeholder stays in the body, so
    // Composer's own unfilled-placeholder gate still stops the send: the
    // student loses the question, never the warning.
    gaps: gated(draft.gaps, (g) => `${g.placeholder}\n${g.question}`, "gap"),
    // Null is already a documented, valid outcome for this field ("there
    // wasn't one"), which is better than a connection line nobody can show.
    connectionUsed: findBlockedLanguage(draft.connectionUsed) ? null : draft.connectionUsed,
  };
  if (review) {
    review = {
      ...review,
      // Not student-facing by this point (their notes were built above and have
      // just been filtered), but `review` is sealed into the email archive, so
      // an ungated problem is a slur at rest in our own records.
      problems: gated(review.problems, (p) => `${p.quote}\n${p.fix}`, "review problem"),
      // The guard's reason quotes words out of the model's edit, so it can
      // carry one. Replaced rather than removed: dropping the field would make
      // a rejected edit read as an accepted one.
      ...(findBlockedLanguage(review.rejected) ? { rejected: "the edit was rejected" } : {}),
      ...(findBlockedLanguage(review.revisedBody) ? { revisedBody: undefined } : {}),
    };
  }
  const plan = response.parsed_output.plan;
  const gatedPlan = {
    ...plan,
    people: gated(plan.people, (p) => `${p.name}\n${p.role}`, "plan person"),
    sentences: gated(plan.sentences, (line) => line, "plan sentence"),
  };
  if (dropped.length > 0) {
    // Never the string itself: this log line is the one place that knows the
    // word, and repeating it here is the same mistake one layer down.
    console.warn(`[draft] dropped ${dropped.length} model-written string(s) for blocked language: ${dropped.join(", ")}`);
  }

  return {
    draft,
    preReview,
    review,
    plan: gatedPlan,
    usage: { input_tokens: draftUsage.input_tokens + reviewTokens.input_tokens, output_tokens: draftUsage.output_tokens + reviewTokens.output_tokens },
    draftUsage,
    reviewUsage,
    timings: { draftMs, lintMs, reviewMs, reviewRetryMs, totalMs },
  };
}
