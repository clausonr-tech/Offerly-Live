import { HESITATION_FAMILY } from "../delivery-metrics";

/**
 * ASR text metrics: normalised word error rate with its substitutions,
 * insertions and deletions, number and currency accuracy, and recall of
 * annotated finance terms and named entities. Pure.
 *
 * Normalisation is what makes WER mean anything across providers. Both sides
 * go through the same steps: lower case; "&" to "and"; "%" to "percent";
 * "$5" to "5 dollars"; spelled-out numbers to digits ("twenty five million"
 * -> 25000000, "two point five" -> 2.5); digit scales ("5 million") folded the
 * same way; thousands separators removed; punctuation dropped (apostrophes
 * inside words and decimal points kept); hesitations (um, uh, er, ah, hmm,
 * mm) dropped - reference transcripts in the public datasets omit them, and a
 * provider should not be charged an error for hearing one. Filler counting is
 * a separate, delivery metric.
 */

// Dropped from WER - every hesitation spelling production knows (the same
// map scores them separately, below).
const HESITATIONS = new Set(Object.keys(HESITATION_FAMILY));

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };

const isNumWord = (w: string) => w in UNITS || w in TENS || w === "hundred" || w in SCALES;
const isDigits = (w: string) => /^\d+(\.\d+)?$/.test(w);

function fmt(n: number): string {
  // Integers as integers; decimals without float noise.
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/**
 * Folds runs of number words (and "5 million"-style digit + scale) into one
 * digit token. "oh" counts as zero only inside a run, never alone.
 */
function foldNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    // Digits followed by scale words: "2.5 billion" -> 2500000000.
    if (isDigits(t) && tokens[i + 1] && tokens[i + 1] in SCALES) {
      let value = Number(t);
      let j = i + 1;
      while (tokens[j] && tokens[j] in SCALES) value *= SCALES[tokens[j++]];
      out.push(fmt(value));
      i = j;
      continue;
    }
    if (!isNumWord(t) || (t === "oh" && !isNumWord(tokens[i + 1] ?? ""))) {
      out.push(t);
      i++;
      continue;
    }
    let total = 0;
    let current = 0;
    let j = i;
    let used = false;
    for (; j < tokens.length; j++) {
      const w = tokens[j];
      if (w in UNITS) current += UNITS[w];
      else if (w in TENS) current += TENS[w];
      else if (w === "hundred") current = (current || 1) * 100;
      else if (w in SCALES) {
        total += (current || 1) * SCALES[w];
        current = 0;
      } else if (w === "and" && used && tokens[j + 1] && isNumWord(tokens[j + 1])) continue;
      else break;
      used = true;
    }
    let value = total + current;
    // "point five" decimals.
    if (tokens[j] === "point" && tokens[j + 1] && tokens[j + 1] in UNITS) {
      let digits = "";
      j++;
      while (tokens[j] && tokens[j] in UNITS && UNITS[tokens[j]] < 10) digits += String(UNITS[tokens[j++]]);
      value = Number(`${value}.${digits}`);
      while (tokens[j] && tokens[j] in SCALES) value *= SCALES[tokens[j++]];
    }
    out.push(fmt(value));
    i = j;
  }
  return out;
}

