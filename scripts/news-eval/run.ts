/**
 * Scores a news labeller against the golden set (scripts/news-eval/golden.jsonl).
 *
 *   npm run news:eval -- baseline               the original keyword rules in finance-news.ts
 *   npm run news:eval -- classifier [--model m] the live classifier, through the claude CLI
 *   npm run news:eval -- file <labels.jsonl>    any saved labels: {key, relevant, sectors, story_type, worthiness}
 *   npm run news:eval -- audit                  what the tabs actually show now, judged against the golden labels
 *   add --golden <file> to score against another golden set (default golden.jsonl)
 *
 * Reports relevance precision and recall, precision / recall / F1 for every
 * one of the fourteen sectors, and whether each clears the bar - on the whole
 * set, and again on the stories the labellers were confident about.
 *
 * THE BARS (both precision and recall - the owner asked for both):
 *   relevance precision >= 97%   no off-topic story on a tab
 *   relevance recall    >= 85%   good stories are not thrown away
 *   every sector precision >= 88% and recall >= 80%
 *   macro-F1 across sectors >= 0.85
 * A sector with fewer than 10 gold stories is reported but not judged: one
 * story is ten points of recall at that size.
 *
 * The golden labels were written by a strong model from the same rubric the
 * classifier is given (src/lib/news/classifier-prompt.ts). Change the rubric,
 * and the golden set's labels may need revisiting for the stories it touches.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { legacyLabel } from "../../src/lib/finance-news";
import { classifyPack, validateLabel, type ModelItem } from "../../src/lib/news/classify";
import { CLASSIFIER_MODEL, CLASSIFIER_VERSION, PACK_SIZE } from "../../src/lib/news/classifier-prompt";
import { mapLimit } from "../../src/lib/news/fetch";
import { SECTORS, isSector, type Sector } from "../../src/lib/news/types";

// Three database connections, not the default twelve. The Supabase pooler
// allows fifteen for the whole project, the dev server holds eight and the
// crawl wants its own - on 21 September 2026 that collision lost fifteen firms
// from a crawl. This job's queries are small and sequential enough for three.
process.env.OFFERLY_DB_POOL ??= "3";

type Gold = { relevant: boolean; abstain: string | null; sectors: string[]; storyType: string; worthiness: number; uncertain: boolean; qualityOk?: boolean };
type Row = { key: string; headline: string; summary: string | null; publisher: string; publisherDomain: string | null; source: string; tier: string; trustedFor: string[]; gold: Gold };
type Prediction = { relevant: boolean; sectors: Sector[]; storyType?: string; worthiness?: number };

const BARS = { relevancePrecision: 0.97, relevanceRecall: 0.85, sectorPrecision: 0.88, sectorRecall: 0.8, macroF1: 0.85, minSupport: 10 };

const GOLDEN = process.argv.includes("--golden") ? process.argv[process.argv.indexOf("--golden") + 1] : "scripts/news-eval/golden.jsonl";

function load(): Row[] {
  return readFileSync(GOLDEN, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

/**
 * The end-to-end check: read every tab exactly as the page does, and judge each
 * story shown against the golden labels. This is the number a student feels -
 * what is on the screen - rather than the classifier's accuracy on its own.
 */
