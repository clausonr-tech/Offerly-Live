// AGENT-M / MEASUREMENT 1. The reviewer's REAL edit-span count k, measured by
// aligning each draft's pre-review body against its post-review body, then the
// patch-vs-whole-body payload arithmetic at each draft's OWN measured k,
// following TESTER-1's method in docs/concepts/TEST-A.md T3.
//
// Input: one or more --json= outputs of scripts/draft-cli-eval.ts (which persist
// `preReviewBody` and `body` per scenario). No model call, no API, no src/ edit.
import { readFileSync } from "node:fs";

const CPT = 3.7;
const tok = (s: string) => s.length / CPT;

// --- the harness's own body split, copied verbatim (scripts/draft-cli-eval.ts:175)
function bodyParts(body: string): { aboveSignOff: string; greeting: string; text: string } {
  const lines = body.split("\n");
  const signOff = lines.map((l) => l.trim()).lastIndexOf("Best,");
  const aboveSignOff = (signOff >= 0 ? lines.slice(0, signOff) : lines).join("\n").trim();
  const greeting = aboveSignOff.split("\n")[0]?.trim() ?? "";
  return { aboveSignOff, greeting, text: aboveSignOff.split("\n").slice(1).join("\n").trim() };
}
// --- the harness's own sentence split, copied verbatim (scripts/draft-cli-eval.ts:167)
function sentencesOf(text: string): string[] {
  return text
    .replace(/\s*\n\s*/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- apostrophe/quote normalisation, the approach of draft-review.ts's `loose()`
//     (src/lib/draft-review.ts:252). `loose` also lowercases; for counting edits a
//     case change IS an edit, so `norm` keeps case and `looseNorm` does not. Both
//     are reported, so the trap is visible rather than assumed away.
const quoteNorm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const norm = (s: string) => quoteNorm(s);
const looseNorm = (s: string) => quoteNorm(s).toLowerCase();

type Hunk = { pre: string[]; post: string[] };

/** LCS over normalised sentences -> contiguous diff hunks. */
function hunks(a: string[], b: string[], key: (s: string) => string): Hunk[] {
  const A = a.map(key), B = b.map(key);
  const n = A.length, m = B.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Hunk[] = [];
  let i = 0, j = 0, cur: Hunk | null = null;
  const flush = () => { if (cur && (cur.pre.length || cur.post.length)) out.push(cur); cur = null; };
  while (i < n && j < m) {
    if (A[i] === B[j]) { flush(); i++; j++; continue; }
    cur ??= { pre: [], post: [] };
    if (L[i + 1][j] >= L[i][j + 1]) cur.pre.push(a[i++]);
    else cur.post.push(b[j++]);
  }
  if (i < n || j < m) { cur ??= { pre: [], post: [] }; while (i < n) cur.pre.push(a[i++]); while (j < m) cur.post.push(b[j++]); }
  flush();
  return out;
}

type Row = {
  file: string; id: string; profile: string; boxes: string; leadType: string;
  nPre: number; nPost: number;
  kHunks: number; kSent: number; kHunksLoose: number; kSentLoose: number;
  charsPreChanged: number; charsPostChanged: number; bodyChars: number; fullBodyChars: number;
  problems: number;
  hunkList: Hunk[]; preText: string; postText: string; fullPostBody: string;
};

const files = process.argv.slice(2);
if (!files.length) { console.error("usage: k-measure.ts <eval-json> [more...]"); process.exit(1); }

const rows: Row[] = [];
let skippedRejected = 0, skippedErrored = 0, skippedNoChange = 0, totalReviewed = 0;

for (const file of files) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const r of data.scenarios as Record<string, unknown>[]) {
    if (!r.ok) { skippedErrored++; continue; }
    const rev = r.review as Record<string, unknown> | null;
    if (!rev || !rev.ran) { skippedErrored++; continue; }
    totalReviewed++;
    if (!rev.applied) { skippedRejected++; continue; }
    const pre = bodyParts(String(r.preReviewBody)).text;
    const post = bodyParts(String(r.body)).text;
    const sPre = sentencesOf(pre), sPost = sentencesOf(post);
    const hs = hunks(sPre, sPost, norm);
    const hsL = hunks(sPre, sPost, looseNorm);
    if (!hs.length) { skippedNoChange++; }
    rows.push({
      file: file.replace(/^.*\//, ""), id: String(r.id), profile: String(r.profile),
      boxes: (r.boxes as string[]).join("+"), leadType: String(r.leadType),
      nPre: sPre.length, nPost: sPost.length,
      kHunks: hs.length, kSent: hs.reduce((a, h) => a + Math.max(h.pre.length, h.post.length), 0),
      kHunksLoose: hsL.length, kSentLoose: hsL.reduce((a, h) => a + Math.max(h.pre.length, h.post.length), 0),
      charsPreChanged: hs.reduce((a, h) => a + h.pre.join(" ").length, 0),
      charsPostChanged: hs.reduce((a, h) => a + h.post.join(" ").length, 0),
      bodyChars: pre.length, fullBodyChars: String(r.body).length,
      problems: Number(rev.problems ?? 0),
      hunkList: hs, preText: pre, postText: post, fullPostBody: String(r.body),
    });
  }
}

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;
const histLine = (xs: number[]) => {
  const h = new Map<number, number>();
  for (const x of xs) h.set(x, (h.get(x) ?? 0) + 1);
  return [...h.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `k=${k}: ${v} (${pct(v, xs.length)})`).join("  ");
};

console.log(`\n================ MEASUREMENT 1 - the reviewer's real k ================`);
console.log(`files: ${files.map(f => f.replace(/^.*\//, "")).join(", ")}`);
console.log(`reviewed drafts: ${totalReviewed}   guard-applied (k measurable): ${rows.length}   guard-rejected (no edit landed): ${skippedRejected}   errored/no-review: ${skippedErrored}`);
console.log(`of the applied edits, drafts with zero detected sentence change: ${skippedNoChange}`);

for (const [label, kk] of [["k = contiguous diff HUNKS (one {find,replace} each)", rows.map(r => r.kHunks)],
                           ["k = changed SENTENCE slots (TESTER-1's unit)", rows.map(r => r.kSent)]] as const) {
  console.log(`\n--- ${label}`);
  console.log(`  histogram: ${histLine(kk as number[])}`);
  const a = kk as number[];
  console.log(`  median ${med(a)}  mean ${mean(a).toFixed(2)}  min ${Math.min(...a)}  max ${Math.max(...a)}`);
  console.log(`  k=0: ${a.filter(x=>x===0).length} (${pct(a.filter(x=>x===0).length,a.length)})   k=1: ${a.filter(x=>x===1).length} (${pct(a.filter(x=>x===1).length,a.length)})   k=2: ${a.filter(x=>x===2).length} (${pct(a.filter(x=>x===2).length,a.length)})   k>=3: ${a.filter(x=>x>=3).length} (${pct(a.filter(x=>x>=3).length,a.length)})`);
}
console.log(`\n--- apostrophe/quote trap check (does normalisation change k?)`);
const diffNorm = rows.filter(r => r.kHunks !== r.kHunksLoose).length;
console.log(`  case+quote-insensitive vs quote-only-insensitive hunk count differs on ${diffNorm}/${rows.length} drafts`);
const rawHunks = rows.map(r => hunks(sentencesOf(r.preText), sentencesOf(r.postText), (s) => s.replace(/\s+/g, " ").trim()).length);
console.log(`  WITHOUT apostrophe normalisation, mean k(hunks) would be ${mean(rawHunks).toFixed(2)} vs ${mean(rows.map(r=>r.kHunks)).toFixed(2)} WITH it (inflation ${(mean(rawHunks)-mean(rows.map(r=>r.kHunks))).toFixed(2)} spans/draft)`);
const u2019pre = rows.filter(r=>/[‘’]/.test(r.preText)).length, u2019post = rows.filter(r=>/[‘’]/.test(r.postText)).length;
console.log(`  bodies containing U+2019 above the sign-off: pre ${u2019pre}/${rows.length}, post ${u2019post}/${rows.length}`);

console.log(`\n--- the review's own problems[] (emitted by BOTH schemas)`);
console.log(`  problems per draft: median ${med(rows.map(r=>r.problems))}  mean ${mean(rows.map(r=>r.problems)).toFixed(2)}`);

console.log(`\n--- characters changed vs body length (what a patch payload actually costs)`);
const ratio = rows.map(r => (r.charsPreChanged + r.charsPostChanged) / (r.bodyChars || 1));
console.log(`  pre-side chars inside changed spans:  median ${med(rows.map(r=>r.charsPreChanged)).toFixed(0)}  mean ${mean(rows.map(r=>r.charsPreChanged)).toFixed(0)}`);
console.log(`  post-side chars inside changed spans: median ${med(rows.map(r=>r.charsPostChanged)).toFixed(0)}  mean ${mean(rows.map(r=>r.charsPostChanged)).toFixed(0)}`);
console.log(`  editable body chars (pre):            median ${med(rows.map(r=>r.bodyChars)).toFixed(0)}  mean ${mean(rows.map(r=>r.bodyChars)).toFixed(0)}`);
console.log(`  (find+replace)/body ratio:            median ${med(ratio).toFixed(2)}  mean ${mean(ratio).toFixed(2)}  >=1.0 on ${rows.filter((_,i)=>ratio[i]>=1).length}/${rows.length} drafts`);

// ---- the payload arithmetic, TESTER-1's method (TEST-A.md T3 / scripts/probe/edits-arith.ts)
// problems[] is in BOTH schemas; its `quote` already repeats the span, so it is counted.
function payload(r: Row, unit: "hunks" | "sentences", bodyMode: "editable" | "full") {
  const spans = unit === "hunks"
    ? r.hunkList.map(h => ({ find: h.pre.join(" "), replace: h.post.join(" ") }))
    : r.hunkList.flatMap(h => { const n = Math.max(h.pre.length, h.post.length); return Array.from({length:n},(_,i)=>({find: h.pre[i] ?? "", replace: h.post[i] ?? ""})); });
  // problems[] is IDENTICAL in both schemas, so its quotes must not depend on `unit`.
  // Real `quote` values are short: a single offending sentence. Use the changed
  // pre-side sentences, flattened, exactly as TESTER-1's probe did.
  const changedSentences = r.hunkList.flatMap(h => h.pre);
  const quotes = Array.from({ length: r.problems }, (_, i) => changedSentences[i % Math.max(changedSentences.length, 1)] || r.preText.slice(0, 80));
  const probs = quotes.map(q => ({ kind: "flow", quote: q, fix: "reworded it", needsStudent: false }));
  const bodyOut = bodyMode === "editable" ? r.postText : r.fullPostBody;
  const patch = tok(JSON.stringify({ problems: probs, subjectFix: null, edits: spans }));
  const whole = tok(JSON.stringify({ problems: probs, subject: "A subject line of ordinary length", body: bodyOut }));
  return { patch, whole };
}
for (const bodyMode of ["editable", "full"] as const) {
  console.log(`\n--- payload arithmetic, problems[] counted, whole-body = ${bodyMode === "editable" ? "editable middle only (TESTER-1's base, conservative toward the patch being a LOSS)" : "the real full body the reviewer emits (greeting + sign-off included)"}`);
  for (const unit of ["hunks", "sentences"] as const) {
    let P = 0, W = 0, win = 0;
    const deltas: number[] = [];
    for (const r of rows) { const { patch, whole } = payload(r, unit, bodyMode); P += patch; W += whole; if (patch < whole) win++; deltas.push((patch - whole) / whole); }
    const d = (1 - P / W) * 100;
    console.log(`  unit=${unit.padEnd(9)} patch ${(P/rows.length).toFixed(0)} tok vs whole ${(W/rows.length).toFixed(0)} tok  =>  ${d >= 0 ? "-" : "+"}${Math.abs(d).toFixed(0)}% output tokens` +
      `   patch smaller on ${win}/${rows.length} (${pct(win, rows.length)})   per-draft median delta ${(med(deltas)*100>=0?"+":"")}${(med(deltas)*100).toFixed(0)}%`);
  }
}

console.log(`\n--- payload delta by measured k bucket (unit=hunks, problems[] counted, whole-body = editable middle)`);
console.log(`  k | drafts | patch tok | whole tok | delta`);
for (const k of [0, 1, 2, 3, 4, 5]) {
  const g = rows.filter(r => r.kHunks === k);
  if (!g.length) continue;
  let P = 0, W = 0;
  for (const r of g) { const { patch, whole } = payload(r, "hunks", "editable"); P += patch; W += whole; }
  const d = (1 - P / W) * 100;
  console.log(`  ${k} | ${String(g.length).padStart(6)} | ${(P/g.length).toFixed(0).padStart(9)} | ${(W/g.length).toFixed(0).padStart(9)} | ${d >= 0 ? "-" : "+"}${Math.abs(d).toFixed(0)}%`);
}

console.log(`\n--- per-arm breakdown (k = hunks)`);
for (const f of new Set(rows.map(r => r.file))) {
  const g = rows.filter(r => r.file === f);
  console.log(`  ${f.padEnd(18)} n=${String(g.length).padEnd(3)} median ${med(g.map(r=>r.kHunks))}  mean ${mean(g.map(r=>r.kHunks)).toFixed(2)}  k>=3 ${pct(g.filter(r=>r.kHunks>=3).length, g.length)}`);
}
for (const p of new Set(rows.map(r => r.profile))) {
  const g = rows.filter(r => r.profile === p);
  console.log(`  profile=${p.padEnd(11)} n=${String(g.length).padEnd(3)} median ${med(g.map(r=>r.kHunks))}  mean ${mean(g.map(r=>r.kHunks)).toFixed(2)}  k>=3 ${pct(g.filter(r=>r.kHunks>=3).length, g.length)}`);
}

if (process.argv.includes("--rows")) {
  console.log(`\n--- per-draft rows`);
  console.log(`  id/boxes | prof | nPre | nPost | kHunks | kSent | preCh | postCh | bodyCh | probs`);
  for (const r of [...rows].sort((a,b)=>a.kHunks-b.kHunks))
    console.log(`  ${r.id} ${r.boxes} | ${r.profile} | ${r.nPre} | ${r.nPost} | ${r.kHunks} | ${r.kSent} | ${r.charsPreChanged} | ${r.charsPostChanged} | ${r.bodyChars} | ${r.problems}`);
}
