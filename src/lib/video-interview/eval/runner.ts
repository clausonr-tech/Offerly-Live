import "server-only";

import { computeDeliveryMetrics, type TimedWord } from "../delivery-metrics";
import { classifyScore, gradeSpokenAnswerDetailed, type ModelCall, type ScoreClass } from "../grading";
import type { TranscriptionProvider } from "../transcription";
import {
  prf,
  graderMetrics,
  humanAgreement,
  mean,
  repeatability,
  stdDev,
  transcriptSourceDelta,
  type GradedItem,
  type GraderMetrics,
} from "./grader-metrics";
import { RUBRIC_DIMENSIONS, type Manifest, type ManifestItem } from "./manifest";
import { currencyCounts, fillerCounts, normalizeForWer, numberCounts, phraseRecall, timestampCoverage, wer, wordErrors, type Counts } from "./text-metrics";
import { RequestLimitReached, type RequestBudget } from "./budget";
import { evaluateDeliveryItem, summarizeDelivery, type DeliverySummary } from "./delivery-eval";

/**
 * The evaluator: three stages, measured separately.
 *
 *   asr         recording -> transcript (the production transcriber)
 *   grader      VERIFIED reference transcript -> grading
 *   end-to-end  recording -> transcript -> grading, reported against the
 *               reference-transcript grading of the same items
 *
 * Every step is the production code: the same transcriber class, the same
 * delivery metrics, the same prompt builder, parser and score combination
 * (gradeSpokenAnswerDetailed). Only the model CALL is injected - the CLI
 * gives it one that routes like production but on no student's account or
 * quota, and tests give it a stub.
 *
 * Nothing here touches the database, and the report holds fixture ids and
 * numbers only. Transcripts appear in the report only with `debug`.
 */

/** Passed to the model call's userId slot. Not a database user - the
 *  evaluator's call never reads it and nothing meters against it. */
const EVAL_USER_ID = "00000000-0000-0000-0000-00000000e7a1";

export type EvalMode = "asr" | "grader" | "end-to-end";

export type EvalDeps = {
  transcriber: TranscriptionProvider;
  gradeCall: ModelCall;
  readMedia: (item: ManifestItem) => Promise<{ bytes: Buffer; contentType: string; filename: string }>;
  /** Live runs: the cap on actual provider requests, shared by every call. */
  budget?: RequestBudget;
};

export type EvalOptions = { mode: EvalMode; runs: number; maxItems?: number; debug?: boolean };

/** The items a mode evaluates, in manifest order, capped by maxItems. */
export function selectItems(manifest: Manifest, mode: EvalMode, maxItems?: number): ManifestItem[] {
  const fits = (i: ManifestItem) =>
    mode === "asr" ? i.tasks.includes("asr") : mode === "grader" ? i.tasks.includes("grader") : i.tasks.includes("asr") && i.tasks.includes("grader");
  const items = manifest.items.filter(fits);
  return maxItems && maxItems > 0 ? items.slice(0, maxItems) : items;
}

/**
 * The logical CASES a run will evaluate: each is one transcription or one
 * grading. Each case costs at least one provider REQUEST, and more when a
 * request is retried or falls back to another model - so `minimumRequests`
 * is a floor, and --max-calls caps the real count at run time.
 */
export function estimateCalls(items: ManifestItem[], mode: EvalMode, runs: number) {
  const n = items.length;
  const asrCases = mode === "grader" ? 0 : n * runs;
  // End-to-end grades each item twice per run: reference, then ASR transcript.
  const gradingCases = mode === "asr" ? 0 : mode === "grader" ? n * runs : 2 * n * runs;
  const audioSeconds = mode === "grader" ? 0 : items.reduce((s, i) => s + (i.durationSec ?? 0), 0) * runs;
  return { items: n, runs, asrCases, gradingCases, totalCases: asrCases + gradingCases, minimumRequests: asrCases + gradingCases, audioMinutes: Math.round((audioSeconds / 60) * 10) / 10 };
}

