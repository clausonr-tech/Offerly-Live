// CORPUS-VARIETY probe: measure how ALIKE the 192 gold bodies are to each other.
//
// The 138-edit corpus pass moved every phrase metric it targeted and still
// regressed "repeated sentences across drafts" and "problems the reviewer had
// to fix". The hypothesis under test is that the edits made the corpus bodies
// more alike - same replacement shape, same shortened skeleton, same opener -
// so the drafter has less varied material and converges on its own defaults.
//
// This probe answers that with numbers, for ANY revision, so before/after is
// measured and not asserted:
//
//   npx tsx scripts/audit-probe/corpus/variety.ts                 # working tree
//   npx tsx scripts/audit-probe/corpus/variety.ts 36aecc6~1       # a revision
//   npx tsx scripts/audit-probe/corpus/variety.ts 36aecc6~1 HEAD  # both, diffed
//   npx tsx scripts/audit-probe/corpus/variety.ts --json <rev>
//   npx tsx scripts/audit-probe/corpus/variety.ts --pairs <rev>   # top pairs
//   npx tsx scripts/audit-probe/corpus/variety.ts --skeletons <rev>
//   npx tsx scripts/audit-probe/corpus/variety.ts --closers <rev>
//
// READ-ONLY. No model call, no database, no network.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { bodyMap, type JsonVolume } from "./corpus-map";

const TYPE_IDS = Object.keys(EMAIL_EXAMPLES);

/** Read a corpus at a git revision, or from the working tree when rev is null. */
export function corpusAt(rev: string | null): Map<string, string> {
  const read = (f: string) =>
    rev === null
      ? readFileSync(new URL(`../../../src/lib/${f}`, import.meta.url), "utf8")
      : execFileSync("git", ["show", `${rev}:src/lib/${f}`], { encoding: "utf8", maxBuffer: 64e6 });
  return bodyMap(
    read("email-examples.ts"),
    JSON.parse(read("email-examples-v3.json")) as JsonVolume,
    JSON.parse(read("email-examples-v4.json")) as JsonVolume,
    TYPE_IDS,
  );
}

// ---- body split and sentence split, same as the other probes ---------------
const sentencesOf = (t: string) =>
  t.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((s) => s.trim()).filter(Boolean);
export function mainText(body: string): string {
  const l = body.split("\n");
  const s = l.map((x) => x.trim()).lastIndexOf("Best,");
  const a = (s >= 0 ? l.slice(0, s) : l).join("\n").trim();
  return a.split("\n").slice(1).join("\n").trim();
}
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ---- the similarity machinery ----------------------------------------------
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * A sentence's SKELETON: content words become "_", function words stay. Two
 * sentences with the same skeleton are the same sentence with the nouns swapped
 * - which is exactly the "same replacement shape used repeatedly" failure.
 */
const FUNCTION_WORDS = new Set(
  ("a about after again all also am an and any are as at be been before being but by can could did do does " +
   "doing for from had has have he her here him his how i if in into is it its just me more most my no not " +
   "of on one or our out over own she should so some such than that the their them then there these they " +
   "this those through to too up very was we were what when where whether which while who whom why will with " +
   "would you your yours am i'd i'll i'm i've it's that's there's you're").split(" "),
);
export function skeleton(sentence: string): string {
  return norm(sentence).split(" ").map((w) => (FUNCTION_WORDS.has(w) ? w : "_")).join(" ");
}