export function normalizeForWer(text: string): string[] {
  let t = text.toLowerCase().replace(/[’‘`]/g, "'");
  t = t.replace(/&/g, " and ");
  t = t.replace(/(\d),(?=\d{3}\b)/g, "$1"); // 1,000 -> 1000
  t = t.replace(/\$\s*(\d+(?:\.\d+)?)(\s*(?:thousand|million|billion|trillion))?/g, (_m, n, scale) => `${n}${scale ?? ""} dollars`);
  t = t.replace(/(\d)\s*%/g, "$1 percent");
  t = t.replace(/(\d)\s*(k|m|bn)\b/g, (_m, d, s) => `${d} ${s === "k" ? "thousand" : s === "m" ? "million" : "billion"}`);
  t = t.replace(/-/g, " ");
  // Keep decimal points inside numbers and apostrophes inside words; drop the rest.
  t = t.replace(/(\d)\.(\d)/g, "$1\u0000$2").replace(/(\w)'(\w)/g, "$1\u0001$2");
  t = t.replace(/[^a-z0-9\u0000\u0001\s]/g, " ").replace(/\u0000/g, ".").replace(/\u0001/g, "'");
  const tokens = t.split(/\s+/).filter((w) => w && !HESITATIONS.has(w));
  // "q three" and "Q3", "f y twenty six" and "FY26" are the same token.
  const folded = foldNumbers(tokens);
  const out: string[] = [];
  for (let i = 0; i < folded.length; i++) {
    const w = folded[i];
    const next = folded[i + 1];
    if (w === "q" && next && /^[1-4]$/.test(next)) {
      out.push(`q${next}`);
      i++;
    } else if (w === "fy" && next && /^\d{2,4}$/.test(next)) {
      out.push(`fy${next}`);
      i++;
    } else if (w === "f" && next === "y" && folded[i + 2] && /^\d{2,4}$/.test(folded[i + 2])) {
      out.push(`fy${folded[i + 2]}`);
      i += 2;
    } else out.push(w);
  }
  return out;
}

export type WerCounts = { substitutions: number; insertions: number; deletions: number; hits: number; refWords: number };

/** Levenshtein alignment over words, with the edit types counted. */
export function wordErrors(reference: string[], hypothesis: string[]): WerCounts {
  const n = reference.length;
  const m = hypothesis.length;
  // cost[i][j] and the op that produced it, on one flat array each.
  const cost = new Uint32Array((n + 1) * (m + 1));
  const op = new Uint8Array((n + 1) * (m + 1)); // 0 hit, 1 sub, 2 del, 3 ins
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) {
    cost[at(i, 0)] = i;
    op[at(i, 0)] = 2;
  }
  for (let j = 1; j <= m; j++) {
    cost[at(0, j)] = j;
    op[at(0, j)] = 3;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = reference[i - 1] === hypothesis[j - 1];
      const diag = cost[at(i - 1, j - 1)] + (same ? 0 : 1);
      const del = cost[at(i - 1, j)] + 1;
      const ins = cost[at(i, j - 1)] + 1;
      if (diag <= del && diag <= ins) {
        cost[at(i, j)] = diag;
        op[at(i, j)] = same ? 0 : 1;
      } else if (del <= ins) {
        cost[at(i, j)] = del;
        op[at(i, j)] = 2;
      } else {
        cost[at(i, j)] = ins;
        op[at(i, j)] = 3;
      }
    }
  }
  const c: WerCounts = { substitutions: 0, insertions: 0, deletions: 0, hits: 0, refWords: n };
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const o = op[at(i, j)];
    if (o === 0 || o === 1) {
      if (o === 0) c.hits++;
      else c.substitutions++;
      i--;
      j--;
    } else if (o === 2) {
      c.deletions++;
      i--;
    } else {
      c.insertions++;
      j--;
    }
  }
  return c;
}

export function wer(c: WerCounts): number | null {
  return c.refWords === 0 ? null : (c.substitutions + c.deletions + c.insertions) / c.refWords;
}

export type Counts = { tp: number; fp: number; fn: number };

/** tp/fp/fn between two multisets of tokens. */
function multisetCounts(ref: string[], hyp: string[]): Counts {
  const pool = new Map<string, number>();
  for (const t of hyp) pool.set(t, (pool.get(t) ?? 0) + 1);
  let tp = 0;
  for (const t of ref) {
    const left = pool.get(t) ?? 0;
    if (left > 0) {
      tp++;
      pool.set(t, left - 1);
    }
  }
  return { tp, fp: hyp.length - tp, fn: ref.length - tp };
}

/**
 * Numbers in the reference vs the hypothesis, as a multiset: a missed number
 * is a false negative, a wrong or invented one a false positive. (Recall
 * alone would reward a transcript that sprays extra numbers.)
 */
export function numberCounts(refTokens: string[], hypTokens: string[]): Counts {
  return multisetCounts(refTokens.filter(isDigits), hypTokens.filter(isDigits));
}

/** Currency amounts - the amount AND the unit ("<number> dollars") must match. */
export function currencyCounts(refTokens: string[], hypTokens: string[]): Counts {
  const amounts = (ts: string[]) => ts.flatMap((t, i) => (isDigits(t) && ts[i + 1] === "dollars" ? [`${t} dollars`] : []));
  return multisetCounts(amounts(refTokens), amounts(hypTokens));
}

/**
 * Filler words, by variant family: "umm" counts as "um", "uhh" as "uh",
 * "erm" as "er". Compared as a multiset, like numbers. Only meaningful when
 * the reference transcript is verbatim (annotations.verbatimFillers) - most
 * public datasets strip fillers, and comparing against those would score a
 * provider for hearing hesitations that were really there.
 */
const FILLER_FAMILIES = HESITATION_FAMILY;

export function fillerTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) ?? []).map((w) => FILLER_FAMILIES[w]).filter((f): f is string => Boolean(f));
}

export function fillerCounts(reference: string, hypothesis: string): Counts {
  return multisetCounts(fillerTokens(reference), fillerTokens(hypothesis));
}

/** How many annotated phrases appear, whole-word, in the hypothesis. */
export function phraseRecall(phrases: readonly string[], hypothesis: string): { matched: number; total: number } {
  const hyp = ` ${normalizeForWer(hypothesis).join(" ")} `;
  let matched = 0;
  for (const p of phrases) {
    const norm = normalizeForWer(p).join(" ");
    if (norm && hyp.includes(` ${norm} `)) matched++;
  }
  return { matched, total: phrases.length };
}

/** Share of hypothesis words that came with a timestamp (capped at 1). */
export function timestampCoverage(words: unknown[] | null | undefined, hypothesisTokens: number): number {
  if (!words || hypothesisTokens === 0) return 0;
  return Math.min(1, words.length / hypothesisTokens);
}
