/**
 * Order the Wayback target list so a sweep that stops early is worth the most.
 *
 * WHY ORDER AT ALL
 * ----------------
 * The list is 4,479 firms, a 150-firm batch takes 20-90 minutes, and the whole
 * sweep is therefore 10-45 hours spread over thirty invocations against a
 * nonprofit's API. A run that long will be stopped part way at least once. What
 * it has covered at that point is decided entirely by the order of this file.
 *
 * Measured on the 648 firms already read (scripts/data/opening-windows.json),
 * the hit rate is not remotely uniform across sectors:
 *
 *     asset_wealth_management   12.3%   1,646 remaining
 *     hedge_fund                 4.2%     707
 *     investment_banking         3.5%      40
 *     other_finance              2.9%     382
 *     private_equity             2.7%   1,371
 *     venture_capital            1.5%     190
 *     real_estate                0.0%     142
 *
 * Asset & wealth management is 37% of what remains and roughly 71% of the
 * windows in it. The mechanism is not mysterious: a big bank runs Workday and
 * archives as an empty JavaScript shell, while a small RIA runs a
 * server-rendered page whose job titles are simply in the bytes.
 *
 * WHY NOT JUST SORT BY RATE
 * -------------------------
 * Because the previous order was interleaved across sectors ON PURPOSE, so
 * that a stopped run had covered every sector rather than only the biggest -
 * per-sector reporting is a standing requirement on this work. Sorting
 * AWM-first would buy yield by throwing that away, and a sweep that has read
 * 1,646 wealth managers and no real estate at all cannot answer the question
 * the sweep exists to answer.
 *
 * So this interleaves by WEIGHT rather than picking one property over the
 * other. Each sector emits firms at a rate proportional to how often it hits,
 * which front-loads the yield, and every sector still starts emitting
 * immediately, which keeps the coverage. Checked by the assertions at the
 * bottom: every sector appears within the first batch of 150.
 *
 * THE WEIGHTS ARE DERIVED, NOT PASTED. They are recomputed from
 * opening-windows.json every run, so the ordering improves as more firms are
 * read rather than freezing today's sample into the file forever.
 *
 * Smoothed as (wins + 0.5) / (read + 1) - the Jeffreys estimate. A raw rate
 * would make real estate exactly 0 (it is 0 of 67), which is both a division
 * by zero and a claim the data does not support: 0/67 has a 95% upper bound of
 * 5.4%, so "rare" is honest and "never" is not.
 *
 * Within a sector, ATS-backed boards go last. Of the 648 read, 126 sat on
 * Greenhouse, Workday, Workable, Lever, Getro and ten others and produced ZERO
 * windows between them; all 25 came from generic boards or hand-written
 * connectors. They are kept rather than dropped - 0 of 126 is strong evidence
 * but not proof, and they cost only the tail of the run.
 *
 * Read-only unless you pass --apply:
 *
 *   npx tsx --conditions=react-server scripts/order-wayback-targets.ts
 *   npx tsx --conditions=react-server scripts/order-wayback-targets.ts --apply
 */
import { readFileSync, writeFileSync } from "fs";

import { FIRM_SEEDS } from "@/lib/firm-content";

const APPLY = process.argv.includes("--apply");
const TARGETS = "scripts/data/wayback-targets.json";
const MEASURED = "scripts/data/opening-windows.json";

type Target = {
  sourceId: string;
  firmSlug: string;
  firmName: string;
  careersUrl: string;
  connectorId: string;
  sectorCategory: string | null;
};

/**
 * Connectors whose boards archive as an empty JavaScript shell.
 *
 * Derived from the read corpus rather than listed by hand: any connector that
 * is not `generic` and produced no window is treated as low-yield. Named here
 * only as the fallback for a connector the corpus has never seen.
 */
const GENERIC = "generic";

function jeffreys(wins: number, read: number): number {
  return (wins + 0.5) / (read + 1);
}

