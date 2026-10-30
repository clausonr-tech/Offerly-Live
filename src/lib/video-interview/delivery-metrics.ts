import type { DeliveryMetrics } from "./types";

/**
 * Delivery, measured - pace, pauses, filler words, repetition and probable
 * disfluencies - from a transcript and (when the provider gives them) word
 * timings. Arithmetic, not a model: the same answer always gets the same
 * numbers, and none of it costs a call.
 *
 * Everything here reads WORDS. It cannot hear tone, and speech-to-text
 * providers tend to tidy speech up (dropping an "um", merging a repeat), so
 * fillers and disfluencies are floors, and the disfluency count is labelled an
 * estimate everywhere it is shown. It never tries to diagnose anything.
 */

export type TimedWord = { word: string; start: number; end: number };

/**
 * Every hesitation spelling, mapped to its family ("umm" is "um"). The one
 * list: the ASR filler metric in eval/text-metrics reads it too.
 */
export const HESITATION_FAMILY: Record<string, string> = {
  um: "um", umm: "um", ummm: "um",
  uh: "uh", uhh: "uh", uhhh: "uh",
  er: "er", erm: "er",
  ah: "ah", ahh: "ah",
  hmm: "hmm", hm: "hmm", hmmm: "hmm",
  mm: "mm", mmm: "mm",
  mhm: "mhm", "mm-hmm": "mhm", mmhmm: "mhm",
};

/** The hesitations DELIVERY SCORING counts as fillers. (A backchannel like
 *  "mhm" is transcribed and measured, but not scored against the student.) */
const FILLER_WORDS = new Set(["um", "umm", "uh", "uhh", "er", "erm", "ah", "hmm", "mm"]);
/** Filler phrases, longest first so "you know what i mean" is one filler. */
const FILLER_PHRASES = ["you know what i mean", "you know", "i mean", "kind of", "sort of"] as const;
/** Discourse words that are fillers only when they open a clause. */
const CLAUSE_OPENERS = new Set(["basically", "literally", "actually"]);
const LIKE_VERB_BEFORE = new Set(["i", "you", "we", "they", "would", "really", "don't", "didn't", "look", "looks", "looked", "feel", "feels", "felt", "sounds", "seem", "seems", "just"]);
const LIKE_COMPARISON_AFTER = new Set(["a", "an", "the", "this", "that", "these", "those", "how", "what", "when"]);

/** Every label a filler event can carry - what human annotations use. */
export const FILLER_LABELS = ["um", "uh", "er", "ah", "hmm", "mm", "like", "basically", "literally", "actually", ...FILLER_PHRASES] as const;
type FillerLabel = (typeof FILLER_LABELS)[number];

/** Gap between words that counts as a pause, and as a long one. */
export const PAUSE_SEC = 1.5;
export const LONG_PAUSE_SEC = 3;

