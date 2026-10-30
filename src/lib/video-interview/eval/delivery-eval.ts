import { LONG_PAUSE_SEC, analyzeDelivery, deliveryScores, tokenize, type PauseEvent, type TimedWord } from "../delivery-metrics";
import type { DeliveryMetrics } from "../types";
import { mae, mean, prf, type Prf } from "./grader-metrics";
import type { ManifestItem } from "./manifest";
import type { Counts } from "./text-metrics";

/**
 * Delivery-signal evaluation: is what Offerly MEASURES about delivery -
 * pace, pauses, fillers, repeated phrases, probable disfluencies - right,
 * and how far off are the resulting pace/pauses and filler scores?
 *
 * The prediction is always production's own analyzeDelivery() - the same
 * detectors the student is scored with. The ground truth is always the
 * item's human-verified `delivery` annotation, made from the recording. It is
 * never inferred from any model's transcript, and a metric is computed only
 * where its annotation exists.
 *
 * Run on two transcripts, reported separately:
 *   onReferenceTranscript - the verified text: isolates the detectors. No
 *                           word timings, so pauses are not measured here.
 *   onAsrTranscript       - the provider's text and timings: detectors plus
 *                           transcription and timestamp errors.
 */

/** A predicted pause matches an annotated one when they overlap and both
 *  boundaries are within this many seconds. */
const PAUSE_BOUNDARY_TOLERANCE_SEC = 0.5;

type Pause = { start: number; end: number; duration: number; long: boolean };

/** One-to-one matching of predicted to annotated pauses, in time order. */
export function matchPauses(predicted: Pause[], reference: Pause[]) {
  const used = new Set<number>();
  const boundaryErrors: number[] = [];
  let tp = 0;
  for (const r of reference) {
    let best = -1;
    let bestErr = Infinity;
    predicted.forEach((p, i) => {
      if (used.has(i)) return;
      const overlap = Math.min(p.end, r.end) - Math.max(p.start, r.start);
      const err = Math.max(Math.abs(p.start - r.start), Math.abs(p.end - r.end));
      if (overlap > 0 && err <= PAUSE_BOUNDARY_TOLERANCE_SEC && err < bestErr) {
        best = i;
        bestErr = err;
      }
    });
    if (best >= 0) {
      used.add(best);
      tp++;
      boundaryErrors.push((Math.abs(predicted[best].start - r.start) + Math.abs(predicted[best].end - r.end)) / 2);
    }
  }
  return { tp, fp: predicted.length - tp, fn: reference.length - tp, boundaryErrors };
}

function multiset(ref: string[], hyp: string[]): Counts {
  const pool = new Map<string, number>();
  for (const h of hyp) pool.set(h, (pool.get(h) ?? 0) + 1);
  let tp = 0;
  for (const r of ref) {
    const n = pool.get(r) ?? 0;
    if (n > 0) {
      tp++;
      pool.set(r, n - 1);
    }
  }
  return { tp, fp: hyp.length - tp, fn: ref.length - tp };
}

const normPhrase = (s: string) => tokenize(s).join(" ");

/** Repeated phrases: a detected phrase matches an annotated one when either
 *  contains the other (the detector reports the longest non-overlapping n-gram). */
function matchPhrases(ref: string[], hyp: string[]): Counts {
  const used = new Set<number>();
  let tp = 0;
  for (const r of ref.map(normPhrase)) {
    const i = hyp.map(normPhrase).findIndex((h, k) => !used.has(k) && (h.includes(r) || r.includes(h)));
    if (i >= 0) {
      used.add(i);
      tp++;
    }
  }
  return { tp, fp: hyp.length - tp, fn: ref.length - tp };
}

export type DeliveryItemResult = {
  id: string;
  timed: boolean;
  wpm: { predicted: number | null; reference: number } | null;
  pauses: (Counts & { long: Counts; boundaryErrors: number[] }) | null;
  fillers: (Counts & { byLabel: Record<string, Counts> }) | null;
  repeatedPhrases: Counts | null;
  disfluencies: (Counts & { repetition: Counts; cutoff: Counts }) | null;
  scores: {
    pacePauses: { predicted: number | null; reference: number | null } | null;
    fillers: { predicted: number | null; reference: number | null } | null;
  };
};

/** The reference words-per-minute: as annotated, or from the verified word
 *  count over the annotated speaking time. */
