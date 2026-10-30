// Quality evaluation of the whole draft pipeline at zero API cost.
//
//   npx tsx --conditions=react-server scripts/draft-cli-eval.ts --scenarios=3
//   npx tsx --conditions=react-server scripts/draft-cli-eval.ts --scenarios=12 --json=run-a.json
//   npx tsx --conditions=react-server scripts/draft-cli-eval.ts --compare=run-a.json --json=run-b.json
//
// It reproduces runDraftPipeline (src/lib/draft-pipeline.ts) over `runClaude`
// (src/lib/news/claude-cli.ts), which reaches a model through the Claude Code
// CLI on the owner's subscription rather than the API. Every prompt, check and
// guard is the real one, imported: the only thing swapped out is the transport.
// That makes a quality A/B free and unlimited - and means NOTHING here measures
// production latency. See docs/concepts/HARNESS.md.
//
// What it cannot do, all from the transport (docs/concepts/FINDINGS-probe.md):
//   - no `effort`, `thinking` or `speed: fast` controls, so the durations it
//     prints are CLI durations, not the app's;
//   - no PDF document blocks, so only the `studentResumeSummary` path runs;
//   - the model is whatever the CLI accepts, not the per-plan registry model;
//   - the CLI is single-turn, so the guard's retry turn is flattened into one
//     prompt (the correction wording is copied verbatim from the pipeline).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runClaude, type CliUsage } from "../src/lib/news/claude-cli";
import { buildDraftPrompt, finishDraft, type DraftPromptInput, type RawDraft } from "../src/lib/draft-prompt";
import { draftChecks } from "../src/lib/draft-lint";
import { findBlockedLanguage } from "../src/lib/content-limits";
import {
  buildReviewPrompt,
  guardRevision,
  reviewOutputSchema,
  studentNotesFromReview,
  type ReviewProblem,
} from "../src/lib/draft-review";
import { situationTypes } from "../src/lib/draft-occasions";
import { getModelConfig } from "../src/lib/model-registry";
import { draftIssues, sims, type Sim } from "./draft-occasions-sim";

// ---------------------------------------------------------------------------
// The draft call's output schema
//
// draft-pipeline.ts declares this privately and this script may not edit
// src/, so it is redeclared here - which means it can silently drift from the
// real one. assertSchemaMatchesPipeline() reads the real declaration out of the
// source file and fails loudly if the two stop agreeing.
// ---------------------------------------------------------------------------

const draftOutputSchema = z.object({
  plan: z.object({
    people: z.array(z.object({ name: z.string(), role: z.string() })),
    sentences: z.array(z.string()),
  }),
  subject: z.string(),
  body: z.string(),
  connectionUsed: z.string().nullable(),
  gaps: z.array(z.object({ placeholder: z.string(), question: z.string() })),
  notesForStudent: z.array(z.string()),
});

type DraftOutput = z.infer<typeof draftOutputSchema>;
// The pipeline hands this straight to finishDraft, so it must satisfy RawDraft.
const _draftOutputIsRawDraft: RawDraft = {} as DraftOutput;
void _draftOutputIsRawDraft;

// tsx compiles these scripts as CJS, so __dirname is the one that works here.
const PIPELINE_FILE = join(typeof __dirname === "string" ? __dirname : "scripts", "../src/lib/draft-pipeline.ts");

