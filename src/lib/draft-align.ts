// Aligning a reviewer's edited body to the draft it edited, sentence by
// sentence, so each change can be judged on its own instead of the edit being
// accepted or thrown away whole.
//
// Why sentence level and not a word or character diff. Every rule the guard
// enforces is a property of a sentence: a comma splice belongs to a sentence,
// not to the words that changed, and "added a capitalised word" needs to know
// whether the word opens its sentence. A word-level hunk like `great -> glad`
// cannot be lint-checked, and a hunk that straddles a sentence boundary cannot
// be validated independently - which is the whole point (PLAN-B v1 §3.1.2).
//
// Pure: no API calls, no clock, no I/O.

/** One sentence of the original body, with where it sat. */
export type Seg = { i: number; para: number; sent: number; text: string };

export type Op =
  /** 1:1, identical after normalising. */
  | { kind: "keep"; orig: Seg[]; rev: string[] }
  /** 1:1, reworded. */
  | { kind: "rewrite"; orig: Seg[]; rev: string[] }
  /** 1:n - one sentence became several. */
  | { kind: "split"; orig: Seg[]; rev: string[] }
  /** n:1 - several sentences became one. */
  | { kind: "merge"; orig: Seg[]; rev: string[] }
  /** The sentence is gone from the edit. */
  | { kind: "delete"; orig: Seg[]; rev: [] }
  /** New text with no original behind it, anchored after an original index. */
  | { kind: "insert"; orig: []; rev: string[]; afterOrig: number };

export type Alignment = {
  greeting: { original: string; revised: string };
  ops: Op[];
  /** Original paragraph count, so the assembler can rebuild the breaks. */
  paragraphs: number;
  /**
   * Why the edit cannot be represented sentence-wise at all. Set when the
   * aligner sees a reorder: `REVIEW_SYSTEM` explicitly permits reordering ("To
   * vary sentence openings, reorder or reword a sentence"), a monotone
   * alignment reads a reorder as a delete plus an insert, and applying half of
   * that either duplicates or loses a sentence. The caller falls back to the
   * whole edit rather than guessing (PLAN-B v2 ranks this the design's largest
   * risk).
   */
  bail?: string;
};

// Abbreviations that end in a period without ending a sentence. "a.m."/"p.m."
// are here because LOGIC-2 F12 recorded the lint's own splitter breaking on them.
const ABBREVIATIONS = new Set(
  "mr mrs ms dr prof dean st jr sr vs e.g i.e u.s inc co ltd corp dept approx no fig a.m p.m".split(" "),
);

/** Mask `[placeholders]` with same-length filler so a "." inside one never ends a sentence. */
function maskPlaceholders(text: string): { masked: string; restore: (s: string) => string } {
  const found: string[] = [];
  const masked = text.replace(/\[[^\]\n]{2,}\]/g, (m) => {
    found.push(m);
    // Same length, no sentence punctuation, no capital that could start a sentence.
    return `\u0001${"x".repeat(Math.max(0, m.length - 2))}\u0002`;
  });
  let n = 0;
  const restore = (s: string) => s.replace(/\u0001x*\u0002/g, () => found[n++] ?? "");
  return { masked, restore };
}