// ---------------------------------------------------------------- ASR

type AsrResult = {
  id: string;
  run: number;
  ok: boolean;
  empty: boolean;
  text: string | null;
  words: TimedWord[] | null;
  counts: ReturnType<typeof wordErrors> | null;
  wer: number | null;
  numbers: Counts;
  currency: Counts;
  /** Only for verbatim references (verbatimFillers). */
  fillers: Counts | null;
  financeTerms: { matched: number; total: number };
  entities: { matched: number; total: number };
  timestampCoverage: number;
};

async function transcribeItem(item: ManifestItem, run: number, deps: EvalDeps): Promise<AsrResult> {
  const refTokens = normalizeForWer(item.referenceTranscript);
  const blank = { matched: 0, total: 0 };
  const none: Counts = { tp: 0, fp: 0, fn: 0 };
  try {
    const media = await deps.readMedia(item);
    const r = await deps.transcriber.transcribe(media);
    const hypTokens = normalizeForWer(r.text);
    const counts = wordErrors(refTokens, hypTokens);
    return {
      id: item.id,
      run,
      ok: true,
      empty: hypTokens.length === 0,
      text: r.text,
      words: r.words,
      counts,
      wer: wer(counts),
      numbers: numberCounts(refTokens, hypTokens),
      currency: currencyCounts(refTokens, hypTokens),
      fillers: item.verbatimFillers ? fillerCounts(item.referenceTranscript, r.text) : null,
      financeTerms: item.annotations?.financeTerms ? phraseRecall(item.annotations.financeTerms, r.text) : blank,
      entities: item.annotations?.namedEntities ? phraseRecall(item.annotations.namedEntities, r.text) : blank,
      timestampCoverage: timestampCoverage(r.words, hypTokens.length),
    };
  } catch (err) {
    // Hitting the request limit stops the run; it is not a failed transcription.
    if (err instanceof RequestLimitReached) throw err;
    // The error itself can carry request details; only the fact is kept.
    return { id: item.id, run, ok: false, empty: true, text: null, words: null, counts: null, wer: null, numbers: none, currency: none, fillers: null, financeTerms: blank, entities: blank, timestampCoverage: 0 };
  }
}

const ratio = (m: { matched: number; total: number }[]) => {
  const total = m.reduce((s, x) => s + x.total, 0);
  return total ? Math.round((m.reduce((s, x) => s + x.matched, 0) / total) * 1000) / 1000 : null;
};

/** Micro precision/recall/F1 over many items' tp/fp/fn. */
const sumPrf = (cs: Counts[]) => prf(cs.reduce((s, c) => s + c.tp, 0), cs.reduce((s, c) => s + c.fp, 0), cs.reduce((s, c) => s + c.fn, 0));

function summarizeAsr(results: AsrResult[]) {
  const ok = results.filter((r) => r.ok && r.counts);
  const sum = (k: "substitutions" | "insertions" | "deletions" | "refWords") => ok.reduce((s, r) => s + r.counts![k], 0);
  const refWords = sum("refWords");
  const errors = sum("substitutions") + sum("insertions") + sum("deletions");
  const r3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);
  return {
    transcriptions: results.length,
    corpusWer: refWords ? r3(errors / refWords) : null,
    meanItemWer: r3(mean(ok.map((r) => r.wer).filter((w): w is number => w !== null))),
    substitutions: sum("substitutions"),
    insertions: sum("insertions"),
    deletions: sum("deletions"),
    referenceWords: refWords,
    numbers: sumPrf(ok.map((r) => r.numbers)),
    currency: sumPrf(ok.map((r) => r.currency)),
    fillers: ok.some((r) => r.fillers) ? { items: ok.filter((r) => r.fillers).length, ...sumPrf(ok.flatMap((r) => (r.fillers ? [r.fillers] : []))) } : null,
    financeTermRecall: ratio(ok.map((r) => r.financeTerms)),
    namedEntityRecall: ratio(ok.map((r) => r.entities)),
    meanTimestampCoverage: r3(mean(ok.map((r) => r.timestampCoverage))),
    withTimestampsRate: results.length ? r3(ok.filter((r) => r.words && r.words.length > 0).length / results.length) : null,
    emptyRate: results.length ? r3(results.filter((r) => r.ok && r.empty).length / results.length) : null,
    failedRate: results.length ? r3(results.filter((r) => !r.ok).length / results.length) : null,
  };
}