const WORD_RE = /[a-z0-9]+(?:['’-][a-z0-9]+)*-?/g;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).map((w) => w.replace(/’/g, "'"));
}

/** A filler found in the tokens: where, the word(s) as said, and its label. */
export type FillerEvent = { index: number; length: number; word: string; label: FillerLabel };

/**
 * Filler detection - THE definition, used by delivery scoring and by the
 * evaluator alike:
 *  - hesitations (um, uh, er, ah, hmm, mm and their spellings)
 *  - "like", except as a verb ("I like", "would like", "looks like") or a
 *    comparison ("like a", "like the", "like how")
 *  - "you know what i mean", "you know", "i mean", "kind of", "sort of"
 *  - "basically", "literally", "actually" opening a clause: the first word,
 *    or straight after a hesitation (punctuation is gone by this point, so
 *    that is the clause boundary the words can show)
 * Phrases are matched longest first and never overlap.
 */
export function detectFillers(tokens: string[]): FillerEvent[] {
  const events: FillerEvent[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const phrase = FILLER_PHRASES.find((p) => {
      const parts = p.split(" ");
      return parts.every((w, k) => tokens[i + k] === w);
    });
    if (phrase) {
      const length = phrase.split(" ").length;
      events.push({ index: i, length, word: phrase, label: phrase });
      i += length - 1;
      continue;
    }
    if (FILLER_WORDS.has(t)) events.push({ index: i, length: 1, word: t, label: HESITATION_FAMILY[t] as FillerLabel });
    else if (t === "like") {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const verbUse = prev !== undefined && LIKE_VERB_BEFORE.has(prev);
      const comparison = next !== undefined && LIKE_COMPARISON_AFTER.has(next);
      if (!verbUse && !comparison) events.push({ index: i, length: 1, word: t, label: "like" });
    } else if (CLAUSE_OPENERS.has(t) && (i === 0 || FILLER_WORDS.has(tokens[i - 1]))) {
      events.push({ index: i, length: 1, word: t, label: t as FillerLabel });
    }
  }
  return events;
}

const STOP = new Set(["the", "a", "an", "and", "of", "to", "in", "that", "is", "it", "i", "was", "we", "for", "on", "so", "with", "my", "as", "at", "be", "this", "you", "they", "but", "or", "are"]);

/** Three- and four-word phrases said three times or more, content words only. */
function detectRepeatedPhrases(tokens: string[]): { phrase: string; count: number }[] {
  const words = tokens.filter((t) => !FILLER_WORDS.has(t));
  const counts = new Map<string, number>();
  for (const n of [4, 3]) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      if (gram.filter((w) => !STOP.has(w)).length < 2) continue;
      const key = gram.join(" ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const hits = [...counts].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  // Drop a 3-gram already inside a reported 4-gram.
  const out: { phrase: string; count: number }[] = [];
  for (const [phrase, count] of hits) {
    if (out.some((o) => o.phrase.includes(phrase))) continue;
    out.push({ phrase, count });
    if (out.length === 5) break;
  }
  return out;
}

export type DisfluencyEvent = { index: number; type: "repetition" | "cutoff"; text: string };

/**
 * Probable disfluencies, from the words: a word said twice in a row ("I I
 * think") is a repetition; a word cut off with a dash ("th- the") or a
 * part-word restarted as the full one ("comp company") is a cut-off. An
 * estimate by construction - see the note at the top.
 */
export function detectDisfluencies(tokens: string[]): DisfluencyEvent[] {
  const events: DisfluencyEvent[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1].replace(/-$/, "");
    const cur = tokens[i].replace(/-$/, "");
    // "that that" is sometimes grammatical ("I knew that that was wrong").
    const repeat = prev === cur && prev !== "that" && prev !== "had" && !/^\d+$/.test(prev);
    const cutoff = tokens[i - 1].endsWith("-") || (prev.length >= 1 && prev.length <= 3 && cur.length > prev.length + 1 && cur.startsWith(prev) && !STOP.has(prev));
    if (repeat || cutoff) events.push({ index: i, type: repeat && !tokens[i - 1].endsWith("-") ? "repetition" : "cutoff", text: `${tokens[i - 1]} ${tokens[i]}` });
  }
  return events;
}

/** Only well-formed timings, in order of speech. */
function usableWords(words: TimedWord[] | null | undefined): TimedWord[] {
  return (words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
}

export type PauseEvent = { afterWord: number; start: number; end: number; duration: number; long: boolean };

/** Gaps of PAUSE_SEC or more between consecutive timed words. */
function detectPauses(words: TimedWord[]): PauseEvent[] {
  const out: PauseEvent[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= PAUSE_SEC) out.push({ afterWord: i - 1, start: words[i - 1].end, end: words[i].start, duration: gap, long: gap >= LONG_PAUSE_SEC });
  }
  return out;
}

/**
 * Speaking time: first word to last when there are timings (a long silence
 * before starting is a pause, not slow speech), else the recording's length.
 */
function speakingSeconds(words: TimedWord[], durationSec: number): number {
  return words.length >= 2 ? Math.max(0.1, words[words.length - 1].end - words[0].start) : durationSec;
}

/** Words per minute, or null when there is too little to measure. */
export function wordsPerMinute(wordCount: number, spokenSec: number): number | null {
  return wordCount >= 5 && spokenSec >= 3 ? Math.round((wordCount / spokenSec) * 60) : null;
}

export type DeliveryAnalysis = {
  metrics: DeliveryMetrics;
  events: {
    fillers: FillerEvent[];
    pauses: PauseEvent[] | null;
    disfluencies: DisfluencyEvent[];
    repeatedPhrases: { phrase: string; count: number }[];
    spokenSec: number;
    timed: boolean;
  };
};

/** The metrics AND the individual events behind them - one computation, so
 *  what the evaluator checks is exactly what the student is scored on. */
export function analyzeDelivery(input: { transcript: string; durationMs: number; words?: TimedWord[] | null }): DeliveryAnalysis {
  const tokens = tokenize(input.transcript);
  const durationSec = Math.max(0, Math.round(input.durationMs / 100) / 10);
  const words = usableWords(input.words);
  const spokenSec = speakingSeconds(words, durationSec);

  const pauseEvents = words.length >= 2 ? detectPauses(words) : null;
  const pauses: DeliveryMetrics["pauses"] = pauseEvents
    ? {
        count: pauseEvents.length,
        longest: Math.round(Math.max(0, ...pauseEvents.map((p) => p.duration)) * 10) / 10,
        totalSec: Math.round(pauseEvents.reduce((s, p) => s + p.duration, 0) * 10) / 10,
      }
    : null;

  const fillerEvents = detectFillers(tokens);
  // Tallied single words first, then phrases in their historical order, so
  // ties in the "top" list keep the order students have always seen.
  const PHRASE_ORDER = ["you know", "i mean", "kind of", "sort of", "you know what i mean"];
  const fillerCounts = new Map<string, number>();
  for (const e of fillerEvents) if (e.length === 1) fillerCounts.set(e.word, (fillerCounts.get(e.word) ?? 0) + 1);
  for (const p of PHRASE_ORDER) {
    const n = fillerEvents.filter((e) => e.word === p).length;
    if (n) fillerCounts.set(p, n);
  }
  const minutes = spokenSec / 60;
  const repeated = detectRepeatedPhrases(tokens);
  const disfluencies = detectDisfluencies(tokens);

  return {
    metrics: {
      wordCount: tokens.length,
      durationSec,
      wordsPerMinute: wordsPerMinute(tokens.length, spokenSec),
      pauses,
      fillers: {
        total: fillerEvents.length,
        perMinute: minutes >= 0.1 ? Math.round((fillerEvents.length / minutes) * 10) / 10 : null,
        top: [...fillerCounts]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([word, count]) => ({ word, count })),
      },
      repeatedPhrases: repeated,
      disfluencyEstimate: { count: disfluencies.length, examples: disfluencies.slice(0, 3).map((d) => d.text) },
    },
    events: { fillers: fillerEvents, pauses: pauseEvents, disfluencies, repeatedPhrases: repeated, spokenSec, timed: words.length >= 2 },
  };
}

