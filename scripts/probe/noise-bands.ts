// AGENT-M / MEASUREMENT 3. Per-metric noise bands from N identical arms of
// scripts/draft-cli-eval.ts (same seed, same scenario count, no code change).
// D21: an A/B moved 31 of 58 metrics while its same-code control moved 28.
// This gives every future A/B a yardstick. Offline, reads only --json outputs.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length < 2) { console.error("usage: noise-bands.ts <run-a.json> <run-b.json> [run-c.json ...]"); process.exit(1); }

type Agg = Record<string, number>;
const arms = files.map((f) => {
  const d = JSON.parse(readFileSync(f, "utf8"));
  if (!d.aggregate) throw new Error(`${f} has no aggregate block`);
  return { name: f.replace(/^.*\//, "").replace(/\.json$/, ""), agg: d.aggregate as Agg, meta: d.meta, errored: Number(d.aggregate.errored ?? 0) };
});

for (const a of arms) if (a.errored > 0) console.log(`!! ARM ${a.name} HAS errored=${a.errored} - NOT COMPARABLE`);
console.log(`arms: ${arms.map((a) => `${a.name} (drafted ${a.agg.drafted}, errored ${a.agg.errored})`).join(" | ")}`);

// The "58 metrics" of D21/HARNESS: the aggregate block minus the three run-shape
// counters (scenarios, drafted, errored), which describe the run, not the drafts.
const SHAPE = new Set(["scenarios", "drafted", "errored"]);
const keys = Object.keys(arms[0].agg).filter((k) => !SHAPE.has(k));
console.log(`metrics compared: ${keys.length} (aggregate keys ${Object.keys(arms[0].agg).length} minus ${[...SHAPE].join("/")})\n`);

// Metrics whose unit is "number of drafts out of n" or a per-draft mean. A band
// is only useful relative to the effect sizes people claim, so three views are
// given: absolute spread, spread as a share of the mean, and - for count metrics
// - spread in drafts.
const COUNTS = new Set(keys.filter((k) => Number.isInteger(arms[0].agg[k]) && arms.every((a) => Number.isInteger(a.agg[k]))));

type Row = { key: string; vals: number[]; min: number; max: number; range: number; mean: number; cv: number; moved: number; cls: string; note: string };
const rows: Row[] = keys.map((k) => {
  const vals = arms.map((a) => Number(a.agg[k] ?? 0));
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min;
  const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
  const cv = mean === 0 ? 0 : range / Math.abs(mean);
  // "moved": how many of the other arms differ from arm 1 - the D21 counting rule
  const moved = vals.slice(1).filter((v) => v !== vals[0]).length;
  return { key: k, vals, min, max, range, mean, cv, moved, cls: "", note: "" };
});

// --- the classification rule, stated before looking at the numbers:
//   LOW-NOISE at n=12        : identical across all arms (range 0), OR range <= 5% of the mean
//   MEDIUM (needs n>=24)     : range <= 25% of the mean
//   UNUSABLE-AT-THIS-N       : range > 25% of the mean
//   DEGENERATE               : all arms 0 (or constant 0) - no variance observed AND no
//                              baseline rate, so a change cannot be detected against it either
for (const r of rows) {
  if (r.mean === 0 && r.range === 0) { r.cls = "DEGENERATE"; r.note = "0 in every arm: no baseline rate, so nothing can regress against it (the D21 trap)"; continue; }
  if (r.range === 0) { r.cls = "LOW-NOISE"; r.note = "identical in every arm"; continue; }
  if (r.cv <= 0.05) r.cls = "LOW-NOISE";
  else if (r.cv <= 0.25) r.cls = "MEDIUM";
  else r.cls = "UNUSABLE-AT-THIS-N";
  if (COUNTS.has(r.key)) r.note = `moves by up to ${r.range} with the code untouched`;
}

const order = { "LOW-NOISE": 0, MEDIUM: 1, "UNUSABLE-AT-THIS-N": 2, DEGENERATE: 3 } as Record<string, number>;
rows.sort((a, b) => order[a.cls] - order[b.cls] || b.cv - a.cv || a.key.localeCompare(b.key));

const w = Math.max(...rows.map((r) => r.key.length));
console.log(`${"metric".padEnd(w)}  ${arms.map((a, i) => `arm${String.fromCharCode(65 + i)}`.padStart(10)).join("")}  ${"range".padStart(9)}  ${"range/mean".padStart(10)}  class`);
console.log("-".repeat(w + 12 * arms.length + 36));
for (const r of rows)
  console.log(`${r.key.padEnd(w)}  ${r.vals.map((v) => String(Number(v.toFixed(3))).padStart(10)).join("")}  ${String(Number(r.range.toFixed(3))).padStart(9)}  ${(r.mean === 0 ? "-" : (100 * r.cv).toFixed(1) + "%").padStart(10)}  ${r.cls}${r.note ? ` - ${r.note}` : ""}`);

const tally = new Map<string, number>();
for (const r of rows) tally.set(r.cls, (tally.get(r.cls) ?? 0) + 1);
console.log(`\nsummary of ${rows.length} metrics: ${[...tally].map(([k, v]) => `${k} ${v}`).join(", ")}`);

// D21's counting rule, reproduced: how many metrics move between identical arms.
for (let i = 1; i < arms.length; i++) {
  const n = keys.filter((k) => Number(arms[i].agg[k]) !== Number(arms[0].agg[k])).length;
  console.log(`metrics that moved, arm${String.fromCharCode(65 + i)} vs armA (same code, same seed): ${n} of ${keys.length}`);
}
const anyMoved = keys.filter((k) => new Set(arms.map((a) => Number(a.agg[k]))).size > 1).length;
console.log(`metrics that took more than one value across all ${arms.length} arms: ${anyMoved} of ${keys.length}`);

// What a future A/B needs: the minimum effect a single pair of runs could detect.
console.log(`\n--- minimum detectable effect at this n, per class (one run per arm)`);
console.log(`  a single-pair delta smaller than the band below is indistinguishable from noise:`);
for (const cls of ["LOW-NOISE", "MEDIUM", "UNUSABLE-AT-THIS-N"]) {
  const g = rows.filter((r) => r.cls === cls);
  if (!g.length) continue;
  console.log(`  ${cls.padEnd(20)} n=${String(g.length).padStart(2)}  worst range/mean in class ${(100 * Math.max(...g.map((r) => r.cv))).toFixed(1)}%`);
}