async function audit(rows: Row[]) {
  const { openDb } = await import("../../src/db/open");
  const { readTab } = await import("../../src/lib/news/read");
  const { urlHash } = await import("../../src/lib/news/filters");
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const opened = await openDb();
  console.log(`database: ${opened.backend}`);
  const shownKeys = new Set<string>();
  let confidentJudged = 0, confidentRight = 0;
  let shown = 0, judged = 0, relevant = 0, qualityOk = 0, speculative = 0, thin = 0, unconfirmed = 0, withPhoto = 0, rightTab = 0;
  const bad: string[] = [];
  try {
    for (const sector of [null, ...SECTORS]) {
      const tab = await readTab(opened.db, sector, sector ? 24 : 30);
      for (const story of tab) {
        shown++;
        if (story.unconfirmed) unconfirmed++;
        if (story.imageUrl) withPhoto++;
        const key = urlHash(story.link).slice(0, 16);
        shownKeys.add(key);
        const row = byKey.get(key);
        if (!row) continue;
        judged++;
        const g = row.gold;
        if (g.relevant) relevant++;
        if (g.qualityOk !== false && g.relevant) qualityOk++;
        if (g.abstain === "speculative") speculative++;
        if (g.relevant && g.worthiness <= 1) thin++;
        const onRightTab = sector === null ? g.relevant : g.sectors.includes(sector);
        if (onRightTab) rightTab++;
        if (!g.uncertain) {
          confidentJudged++;
          if (onRightTab) confidentRight++;
        }
        if (!onRightTab) bad.push(`  [${sector ?? "main"}] gold=${g.relevant ? g.sectors.join(",") : g.abstain}  ${row.headline.slice(0, 90)} - ${row.publisher}`);
      }
    }
  } finally {
    await opened.close().catch(() => {});
  }
  const high = rows.filter((r) => r.gold.relevant && r.gold.qualityOk !== false && r.gold.worthiness >= 3 && !r.gold.uncertain);
  const reached = high.filter((r) => shownKeys.has(r.key)).length;
  const p = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
  console.log(`\nWHAT STUDENTS SEE (all 15 tabs, ${shown} cards; ${judged} of them in the golden set)`);
  console.log(`  real finance news             ${p(relevant, judged)}`);
  console.log(`  judged good quality           ${p(qualityOk, judged)}`);
  console.log(`  on the right tab              ${p(rightTab, judged)}   (confident gold only: ${p(confidentRight, confidentJudged)})`);
  console.log(`  speculative pieces shown      ${speculative}`);
  console.log(`  thin (worthiness 1) shown     ${thin}`);
  console.log(`  marked Unconfirmed            ${unconfirmed}`);
  console.log(`  cards with a photo            ${withPhoto}`);
  console.log(`\nGOOD STORIES THAT REACHED A TAB`);
  console.log(`  important (worthiness 3-4), confident gold: ${reached}/${high.length} = ${p(reached, high.length)}`);
  if (bad.length) console.log(`\nSHOWN BUT WRONG (${bad.length}):\n${bad.slice(0, 40).join("\n")}`);
}

async function predictBaseline(rows: Row[]): Promise<Map<string, Prediction>> {
  return new Map(
    rows.map((r) => {
      const l = legacyLabel({ title: r.headline, source: r.publisher, sourceDomain: r.publisherDomain });
      return [r.key, { relevant: l.relevant, sectors: l.sectors }];
    }),
  );
}

async function predictClassifier(rows: Row[], model: string): Promise<Map<string, Prediction>> {
  const sources = new Map(rows.map((r) => [r.source, { tier: r.tier, sectors: r.trustedFor }]));
  const packs: Row[][] = [];
  for (let i = 0; i < rows.length; i += PACK_SIZE) packs.push(rows.slice(i, i + PACK_SIZE));
  const out = new Map<string, Prediction>();
  let cost = 0;
  let done = 0;
  await mapLimit(packs, 3, async (pack) => {
    const outcome = await classifyPack(
      pack.map((r) => ({ id: r.key, title: r.headline, description: r.summary, publisher: r.publisher, sourceId: r.source })),
      sources,
      { model },
    );
    if (!outcome.result.ok) throw new Error(`${outcome.result.failure}: ${outcome.result.error}`);
    cost += outcome.result.usage.costUsd;
    for (const [key, label] of outcome.labels) {
      out.set(key, { relevant: label.relevant, sectors: label.sectors, storyType: label.storyType, worthiness: label.worthiness });
    }
    process.stdout.write(`\r  labelled ${(done += pack.length)}/${rows.length}`);
  });
  console.log(`\n  model ${model}, prompt ${CLASSIFIER_VERSION}, notional cost $${cost.toFixed(3)}, unlabelled ${rows.length - out.size}`);
  return out;
}

/**
 * Saved labels. A raw model answer (it has an "id" and "entities") goes through
 * the same validateLabel as production, so the score is of what would actually
 * be stored - not of what the model said before the checks.
 */
function predictFile(path: string, rows: Row[]): Map<string, Prediction> {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = new Map<string, Prediction>();
  for (const line of readFileSync(path, "utf8").trim().split("\n")) {
    const l = JSON.parse(line);
    const key = l.key ?? l.id;
    const row = byKey.get(key);
    if (!row) continue;
    if ("entities" in l) {
      const v = validateLabel(l as ModelItem, { title: row.headline, description: row.summary });
      if (v) out.set(key, { relevant: v.relevant, sectors: v.sectors, storyType: v.storyType, worthiness: v.worthiness });
    } else {
      out.set(key, { relevant: Boolean(l.relevant), sectors: (l.sectors ?? []).filter(isSector), storyType: l.story_type, worthiness: l.worthiness });
    }
  }
  return out;
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "  n/a");
const f1 = (p: number, r: number) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));