/** Word 4-gram shingle set of a whole body, for pairwise Jaccard. */
function shingles(text: string, n = 4): Set<string> {
  const w = norm(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * The TIMING-ACCOMMODATION move: a sentence that bends to the recipient's
 * calendar, or states the student's own availability so the recipient need not
 * ask. This is the move the 138-edit pass deleted 24 times without replacing,
 * and the one CORPUS-VARIETY restores.
 *
 * Deliberately VOCABULARY-NEUTRAL, because the whole point is that the same
 * move can be made in many wordings: a detector keyed to "flexible" and "work
 * around your schedule" would score the cliche and miss every honest
 * alternative, which would make an "after" number meaningless. Questions are
 * excluded, so the ask itself ("Would you have 15 minutes for a call?") is not
 * counted as its own accommodation.
 *
 * It is a proxy, not a definition, and it is applied IDENTICALLY to every
 * revision compared - that is what makes the before/after honest.
 */
const ACCOMMODATION: RegExp[] = [
  /\b(?:flexible|at your (?:earliest )?convenience|work(?:s|ing)? around your schedule)\b/i,
  /\b(?:any|whatever|whenever|either)\b[^.!?]{0,45}\b(?:time|hour|day|morning|afternoon|evening|weekend|slot|window|week|notice)\b/i,
  /\b(?:morning|afternoon|evening|weekend|hour)s?\b[^.!?]{0,45}\b(?:open|free|easy|easiest|works?|fine|plenty|wide)\b/i,
  /\b(?:I can|I will|I am|I\u2019m)\b[^.!?]{0,70}\b(?:free|open|clear an|fit a|fit the|dial in|take the call|take it|be there|keep it free|short notice|build the week)\b/i,
  /\b(?:name an?|pick|choose|say the word)\b[^.!?]{0,45}\b(?:time|hour|slot|day|word|it)\b/i,
  /\b(?:can spare|time you can spare|least in the way|least trouble|least inconvenient|no constraints|no fixed commitments|has left over|between your own meetings|come back again)\b/i,
];
export function isAccommodation(sentence: string): boolean {
  if (/\?\s*$/.test(sentence.trim())) return false;
  return ACCOMMODATION.some((r) => r.test(sentence));
}

const THANKS_CLOSE = /^thank(?:s| you)\b/i;
const THANKS_TIME_CLOSE = /^thank(?:s| you)\b[^.!?]*\bfor (?:your |the |taking the )?time\b/i;
/** Thanks anywhere in the final sentence, not only sentence-initial. */
const THANKS_ANYWHERE = /\b(?:thank you|thanks|thank them|thankful)\b/i;

export type Report = {
  bodies: number;
  totalWords: number;
  sentences: number;
  meanSentWords: number;
  // repetition of whole sentences across different bodies
  distinctSentences: number;
  repeatedSentenceInstances: number;
  bodiesSharingASentence: number;
  topRepeatedSentences: [string, number][];
  // repetition of SHAPE across different bodies
  distinctSkeletons: number;
  repeatedSkeletonInstances: number;
  skeletonReuseRate: number;
  topSkeletons: [string, number][];
  // pairwise body similarity
  meanJaccard: number;
  p95Jaccard: number;
  pairsOver10: number;
  pairsOver20: number;
  topPairs: [string, string, number][];
  // openers and closers
  distinctOpeners: number;
  distinctClosers: number;
  topOpener: [string, number];
  topCloser: [string, number];
  topOpeners: [string, number][];
  topClosers: [string, number][];
  closeThanksAny: number;
  closeThanksTime: number;
  closeThanksAnywhere: number;
  // opener/closer SHAPE, not string
  distinctOpenerSkeletons: number;
  distinctCloserSkeletons: number;
  topCloserSkeletons: [string, number][];
  topOpenerSkeletons: [string, number][];
};

const tally = <T,>(xs: T[]) => {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
const top = <T,>(m: Map<T, number>, n: number) => [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);

export function report(corpus: Map<string, string>): Report {
  const keys = [...corpus.keys()];
  const texts = keys.map((k) => mainText(corpus.get(k)!));
  const sents = texts.map((t) => sentencesOf(t));

  // sentence-level repetition, counted ACROSS bodies (a sentence repeated
  // inside one body is not the failure being measured)
  const sentOwners = new Map<string, Set<number>>();
  sents.forEach((ss, i) => {
    for (const s of ss) {
      const k = norm(s);
      if (!k) continue;
      if (!sentOwners.has(k)) sentOwners.set(k, new Set());
      sentOwners.get(k)!.add(i);
    }
  });
  let repeatedSentenceInstances = 0;
  const sharing = new Set<number>();
  const repeatedTally = new Map<string, number>();
  for (const [k, owners] of sentOwners) {
    if (owners.size > 1) {
      repeatedSentenceInstances += owners.size;
      for (const o of owners) sharing.add(o);
      repeatedTally.set(k, owners.size);
    }
  }

  // skeleton repetition across bodies
  const skelOwners = new Map<string, Set<number>>();
  sents.forEach((ss, i) => {
    for (const s of ss) {
      const k = skeleton(s);
      if (!k || k.split(" ").length < 4) continue; // too short to be a shape
      if (!skelOwners.has(k)) skelOwners.set(k, new Set());
      skelOwners.get(k)!.add(i);
    }
  });
  let repeatedSkeletonInstances = 0;
  const skelTally = new Map<string, number>();
  for (const [k, owners] of skelOwners) {
    if (owners.size > 1) { repeatedSkeletonInstances += owners.size; skelTally.set(k, owners.size); }
  }
  const skelTotalInstances = [...skelOwners.values()].reduce((a, s) => a + s.size, 0);

  // pairwise Jaccard over 4-gram shingles
  const sh = texts.map((t) => shingles(t));
  const sims: number[] = [];
  const pairs: [string, string, number][] = [];
  for (let i = 0; i < sh.length; i++)
    for (let j = i + 1; j < sh.length; j++) {
      const s = jaccard(sh[i], sh[j]);
      sims.push(s);
      if (s >= 0.1) pairs.push([keys[i], keys[j], s]);
    }
  sims.sort((a, b) => a - b);
  const mean = sims.reduce((a, b) => a + b, 0) / (sims.length || 1);

  const openers = sents.map((ss) => ss[0] ?? "");
  const closers = sents.map((ss) => ss[ss.length - 1] ?? "");
  const openTally = tally(openers);
  const closeTally = tally(closers);

  return {
    bodies: keys.length,
    totalWords: texts.reduce((a, t) => a + words(t), 0),
    sentences: sents.reduce((a, s) => a + s.length, 0),
    meanSentWords: +(texts.reduce((a, t) => a + words(t), 0) / sents.reduce((a, s) => a + s.length, 0)).toFixed(2),
    distinctSentences: sentOwners.size,
    repeatedSentenceInstances,
    bodiesSharingASentence: sharing.size,
    topRepeatedSentences: top(repeatedTally, 12),
    distinctSkeletons: skelOwners.size,
    repeatedSkeletonInstances,
    skeletonReuseRate: +(repeatedSkeletonInstances / (skelTotalInstances || 1)).toFixed(4),
    topSkeletons: top(skelTally, 14),
    meanJaccard: +mean.toFixed(5),
    p95Jaccard: +(sims[Math.floor(sims.length * 0.95)] ?? 0).toFixed(5),
    pairsOver10: sims.filter((s) => s >= 0.1).length,
    pairsOver20: sims.filter((s) => s >= 0.2).length,
    topPairs: pairs.sort((a, b) => b[2] - a[2]).slice(0, 15),
    distinctOpeners: openTally.size,
    distinctClosers: closeTally.size,
    topOpener: top(openTally, 1)[0],
    topCloser: top(closeTally, 1)[0],
    topOpeners: top(openTally, 8),
    topClosers: top(closeTally, 10),
    closeThanksAny: closers.filter((c) => THANKS_CLOSE.test(c)).length,
    closeThanksTime: closers.filter((c) => THANKS_TIME_CLOSE.test(c)).length,
    closeThanksAnywhere: closers.filter((c) => THANKS_ANYWHERE.test(c)).length,
    distinctOpenerSkeletons: new Set(openers.map(skeleton)).size,
    distinctCloserSkeletons: new Set(closers.map(skeleton)).size,
    topCloserSkeletons: top(tally(closers.map(skeleton)), 8),
    topOpenerSkeletons: top(tally(openers.map(skeleton)), 8),
  };
}

// ---- CLI -------------------------------------------------------------------
// Guarded, so other probes can import corpusAt/report without this running a
// main() on import (the mistake draft-cli-eval.ts makes, per measure.ts's note).
const IS_MAIN = process.argv[1] !== undefined && /audit-probe\/corpus\/variety\.ts$/.test(process.argv[1]);
const argv = IS_MAIN ? process.argv.slice(2) : [];
if (IS_MAIN) runCli();
function runCli(): void {
const flags = argv.filter((a) => a.startsWith("--"));
const revs = argv.filter((a) => !a.startsWith("--"));
const label = (r: string | null) => r ?? "working tree";

const load = (r: string) => corpusAt(r === "." || r === "wt" ? null : r);

if (flags.includes("--json")) {
  console.log(JSON.stringify(report(load(revs[0] ?? ".")), null, 2));
} else if (flags.includes("--pairs") || flags.includes("--skeletons") || flags.includes("--closers")) {
  const r = report(load(revs[0] ?? "."));
  if (flags.includes("--pairs")) { console.log(`top pairs (${label(revs[0] ?? null)}):`); for (const [a, b, s] of r.topPairs) console.log(`  ${s.toFixed(3)}  ${a}  ~  ${b}`); }
  if (flags.includes("--skeletons")) { console.log(`\nmost reused SENTENCE SHAPES across bodies:`); for (const [k, n] of r.topSkeletons) console.log(`  ${String(n).padStart(3)}x  ${k.slice(0, 120)}`); }
  if (flags.includes("--closers")) {
    console.log(`\nmost repeated CLOSING strings:`); for (const [k, n] of r.topClosers) console.log(`  ${String(n).padStart(3)}x  ${k.slice(0, 100)}`);
    console.log(`\nmost repeated CLOSING shapes:`); for (const [k, n] of r.topCloserSkeletons) console.log(`  ${String(n).padStart(3)}x  ${k.slice(0, 100)}`);
    console.log(`\nmost repeated OPENING strings:`); for (const [k, n] of r.topOpeners) console.log(`  ${String(n).padStart(3)}x  ${k.slice(0, 100)}`);
  }
} else {
  const a = report(load(revs[0] ?? "."));
  const b = revs[1] ? report(load(revs[1])) : null;
  const nameA = label(revs[0] === "." || revs[0] === undefined ? null : revs[0]);
  const nameB = revs[1] ? label(revs[1] === "." ? null : revs[1]) : null;
  const row = (name: string, x: number | string, y?: number | string) =>
    console.log(`  ${name.padEnd(40)} ${String(x).padStart(10)}${y !== undefined ? String(y).padStart(12) : ""}`);
  console.log(`\n===== CORPUS VARIETY =====`);
  console.log(`  ${"".padEnd(40)} ${nameA.padStart(10)}${nameB ? nameB.padStart(12) : ""}`);
  const k = <K extends keyof Report>(key: K) => [a[key] as number | string, b ? (b[key] as number | string) : undefined] as const;
  for (const [name, key] of [
    ["bodies", "bodies"], ["total body words", "totalWords"], ["sentences", "sentences"], ["mean words / sentence", "meanSentWords"],
    ["-- sentence repetition --", null],
    ["distinct sentences", "distinctSentences"], ["sentence instances shared >1 body", "repeatedSentenceInstances"], ["bodies sharing a sentence", "bodiesSharingASentence"],
    ["-- SHAPE repetition --", null],
    ["distinct sentence shapes", "distinctSkeletons"], ["shape instances shared >1 body", "repeatedSkeletonInstances"], ["shape reuse rate", "skeletonReuseRate"],
    ["-- pairwise body similarity --", null],
    ["mean Jaccard (4-gram)", "meanJaccard"], ["p95 Jaccard", "p95Jaccard"], ["pairs >= 0.10", "pairsOver10"], ["pairs >= 0.20", "pairsOver20"],
    ["-- openers / closers --", null],
    ["distinct openers", "distinctOpeners"], ["distinct closers", "distinctClosers"],
    ["distinct opener shapes", "distinctOpenerSkeletons"], ["distinct closer shapes", "distinctCloserSkeletons"],
    ["closes on thanks (initial)", "closeThanksAny"], ["closes thanks-for-time", "closeThanksTime"], ["closing mentions thanks anywhere", "closeThanksAnywhere"],
  ] as [string, keyof Report | null][]) {
    if (key === null) { console.log(`  ${name}`); continue; }
    const [x, y] = k(key);
    row(name, x, y);
  }
  console.log(`\n  most-repeated OPENER  ${nameA}: ${a.topOpener[1]}x ${JSON.stringify(a.topOpener[0].slice(0, 46))}`);
  console.log(`  most-repeated CLOSER  ${nameA}: ${a.topCloser[1]}x ${JSON.stringify(a.topCloser[0].slice(0, 46))}`);
  if (b && nameB) {
    console.log(`  most-repeated OPENER  ${nameB}: ${b.topOpener[1]}x ${JSON.stringify(b.topOpener[0].slice(0, 46))}`);
    console.log(`  most-repeated CLOSER  ${nameB}: ${b.topCloser[1]}x ${JSON.stringify(b.topCloser[0].slice(0, 46))}`);
  }
  console.log();
}
}