/** Results grouped by dataset and by each slice. Accent groups exist only
 *  where the dataset supplied an accent. */
function groupAsr(results: AsrResult[], items: Map<string, ManifestItem>) {
  const groups: Record<string, Record<string, ReturnType<typeof summarizeAsr>>> = {};
  const keys: [string, (i: ManifestItem) => string | null][] = [
    ["dataset", (i) => i.source.dataset],
    ["audio", (i) => i.slices.audio],
    ["accent", (i) => (i.slices.accentSource === "dataset" ? i.slices.accent : null)],
    ["speakingSpeed", (i) => i.slices.speakingSpeed],
    ["answerLength", (i) => i.slices.answerLength],
  ];
  for (const [name, key] of keys) {
    const buckets = new Map<string, AsrResult[]>();
    for (const r of results) {
      const k = key(items.get(r.id)!);
      if (k === null) continue;
      buckets.set(k, [...(buckets.get(k) ?? []), r]);
    }
    if (buckets.size) groups[name] = Object.fromEntries([...buckets].map(([k, rs]) => [k, summarizeAsr(rs)]));
  }
  return groups;
}

// ---------------------------------------------------------------- grading

type GradeResult = { id: string; run: number; outcome: string; overall: number | null; classification: ScoreClass | null; graded: GradedItem; summary: string };

async function gradeItem(item: ManifestItem, run: number, transcript: { text: string; words: TimedWord[] | null }, deps: EvalDeps): Promise<GradeResult> {
  const q = item.question!;
  const delivery = computeDeliveryMetrics({ transcript: transcript.text, durationMs: (item.durationSec ?? 0) * 1000, words: transcript.words });
  const { feedback, outcome, parsed } = await gradeSpokenAnswerDetailed(
    { userId: EVAL_USER_ID, kind: q.kind, prompt: q.prompt, topic: q.topic, difficulty: q.difficulty, expectedPoints: q.expectedPoints, transcript: transcript.text, delivery },
    deps.gradeCall,
  );
  const graded = outcome === "graded";
  const overall = graded ? feedback.overall : null;
  const classification = overall === null ? null : classifyScore(overall);
  const adj = item.adjudicated!;
  return {
    id: item.id,
    run,
    outcome,
    overall,
    classification,
    summary: feedback.summary,
    graded: {
      id: item.id,
      kind: q.kind,
      outcome,
      human: {
        overall: adj.scores.overall,
        scores: Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, adj.scores[d]])) as GradedItem["human"]["scores"],
        classification: adj.classification,
      },
      model: { overall, scores: graded ? feedback.scores : {}, classification },
      expectedCovered: item.expected!.coveredPoints,
      modelCovered: parsed?.coveredPoints ?? null,
      expectedErrorCount: item.expected!.factualErrors.length,
      modelErrorCount: parsed ? parsed.factualErrors.length : null,
      expectedStar: item.expected!.star,
      modelStar: q.kind === "behavioral" && parsed ? parsed.star : null,
    },
  };
}

/** Every pair of blind reviews of every item - with three reviewers, three
 *  pairs - so agreement reflects all of them, not only the first two. */
function reviewPairs(items: ManifestItem[]) {
  const pick = (r: NonNullable<ManifestItem["reviews"]>[number]) => ({
    overall: r.scores.overall,
    scores: Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, r.scores[d]])) as GradedItem["human"]["scores"],
    classification: r.classification,
  });
  return items.flatMap((i) => {
    const rs = i.reviews ?? [];
    const pairs: { a: ReturnType<typeof pick>; b: ReturnType<typeof pick> }[] = [];
    for (let x = 0; x < rs.length; x++) for (let y = x + 1; y < rs.length; y++) pairs.push({ a: pick(rs[x]), b: pick(rs[y]) });
    return pairs;
  });
}