function score(rows: Row[], preds: Map<string, Prediction>, title: string): boolean {
  let tp = 0, fp = 0, fn = 0;
  const per = new Map(SECTORS.map((s) => [s, { tp: 0, fp: 0, fn: 0 }]));
  let typeRight = 0, typeTotal = 0, worthClose = 0;
  for (const r of rows) {
    // An unlabelled story counts as "not relevant": a failure to label is a miss.
    const p = preds.get(r.key) ?? { relevant: false, sectors: [] };
    if (p.relevant && r.gold.relevant) tp++;
    else if (p.relevant) fp++;
    else if (r.gold.relevant) fn++;
    const gold = new Set(r.gold.relevant ? r.gold.sectors : []);
    const pred = new Set(p.relevant ? p.sectors : []);
    for (const s of SECTORS) {
      const c = per.get(s)!;
      if (pred.has(s) && gold.has(s)) c.tp++;
      else if (pred.has(s)) c.fp++;
      else if (gold.has(s)) c.fn++;
    }
    if (p.relevant && r.gold.relevant && p.storyType) {
      typeTotal++;
      if (p.storyType === r.gold.storyType) typeRight++;
      if (p.worthiness && Math.abs(p.worthiness - r.gold.worthiness) <= 1) worthClose++;
    }
  }

  const relP = tp / (tp + fp), relR = tp / (tp + fn);
  let pass = relP >= BARS.relevancePrecision && relR >= BARS.relevanceRecall;
  console.log(`\n${title}  (${rows.length} stories, ${rows.filter((r) => r.gold.relevant).length} relevant)`);
  console.log(`  relevance   precision ${pct(relP)} ${relP >= BARS.relevancePrecision ? "ok " : "LOW"}   recall ${pct(relR)} ${relR >= BARS.relevanceRecall ? "ok " : "LOW"}`);
  console.log(`  sector                      n   precision  recall     F1`);
  const f1s: number[] = [];
  for (const s of SECTORS) {
    const c = per.get(s)!;
    const n = c.tp + c.fn;
    const p = c.tp / (c.tp + c.fp), r = c.tp / (c.tp + c.fn), f = f1(p || 0, r || 0);
    const judged = n >= BARS.minSupport;
    if (judged) f1s.push(f);
    const ok = !judged ? "(too few to judge)" : p >= BARS.sectorPrecision && r >= BARS.sectorRecall ? "ok" : "BELOW BAR";
    if (judged && ok !== "ok") pass = false;
    console.log(`  ${s.padEnd(26)} ${String(n).padStart(3)}   ${pct(p).padStart(7)}  ${pct(r).padStart(7)}  ${f.toFixed(2)}  ${ok}`);
  }
  const macro = f1s.reduce((a, b) => a + b, 0) / (f1s.length || 1);
  if (macro < BARS.macroF1) pass = false;
  console.log(`  macro-F1 ${macro.toFixed(3)} ${macro >= BARS.macroF1 ? "ok" : "LOW"}`);
  if (typeTotal) console.log(`  story type ${pct(typeRight / typeTotal)}   worthiness within 1: ${pct(worthClose / typeTotal)}`);
  console.log(`  => ${pass ? "PASSES every bar" : "does not pass"}`);
  return pass;
}

async function main() {
  const [mode = "baseline", arg] = process.argv.slice(2);
  const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : CLASSIFIER_MODEL;
  const rows = load();
  if (mode === "audit") return audit(rows);
  const preds =
    mode === "baseline" ? await predictBaseline(rows) : mode === "classifier" ? await predictClassifier(rows, model) : mode === "file" ? predictFile(arg, rows) : null;
  if (!preds) throw new Error(`unknown mode "${mode}"`);
  if (mode === "classifier") {
    const path = `scripts/news-eval/last-run-${model}.jsonl`;
    writeFileSync(path, [...preds].map(([key, p]) => JSON.stringify({ key, relevant: p.relevant, sectors: p.sectors, story_type: p.storyType, worthiness: p.worthiness })).join("\n") + "\n");
    console.log(`  predictions saved to ${path}`);
  }
  // --only <keys file>: score a subset, e.g. the held-out half when the
  // prompt has been tuned on the other half. Scoring on stories the prompt
  // was tuned against overstates how well it generalises.
  const onlyPath = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const only = onlyPath ? new Set(readFileSync(onlyPath, "utf8").split(/\s+/).filter(Boolean)) : null;
  const scored = only ? rows.filter((r) => only.has(r.key)) : rows;
  const label = `${mode}${only ? ` (${onlyPath})` : ""}`;
  score(scored, preds, `${label} - all stories`);
  score(scored.filter((r) => !r.gold.uncertain), preds, `${label} - confident gold labels only`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
