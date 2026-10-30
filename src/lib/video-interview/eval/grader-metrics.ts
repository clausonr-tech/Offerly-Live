import { CLASSES, RUBRIC_DIMENSIONS, STAR_ELEMENTS, type RubricDimension } from "./manifest";

/**
 * Grader metrics: agreement between the grading pipeline and adjudicated
 * human scores, and - as the ceiling to read those numbers against - between
 * the human reviewers themselves. Pure; numbers in, numbers out.
 */

type Class = (typeof CLASSES)[number];
type Star = Record<(typeof STAR_ELEMENTS)[number], boolean>;

const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

export function mae(pairs: [number, number][]): number | null {
  return pairs.length ? round(pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / pairs.length) : null;
}

/** Ranks with ties given their average rank (1-based). */
function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman's rank correlation (Pearson over ranks). Null when undefined. */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = mean(rx)!;
  const my = mean(ry)!;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? null : round(num / Math.sqrt(dx * dy));
}

export type Prf = { precision: number | null; recall: number | null; f1: number | null; tp: number; fp: number; fn: number };

export function prf(tp: number, fp: number, fn: number): Prf {
  const precision = tp + fp ? round(tp / (tp + fp)) : null;
  const recall = tp + fn ? round(tp / (tp + fn)) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? round((2 * precision * recall) / (precision + recall)) : precision === 0 || recall === 0 ? 0 : null;
  return { precision, recall, f1, tp, fp, fn };
}

/** Macro F1 over strong / average / poor. Classes absent from both sides are skipped. */
export function macroF1(truth: Class[], pred: Class[]): number | null {
  const f1s: number[] = [];
  for (const c of CLASSES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    truth.forEach((t, i) => {
      const p = pred[i];
      if (t === c && p === c) tp++;
      else if (p === c) fp++;
      else if (t === c) fn++;
    });
    if (tp + fp + fn === 0) continue;
    f1s.push(prf(tp, fp, fn).f1 ?? 0);
  }
  return f1s.length ? round(mean(f1s)!) : null;
}

/** Cohen's kappa for two raters over the three classes. */
export function cohenKappa(a: Class[], b: Class[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const n = a.length;
  const po = a.filter((x, i) => x === b[i]).length / n;
  let pe = 0;
  for (const c of CLASSES) pe += (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n);
  return pe === 1 ? null : round((po - pe) / (1 - pe));
}

/** One graded item, as the metrics see it. */
export type GradedItem = {
  id: string;
  kind: "behavioral" | "technical";
  outcome: string;
  human: { overall: number; scores: Record<RubricDimension, number>; classification: Class };
  model: { overall: number | null; scores: Partial<Record<RubricDimension, number>>; classification: Class | null };
  expectedCovered: number[];
  modelCovered: number[] | null;
  expectedErrorCount: number;
  modelErrorCount: number | null;
  expectedStar: Star | null;
  modelStar: Star | null;
};

export type GraderMetrics = {
  items: number;
  graded: number;
  overallMae: number | null;
  dimensionMae: Partial<Record<RubricDimension, number | null>>;
  spearman: number | null;
  classMacroF1: number | null;
  classAccuracy: number | null;
  expectedPoints: Prf;
  factualErrorDetection: Prf;
  star: Record<(typeof STAR_ELEMENTS)[number], Prf>;
  outcomeRates: Record<string, number>;
};

export function graderMetrics(items: GradedItem[]): GraderMetrics {
  const scored = items.filter((i) => i.model.overall !== null);
  const dimensionMae: GraderMetrics["dimensionMae"] = {};
  for (const d of RUBRIC_DIMENSIONS) {
    const pairs = scored.flatMap((i) => (typeof i.model.scores[d] === "number" ? [[i.model.scores[d]!, i.human.scores[d]] as [number, number]] : []));
    dimensionMae[d] = mae(pairs);
  }
  const classed = scored.filter((i) => i.model.classification);

  // Expected points: per-item sets, micro-averaged.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const i of items.filter((x) => x.kind === "technical" && x.modelCovered)) {
    const exp = new Set(i.expectedCovered);
    const got = new Set(i.modelCovered);
    for (const g of got) {
      if (exp.has(g)) tp++;
      else fp++;
    }
    for (const e of exp) if (!got.has(e)) fn++;
  }

  // Factual errors: did the grader flag an answer that has errors? Item-level,
  // because an error's wording differs between a reviewer and the model.
  let etp = 0;
  let efp = 0;
  let efn = 0;
  for (const i of items.filter((x) => x.kind === "technical" && x.modelErrorCount !== null)) {
    const has = i.expectedErrorCount > 0;
    const flagged = (i.modelErrorCount ?? 0) > 0;
    if (has && flagged) etp++;
    else if (flagged) efp++;
    else if (has) efn++;
  }

  const star = {} as GraderMetrics["star"];
  for (const e of STAR_ELEMENTS) {
    let stp = 0;
    let sfp = 0;
    let sfn = 0;
    for (const i of items.filter((x) => x.kind === "behavioral" && x.expectedStar && x.modelStar)) {
      const want = i.expectedStar![e];
      const got = i.modelStar![e];
      if (want && got) stp++;
      else if (got) sfp++;
      else if (want) sfn++;
    }
    star[e] = prf(stp, sfp, sfn);
  }

  const outcomeRates: Record<string, number> = {};
  for (const i of items) outcomeRates[i.outcome] = (outcomeRates[i.outcome] ?? 0) + 1;
  for (const k of Object.keys(outcomeRates)) outcomeRates[k] = round(outcomeRates[k] / Math.max(1, items.length));

  return {
    items: items.length,
    graded: scored.length,
    overallMae: mae(scored.map((i) => [i.model.overall!, i.human.overall])),
    dimensionMae,
    spearman: spearman(scored.map((i) => i.model.overall!), scored.map((i) => i.human.overall)),
    classMacroF1: macroF1(classed.map((i) => i.human.classification), classed.map((i) => i.model.classification!)),
    classAccuracy: classed.length ? round(classed.filter((i) => i.model.classification === i.human.classification).length / classed.length) : null,
    expectedPoints: prf(tp, fp, fn),
    factualErrorDetection: prf(etp, efp, efn),
    star,
    outcomeRates,
  };
}