function byItemRuns(results: GradeResult[]) {
  const m = new Map<string, { overall: number | null; classification: ScoreClass | null }[]>();
  for (const r of results) m.set(r.id, [...(m.get(r.id) ?? []), { overall: r.overall, classification: r.classification }]);
  return m;
}

function perRunMetrics(results: GradeResult[], runs: number): GraderMetrics[] {
  return Array.from({ length: runs }, (_, run) => graderMetrics(results.filter((r) => r.run === run).map((r) => r.graded)));
}

// ---------------------------------------------------------------- delivery runs

type DeliveryRunRow = {
  run: number;
  items: number;
  /** Fixture ids whose transcription failed IN THIS RUN (excluded from it). */
  failedTranscriptions: string[];
  wpmMae: number | null;
  pauseF1: number | null;
  longPauseF1: number | null;
  fillerF1: number | null;
  repeatedPhraseF1: number | null;
  /** Repeated-word disfluencies ("I I"). */
  repetitionF1: number | null;
  cutoffF1: number | null;
  disfluencyF1: number | null;
  paceScoreMae: number | null;
  fillerScoreMae: number | null;
};

function deliveryRunRow(run: number, results: NonNullable<ReturnType<typeof evaluateDeliveryItem>>[], failed: string[]): DeliveryRunRow {
  const s = summarizeDelivery(results);
  return {
    run,
    items: results.length,
    failedTranscriptions: failed,
    wpmMae: s.wordsPerMinute?.meanAbsoluteError ?? null,
    pauseF1: s.pauses?.all.f1 ?? null,
    longPauseF1: s.pauses?.long.f1 ?? null,
    fillerF1: s.fillers?.all.f1 ?? null,
    repeatedPhraseF1: s.repeatedPhrases?.f1 ?? null,
    repetitionF1: s.disfluencies?.repetition.f1 ?? null,
    cutoffF1: s.disfluencies?.cutoff.f1 ?? null,
    disfluencyF1: s.disfluencies?.all.f1 ?? null,
    paceScoreMae: s.scoreError.pacePauses?.meanAbsoluteError ?? null,
    fillerScoreMae: s.scoreError.fillers?.meanAbsoluteError ?? null,
  };
}

const RUN_METRICS = ["wpmMae", "pauseF1", "longPauseF1", "fillerF1", "repeatedPhraseF1", "repetitionF1", "cutoffF1", "disfluencyF1", "paceScoreMae", "fillerScoreMae"] as const;

/** For each per-run metric: its spread across runs (null with fewer than two). */
function deliveryVariability(rows: DeliveryRunRow[]) {
  const out = {} as Record<(typeof RUN_METRICS)[number], { runs: number; min: number; max: number; range: number; stdDev: number } | null>;
  for (const k of RUN_METRICS) {
    const vals = rows.map((r) => r[k]).filter((v): v is number => v !== null);
    out[k] =
      vals.length >= 2
        ? { runs: vals.length, min: Math.min(...vals), max: Math.max(...vals), range: Math.round((Math.max(...vals) - Math.min(...vals)) * 1000) / 1000, stdDev: Math.round(stdDev(vals) * 1000) / 1000 }
        : null;
  }
  return out;
}

// ---------------------------------------------------------------- report

