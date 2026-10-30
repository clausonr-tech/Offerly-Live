import "server-only";

import { execFileSync } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";
import { attemptConfig, isCapacityError } from "../../ai-runner";
import { getAnthropicClient } from "../../anthropic-client";
import { getModelConfig, nextFallbackModel, type Plan } from "../../model-registry";
import type { RequestBudget } from "./budget";
import { GRADING_REQUEST_OPTIONS, GRADING_RUBRIC_VERSION, REFUSAL, gradingFeature, gradingPromptHash, gradingRequest, type ModelCall } from "../grading";
import { transcriptionConfigFromEnv } from "../transcription";
import type { EvalMode, EvalReport } from "./runner";

/**
 * The evaluator's live model call: the production request (gradingRequest)
 * and the production routing and fallback chain (getModelConfig,
 * attemptConfig, nextFallbackModel) - on no student's account and no
 * student's quota.
 *
 * It walks the chain itself instead of using runBackgroundAiFeature, so that
 * EVERY request is counted and capped: the SDK's own retries are switched
 * off (maxRetries 0 - one call is one HTTP request), and each attempt, retry
 * and fallback claims a request from the budget first. When the budget is
 * spent it throws RequestLimitReached without starting another request.
 * Records which model actually answered each call.
 */
export function evalGradeCall(
  plan: Plan,
  observed: Map<string, number>,
  budget: RequestBudget,
  opts: {
    retriesPerModel?: number;
    client?: () => Pick<Anthropic, "messages">;
    isRetryable?: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): ModelCall {
  const retries = opts.retriesPerModel ?? 1;
  const retryable = opts.isRetryable ?? isCapacityError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async ({ kind, system, user }) => {
    const client = (opts.client ?? getAnthropicClient)();
    const base = getModelConfig(gradingFeature(kind), plan);
    let model: string | null = base.model;
    let first = true;
    let lastError: unknown;
    while (model) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        // Claimed BEFORE the request; throws (starting nothing) at the limit.
        const req = budget.begin("anthropic", first ? "first" : attempt > 0 ? "retry" : "fallback");
        first = false;
        try {
          const response = await client.messages.parse(gradingRequest(attemptConfig(base, model), system, user), { ...GRADING_REQUEST_OPTIONS, maxRetries: 0 });
          req.ok();
          const answered = (response as { model?: string }).model ?? model;
          observed.set(answered, (observed.get(answered) ?? 0) + 1);
          if (response.stop_reason === "refusal") return REFUSAL;
          return response.parsed_output;
        } catch (err) {
          req.fail();
          if (!retryable(err)) throw err;
          lastError = err;
          if (attempt < retries) await sleep(1000 * 2 ** attempt);
        }
      }
      model = nextFallbackModel(model);
    }
    throw new Error("Grading model at capacity across the fallback chain.", { cause: lastError });
  };
}