export function computeDeliveryMetrics(input: { transcript: string; durationMs: number; words?: TimedWord[] | null }): DeliveryMetrics {
  return analyzeDelivery(input).metrics;
}

/**
 * Delivery scores out of 100, from the metrics. The bands are what interview
 * coaches use for spoken answers: roughly 130-160 words a minute reads as
 * confident, a pause now and then is fine, and a filler every ten seconds is
 * noticeable.
 */
export function deliveryScores(m: DeliveryMetrics): { pacePauses: number | null; fillers: number | null } {
  if (m.wordCount < 5) return { pacePauses: null, fillers: null };

  let pace = 70;
  if (m.wordsPerMinute != null) {
    const wpm = m.wordsPerMinute;
    if (wpm >= 125 && wpm <= 165) pace = 100;
    else if (wpm < 125) pace = Math.max(30, 100 - (125 - wpm) * 1.4);
    else pace = Math.max(30, 100 - (wpm - 165) * 1.4);
  }
  if (m.pauses) {
    const perMin = m.durationSec > 0 ? m.pauses.count / (m.durationSec / 60) : 0;
    pace -= Math.max(0, perMin - 2) * 6;
    if (m.pauses.longest >= LONG_PAUSE_SEC) pace -= Math.min(15, (m.pauses.longest - LONG_PAUSE_SEC) * 3 + 5);
  }

  const perMin = m.fillers.perMinute ?? 0;
  const repeats = m.repeatedPhrases.reduce((s, r) => s + (r.count - 2), 0);
  const fillers = 100 - Math.max(0, perMin - 1) * 9 - repeats * 4;

  const clamp = (n: number) => Math.round(Math.max(0, Math.min(100, n)));
  return { pacePauses: clamp(pace), fillers: clamp(fillers) };
}