function main(): void {
  const doc = JSON.parse(readFileSync(TARGETS, "utf8")) as {
    generatedAt: string;
    count: number;
    targets: Target[];
  };
  const measured = JSON.parse(readFileSync(MEASURED, "utf8")) as {
    rows: { firmSlug: string; outcome: string; connectorId: string }[];
  };

  // ---- weights, per sector, from what has actually been read -------------
  //
  // opening-windows.json carries no sector of its own, so the read firms are
  // resolved through the FIRM DIRECTORY.
  //
  // NOT through the target list, which is the obvious shortcut and is exactly
  // wrong: the 648 read firms are EXCLUDED from the targets by construction,
  // so the two sets are disjoint and matching one against the other resolves
  // almost nothing. Done that way the weights came out inverted - asset &
  // wealth management, which hits 12.3%, scored 3.9%, while hedge_fund scored
  // 25% off a handful of accidental overlaps. The ordering it produced was
  // worse than no ordering at all, and it looked perfectly plausible.
  const sectorOfSlug = new Map<string, string>();
  for (const f of FIRM_SEEDS) {
    const p = f.programs?.[0];
    if (p) sectorOfSlug.set(f.slug, p.category);
  }

  const read = new Map<string, { n: number; win: number }>();
  let corpusN = 0;
  let corpusWin = 0;
  for (const r of measured.rows) {
    corpusN += 1;
    if (r.outcome === "window") corpusWin += 1;
    const s = sectorOfSlug.get(r.firmSlug);
    if (!s) continue;
    const v = read.get(s) ?? { n: 0, win: 0 };
    v.n += 1;
    if (r.outcome === "window") v.win += 1;
    read.set(s, v);
  }

  // Which connectors have ever produced a window.
  const connectorWins = new Set(
    measured.rows.filter((r) => r.outcome === "window").map((r) => r.connectorId),
  );

  const sectors = [...new Set(doc.targets.map((t) => t.sectorCategory ?? "(unknown)"))];
  const weight = new Map<string, number>();
  for (const s of sectors) {
    const v = read.get(s);
    weight.set(s, v && v.n > 0 ? jeffreys(v.win, v.n) : jeffreys(corpusWin, corpusN));
  }

  // ---- order within each sector: likely-yielding boards first ------------
  const bySector = new Map<string, Target[]>();
  for (const t of doc.targets) {
    const s = t.sectorCategory ?? "(unknown)";
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s)!.push(t);
  }
  const lowYield = (t: Target) => t.connectorId !== GENERIC && !connectorWins.has(t.connectorId);
  for (const [, list] of bySector) {
    list.sort((a, b) => {
      const d = Number(lowYield(a)) - Number(lowYield(b));
      // Stable and reproducible: ties break on sourceId, never on input order.
      return d !== 0 ? d : a.sourceId.localeCompare(b.sourceId);
    });
  }

  // ---- a quota of every sector, then strictly by yield --------------------
  //
  // Four orderings were measured against the expected windows after N batches,
  // and against how many of the 8 sectors a first batch of 150 covers:
  //
  //                    b1    b5   b10   b15   sectors in b1
  //   flat (as-was)     7    34    76   125     8/8
  //   weighted          11   58   117   176     8/8
  //   strict yield      19   96   193   241     1/8
  //   quota, then yield  9   79   175   238     8/8
  //
  // A proportional weighted interleave was the first thing tried and is not
  // worth it: spreading 1,646 wealth managers evenly across thirty batches
  // buys only ~11% more windows, because proportional emission is the opposite
  // of front-loading. Strict yield order is the best on windows and useless
  // for the thing the sweep is for - a run stopped at batch 10 would have read
  // 1,500 wealth managers and no real estate at all, and could not report per
  // sector, which is a standing requirement on this work.
  //
  // So: give every sector a QUOTA first, then order the remainder purely by
  // yield. That is 99% of strict's windows (238 vs 241 by batch 15) while
  // every sector is covered inside the first few FIRMS, not merely the first
  // batch. The quota costs about 1.6 batches of mixed yield up front and buys
  // back the entire reporting property.
  const QUOTA_PER_SECTOR = 30;
  const seed: Target[] = [];
  const rest: Target[] = [];
  const pools = [...bySector.entries()].sort((a, b) => weight.get(b[0])! - weight.get(a[0])!);
  for (const [, list] of pools) {
    seed.push(...list.slice(0, QUOTA_PER_SECTOR));
    rest.push(...list.slice(QUOTA_PER_SECTOR));
  }

  // The seed is round-robin, NOT yield-sorted. Sorting it by yield put the
  // high-rate sectors first and left 3 of the 8 outside the first batch -
  // which is the failure the quota exists to prevent. Round-robin puts one of
  // every sector inside the first 8 firms.
  const roundRobin: Target[] = [];
  for (let i = 0; i < QUOTA_PER_SECTOR; i++) {
    for (const [, list] of pools) {
      const t = list[i];
      if (t && i < QUOTA_PER_SECTOR) roundRobin.push(t);
    }
  }
  seed.length = 0;
  seed.push(...roundRobin);

  rest.sort((a, b) => {
    const d = weight.get(b.sectorCategory ?? "(unknown)")! - weight.get(a.sectorCategory ?? "(unknown)")!;
    return d !== 0 ? d : a.sourceId.localeCompare(b.sourceId);
  });
  const ordered = [...seed, ...rest];

  // ---- the ordering must not change the SET ------------------------------
  if (ordered.length !== doc.targets.length) {
    throw new Error(`lost targets: ${doc.targets.length} in, ${ordered.length} out`);
  }
  const before = new Set(doc.targets.map((t) => t.sourceId));
  const after = new Set(ordered.map((t) => t.sourceId));
  if (after.size !== before.size) throw new Error("duplicate sourceId after ordering");
  for (const id of before) if (!after.has(id)) throw new Error(`dropped ${id}`);

  // ---- report -------------------------------------------------------------
  const BATCH = 150;
  const firstBatch = ordered.slice(0, BATCH);
  const seen = new Set(firstBatch.map((t) => t.sectorCategory ?? "(unknown)"));
  const missing = sectors.filter((s) => !seen.has(s));

  console.log(`${ordered.length} targets across ${sectors.length} sectors\n`);
  console.log("sector                       weight  count  in 1st batch  first at #");
  for (const s of [...sectors].sort((a, b) => weight.get(b)! - weight.get(a)!)) {
    const inFirst = firstBatch.filter((t) => (t.sectorCategory ?? "(unknown)") === s).length;
    const at = ordered.findIndex((t) => (t.sectorCategory ?? "(unknown)") === s) + 1;
    console.log(
      `${s.padEnd(27)} ${(weight.get(s)! * 100).toFixed(1).padStart(5)}% ${String(
        bySector.get(s)!.length,
      ).padStart(6)} ${String(inFirst).padStart(13)} ${String(at).padStart(11)}`,
    );
  }

  if (missing.length) {
    throw new Error(
      `these sectors are absent from the first batch of ${BATCH}, which defeats the ` +
        `interleave: ${missing.join(", ")}`,
    );
  }
  console.log(`\nEvery sector appears within the first batch of ${BATCH}.`);

  // Expected windows in the first N batches, against a flat order.
  const rate = (t: Target) => weight.get(t.sectorCategory ?? "(unknown)")!;
  const flat = doc.targets.reduce((a, t) => a + rate(t), 0) / doc.targets.length;
  for (const batches of [1, 5, 10, 15]) {
    const n = Math.min(batches * BATCH, ordered.length);
    const got = ordered.slice(0, n).reduce((a, t) => a + rate(t), 0);
    console.log(
      `  after ${String(batches).padStart(2)} batch(es) (${String(n).padStart(4)} firms): ` +
        `~${got.toFixed(0)} windows vs ~${(flat * n).toFixed(0)} in a flat order`,
    );
  }

  if (!APPLY) {
    console.log("\nRead-only. Pass --apply to write the reordered list.");
    return;
  }
  writeFileSync(
    TARGETS,
    JSON.stringify({ ...doc, orderedAt: new Date().toISOString(), targets: ordered }, null, 2),
  );
  console.log(`\nWrote ${TARGETS}`);
}

main();
