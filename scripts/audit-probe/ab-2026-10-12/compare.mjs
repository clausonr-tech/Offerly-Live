// Compare two draft-cli-eval --json runs and their graded counterparts.
// node compare.mjs <base.json> <new.json> [base-graded.json] [new-graded.json]
import { readFileSync, existsSync } from "node:fs";
const read = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const [basePath, newPath, baseGradedPath, newGradedPath] = process.argv.slice(2);
const base = read(basePath), neu = read(newPath);

// +1 bigger is better, -1 smaller is better, 0 informational (no verdict).
const DIR = {
  blockedLanguage: -1,
  cannedEasyOutPre: -1, cannedEasyOutPost: -1, cannedFlexibilityPre: -1, cannedFlexibilityPost: -1,
  cannedLinesPre: -1, cannedLinesPost: -1, cannedResumePre: -1, cannedResumePost: -1,
  contractionRatePreMean: +1, contractionRatePostMean: +1, contractionsPreMean: +1, contractionsPostMean: +1,
  zeroContractionPre: -1, zeroContractionPost: -1,
  draftMsMean: -1, reviewMsMean: -1, totalMsMean: -1,
  drafted: +1, errored: -1, guardAcceptRate: +1,
  issuesPre: -1, issuesPost: -1, issuesPreMean: -1, issuesPostMean: -1,
  lintCleanPre: +1, lintCleanPost: +1,
  lintForReviewPre: -1, lintForReviewPost: -1, lintForStudentPost: -1,
  longestIRunPreMean: -1, longestIRunPostMean: -1, threeIStartsPre: -1, threeIStartsPost: -1,
  overCeilingPre: -1, overCeilingPost: -1, overCeilingWordsPost: -1,
  pleasantryOpenPre: -1, pleasantryOpenPost: -1,
  problems: -1, problemsMean: -1, problemsNeedsStudent: -1,
  repeatedSentencesPre: -1, repeatedSentencesPost: -1,
  reviewErrored: -1, reviewRejected: -1, reviewRetried: -1, reviewRetrySkippedForTime: -1,
  wordsPreMean: -1, wordsPostMean: -1,
  // informational
  scenarios: 0, reviewRan: 0, reviewApplied: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdSubscription: 0,
};
// Noise bands measured at n=24, widened by sqrt(24/n).
const BAND24 = { contractionsPreMean: 0.16, contractionsPostMean: 0.16, cannedLinesPre: 1, cannedLinesPost: 1, issuesPre: 4, issuesPost: 4, wordsPreMean: 2.8, wordsPostMean: 2.8 };

const n = Math.min(base.aggregate.drafted, neu.aggregate.drafted) || 1;
const band = (k) => (BAND24[k] === undefined ? 0 : BAND24[k] * Math.sqrt(24 / n));

const unknown = [];
const rows = [];
for (const k of [...new Set([...Object.keys(base.aggregate), ...Object.keys(neu.aggregate)])]) {
  const b = base.aggregate[k], a = neu.aggregate[k];
  if (typeof b !== "number" || typeof a !== "number") continue;
  if (DIR[k] === undefined) unknown.push(k);
  const dir = DIR[k] ?? 0;
  const d = Number((a - b).toFixed(4));
  const w = band(k);
  let verdict;
  if (dir === 0) verdict = "info";
  else if (d === 0) verdict = "same";
  else if (Math.abs(d) <= w) verdict = `same (within ±${w.toFixed(2)})`;
  else verdict = (dir > 0 ? d > 0 : d < 0) ? "BETTER" : "WORSE";
  rows.push({ k, b, a, d, verdict });
}
const rank = (v) => (v === "BETTER" ? 0 : v === "WORSE" ? 1 : v.startsWith("same") ? 2 : 3);
rows.sort((x, y) => rank(x.verdict) - rank(y.verdict) || x.k.localeCompare(y.k));

console.log(`\n=== ${basePath.split("/").pop()}  ->  ${newPath.split("/").pop()}   (n=${n} drafted each) ===\n`);
console.log("metric".padEnd(26) + "base".padStart(11) + "new".padStart(11) + "delta".padStart(11) + "   verdict");
for (const r of rows) console.log(r.k.padEnd(26) + String(r.b).padStart(11) + String(r.a).padStart(11) + String(r.d > 0 ? `+${r.d}` : r.d).padStart(11) + "   " + r.verdict);
const t = rows.reduce((m, r) => { const key = r.verdict === "info" ? "info" : r.verdict.startsWith("same") ? "same" : r.verdict; m[key] = (m[key] ?? 0) + 1; return m; }, {});
console.log(`\n  ${t.BETTER ?? 0} better, ${t.same ?? 0} same, ${t.WORSE ?? 0} worse, ${t.info ?? 0} informational, of ${rows.length} metrics.`);
if (unknown.length) console.log(`  ** no direction declared for: ${unknown.join(", ")} - treated as informational **`);

const bg = read(baseGradedPath), ng = read(newGradedPath);
if (bg && ng) {
  console.log("\n=== WOULD THEY REPLY ===\n");
  const label = { ask: "asked for a reply", no_ask: "asked for nothing", conditional: "ask only if named", unclassified: "unclassified" };
  console.log("bucket".padEnd(20) + "base".padStart(14) + "new".padStart(14) + "   verdict");
  for (const s of ["ask", "no_ask", "conditional", "unclassified"]) {
    const B = bg.byShape?.[s], A = ng.byShape?.[s];
    if (!B?.n && !A?.n) continue;
    const num = (x) => (s === "ask" ? x.replied : x.n - x.offPutting);
    const d = num(A) / (A.n || 1) - num(B) / (B.n || 1);
    console.log(label[s].padEnd(20) + `${num(B)} of ${B.n}`.padStart(14) + `${num(A)} of ${A.n}`.padStart(14) + "   " + (d > 0.001 ? "BETTER" : d < -0.001 ? "WORSE" : "same"));
  }
  const tells = [...new Set([...Object.keys(bg.tells ?? {}), ...Object.keys(ng.tells ?? {})])];
  console.log("\n" + "tell".padEnd(24) + "base".padStart(7) + "new".padStart(7));
  for (const k of tells.sort((x, y) => ((ng.tells?.[y] ?? 0) + (bg.tells?.[y] ?? 0)) - ((ng.tells?.[x] ?? 0) + (bg.tells?.[x] ?? 0))))
    console.log(k.padEnd(24) + String(bg.tells?.[k] ?? 0).padStart(7) + String(ng.tells?.[k] ?? 0).padStart(7));
  const off = (g) => Object.values(g.byShape ?? {}).reduce((s, x) => s + x.offPutting, 0);
  console.log(`\n  off-putting overall: base ${off(bg)}, new ${off(ng)}`);
}