/** The sentences of one paragraph, in order. A single newline is also a boundary. */
export function sentencesOfParagraph(paragraph: string): string[] {
  const out: string[] = [];
  for (const line of paragraph.split("\n")) {
    const { masked, restore } = maskPlaceholders(line);
    const pieces: string[] = [];
    let at = 0;
    const boundary = /([.!?])(["'”’)]*)(\s+)(?=[A-Z“"(\u0001])/g;
    let m: RegExpExecArray | null;
    while ((m = boundary.exec(masked)) !== null) {
      const head = masked.slice(at, m.index + m[1].length + m[2].length);
      const lastWord = (head.match(/([A-Za-z.]+)\.$/)?.[1] ?? "").toLowerCase();
      // Never after an abbreviation, and never after a single initial ("J. Moreno").
      if (ABBREVIATIONS.has(lastWord) || /^[A-Za-z]$/.test(lastWord)) continue;
      pieces.push(head);
      at = m.index + m[0].length;
    }
    pieces.push(masked.slice(at));
    for (const piece of pieces) {
      // Restore in order across the whole line, so the counter stays in step.
      const text = restore(piece).trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/** A body above the sign-off, as a greeting line and paragraphs of sentences. */
export function segment(bodyAboveSignOff: string): { greeting: string; paragraphs: string[][] } {
  const lines = bodyAboveSignOff.split("\n");
  const greeting = (lines[0] ?? "").trim();
  const rest = lines.slice(1).join("\n");
  const paragraphs = rest
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(sentencesOfParagraph);
  return { greeting, paragraphs };
}

const tokens = (s: string): string[] =>
  (s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .match(/[a-z0-9']+/g) ?? []);

/** Token Dice coefficient: 1 when the two share every token, 0 when they share none. */
export function sim(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.length === 0 && B.length === 0) return 1;
  if (A.length === 0 || B.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const t of A) pool.set(t, (pool.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of B) {
    const n = pool.get(t) ?? 0;
    if (n > 0) {
      shared++;
      pool.set(t, n - 1);
    }
  }
  return (2 * shared) / (A.length + B.length);
}

/** Same words in the same order, ignoring case, quote shape and spacing. */
const same = (a: string, b: string) => tokens(a).join(" ") === tokens(b).join(" ");

/** A reworded sentence at this similarity or above pairs with its original rather than being a delete plus an insert. */
const MATCH_FLOOR = 0.35;
/** One sentence became these, or these became one, at this similarity or above. */
const SPLIT_FLOOR = 0.45;
/** A moved sentence: an insert this close to a deleted original is a reorder, not new text. */
const MOVE_FLOOR = 0.8;

/**
 * Needleman-Wunsch over two sentence lists. Gap penalty 0.35 so a pair at
 * `sim >= 0.35` prefers the diagonal (cost 0.35 against 0.70 for a gap each
 * side). `n, m <= ~12` sentences, so the quadratic cost is nothing.
 */
function nw(a: string[], b: string[]): [number, number][] {
  const GAP = MATCH_FLOOR;
  // A pairing BELOW the floor is not a pairing. Without this the diagonal is
  // always cheaper than a delete plus an insert - a match scores `sim >= 0`
  // against `-2 x 0.35` for the two gaps - so the aligner pairs sentences with
  // nothing in common rather than admitting that one was deleted and another
  // added. MEASURED, on the sweep in scripts/draft-review-test.ts: deleting the
  // first sentence shifted everything up and paired "Jeff Moreno thought you
  // would be a great person..." with "I'm a sophomore at Duke..." at a Dice
  // similarity of 0.14, which made both spans look like rewrites and cost the
  // one good fix in the edit. Alignment quality IS prose quality here, so a
  // pair the aligner cannot believe in is refused outright.
  const score2 = (x: string, y: string) => {
    const value = sim(x, y);
    return value >= MATCH_FLOOR ? value : -Infinity;
  };
  const n = a.length;
  const m = b.length;
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) score[i][0] = score[i - 1][0] - GAP;
  for (let j = 1; j <= m; j++) score[0][j] = score[0][j - 1] - GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      score[i][j] = Math.max(
        score[i - 1][j - 1] + score2(a[i - 1], b[j - 1]),
        score[i - 1][j] - GAP,
        score[i][j - 1] - GAP,
      );
    }
  }
  // Traceback by a tolerance, never by float equality: three sums of Dice
  // coefficients are compared, and `===` on them can miss every branch and
  // fall through to a wrong one.
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && near(score[i][j], score[i - 1][j - 1] + score2(a[i - 1], b[j - 1]))) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (i > 0 && (j === 0 || near(score[i][j], score[i - 1][j] - GAP))) {
      pairs.push([i - 1, -1]);
      i--;
    } else {
      pairs.push([-1, j - 1]);
      j--;
    }
  }
  return pairs.reverse();
}

/**
 * Align a revised body to its original, sentence by sentence.
 *
 * Both bodies are the text above the sign-off: everything from the sign-off on
 * is rebuilt from the profile whatever the reviewer returns, so it is not
 * aligned and never a span.
 */
export function alignBodies(original: string, revised: string): Alignment {
  const before = segment(original);
  const after = segment(revised);
  const origSegs: Seg[] = [];
  before.paragraphs.forEach((sentences, para) =>
    sentences.forEach((text, sent) => origSegs.push({ i: origSegs.length, para, sent, text })),
  );
  const revSentences = after.paragraphs.flat();

  const origTexts = origSegs.map((s) => s.text);
  const pairs = nw(origTexts, revSentences);

  // The traceback gives 1:1, 1:0 and 0:1 only. A SPLIT and a MERGE have to be
  // recovered from it, and they have to be recovered in both directions: when
  // one sentence becomes two, the diagonal lands on whichever half resembles
  // the original more, which is as often the SECOND half as the first. Looking
  // only ahead missed every split whose match landed on the later piece - it
  // came out as an insert plus a rewrite, and the insert is then rejected as
  // new content, which silently halves the sentence.
  //
  // So: start from one block per traceback entry, then fold an orphan block
  // into a neighbouring pair - on either side - whenever doing so explains the
  // original materially better (SPLIT_FLOOR, and +0.1 over the pair alone).
  type Block = { ois: number[]; rjs: number[] };
  const blocks: Block[] = pairs.map(([oi, rj]) => ({ ois: oi >= 0 ? [oi] : [], rjs: rj >= 0 ? [rj] : [] }));
  const joinO = (ois: number[]) => ois.map((i) => origTexts[i]).join(" ");
  const joinR = (rjs: number[]) => rjs.map((j) => revSentences[j]).join(" ");
  for (let guard = 0; guard < blocks.length + 1; guard++) {
    let folded = false;
    for (let k = 0; k < blocks.length && !folded; k++) {
      const b = blocks[k];
      if (b.ois.length > 0 && b.rjs.length > 0) continue;
      for (const nk of [k - 1, k + 1]) {
        if (nk < 0 || nk >= blocks.length) continue;
        const n = blocks[nk];
        if (n.ois.length === 0 || n.rjs.length === 0) continue;
        // An orphan revised sentence beside a 1:1 pair: a split of that original.
        if (b.rjs.length > 0 && b.ois.length === 0 && n.ois.length === 1) {
          const rjs = nk < k ? [...n.rjs, ...b.rjs] : [...b.rjs, ...n.rjs];
          const now = sim(joinO(n.ois), joinR(rjs));
          if (now >= SPLIT_FLOOR && now >= sim(joinO(n.ois), joinR(n.rjs)) + 0.1) {
            n.rjs = rjs;
            blocks.splice(k, 1);
            folded = true;
            break;
          }
        }
        // An orphan original beside a 1:1 pair: a merge into that revised sentence.
        if (b.ois.length > 0 && b.rjs.length === 0 && n.rjs.length === 1) {
          const ois = nk < k ? [...n.ois, ...b.ois] : [...b.ois, ...n.ois];
          const now = sim(joinO(ois), joinR(n.rjs));
          if (now >= SPLIT_FLOOR && now >= sim(joinO(n.ois), joinR(n.rjs)) + 0.1) {
            n.ois = ois;
            blocks.splice(k, 1);
            folded = true;
            break;
          }
        }
      }
    }
    if (!folded) break;
  }

  const ops: Op[] = [];
  for (const { ois, rjs } of blocks) {
    const orig = ois.map((i) => origSegs[i]);
    const rev = rjs.map((j) => revSentences[j]);
    if (orig.length === 0) {
      const placed = ops.flatMap((op) => op.orig).map((seg) => seg.i);
      ops.push({ kind: "insert", orig: [], rev, afterOrig: placed.length > 0 ? Math.max(...placed) : -1 });
    } else if (rev.length === 0) {
      ops.push({ kind: "delete", orig, rev: [] });
    } else if (orig.length === 1 && rev.length === 1) {
      ops.push({ kind: same(orig[0].text, rev[0]) ? "keep" : "rewrite", orig, rev });
    } else if (orig.length === 1) {
      ops.push({ kind: "split", orig, rev });
    } else {
      ops.push({ kind: "merge", orig, rev });
    }
  }

  // What cannot be left alone is a REORDER. A monotone alignment has no way to say
  // "this sentence moved", so it says "deleted here, inserted there" - and
  // applying one half of that duplicates or loses a sentence. Rather than guess,
  // the whole edit is handed back to the whole-edit guard.
  const deleted = ops.filter((op) => op.kind === "delete").flatMap((op) => op.orig.map((s) => s.text));
  const inserted = ops.filter((op) => op.kind === "insert").flatMap((op) => op.rev);
  const moved = inserted.find((text) => deleted.some((gone) => sim(gone, text) >= MOVE_FLOOR));
  const bail = moved ? `the edit moves a sentence ("${moved.slice(0, 40)}")` : undefined;

  return {
    greeting: { original: before.greeting, revised: after.greeting },
    ops,
    paragraphs: before.paragraphs.length,
    ...(bail ? { bail } : {}),
  };
}

export const ALIGN_FLOORS = { MATCH_FLOOR, SPLIT_FLOOR, MOVE_FLOOR };