function referenceWpm(item: ManifestItem): number | null {
  const d = item.delivery;
  if (!d) return null;
  if (d.wordsPerMinute) return d.wordsPerMinute;
  if (d.speakingSec) return Math.round((tokenize(item.referenceTranscript).length / d.speakingSec) * 60);
  return null;
}

/**
 * The DeliveryMetrics the annotations imply, for production's deliveryScores
 * to score - so the reference score and the predicted score come from one
 * scoring function. Null parts where the annotation is missing.
 */
function referenceMetrics(item: ManifestItem): { pace: DeliveryMetrics | null; filler: DeliveryMetrics | null } {
  const d = item.delivery;
  if (!d || item.durationSec === null) return { pace: null, filler: null };
  const wordCount = tokenize(item.referenceTranscript).length;
  const wpm = referenceWpm(item);
  const speakingSec = d.speakingSec ?? (wpm ? (wordCount / wpm) * 60 : null);
  const base: DeliveryMetrics = {
    wordCount,
    durationSec: item.durationSec,
    wordsPerMinute: wpm,
    pauses: null,
    fillers: { total: 0, perMinute: null, top: [] },
    repeatedPhrases: [],
    disfluencyEstimate: { count: 0, examples: [] },
  };
  const pace =
    wpm !== null && d.pauses
      ? {
          ...base,
          pauses: {
            count: d.pauses.length,
            longest: Math.round(Math.max(0, ...d.pauses.map((p) => p.endSec - p.startSec)) * 10) / 10,
            totalSec: Math.round(d.pauses.reduce((s, p) => s + (p.endSec - p.startSec), 0) * 10) / 10,
          },
        }
      : null;
  const filler =
    d.fillers && d.repeatedPhrases && speakingSec
      ? {
          ...base,
          fillers: { total: d.fillers.length, perMinute: speakingSec / 60 >= 0.1 ? Math.round((d.fillers.length / (speakingSec / 60)) * 10) / 10 : null, top: [] },
          repeatedPhrases: d.repeatedPhrases,
        }
      : null;
  return { pace, filler };
}

/** One item, one transcript: production's delivery analysis vs the annotations. */
/**
 * `timing: false` for the verified transcript, which has no word timings:
 * WPM, pauses and the pace/pauses score depend on timings in production, so
 * they are measured only where the transcript carries them (the ASR one).
 * With `timing: true` an ASR transcript that came back WITHOUT timestamps is
 * still measured - its annotated pauses all count as missed.
 */
export function evaluateDeliveryItem(item: ManifestItem, transcript: { text: string; words: TimedWord[] | null }, opts: { timing: boolean } = { timing: true }): DeliveryItemResult | null {
  const d = item.delivery;
  if (!d || item.durationSec === null) return null;
  const { metrics, events } = analyzeDelivery({ transcript: transcript.text, durationMs: item.durationSec * 1000, words: transcript.words });
  const scored = deliveryScores(metrics);
  const ref = referenceMetrics(item);
  const refScores = { pace: ref.pace ? deliveryScores(ref.pace).pacePauses : null, filler: ref.filler ? deliveryScores(ref.filler).fillers : null };

  let pauses: DeliveryItemResult["pauses"] = null;
  if (d.pauses && opts.timing) {
    const refP = d.pauses.map((p) => ({ start: p.startSec, end: p.endSec, duration: p.endSec - p.startSec, long: p.endSec - p.startSec >= LONG_PAUSE_SEC }));
    // No usable timestamps: nothing can be detected, so every annotated
    // pause is a miss - counted, and the item is flagged as untimed.
    const predP: Pause[] = (events.pauses ?? []).map((p: PauseEvent) => ({ start: p.start, end: p.end, duration: p.duration, long: p.long }));
    const all = matchPauses(predP, refP);
    const long = matchPauses(predP.filter((p) => p.long), refP.filter((p) => p.long));
    pauses = { tp: all.tp, fp: all.fp, fn: all.fn, boundaryErrors: all.boundaryErrors, long: { tp: long.tp, fp: long.fp, fn: long.fn } };
  }

  let fillers: DeliveryItemResult["fillers"] = null;
  if (d.fillers) {
    const pred = events.fillers.map((f) => f.label as string);
    const byLabel: Record<string, Counts> = {};
    for (const label of new Set([...d.fillers, ...pred])) byLabel[label] = multiset(d.fillers.filter((l) => l === label), pred.filter((l) => l === label));
    fillers = { ...multiset([...d.fillers], pred), byLabel };
  }

  let disfluencies: DeliveryItemResult["disfluencies"] = null;
  if (d.disfluencies) {
    const key = (t: string, x: string) => `${t}|${normPhrase(x)}`;
    const refKeys = d.disfluencies.map((x) => key(x.type, x.text));
    const predKeys = events.disfluencies.map((x) => key(x.type, x.text));
    const ofType = (t: string) => multiset(refKeys.filter((k) => k.startsWith(`${t}|`)), predKeys.filter((k) => k.startsWith(`${t}|`)));
    disfluencies = { ...multiset(refKeys, predKeys), repetition: ofType("repetition"), cutoff: ofType("cutoff") };
  }

  const rw = referenceWpm(item);
  return {
    id: item.id,
    timed: events.timed,
    wpm: rw === null || !opts.timing ? null : { predicted: metrics.wordsPerMinute, reference: rw },
    pauses,
    fillers,
    repeatedPhrases: d.repeatedPhrases ? matchPhrases(d.repeatedPhrases.map((r) => r.phrase), events.repeatedPhrases.map((r) => r.phrase)) : null,
    disfluencies,
    scores: {
      pacePauses: refScores.pace === null || !opts.timing ? null : { predicted: scored.pacePauses, reference: refScores.pace },
      fillers: refScores.filler === null ? null : { predicted: scored.fillers, reference: refScores.filler },
    },
  };
}