export type Repeatability = {
  runs: number;
  items: number;
  meanScoreStdDev: number | null;
  maxScoreStdDev: number | null;
  classificationFlipRate: number | null;
};

/** Population standard deviation. */
export function stdDev(xs: number[]): number {
  const m = mean(xs) ?? 0;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length));
}

/**
 * How stable the grader is across identical runs: the spread of each item's
 * overall score, and how often an item lands in a different class.
 * `byItem` maps a fixture id to its overall score (or null) per run.
 */
export function repeatability(byItem: Map<string, { overall: number | null; classification: Class | null }[]>): Repeatability {
  const runs = Math.max(0, ...[...byItem.values()].map((r) => r.length));
  const sds: number[] = [];
  let flips = 0;
  let comparable = 0;
  for (const results of byItem.values()) {
    const scores = results.map((r) => r.overall).filter((x): x is number => x !== null);
    if (scores.length >= 2) sds.push(stdDev(scores));
    const classes = results.map((r) => r.classification).filter((c): c is Class => c !== null);
    if (classes.length >= 2) {
      comparable++;
      if (new Set(classes).size > 1) flips++;
    }
  }
  return {
    runs,
    items: byItem.size,
    meanScoreStdDev: sds.length ? round(mean(sds)!) : null,
    maxScoreStdDev: sds.length ? round(Math.max(...sds)) : null,
    classificationFlipRate: comparable ? round(flips / comparable) : null,
  };
}

export type HumanAgreement = {
  /** Every pair of reviews of the same item (three reviewers = three pairs). */
  reviewPairs: number;
  overallMae: number | null;
  dimensionMae: Partial<Record<RubricDimension, number | null>>;
  spearman: number | null;
  classAgreement: number | null;
  cohenKappa: number | null;
};

/**
 * Reviewer-vs-reviewer agreement, over EVERY pair of blind reviews of each
 * item (the runner builds all pairs, not only the first two).
 * The grader cannot be expected to agree with humans better than humans
 * agree with each other, so this is the ceiling every grader number is read
 * against.
 */
export function humanAgreement(reviewPairs: { a: { overall: number; scores: Record<RubricDimension, number>; classification: Class }; b: { overall: number; scores: Record<RubricDimension, number>; classification: Class } }[]): HumanAgreement {
  const dimensionMae: HumanAgreement["dimensionMae"] = {};
  for (const d of RUBRIC_DIMENSIONS) dimensionMae[d] = mae(reviewPairs.map((p) => [p.a.scores[d], p.b.scores[d]]));
  const a = reviewPairs.map((p) => p.a.classification);
  const b = reviewPairs.map((p) => p.b.classification);
  return {
    reviewPairs: reviewPairs.length,
    overallMae: mae(reviewPairs.map((p) => [p.a.overall, p.b.overall])),
    dimensionMae,
    spearman: spearman(reviewPairs.map((p) => p.a.overall), reviewPairs.map((p) => p.b.overall)),
    classAgreement: reviewPairs.length ? round(a.filter((x, i) => x === b[i]).length / reviewPairs.length) : null,
    cohenKappa: cohenKappa(a, b),
  };
}

/**
 * What changed when the grader read the ASR transcript instead of the
 * verified reference: metric deltas (ASR minus reference) and the mean
 * absolute shift of each item's own overall score.
 */
export function transcriptSourceDelta(
  reference: GraderMetrics,
  asr: GraderMetrics,
  pairs: { reference: { overall: number | null; classification: Class | null }; asr: { overall: number | null; classification: Class | null } }[],
): {
  overallMaeDelta: number | null;
  spearmanDelta: number | null;
  classMacroF1Delta: number | null;
  expectedPointsF1Delta: number | null;
  meanAbsoluteScoreShift: number | null;
  classificationChangeRate: number | null;
} {
  const d = (x: number | null, y: number | null) => (x === null || y === null ? null : round(y - x));
  const scored = pairs.filter((p) => p.reference.overall !== null && p.asr.overall !== null);
  const classed = pairs.filter((p) => p.reference.classification && p.asr.classification);
  return {
    overallMaeDelta: d(reference.overallMae, asr.overallMae),
    spearmanDelta: d(reference.spearman, asr.spearman),
    classMacroF1Delta: d(reference.classMacroF1, asr.classMacroF1),
    expectedPointsF1Delta: d(reference.expectedPoints.f1, asr.expectedPoints.f1),
    meanAbsoluteScoreShift: mae(scored.map((p) => [p.reference.overall!, p.asr.overall!])),
    classificationChangeRate: classed.length ? round(classed.filter((p) => p.reference.classification !== p.asr.classification).length / classed.length) : null,
  };
}