function gitCommit(): { commit: string | null; dirty: boolean | null } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const status = execFileSync("git", ["status", "--porcelain"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

/**
 * Everything that identifies what a report measured. Two reports are only
 * comparable when these match (or differ in exactly the thing being
 * compared). Never contains a key or a full endpoint URL with credentials.
 */
export function reportMeta(input: { mode: EvalMode; runs: number; plan: Plan; manifestName: string; manifestSha256: string; items: number; dryRun: boolean }) {
  const stt = transcriptionConfigFromEnv();
  const host = stt ? new URL(stt.baseUrl).host : null;
  return {
    reportVersion: 1,
    timestamp: new Date().toISOString(),
    mode: input.mode,
    dryRun: input.dryRun,
    runs: input.runs,
    code: gitCommit(),
    manifest: { name: input.manifestName, sha256: input.manifestSha256, items: input.items },
    transcription: input.dryRun
      ? { provider: "dry-run stub", model: null, host: null }
      : stt
        ? { provider: host?.includes("groq") ? "groq (openai-compatible)" : "openai-compatible", host, model: stt.model, responseFormat: stt.responseFormat, language: stt.language }
        : { provider: "unconfigured", model: null, host: null },
    grader: {
      provider: input.dryRun ? "dry-run stub" : "anthropic",
      plan: input.plan,
      models: { technical: getModelConfig("technicalGrading", input.plan).model, behavioral: getModelConfig("behavioralFeedback", input.plan).model },
      rubricVersion: GRADING_RUBRIC_VERSION,
      promptHash: gradingPromptHash(),
    },
  };
}

const f = (n: unknown) => (n === null || n === undefined ? "–" : typeof n === "number" ? String(n) : String(n));

/** The report as Markdown: aggregates and fixture counts only. */
export function renderMarkdown(r: EvalReport): string {
  const m = r.meta as ReturnType<typeof reportMeta> & { modelsObserved?: Record<string, number> };
  const lines: string[] = [];
  lines.push(`# Video interview evaluation — ${r.mode}`, "");
  if (m.dryRun) lines.push("> **DRY RUN** — stub providers. The pipeline and manifest were exercised; the metrics below are NOT meaningful.", "");
  if (r.incomplete) lines.push(`> **STOPPED EARLY** — ${r.incomplete.reason} (${r.incomplete.limit}). Metrics cover completed cases only.`, "");
  lines.push(
    "| | |",
    "|---|---|",
    `| Timestamp | ${m.timestamp} |`,
    `| Code | ${f(m.code?.commit)}${m.code?.dirty ? " (uncommitted changes)" : ""} |`,
    `| Manifest | ${m.manifest.name} (${m.manifest.items} items, sha256 ${m.manifest.sha256.slice(0, 12)}) |`,
    `| Transcription | ${m.transcription.provider} ${f(m.transcription.model)} |`,
    `| Grader | ${m.grader.provider}, plan ${m.grader.plan}: technical ${m.grader.models.technical}, behavioral ${m.grader.models.behavioral} |`,
    `| Models that answered | ${m.modelsObserved ? Object.entries(m.modelsObserved).map(([k, v]) => `${k} ×${v}`).join(", ") : "–"} |`,
    `| Rubric / prompt hash | ${m.grader.rubricVersion} / ${m.grader.promptHash} |`,
    `| Runs | ${m.runs} |`,
    `| Cases (logical) | planned ${r.estimate.asrCases} transcription + ${r.estimate.gradingCases} grading; completed ${r.cases ? `${r.cases.completed.asr} + ${r.cases.completed.grading}` : "–"} |`,
    `| Provider requests (actual) | ${r.requests ? `${r.requests.attempted} attempted of ${r.requests.limit} allowed: ${r.requests.succeeded} ok, ${r.requests.failed} failed, ${r.requests.retried} retries, ${r.requests.fallback} fallbacks, ${r.requests.refusedByLimit} refused by the limit` : "none (dry run)"} |`,
    "",
  );
  if (r.asr) {
    const s = r.asr.summary;
    const p3 = (x: { precision: number | null; recall: number | null; f1: number | null } | null) => (x ? `P ${f(x.precision)} / R ${f(x.recall)} / F1 ${f(x.f1)}` : "–");
    lines.push("## 1. Transcript accuracy (recording → transcript)", "", "Public read-speech datasets measure transcription only. They say nothing about how well interviews are graded.", "", "| Metric | Value |", "|---|---|");
    for (const [k, v] of Object.entries(s)) {
      if (k === "numbers" || k === "currency") lines.push(`| ${k} (amount${k === "currency" ? " + unit" : ""}) | ${p3(v as never)} |`);
      else if (k === "fillers") lines.push(`| fillers (verbatim references only) | ${v ? `${(v as { items: number }).items} item(s): ${p3(v as never)}` : "not reported - no verbatim references"} |`);
      else lines.push(`| ${k} | ${f(v)} |`);
    }
    lines.push(`| werStdDevAcrossRuns | ${f(r.asr.werStdDevAcrossRuns)} |`, "");
    for (const [group, buckets] of Object.entries(r.asr.groups)) {
      lines.push(`### By ${group}`, "", "| Slice | n | Corpus WER | Number F1 | Failed |", "|---|---|---|---|---|");
      for (const [k, v] of Object.entries(buckets)) lines.push(`| ${k} | ${v.transcriptions} | ${f(v.corpusWer)} | ${f(v.numbers.f1)} | ${f(v.failedRate)} |`);
      lines.push("");
    }
  }
  const graderTable = (title: string, g: NonNullable<EvalReport["grader"]>["primary"]) => {
    lines.push(`## ${title}`, "", "| Metric | Value |", "|---|---|");
    lines.push(`| Items / graded | ${g.items} / ${g.graded} |`, `| Overall MAE | ${f(g.overallMae)} |`, `| Spearman | ${f(g.spearman)} |`, `| Class macro-F1 | ${f(g.classMacroF1)} |`, `| Class accuracy | ${f(g.classAccuracy)} |`);
    lines.push(`| Expected points P / R / F1 | ${f(g.expectedPoints.precision)} / ${f(g.expectedPoints.recall)} / ${f(g.expectedPoints.f1)} |`);
    lines.push(`| Factual-error detection P / R | ${f(g.factualErrorDetection.precision)} / ${f(g.factualErrorDetection.recall)} |`);
    for (const [e, v] of Object.entries(g.star)) lines.push(`| STAR ${e} P / R / F1 | ${f(v.precision)} / ${f(v.recall)} / ${f(v.f1)} |`);
    for (const [d, v] of Object.entries(g.dimensionMae)) lines.push(`| MAE ${d} | ${f(v)} |`);
    lines.push(`| Outcomes | ${Object.entries(g.outcomeRates).map(([k, v]) => `${k} ${v}`).join(", ")} |`, "");
  };
  if (r.delivery) {
    const p3 = (x: { precision: number | null; recall: number | null; f1: number | null } | null | undefined) => (x ? `P ${f(x.precision)} / R ${f(x.recall)} / F1 ${f(x.f1)}` : "–");
    const col = (d: typeof r.delivery.onReferenceTranscript) => ({
      wpm: d?.wordsPerMinute ? `MAE ${f(d.wordsPerMinute.meanAbsoluteError)}, bias ${f(d.wordsPerMinute.meanSignedError)} (${d.wordsPerMinute.items})` : "–",
      pauses: d?.pauses ? `${p3(d.pauses.all)} (${d.pauses.items}; ${d.pauses.itemsWithoutTimestamps} untimed)` : "–",
      longPauses: d?.pauses ? p3(d.pauses.long) : "–",
      boundary: d?.pauses ? f(d.pauses.meanBoundaryErrorSec) : "–",
      fillers: d?.fillers ? `${p3(d.fillers.all)} (${d.fillers.items})` : "–",
      phrases: d?.repeatedPhrases ? p3(d.repeatedPhrases) : "–",
      disfluencies: d?.disfluencies ? p3(d.disfluencies.all) : "–",
      repetition: d?.disfluencies ? p3(d.disfluencies.repetition) : "–",
      cutoff: d?.disfluencies ? p3(d.disfluencies.cutoff) : "–",
      pace: d?.scoreError.pacePauses ? `MAE ${f(d.scoreError.pacePauses.meanAbsoluteError)}, bias ${f(d.scoreError.pacePauses.meanSignedError)}` : "–",
      fill: d?.scoreError.fillers ? `MAE ${f(d.scoreError.fillers.meanAbsoluteError)}, bias ${f(d.scoreError.fillers.meanSignedError)}` : "–",
    });
    const a = col(r.delivery.onReferenceTranscript);
    const b = col(r.delivery.onAsrTranscript);
    lines.push(
      "## 2. Delivery-signal accuracy (production detectors vs human annotation)",
      "",
      `${r.delivery.annotatedItems} item(s) carry human-verified delivery annotations. On the verified transcript, errors are the detectors' own; on the ASR transcript they include transcription and timestamp errors. Timing-based signals - words per minute, pauses and the pace score - need word timings, so they are measured on the ASR transcript only (an ASR transcript without timestamps counts every annotated pause as missed).`,
      "",
      `| Signal | On verified transcript | On ASR transcript (pooled over ${r.delivery.asrRuns.length} run${r.delivery.asrRuns.length === 1 ? "" : "s"}) |`,
      "|---|---|---|",
      `| Words per minute | ${a.wpm} | ${b.wpm} |`,
      `| Pauses (≥1.5s) | ${a.pauses} | ${b.pauses} |`,
      `| Long pauses (≥3s) | ${a.longPauses} | ${b.longPauses} |`,
      `| Pause boundary error (s) | ${a.boundary} | ${b.boundary} |`,
      `| Fillers | ${a.fillers} | ${b.fillers} |`,
      `| Repeated phrases | ${a.phrases} | ${b.phrases} |`,
      `| Disfluencies (est.) | ${a.disfluencies} | ${b.disfluencies} |`,
      `| — repeated words | ${a.repetition} | ${b.repetition} |`,
      `| — cut-off / restarted | ${a.cutoff} | ${b.cutoff} |`,
      `| Pace & pauses score error | ${a.pace} | ${b.pace} |`,
      `| Filler score error | ${a.fill} | ${b.fill} |`,
      "",
    );
    const runs = r.delivery.asrRuns;
    if (runs.length > 1) {
      lines.push(
        "### Delivery on the ASR transcript, per run",
        "",
        "The verified-transcript column does not vary by run. These do - their spread is the transcriber's instability.",
        "",
        "| Run | Items | Failed | WPM MAE | Pause F1 | Long-pause F1 | Filler F1 | Repeated-phrase F1 | Repetition F1 | Cut-off F1 | Disfluency F1 | Pace score MAE | Filler score MAE |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
      );
      for (const x of runs) {
        lines.push(`| ${x.run + 1} | ${x.items} | ${x.failedTranscriptions.length} | ${f(x.wpmMae)} | ${f(x.pauseF1)} | ${f(x.longPauseF1)} | ${f(x.fillerF1)} | ${f(x.repeatedPhraseF1)} | ${f(x.repetitionF1)} | ${f(x.cutoffF1)} | ${f(x.disfluencyF1)} | ${f(x.paceScoreMae)} | ${f(x.fillerScoreMae)} |`);
      }
      lines.push("", "| Metric | Min | Max | Range | SD across runs |", "|---|---|---|---|---|");
      for (const [k, v] of Object.entries(r.delivery.acrossRuns)) if (v) lines.push(`| ${k} | ${v.min} | ${v.max} | ${v.range} | ${v.stdDev} |`);
      lines.push("");
    }
    const failedByRun = runs.filter((x) => x.failedTranscriptions.length).map((x) => `run ${x.run + 1}: ${x.failedTranscriptions.join(", ")}`);
    if (failedByRun.length) lines.push(`Failed transcriptions, excluded from their run: ${failedByRun.join("; ")}.`, "");
  }
  if (r.grader) {
    graderTable("3. Claude grading accuracy (verified transcript → grading)", r.grader.primary);
    const rp = r.grader.repeatability;
    lines.push(`Repeatability over ${rp.runs} run(s): mean score SD ${f(rp.meanScoreStdDev)}, max ${f(rp.maxScoreStdDev)}, classification flip rate ${f(rp.classificationFlipRate)}.`, "");
  }
  if (r.endToEnd) {
    graderTable("3. Claude grading accuracy (verified transcript → grading)", r.endToEnd.reference);
    graderTable("4. End-to-end grade accuracy (recording → ASR transcript → grading)", r.endToEnd.asrTranscript);
    const d = r.endToEnd.delta;
    lines.push("### What the transcript costs the grade (section 4 minus section 3)", "", "| Metric | Δ |", "|---|---|");
    for (const [k, v] of Object.entries(d)) lines.push(`| ${k} | ${f(v)} |`);
    lines.push("");
  }
  if (r.humanAgreement) {
    const h = r.humanAgreement;
    lines.push("## Human–human agreement (the ceiling)", "", `${h.reviewPairs} reviewer pair(s) across all blind reviews. Overall MAE ${f(h.overallMae)}, Spearman ${f(h.spearman)}, class agreement ${f(h.classAgreement)}, Cohen's κ ${f(h.cohenKappa)}.`, "");
  }
  lines.push("Per-item results are in the JSON report, by fixture id. No transcripts are included unless the run used --debug.", "");
  return lines.join("\n");
}