export type EvalReport = {
  meta: Record<string, unknown>;
  mode: EvalMode;
  estimate: ReturnType<typeof estimateCalls>;
  /** 1. Transcript accuracy. */
  asr?: { summary: ReturnType<typeof summarizeAsr>; groups: ReturnType<typeof groupAsr>; werStdDevAcrossRuns: number | null };
  /** 2. Delivery-signal accuracy, on the verified and on the ASR transcript. */
  delivery?: {
    annotatedItems: number;
    /** Detectors alone - one computation, it does not vary by ASR run. */
    onReferenceTranscript: DeliverySummary | null;
    /** Pooled over every ASR run. */
    onAsrTranscript: DeliverySummary | null;
    /** The same metrics for each ASR run separately. */
    asrRuns: DeliveryRunRow[];
    /** Spread of each per-run metric across runs. */
    acrossRuns: ReturnType<typeof deliveryVariability>;
    failedTranscriptionsExcluded: number;
  };
  /** 3. Claude grading accuracy, on the verified transcript. */
  grader?: { transcriptSource: "reference"; primary: GraderMetrics; perRun: Pick<GraderMetrics, "overallMae" | "spearman" | "classMacroF1">[]; repeatability: ReturnType<typeof repeatability> };
  /** 4. End-to-end grade accuracy (grading on the ASR transcript). */
  endToEnd?: {
    reference: GraderMetrics;
    asrTranscript: GraderMetrics;
    delta: ReturnType<typeof transcriptSourceDelta>;
    repeatability: { reference: ReturnType<typeof repeatability>; asrTranscript: ReturnType<typeof repeatability> };
  };
  humanAgreement?: ReturnType<typeof humanAgreement>;
  /** Logical cases: planned vs actually completed. */
  cases?: { planned: { asr: number; grading: number }; completed: { asr: number; grading: number } };
  /** Actual provider requests (live runs), including retries and fallbacks. */
  requests?: ReturnType<RequestBudget["summary"]>;
  /** Set when the run stopped at the request limit; metrics cover completed cases only. */
  incomplete?: { reason: string; limit: number | null };
  perItem: Record<string, unknown>[];
  /** Only with debug: transcripts and feedback, for local inspection. */
  debug?: Record<string, unknown>[];
};