const sum = (cs: Counts[]): Prf => prf(cs.reduce((s, c) => s + c.tp, 0), cs.reduce((s, c) => s + c.fp, 0), cs.reduce((s, c) => s + c.fn, 0));
const r3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);

/** Aggregate over items. Each metric says how many items it covers. */
export function summarizeDelivery(results: DeliveryItemResult[]) {
  const wpm = results.flatMap((r) => (r.wpm && r.wpm.predicted !== null ? [r.wpm as { predicted: number; reference: number }] : []));
  const pause = results.flatMap((r) => (r.pauses ? [{ ...r.pauses, timed: r.timed }] : []));
  const fill = results.flatMap((r) => (r.fillers ? [r.fillers] : []));
  const labels = new Set(fill.flatMap((f) => Object.keys(f.byLabel)));
  const phr = results.flatMap((r) => (r.repeatedPhrases ? [r.repeatedPhrases] : []));
  const dis = results.flatMap((r) => (r.disfluencies ? [r.disfluencies] : []));
  const delta = (k: "pacePauses" | "fillers") => {
    const pairs = results.flatMap((r) => {
      const s = r.scores[k];
      return s && s.predicted !== null && s.reference !== null ? [[s.predicted, s.reference] as [number, number]] : [];
    });
    return pairs.length ? { items: pairs.length, meanAbsoluteError: mae(pairs), meanSignedError: r3(mean(pairs.map(([p, q]) => p - q))) } : null;
  };
  return {
    items: results.length,
    wordsPerMinute: wpm.length
      ? { items: wpm.length, meanAbsoluteError: mae(wpm.map((w) => [w.predicted, w.reference])), meanSignedError: r3(mean(wpm.map((w) => w.predicted - w.reference))), unmeasured: results.filter((r) => r.wpm && r.wpm.predicted === null).length }
      : null,
    pauses: pause.length
      ? {
          items: pause.length,
          itemsWithoutTimestamps: pause.filter((p) => !p.timed).length,
          all: sum(pause),
          long: sum(pause.map((p) => p.long)),
          meanBoundaryErrorSec: r3(mean(pause.flatMap((p) => p.boundaryErrors))),
        }
      : null,
    fillers: fill.length ? { items: fill.length, all: sum(fill), byLabel: Object.fromEntries([...labels].map((l) => [l, sum(fill.map((f) => f.byLabel[l] ?? { tp: 0, fp: 0, fn: 0 }))])) } : null,
    repeatedPhrases: phr.length ? { items: phr.length, ...sum(phr) } : null,
    disfluencies: dis.length ? { items: dis.length, all: sum(dis), repetition: sum(dis.map((x) => x.repetition)), cutoff: sum(dis.map((x) => x.cutoff)) } : null,
    scoreError: { pacePauses: delta("pacePauses"), fillers: delta("fillers") },
  };
}

export type DeliverySummary = ReturnType<typeof summarizeDelivery>;