/** Every field name in a zod object literal's source text, nested ones included. */
function fieldsInSource(source: string): Set<string> {
  const start = source.indexOf("const draftOutputSchema = z.object({");
  if (start < 0) throw new Error(`${PIPELINE_FILE}: no "const draftOutputSchema = z.object({" to compare against`);
  const end = source.indexOf("\n});", start);
  if (end < 0) throw new Error(`${PIPELINE_FILE}: draftOutputSchema is not closed by a line-start "});"`);
  const body = source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const found = new Set<string>();
  for (const m of body.matchAll(/(?:^|[\s{(,])([A-Za-z_]\w*)\s*:/g)) found.add(m[1]);
  return found;
}

/** The fields this script's copy of the schema declares, nested ones included. */
function fieldsInCopy(): Set<string> {
  const shape = draftOutputSchema.shape;
  return new Set([
    ...Object.keys(shape),
    ...Object.keys(shape.plan.shape),
    ...Object.keys(shape.plan.shape.people.element.shape),
    ...Object.keys(shape.gaps.element.shape),
  ]);
}

function assertSchemaMatchesPipeline(): void {
  const real = fieldsInSource(readFileSync(PIPELINE_FILE, "utf8"));
  const mine = fieldsInCopy();
  const missing = [...real].filter((f) => !mine.has(f));
  const extra = [...mine].filter((f) => !real.has(f));
  if (missing.length || extra.length) {
    throw new Error(
      "draftOutputSchema in src/lib/draft-pipeline.ts no longer matches this script's copy. " +
        `${missing.length ? `The pipeline has fields this script doesn't: ${missing.join(", ")}. ` : ""}` +
        `${extra.length ? `This script has fields the pipeline doesn't: ${extra.join(", ")}. ` : ""}` +
        "Update the copy in scripts/draft-cli-eval.ts, then re-run.",
    );
  }
}

/** The CLI rejects the `$schema` key zod 4 emits (FINDINGS-probe.md). */
function jsonSchemaFor(schema: z.ZodType): object {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  return rest;
}

// ---------------------------------------------------------------------------
// Voice metrics - what draft-lint does NOT measure
//
// FINDINGS-probe.md: a draft that broke four VOICE_RULES scored one finding on
// draftChecks. These four are the gap, measured on the pre-review and the
// post-review body so the review pass's effect on voice is visible.
// ---------------------------------------------------------------------------

const CONTRACTION =
  /\b(?:I|you|we|they|he|she|it|that|there|here|what|who|how|let|this|y'all)['’](?:m|re|ve|ll|d|s)\b|\b\w+n['’]t\b/gi;

// The three courtesy lines VOICE_RULES names - the resume, flexibility, the
// easy out - in their canned forms. Two families count as canned:
//
//   - the stock versions the 300-draft simulation found ("for your reference",
//     "happy to work around your schedule");
//   - the exact phrasings VOICE_RULES itself prints as the fresh alternative.
//     A rule's own example, pasted into every email, is a template too - and
//     the first 3-scenario run found the reviewer doing exactly that ("Any time
//     that suits you works for me" in two of three edits).
//
// The rule is not "never mention the resume", so a line only counts when the
// phrasing is one of these, and the matched words are reported verbatim.
const CANNED_LINES = {
  resumeLine: [
    /\bresume\b[^.!?]{0,40}\bfor your (?:reference|review|convenience|consideration)\b/i,
    /\bfor your (?:reference|review|convenience)\b[^.!?]{0,40}\bresume\b/i,
    /\bI(?:'ve| have| )?\s*attached (?:a copy of )?my resume\b/i,
    /\bmy resume(?:'s| is) attached\b/i,
    /\bplease (?:find|see)[^.!?]{0,20}\battached\b/i,
  ],
  flexibilityLine: [
    /\b(?:more than )?(?:happy|glad) to work around your schedule\b/i,
    /\bat your (?:earliest )?convenience\b/i,
    /\bwhatever (?:time |day |day or time )?works best for you\b/i,
    /\bwhenever (?:is |works )(?:most )?convenient\b/i,
    /\bI(?:'m| am) flexible (?:on|with|around) (?:timing|time|your schedule|whatever)\b/i,
    /\bany time that suits you works for me\b/i,
  ],
  easyOutLine: [
    /\bno (?:worries|pressure|problem)\b[^.!?]{0,40}\bif\b/i,
    /\bI (?:completely |totally |of course )?understand if\b/i,
    /\bif you(?:'re| are) (?:too )?busy\b/i,
    /\bno need to (?:reply|respond|apologi[sz]e)\b/i,
    /\bif (?:now|the timing)[^.!?]{0,25}\b(?:isn't|is not|doesn't|does not)\b/i,
  ],
} as const;

const PLEASANTRY =
  /^(?:[^.!?]{0,40}\b)?(?:I hope (?:this|you|your|all|things)|hope (?:you|this|all|your|things)|I trust you|how are you|hope all is well)\b/i;

function sentencesOf(text: string): string[] {
  return text
    .replace(/\s*\n\s*/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The body split the way draft-lint splits it: the greeting, the main text, everything above "Best,". */
function bodyParts(body: string): { aboveSignOff: string; greeting: string; text: string } {
  const lines = body.split("\n");
  const signOff = lines.map((l) => l.trim()).lastIndexOf("Best,");
  const aboveSignOff = (signOff >= 0 ? lines.slice(0, signOff) : lines).join("\n").trim();
  const greeting = aboveSignOff.split("\n")[0]?.trim() ?? "";
  return { aboveSignOff, greeting, text: aboveSignOff.split("\n").slice(1).join("\n").trim() };
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

type VoiceMetrics = {
  /** Words between the greeting and the sign-off: what the type's maxWords ceiling is about. */
  words: number;
  sentences: number;
  contractions: number;
  /** Contractions per 100 words. VOICE_RULES: "use them naturally"; 255 of 300 simulated drafts had none. */
  contractionRate: number;
  /** The longest run of consecutive sentences opening with "I". VOICE_RULES: never three in a row. */
  longestIRun: number;
  /** The canned courtesy lines VOICE_RULES names, verbatim where found. */
  canned: { resumeLine: string | null; flexibilityLine: string | null; easyOutLine: string | null };
  cannedCount: number;
  /** Opens on a pleasantry ("I hope this finds you well") instead of the specific thing. */
  opensOnPleasantry: boolean;
};

function voiceMetrics(body: string): VoiceMetrics {
  const { text } = bodyParts(body);
  const sentences = sentencesOf(text);
  const words = countWords(text);
  const contractions = (text.match(CONTRACTION) ?? []).length;

  let longestIRun = 0;
  let run = 0;
  for (const s of sentences) {
    if (/^I\b|^I['’]/.test(s)) longestIRun = Math.max(longestIRun, ++run);
    else run = 0;
  }

  const canned = { resumeLine: null, flexibilityLine: null, easyOutLine: null } as VoiceMetrics["canned"];
  for (const [name, patterns] of Object.entries(CANNED_LINES) as [keyof typeof CANNED_LINES, readonly RegExp[]][]) {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        canned[name] = m[0].trim();
        break;
      }
    }
  }

  return {
    words,
    sentences: sentences.length,
    contractions,
    contractionRate: words ? Number(((contractions / words) * 100).toFixed(2)) : 0,
    longestIRun,
    canned,
    cannedCount: Object.values(canned).filter(Boolean).length,
    opensOnPleasantry: sentences.length > 0 && PLEASANTRY.test(sentences[0]),
  };
}

// ---------------------------------------------------------------------------
// The pipeline, over the CLI
// ---------------------------------------------------------------------------

// Copied from the private APP_HANDLES in src/lib/draft-pipeline.ts: notes
// telling the student to do what the app already does. Kept in step by hand;
// it only filters notes, so a drift here changes no score but the note list.
const APP_HANDLES =
  /\battach (?:your |the )?resume\b|\bresume (?:to the email )?in gmail\b|\bresume (?:will be|is|gets) attached automatically\b|\bgmail signature\b|\bgmail adds\b|\bsignature (?:block|lines?)\b|\bdid(?:n't| not) include your (?:phone|email)\b/i;

const dedupe = (notes: string[]) => [...new Set(notes)];

const emptyUsage = (): CliUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
function addUsage(into: CliUsage, from: CliUsage): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.costUsd += from.costUsd;
}

type ReviewOutcome = {
  problems: ReviewProblem[];
  applied: boolean;
  /** The guard's reason, verbatim. The headline number for the project is how often this is set. */
  rejected?: string;
  retried: boolean;
  /** The retry the real pipeline would also have skipped: the request was already older than reviewRetryBeforeMs. */
  retrySkippedForTime?: boolean;
  revisedBody?: string;
  error?: string;
};

type RunOptions = {
  model: string;
  review: boolean;
  timeoutMs: number;
  reviewRetryBeforeMs: number;
};

type PipelineRun = {
  draft: RawDraft & { notesForStudent: string[] };
  preReview: { subject: string; body: string };
  review: ReviewOutcome | null;
  usage: CliUsage;
  timings: { draftMs: number; lintMs: number; reviewMs: number | null; reviewRetryMs: number | null; totalMs: number };
  /** The final gate in the pipeline throws; here it is recorded, because a throw would hide every other score. */
  blockedLanguage: boolean;
};

async function runPipelineViaCli(sim: Sim, opts: RunOptions): Promise<PipelineRun> {
  const started = Date.now();
  // No PDF document blocks over the CLI: the studentResumeSummary path only.
  const promptInput: DraftPromptInput = { ...sim.input, hasResumePdf: false };
  const { system, userText } = buildDraftPrompt(promptInput);
  const usage = emptyUsage();

  const draftRes = await runClaude<unknown>({
    model: opts.model,
    system,
    prompt: userText,
    schema: jsonSchemaFor(draftOutputSchema),
    timeoutMs: opts.timeoutMs,
  });
  addUsage(usage, draftRes.usage);
  const draftMs = draftRes.durationMs;
  if (!draftRes.ok) throw new Error(`draft call ${draftRes.failure}: ${draftRes.error}`);
  const parsed = draftOutputSchema.safeParse(draftRes.data);
  if (!parsed.success) throw new Error(`draft output did not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const out: DraftOutput = parsed.data;

  const first = finishDraft(promptInput, out);
  const preReview = { subject: first.subject, body: first.body };
  let draft = first;
  let review: ReviewOutcome | null = null;
  let lintMs = 0;
  let reviewMs: number | null = null;
  let reviewRetryMs: number | null = null;

  if (opts.review) {
    // The review never costs the student their draft: any failure leaves it as written.
    try {
      const lintAt = Date.now();
      const automaticChecks = draftChecks(promptInput, first.body).forReview;
      lintMs = Date.now() - lintAt;
      const prompt = buildReviewPrompt(promptInput, { ...preReview, plan: out.plan }, automaticChecks);
      const reviewSchema = jsonSchemaFor(reviewOutputSchema);

      const callReview = async (text: string) => {
        const res = await runClaude<unknown>({
          model: opts.model,
          system: prompt.system,
          prompt: text,
          schema: reviewSchema,
          timeoutMs: opts.timeoutMs,
        });
        addUsage(usage, res.usage);
        if (reviewMs === null) reviewMs = res.durationMs;
        else reviewRetryMs = res.durationMs;
        if (!res.ok) return { out: null, stop: `${res.failure}: ${res.error}` };
        const got = reviewOutputSchema.safeParse(res.data);
        return got.success ? { out: got.data, stop: "ok" } : { out: null, stop: `output did not match the schema: ${got.error.issues[0]?.message ?? "?"}` };
      };

      let { out: rev, stop } = await callReview(prompt.userText);
      let guard = rev ? guardRevision(preReview, rev, promptInput, rev.problems) : null;
      let retried = false;
      let retrySkippedForTime = false;

      if (rev && guard && !guard.ok) {
        if (Date.now() - started < opts.reviewRetryBeforeMs) {
          retried = true;
          // The CLI is single-turn, so the real pipeline's assistant+user turns
          // become one prompt. The correction sentence is the pipeline's, verbatim.
          const retryText = [
            prompt.userText,
            `YOUR PREVIOUS EDIT\n${JSON.stringify(rev)}`,
            `That edit can't be used: it ${guard.reason}. Return the whole edit again with only that put right, ` +
              "keeping every other fix you made.",
          ].join("\n\n");
          const retry = await callReview(retryText);
          if (retry.out) {
            const retryGuard = guardRevision(preReview, retry.out, promptInput, retry.out.problems);
            if (retryGuard.ok) ({ out: rev, stop, guard } = { out: retry.out, stop: retry.stop, guard: retryGuard });
          }
        } else {
          retrySkippedForTime = true;
        }
      }

      if (!rev || !guard) {
        review = { problems: [], applied: false, retried, error: `review stopped: ${stop}` };
      } else {
        if (guard.ok) {
          const revised = finishDraft(promptInput, { ...first, subject: guard.subject, body: rev.body });
          draft = { ...revised, notesForStudent: dedupe([...first.notesForStudent, ...revised.notesForStudent]) };
        }
        review = {
          problems: rev.problems,
          applied: guard.ok,
          retried,
          ...(retrySkippedForTime ? { retrySkippedForTime } : {}),
          ...(guard.ok ? {} : { rejected: guard.reason, revisedBody: rev.body }),
        };
        draft = { ...draft, notesForStudent: dedupe([...draft.notesForStudent, ...studentNotesFromReview(rev.problems, guard.ok)]) };
      }
    } catch (err) {
      review = { problems: [], applied: false, retried: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  draft = {
    ...draft,
    notesForStudent: dedupe([...draft.notesForStudent, ...draftChecks(promptInput, draft.body).forStudent]).filter((n) => !APP_HANDLES.test(n)),
  };

  return {
    draft,
    preReview,
    review,
    usage,
    timings: { draftMs, lintMs, reviewMs, reviewRetryMs, totalMs: Date.now() - started },
    blockedLanguage: Boolean(findBlockedLanguage(`${draft.subject}\n${draft.body}`)),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type SideScore = {
  /** draftIssues: the simulation grader written for exactly these situations. */
  issues: string[];
  /** draftChecks(...).forReview - what the reviewer is handed. */
  lintForReview: string[];
  /** draftChecks(...).forStudent - what only the student can fix. */
  lintForStudent: string[];
  voice: VoiceMetrics;
  overCeilingBy: number;
};

type ScenarioRecord = {
  id: string;
  profile: string;
  boxes: string[];
  summary: string;
  leadType: string;
  ceiling: number;
  ok: boolean;
  error?: string;
  pre?: SideScore;
  post?: SideScore;
  /** Null when the review pass was off (--no-review). */
  review?: {
    ran: boolean;
    applied: boolean;
    rejected: string | null;
    retried: boolean;
    retrySkippedForTime: boolean;
    error: string | null;
    problems: number;
    needsStudent: number;
    kinds: Record<string, number>;
  } | null;
  notesForStudent?: string[];
  blockedLanguage?: boolean;
  usage?: CliUsage;
  timings?: PipelineRun["timings"];
  /** The email as the drafting model wrote it, before any review edit. */
  preReviewSubject?: string;
  preReviewBody?: string;
  /** The email that would go to the student. */
  subject?: string;
  body?: string;
};

function scoreSide(sim: Sim, side: { subject: string; body: string }, ceiling: number): SideScore {
  const promptInput: DraftPromptInput = { ...sim.input, hasResumePdf: false };
  const voice = voiceMetrics(side.body);
  const lint = draftChecks(promptInput, side.body);
  return {
    issues: draftIssues(sim, { ...side, notes: [] }),
    lintForReview: lint.forReview,
    lintForStudent: lint.forStudent,
    voice,
    overCeilingBy: Math.max(0, voice.words - ceiling),
  };
}

function scenarioRecord(sim: Sim, run: PipelineRun | null, error?: string): ScenarioRecord {
  const types = situationTypes(sim.situation);
  const ceiling = Math.max(...types.map((t) => t.maxWords));
  const base: ScenarioRecord = {
    id: sim.id,
    profile: sim.profile,
    boxes: [...sim.ids].sort(),
    summary: sim.situation.summary,
    leadType: types[0].id,
    ceiling,
    ok: Boolean(run),
  };
  if (!run) return { ...base, error: error ?? "unknown error" };

  const kinds: Record<string, number> = {};
  for (const p of run.review?.problems ?? []) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;

  return {
    ...base,
    pre: scoreSide(sim, run.preReview, ceiling),
    post: scoreSide(sim, { subject: run.draft.subject, body: run.draft.body }, ceiling),
    review: run.review
      ? {
          ran: !run.review.error,
          applied: run.review.applied,
          rejected: run.review.rejected ?? null,
          retried: run.review.retried,
          retrySkippedForTime: Boolean(run.review.retrySkippedForTime),
          error: run.review.error ?? null,
          problems: run.review.problems.length,
          needsStudent: run.review.problems.filter((p) => p.needsStudent).length,
          kinds,
        }
      : null,
    notesForStudent: run.draft.notesForStudent,
    blockedLanguage: run.blockedLanguage,
    usage: run.usage,
    timings: run.timings,
    preReviewSubject: run.preReview.subject,
    preReviewBody: run.preReview.body,
    subject: run.draft.subject,
    body: run.draft.body,
  };
}

type Aggregate = Record<string, number>;

const mean = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : 0);
const sum = (xs: number[]) => Number(xs.reduce((a, b) => a + b, 0).toFixed(4));

/**
 * Sentences that turn up word for word in more than one scenario's email.
 *
 * The measurable version of the template problem: 300 simulated drafts
 * followed every house rule and still read as one email. Different situations
 * should not produce identical sentences, so this number is the one to watch
 * when a prompt change claims to add variety. Returns [count, examples].
 */
function repeatedSentences(bodies: string[]): [number, string[]] {
  const seen = new Map<string, number>();
  for (const body of bodies) {
    const own = new Set(
      sentencesOf(bodyParts(body).text)
        .map((s) => s.toLowerCase().replace(/\s+/g, " ").trim())
        .filter((s) => s.split(" ").length >= 5),
    );
    for (const s of own) seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  const repeated = [...seen].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  return [repeated.length, repeated.map(([s, n]) => `${n}x "${s}"`)];
}

function aggregate(records: ScenarioRecord[]): Aggregate {
  const done = records.filter((r) => r.ok && r.pre && r.post);
  const pre = done.map((r) => r.pre!);
  const post = done.map((r) => r.post!);
  const reviews = done.map((r) => r.review).filter((r): r is NonNullable<ScenarioRecord["review"]> => Boolean(r));
  const agg: Aggregate = {
    scenarios: records.length,
    drafted: done.length,
    errored: records.length - done.length,
    issuesPre: sum(pre.map((p) => p.issues.length)),
    issuesPost: sum(post.map((p) => p.issues.length)),
    issuesPreMean: mean(pre.map((p) => p.issues.length)),
    issuesPostMean: mean(post.map((p) => p.issues.length)),
    lintForReviewPre: sum(pre.map((p) => p.lintForReview.length)),
    lintForReviewPost: sum(post.map((p) => p.lintForReview.length)),
    lintForStudentPost: sum(post.map((p) => p.lintForStudent.length)),
    lintCleanPre: pre.filter((p) => p.lintForReview.length === 0).length,
    lintCleanPost: post.filter((p) => p.lintForReview.length === 0).length,
    reviewRan: reviews.filter((r) => r.ran).length,
    reviewApplied: reviews.filter((r) => r.applied).length,
    reviewRejected: reviews.filter((r) => r.rejected).length,
    reviewErrored: reviews.filter((r) => r.error).length,
    reviewRetried: reviews.filter((r) => r.retried).length,
    reviewRetrySkippedForTime: reviews.filter((r) => r.retrySkippedForTime).length,
    guardAcceptRate: reviews.length ? Number((reviews.filter((r) => r.applied).length / reviews.length).toFixed(3)) : 0,
    problems: sum(reviews.map((r) => r.problems)),
    problemsMean: mean(reviews.map((r) => r.problems)),
    problemsNeedsStudent: sum(reviews.map((r) => r.needsStudent)),
    wordsPreMean: mean(pre.map((p) => p.voice.words)),
    wordsPostMean: mean(post.map((p) => p.voice.words)),
    overCeilingPre: pre.filter((p) => p.overCeilingBy > 0).length,
    overCeilingPost: post.filter((p) => p.overCeilingBy > 0).length,
    overCeilingWordsPost: sum(post.map((p) => p.overCeilingBy)),
    contractionsPreMean: mean(pre.map((p) => p.voice.contractions)),
    contractionsPostMean: mean(post.map((p) => p.voice.contractions)),
    contractionRatePreMean: mean(pre.map((p) => p.voice.contractionRate)),
    contractionRatePostMean: mean(post.map((p) => p.voice.contractionRate)),
    zeroContractionPre: pre.filter((p) => p.voice.contractions === 0).length,
    zeroContractionPost: post.filter((p) => p.voice.contractions === 0).length,
    longestIRunPreMean: mean(pre.map((p) => p.voice.longestIRun)),
    longestIRunPostMean: mean(post.map((p) => p.voice.longestIRun)),
    threeIStartsPre: pre.filter((p) => p.voice.longestIRun >= 3).length,
    threeIStartsPost: post.filter((p) => p.voice.longestIRun >= 3).length,
    cannedLinesPre: sum(pre.map((p) => p.voice.cannedCount)),
    cannedLinesPost: sum(post.map((p) => p.voice.cannedCount)),
    cannedResumePre: pre.filter((p) => p.voice.canned.resumeLine).length,
    cannedResumePost: post.filter((p) => p.voice.canned.resumeLine).length,
    cannedFlexibilityPre: pre.filter((p) => p.voice.canned.flexibilityLine).length,
    cannedFlexibilityPost: post.filter((p) => p.voice.canned.flexibilityLine).length,
    cannedEasyOutPre: pre.filter((p) => p.voice.canned.easyOutLine).length,
    cannedEasyOutPost: post.filter((p) => p.voice.canned.easyOutLine).length,
    pleasantryOpenPre: pre.filter((p) => p.voice.opensOnPleasantry).length,
    pleasantryOpenPost: post.filter((p) => p.voice.opensOnPleasantry).length,
    repeatedSentencesPre: repeatedSentences(done.map((r) => r.preReviewBody ?? ""))[0],
    repeatedSentencesPost: repeatedSentences(done.map((r) => r.body ?? ""))[0],
    blockedLanguage: done.filter((r) => r.blockedLanguage).length,
    inputTokens: sum(done.map((r) => r.usage!.inputTokens)),
    outputTokens: sum(done.map((r) => r.usage!.outputTokens)),
    cacheReadTokens: sum(done.map((r) => r.usage!.cacheReadTokens)),
    cacheWriteTokens: sum(done.map((r) => r.usage!.cacheWriteTokens)),
    costUsdSubscription: sum(done.map((r) => r.usage!.costUsd)),
    draftMsMean: mean(done.map((r) => r.timings!.draftMs)),
    reviewMsMean: mean(done.map((r) => r.timings!.reviewMs ?? 0)),
    totalMsMean: mean(done.map((r) => r.timings!.totalMs)),
  };
  return agg;
}

// ---------------------------------------------------------------------------
// Scenario choice: deterministic, so two runs cover the same situations
// ---------------------------------------------------------------------------

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function chooseScenarios(opts: { count: number; filter?: string; profile?: string; seed: string }): Sim[] {
  let pool = sims();
  if (opts.profile) pool = pool.filter((s) => s.profile === opts.profile);
  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    pool = pool.filter((s) => [...s.ids].sort().join("+").toLowerCase().includes(needle));
  }
  // One fixed order for a given seed: the same N scenarios every run, spread
  // across occasions rather than the first N of one.
  const ordered = [...pool].sort((a, b) => {
    const d = fnv1a(`${opts.seed}:${a.id}`) - fnv1a(`${opts.seed}:${b.id}`);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  return ordered.slice(0, opts.count);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r, ri) =>
      r
        .map((cell, i) => (i === 0 ? (cell ?? "").padEnd(widths[i]) : (cell ?? "").padStart(widths[i])))
        .join("  ")
        .trimEnd() + (ri === 0 ? `\n${widths.map((w) => "-".repeat(w)).join("  ")}` : ""),
    )
    .join("\n");
}

const yn = (b: boolean) => (b ? "yes" : "no");

function printScenarios(records: ScenarioRecord[]): void {
  const rows: string[][] = [
    ["scenario", "prof", "issues", "lint", "guard", "probs", "stu", "words/max", "contr", "I-run", "canned", "pleas"],
  ];
  for (const r of records) {
    if (!r.ok || !r.pre || !r.post) {
      rows.push([`${r.id} ${r.boxes.join("+")}`, r.profile, "ERROR", "-", "-", "-", "-", "-", "-", "-", "-", "-"]);
      continue;
    }
    const g = !r.review ? "off" : r.review.error ? "err" : r.review.applied ? "ACCEPT" : r.review.rejected ? "REJECT" : "-";
    rows.push([
      `${r.id} ${r.boxes.join("+")}`,
      r.profile,
      `${r.pre.issues.length}→${r.post.issues.length}`,
      `${r.pre.lintForReview.length}→${r.post.lintForReview.length}`,
      g,
      r.review ? String(r.review.problems) : "-",
      r.review ? String(r.review.needsStudent) : "-",
      `${r.post.voice.words}/${r.ceiling}`,
      `${r.pre.voice.contractions}→${r.post.voice.contractions}`,
      `${r.pre.voice.longestIRun}→${r.post.voice.longestIRun}`,
      `${r.pre.voice.cannedCount}→${r.post.voice.cannedCount}`,
      `${r.pre.voice.opensOnPleasantry ? "Y" : "n"}→${r.post.voice.opensOnPleasantry ? "Y" : "n"}`,
    ]);
  }
  console.log(table(rows));
}

function printDetail(records: ScenarioRecord[]): void {
  for (const r of records) {
    console.log(`\n── ${r.id} [${r.profile}] ${r.boxes.join("+")} · ${r.summary}`);
    if (!r.ok || !r.post) {
      console.log(`   ERROR: ${r.error}`);
      continue;
    }
    const rv = r.review;
    console.log(
      rv
        ? `   review: ${rv.error ? `failed (${rv.error})` : rv.applied ? "edit APPLIED" : `edit REJECTED — ${rv.rejected}`}` +
            `${rv.retried ? " (after one retry)" : ""}${rv.retrySkippedForTime ? " (retry skipped: over the retry window)" : ""}` +
            ` · ${rv.problems} problems, ${rv.needsStudent} for the student`
        : "   review: off (--no-review)",
    );
    const v = r.post.voice;
    console.log(
      `   voice (final): ${v.words} words / ceiling ${r.ceiling} · ${v.contractions} contractions (${v.contractionRate}/100w) · ` +
        `longest I-run ${v.longestIRun} · canned ${v.cannedCount} · opens on a pleasantry: ${yn(v.opensOnPleasantry)}`,
    );
    for (const [name, line] of Object.entries(v.canned)) if (line) console.log(`   canned ${name}: "${line}"`);
    if (r.post.issues.length) console.log(r.post.issues.map((i) => `   issue: ${i}`).join("\n"));
    if (r.post.lintForReview.length) console.log(r.post.lintForReview.map((i) => `   lint: ${i}`).join("\n"));
    if (r.post.lintForStudent.length) console.log(r.post.lintForStudent.map((i) => `   lint (student): ${i}`).join("\n"));
    if (r.blockedLanguage) console.log("   BLOCKED LANGUAGE in the final email (the app would have thrown here)");
    console.log(`   Subject: ${r.subject}\n${(r.body ?? "").split("\n").map((l) => `   | ${l}`).join("\n")}`);
  }
}

function printAggregate(agg: Aggregate, records: ScenarioRecord[]): void {
  console.log("\n===== AGGREGATE =====");
  const rows: string[][] = [["metric", "value"]];
  for (const [k, v] of Object.entries(agg)) rows.push([k, String(v)]);
  console.log(table(rows));
  const reasons = new Map<string, number>();
  for (const r of records) if (r.review?.rejected) reasons.set(r.review.rejected, (reasons.get(r.review.rejected) ?? 0) + 1);
  if (reasons.size) {
    console.log("\nGuard rejections, verbatim:");
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${reason}`);
  }
  const kinds = new Map<string, number>();
  for (const r of records) for (const [k, n] of Object.entries(r.review?.kinds ?? {})) kinds.set(k, (kinds.get(k) ?? 0) + n);
  if (kinds.size) {
    console.log("\nReview problem kinds:");
    for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${k}`);
  }
  const [, examples] = repeatedSentences(records.filter((r) => r.ok).map((r) => r.body ?? ""));
  if (examples.length) {
    console.log("\nSentences shared word for word by more than one email (final):");
    for (const e of examples.slice(0, 10)) console.log(`  ${e}`);
  }
}

function printComparison(baselinePath: string, current: { aggregate: Aggregate; scenarios: ScenarioRecord[] }): void {
  const base = JSON.parse(readFileSync(baselinePath, "utf8")) as { aggregate?: Aggregate; scenarios?: ScenarioRecord[]; meta?: Record<string, unknown> };
  if (!base.aggregate) throw new Error(`${baselinePath} has no "aggregate" block - is it a --json run of this script?`);
  const keys = [...new Set([...Object.keys(base.aggregate), ...Object.keys(current.aggregate)])];
  const rows = keys.map((k) => {
    const b = base.aggregate![k];
    const c = current.aggregate[k];
    const delta = typeof b === "number" && typeof c === "number" ? Number((c - b).toFixed(4)) : NaN;
    return { k, b, c, delta, changed: !(typeof b === "number" && typeof c === "number" && b === c) };
  });
  // The metrics that moved come first - that is the whole point of this mode.
  rows.sort((x, y) => {
    if (x.changed !== y.changed) return x.changed ? -1 : 1;
    return Math.abs(y.delta || 0) - Math.abs(x.delta || 0);
  });
  console.log(`\n===== COMPARED WITH ${baselinePath} =====`);
  const baseIds = (base.scenarios ?? []).map((s) => s.id).sort().join(",");
  const curIds = current.scenarios.map((s) => s.id).sort().join(",");
  if (baseIds !== curIds) {
    console.log(`WARNING: the two runs cover different scenarios, so these deltas mix a change in the pipeline with a change in the sample.`);
    console.log(`  baseline: ${baseIds || "(none recorded)"}`);
    console.log(`  current:  ${curIds}`);
  }
  console.log(
    table([
      ["metric", "baseline", "current", "delta"],
      ...rows.map((r) => [
        r.changed ? `* ${r.k}` : `  ${r.k}`,
        r.b === undefined ? "-" : String(r.b),
        r.c === undefined ? "-" : String(r.c),
        Number.isNaN(r.delta) ? "-" : r.delta > 0 ? `+${r.delta}` : String(r.delta),
      ]),
    ]),
  );
  console.log(`\n${rows.filter((r) => r.changed).length} of ${rows.length} metrics moved (marked *).`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

/**
 * The model this rig drafts with, read from the registry rather than named here.
 *
 * It was the literal "claude-sonnet-5-5" until 13 October 2026, with no comment,
 * while lib/model-registry shipped `claude-sonnet-5` - so every measurement
 * taken with this script described a model production does not run. The
 * RELATIVE comparisons survive that (both arms of an A/B used the same model,
 * so a prompt change's effect is still its effect) but the absolute figures did
 * not: "59 of 63 would reply" was Sonnet 5.5's output, not what a student gets.
 *
 * This is the fifth component found choosing a model independently of the
 * registry in two days, after a hardcoded review config, a hardcoded model in
 * help-knowledge-learn, helpMessageParams dropping effort and thinking, and
 * draft-pipeline rebuilding the thinking parameter by hand. The registry is
 * server-only and this script runs under --conditions=react-server, so it can
 * simply ask.
 *
 * `--model` still overrides it, which is how a model A/B is run - and an
 * overridden run says so in its output and its --json, so a number can never
 * again be quoted as production's without that being visible.
 */
const DEFAULT_MODEL = getModelConfig("draft", "free").model;

async function main() {
  if (flag("help") !== undefined) {
    console.log(
      [
        "npx tsx --conditions=react-server scripts/draft-cli-eval.ts [flags]",
        "",
        "  --scenarios=N        how many situations to draft (default 3)",
        "  --filter=<substring> only situations whose sorted box mix contains this (e.g. first.alum)",
        "  --profile=full|sparse  only one answer profile",
        "  --seed=<string>      fixes which situations are chosen (default \"offerly\")",
        "  --concurrency=N      situations in flight at once (default 4; each spawns a claude process)",
        "  --model=<id>         CLI model (default " + DEFAULT_MODEL + ")",
        "  --timeout=<ms>       per model call (default 180000)",
        "  --retry-before=<ms>  the guard retry window the pipeline applies (default 60000)",
        "  --no-review          draft only, no review pass or guard",
        "  --json=<path>        one record per scenario plus the aggregate block",
        "  --compare=<path>     per-metric delta against an earlier --json run",
        "  --quiet              aggregate only, no per-scenario detail",
      ].join("\n"),
    );
    return;
  }

  assertSchemaMatchesPipeline();

  const opts: RunOptions = {
    model: flag("model") || DEFAULT_MODEL,
    review: flag("no-review") === undefined,
    timeoutMs: Number(flag("timeout") || 180_000),
    reviewRetryBeforeMs: Number(flag("retry-before") || 60_000),
  };
  const count = Number(flag("scenarios") || 3);
  const concurrency = Math.max(1, Number(flag("concurrency") || 4));
  const seed = flag("seed") || "offerly";
  const chosen = chooseScenarios({ count, filter: flag("filter") || undefined, profile: flag("profile") || undefined, seed });
  if (!chosen.length) throw new Error("no situations matched --filter/--profile.");

  console.log("draft-cli-eval — quality only, on the Claude CLI (subscription), never the API.");
  console.log(
    [
      `model ${opts.model} (the CLI exposes no effort, thinking or fast-mode controls, so this is NOT the app's model config)`,
      "durations below are CLI durations: they include process startup and say nothing about production latency",
      "no PDF document blocks over the CLI, so every draft runs the studentResumeSummary path, never the resume-PDF path",
      "costUsd is subscription accounting - what the same tokens would have cost on the API, not a charge",
      `review pass ${opts.review ? "on" : "OFF"} · ${chosen.length} situations, ${concurrency} at a time · seed "${seed}"`,
    ]
      .map((l) => `  · ${l}`)
      .join("\n"),
  );
  console.log("");

  const records: ScenarioRecord[] = [];
  for (let i = 0; i < chosen.length; i += concurrency) {
    const batch = await Promise.all(
      chosen.slice(i, i + concurrency).map(async (sim) => {
        try {
          return scenarioRecord(sim, await runPipelineViaCli(sim, opts));
        } catch (err) {
          return scenarioRecord(sim, null, err instanceof Error ? err.message : String(err));
        }
      }),
    );
    records.push(...batch);
    console.log(`${records.length}/${chosen.length} drafted`);
  }
  records.sort((a, b) => a.id.localeCompare(b.id));

  console.log("");
  printScenarios(records);
  // Failures are printed whatever else is suppressed: a scenario that errored
  // is a finding, and a rig that hides the reason is worth nothing.
  const failed = records.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n${failed.length} scenario${failed.length === 1 ? "" : "s"} failed:`);
    for (const r of failed) console.log(`  ${r.id} [${r.profile}] ${r.boxes.join("+")}: ${r.error}`);
  }
  if (flag("quiet") === undefined) printDetail(records);
  const agg = aggregate(records);
  printAggregate(agg, records);

  const payload = {
    meta: {
      script: "scripts/draft-cli-eval.ts",
      ranAt: new Date().toISOString(),
      transport: "claude CLI (subscription)",
      model: opts.model,
      review: opts.review,
      seed,
      scenarios: count,
      filter: flag("filter") || null,
      profile: flag("profile") || null,
      caveat: "quality only; durations are CLI durations, not production latency; studentResumeSummary path only",
    },
    aggregate: agg,
    scenarios: records,
  };
  const jsonPath = flag("json");
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    console.log(`\nJSON written to ${jsonPath}`);
  }
  const comparePath = flag("compare");
  if (comparePath) printComparison(comparePath, payload);

  if (records.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