export async function runEvaluation(manifest: Manifest, deps: EvalDeps, opts: EvalOptions, meta: Record<string, unknown>): Promise<EvalReport> {
  const runs = Math.max(1, Math.floor(opts.runs));
  const items = selectItems(manifest, opts.mode, opts.maxItems);
  const byId = new Map(items.map((i) => [i.id, i]));
  const estimate = estimateCalls(items, opts.mode, runs);
  const report: EvalReport = { meta, mode: opts.mode, estimate, perItem: [] };
  const debug: Record<string, unknown>[] = [];

  // A case whose request was refused by the limit is discarded, not scored
  // as a failure, and the run stops there.
  let stopped = false;
  const refused = () => Boolean(deps.budget?.exhausted);
  const guard = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    if (stopped) return null;
    try {
      const out = await fn();
      if (refused()) {
        stopped = true;
        return null;
      }
      return out;
    } catch (err) {
      if (err instanceof RequestLimitReached || refused()) {
        stopped = true;
        return null;
      }
      throw err;
    }
  };

  const asrResults: AsrResult[] = [];
  if (opts.mode !== "grader") {
    for (let run = 0; run < runs && !stopped; run++) {
      for (const item of items) {
        const r = await guard(() => transcribeItem(item, run, deps));
        if (!r) break;
        asrResults.push(r);
      }
    }
    const perItemWer = new Map<string, number[]>();
    for (const r of asrResults) if (r.wer !== null) perItemWer.set(r.id, [...(perItemWer.get(r.id) ?? []), r.wer]);
    const sds = [...perItemWer.values()].filter((w) => w.length > 1).map(stdDev);
    report.asr = { summary: summarizeAsr(asrResults), groups: groupAsr(asrResults, byId), werStdDevAcrossRuns: sds.length ? Math.round(mean(sds)! * 1000) / 1000 : null };
  }

  // Delivery signals: no provider calls - production's analysis of text the
  // run already has, against human annotations only. The verified-transcript
  // side does not depend on the ASR run, so it is computed once; the ASR side
  // is computed for EVERY run, so unstable transcription shows up.
  const annotated = items.filter((i) => i.delivery);
  if (annotated.length) {
    const onRef = annotated.flatMap((i) => evaluateDeliveryItem(i, { text: i.referenceTranscript, words: null }, { timing: false }) ?? []);
    const runsDone = [...new Set(asrResults.map((r) => r.run))].sort((x, y) => x - y);
    const allAsr: ReturnType<typeof evaluateDeliveryItem>[] = [];
    const perRun = runsDone.map((run) => {
      const ofRun = asrResults.filter((r) => r.run === run && byId.get(r.id)?.delivery);
      const evaluated = ofRun.filter((r) => r.ok && r.text !== null).flatMap((r) => evaluateDeliveryItem(byId.get(r.id)!, { text: r.text!, words: r.words }) ?? []);
      allAsr.push(...evaluated);
      return deliveryRunRow(run, evaluated, ofRun.filter((r) => !r.ok).map((r) => r.id));
    });
    report.delivery = {
      annotatedItems: annotated.length,
      onReferenceTranscript: onRef.length ? summarizeDelivery(onRef) : null,
      onAsrTranscript: allAsr.length ? summarizeDelivery(allAsr.filter((x): x is NonNullable<typeof x> => x !== null)) : null,
      asrRuns: perRun,
      acrossRuns: deliveryVariability(perRun),
      failedTranscriptionsExcluded: perRun.reduce((n, r) => n + r.failedTranscriptions.length, 0),
    };
    if (opts.debug) {
      for (const x of onRef) debug.push({ delivery: { condition: "reference", ...x } });
      for (const run of runsDone) {
        for (const r of asrResults.filter((a) => a.run === run && a.ok && a.text !== null && byId.get(a.id)?.delivery)) {
          debug.push({ delivery: { condition: "asr", run, ...evaluateDeliveryItem(byId.get(r.id)!, { text: r.text!, words: r.words }) } });
        }
      }
    }
  }

  const refResults: GradeResult[] = [];
  const asrGraded: GradeResult[] = [];
  if (opts.mode === "asr") {
    report.perItem = items.map((i) => {
      const rs = asrResults.filter((r) => r.id === i.id);
      return { id: i.id, dataset: i.source.dataset, wer: rs.map((r) => (r.wer === null ? null : Math.round(r.wer * 1000) / 1000)), failed: rs.filter((r) => !r.ok).length };
    });
    if (opts.debug) for (const r of asrResults) debug.push({ id: r.id, run: r.run, reference: byId.get(r.id)!.referenceTranscript, hypothesis: r.text });
  } else {
    // Grading against the verified reference transcript: the grader alone.
    for (let run = 0; run < runs && !stopped; run++) {
      for (const item of items) {
        const g = await guard(() => gradeItem(item, run, { text: item.referenceTranscript, words: null }, deps));
        if (!g) break;
        refResults.push(g);
      }
    }
    const refRuns = perRunMetrics(refResults, runs);
    report.humanAgreement = humanAgreement(reviewPairs(items));

    if (opts.mode === "grader") {
      report.grader = {
        transcriptSource: "reference",
        primary: refRuns[0],
        perRun: refRuns.map((m) => ({ overallMae: m.overallMae, spearman: m.spearman, classMacroF1: m.classMacroF1 })),
        repeatability: repeatability(byItemRuns(refResults)),
      };
      report.perItem = items.map((i) => {
        const rs = refResults.filter((r) => r.id === i.id);
        return { id: i.id, kind: i.question!.kind, human: i.adjudicated!.scores.overall, model: rs.map((r) => r.overall), outcome: rs.map((r) => r.outcome) };
      });
    } else {
      // The same grading, fed the ASR transcript of the same run instead.
      for (const r of asrResults) {
        if (stopped) break;
        const item = byId.get(r.id)!;
        const text = r.ok && r.text ? r.text : "";
        const g = await guard(() => gradeItem(item, r.run, { text, words: r.words }, deps));
        if (!g) break;
        asrGraded.push(g);
      }
      const asrRuns = perRunMetrics(asrGraded, runs);
      // Only items with BOTH gradings in run 0 are compared.
      const pairs = refResults
        .filter((r) => r.run === 0)
        .flatMap((ref) => {
          const a = asrGraded.find((x) => x.id === ref.id && x.run === 0);
          return a ? [{ reference: { overall: ref.overall, classification: ref.classification }, asr: { overall: a.overall, classification: a.classification } }] : [];
        });
      report.endToEnd = {
        reference: refRuns[0],
        asrTranscript: asrRuns[0],
        delta: transcriptSourceDelta(refRuns[0], asrRuns[0], pairs),
        repeatability: { reference: repeatability(byItemRuns(refResults)), asrTranscript: repeatability(byItemRuns(asrGraded)) },
      };
      report.perItem = items.map((i) => ({
        id: i.id,
        kind: i.question!.kind,
        human: i.adjudicated!.scores.overall,
        referenceTranscriptScore: refResults.filter((r) => r.id === i.id).map((r) => r.overall),
        asrTranscriptScore: asrGraded.filter((r) => r.id === i.id).map((r) => r.overall),
        wer: asrResults.filter((r) => r.id === i.id).map((r) => (r.wer === null ? null : Math.round(r.wer * 1000) / 1000)),
      }));
      if (opts.debug) for (const r of asrResults) debug.push({ id: r.id, run: r.run, reference: byId.get(r.id)!.referenceTranscript, hypothesis: r.text });
    }
    if (opts.debug) for (const r of refResults) debug.push({ id: r.id, run: r.run, transcriptSource: "reference", outcome: r.outcome, overall: r.overall, summary: r.summary });
  }

  report.cases = {
    planned: { asr: estimate.asrCases, grading: estimate.gradingCases },
    completed: { asr: asrResults.length, grading: refResults.length + asrGraded.length },
  };
  if (deps.budget) report.requests = deps.budget.summary();
  if (stopped) report.incomplete = { reason: "request limit reached", limit: deps.budget?.limit ?? null };
  if (opts.debug) report.debug = debug;
  return report;
}

// ---------------------------------------------------------------- stubs

/**
 * Offline stand-ins for a no-cost dry run: the "transcriber" returns each
 * item's reference transcript, the "grader" returns the item's own expected
 * judgement. They exercise every production step between the calls - so a
 * dry run proves the manifest and the pipeline work - but the METRICS they
 * produce are meaningless and the report says so.
 */
export function dryRunDeps(manifest: Manifest): EvalDeps {
  const byId = new Map(manifest.items.map((i) => [i.id, i]));
  const byTranscript = new Map(manifest.items.map((i) => [normalizeForWer(i.referenceTranscript).join(" "), i]));
  return {
    readMedia: async (item) => ({ bytes: Buffer.from(item.id), contentType: "audio/wav", filename: "dry-run.wav" }),
    transcriber: {
      name: "dry-run",
      transcribe: async ({ bytes }) => ({ text: byId.get(bytes.toString())?.referenceTranscript ?? "", words: null }),
    },
    gradeCall: async ({ user }) => {
      const text = user.split("<transcript>\n")[1]?.split("\n</transcript>")[0] ?? "";
      const item = byTranscript.get(normalizeForWer(text).join(" "));
      if (!item?.adjudicated || !item.expected) return null;
      const s = item.adjudicated.scores;
      const t = (n: number) => Math.round(n / 10);
      return {
        summary: "Dry-run stub judgement.",
        strengths: [],
        improvements: [],
        grammarNotes: [],
        coveredPoints: item.expected.coveredPoints,
        factualErrors: item.expected.factualErrors,
        star: item.expected.star ?? { situation: false, task: false, action: false, result: false, reflection: false },
        scores: { grammarClarity: t(s.grammarClarity), structure: t(s.structure), relevance: t(s.relevance), completeness: t(s.completeness), logic: t(s.logic), concision: t(s.concision) },
      };
    },
  };
}
