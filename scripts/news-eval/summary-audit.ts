/**
 * Checks what students read on /news beyond the headlines: the story
 * summaries, the daily briefing, and each student's digest.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/news-eval/summary-audit.ts [options]
 *     --generate N     first write summaries for up to N stories without one
 *     --summaries N    judge the N newest summaries (default 300)
 *     --out <file>     every verdict as JSONL (default: summary-audit.jsonl in the OS temp dir)
 *     --only-failed <file>  re-judge only the stories a previous --out marked failing
 *
 * Summaries: rebuilt from the same material the summary step reads (the
 * article's text, or every outlet's feed summary), then a stronger model than
 * the writer judges each one - is every point supported, is it clear to a
 * student new to finance, is it short, is the takeaway specific to the story.
 * Code checks run alongside: length, blocked language, dangling references.
 * A page can change between writing and judging, so an "unsupported" verdict
 * is a flag to read, not proof.
 *
 * Briefing: every bullet of today's briefing, judged against the stories it
 * cites. Digest: real students' digests built (not stored) and checked for
 * the rules the page depends on.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { openDb } from "../../src/db/open";
import { newsBriefings, newsItems, newsSummaries, users } from "../../src/db/schema";
import { findBlockedLanguage } from "../../src/lib/content-limits";
import { runClaude } from "../../src/lib/news/claude-cli";
import { buildDigest, editionDate } from "../../src/lib/news/digest";
import { mapLimit } from "../../src/lib/news/fetch";
import { materialFor, runSummaries, type StorySummary, type SummaryMaterial } from "../../src/lib/news/summary";
import { publisherArticles, type SitemapEntry } from "../../src/lib/news/resolve-url";
import type { BriefingPiece } from "../../src/lib/news/briefing";
import { buildDashboard, dataLines } from "../../src/lib/market-data/board";

process.env.OFFERLY_DB_POOL ??= "3";

const JUDGE_MODEL = "claude-opus-5-5";
const BATCH = 5;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------------------------------------------------------------- code checks

const DANGLING = /^(?:the (?:firm|company|bank|fund|deal|group|move)|it|they|this|these|he|she)\b/i;

export function codeProblems(s: StorySummary): string[] {
  const out: string[] = [];
  const all = [...s.points, ...(s.takeaway ? [s.takeaway] : [])];
  if (s.points.length < 1 || s.points.length > 3) out.push(`${s.points.length} points`);
  if (!s.takeaway) out.push("no takeaway");
  for (const p of s.points) if (p.split(" ").length > 22) out.push(`long point (${p.split(" ").length} words)`);
  if (s.takeaway && s.takeaway.split(" ").length > 24) out.push("long takeaway");
  if (all.some((t) => t.includes("—"))) out.push("em dash");
  if (all.some((t) => findBlockedLanguage(t))) out.push("blocked language");
  if (s.points[0] && DANGLING.test(s.points[0])) out.push("first point starts with a dangling reference");
  const seen = new Set<string>();
  for (const p of s.points) {
    const k = p.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    if (seen.has(k)) out.push("repeated point");
    seen.add(k);
  }
  return out;
}

// ---------------------------------------------------------------- the judge

const SUMMARY_JUDGE = `You audit short summaries of finance news stories written for university students recruiting into finance. For each one you get the source text the summary was written from, and the summary: key points and a takeaway.

Judge strictly:
- accurate: everything that happened, every number, cause and judgement ("growing", "underperforming", "drove", a trend) is stated in the source text. A claim not in the text makes it false, as does a rumour stated as done, one cause given where the text gives several, or a number attached to the wrong thing. Identifying context is allowed from general knowledge - who a well-known person or institution is, what an abbreviation or term means - judge that only on whether it is true, and fail it only if it is wrong or doubtful. List each problem in "problems".
- on_story: every point is about the story in the headline, not another story on the same page.
- clear: 1-5, how easily a smart student new to finance understands it without reading the article. 5 = instantly clear; 3 = needs a re-read or has an unexplained term; 1 = confusing.
- standalone: every point makes sense on its own (names the company or person; no "the facilities" or "the deal" with nothing before it saying which).
- concise: short and plain; no padding, no two facts crammed into one point.
- takeaway_specific: the takeaway says something about THIS story, not a line that fits any story ("shows strong deal activity", "matters for finance recruits").
- note: at most 20 words on the biggest problem, or "fine".`;

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          accurate: { type: "boolean" },
          problems: { type: "array", items: { type: "string" } },
          on_story: { type: "boolean" },
          clear: { type: "integer" },
          standalone: { type: "boolean" },
          concise: { type: "boolean" },
          takeaway_specific: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["id", "accurate", "problems", "on_story", "clear", "standalone", "concise", "takeaway_specific", "note"],
      },
    },
  },
  required: ["verdicts"],
};

type SummaryVerdict = { accurate: boolean; problems: string[]; on_story: boolean; clear: number; standalone: boolean; concise: boolean; takeaway_specific: boolean; note: string };

const BULLET_JUDGE = `You audit a daily news briefing for university students recruiting into finance. Each bullet cites the stories it came from; you get each story's headline and feed summary.

Judge strictly:
- supported: everything that happened, every number and every judgement in the bullet is stated or directly implied by its cited stories; list each claim that is not in "problems". Identifying context is allowed from general knowledge - a well-known person's first name or title, which country an institution is from, what an abbreviation means - judge it only on whether it is true.
- clear: 1-5, how easily a smart student new to finance understands it. 5 = instantly clear; 3 = needs a re-read or an unexplained term; 1 = confusing.
- standalone: it names who and where; no "the firm" or "inflation rose" without saying which.
- A bullet under "What the moves mean" may also say how markets or the economy usually work, worded that way ("higher yields usually push up mortgage rates") - judge that only on whether it is true and well established. A forecast of what will happen, advice or opinion is NOT supported.
- A bullet that cites DATA lines: its numbers must match them.
- note: at most 20 words on the biggest problem, or "fine".`;

const BULLET_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          supported: { type: "boolean" },
          problems: { type: "array", items: { type: "string" } },
          clear: { type: "integer" },
          standalone: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["id", "supported", "problems", "clear", "standalone", "note"],
      },
    },
  },
  required: ["verdicts"],
};

type BulletVerdict = { supported: boolean; problems: string[]; clear: number; standalone: boolean; note: string };

async function judge<V>(system: string, schema: object, items: { id: string; text: string }[], label: string): Promise<Map<string, V>> {
  const out = new Map<string, V>();
  const batches: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  let done = 0;
  await mapLimit(batches, 3, async (batch) => {
    const result = await runClaude<{ verdicts: (V & { id: string })[] }>({
      model: JUDGE_MODEL,
      system,
      prompt: `Judge each of these ${batch.length}.\n\n${batch.map((b) => `=== [${b.id}]\n${b.text}`).join("\n\n")}`,
      schema,
      timeoutMs: 300_000,
    });
    done += batch.length;
    if (!result.ok) {
      console.log(`  ${label}: a judge call failed (${result.error}); ${batch.length} left unjudged`);
      return;
    }
    for (const v of result.data.verdicts ?? []) if (batch.some((b) => b.id === v.id)) out.set(v.id, v);
    if (done % 50 < BATCH) console.log(`  ${label}: ${done}/${items.length} judged`);
  });
  return out;
}

// ---------------------------------------------------------------- main

async function main() {
  const opened = await openDb();
  const db = opened.db;
  console.log(`summary audit ${new Date().toISOString()}  database: ${opened.backend}`);
  const outFile = arg("out") ?? path.join(tmpdir(), "summary-audit.jsonl");
  const lines: string[] = [];
  let tests = 0;
  let failures = 0;

  try {
    const generate = Number(arg("generate") ?? 0);
    if (generate > 0) {
      const r = await runSummaries(db, { limit: generate, timeBudgetMs: 60 * 60_000 });
      console.log(`generate  ${r.looked} looked at: ${r.written} written, ${r.thin} too thin, ${r.failed} failed, ${r.calls} calls${r.stopped ? `  STOPPED ${r.stopped}` : ""}`);
    }

    // ---- summaries
    const want = Number(arg("summaries") ?? 300);
    const onlyFailed = arg("only-failed");
    const failedIds = onlyFailed
      ? readFileSync(onlyFailed, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "summary" && !r.pass).map((r) => r.itemId as string)
      : null;
    const rows = await db
      .select({ itemId: newsItems.id, clusterId: newsItems.clusterId, origin: newsItems.origin, url: newsItems.url, resolvedUrl: newsItems.resolvedUrl, title: newsItems.title, publisher: newsItems.publisher, publisherDomain: newsItems.publisherDomain, payload: newsSummaries.payload })
      .from(newsSummaries)
      .innerJoin(newsItems, eq(newsItems.id, newsSummaries.itemId))
      .where(and(eq(newsSummaries.status, "ok"), isNull(newsItems.hiddenAt), failedIds ? inArray(newsItems.id, failedIds.length ? failedIds : ["00000000-0000-0000-0000-000000000000"]) : sql`true`))
      .orderBy(desc(newsSummaries.createdAt))
      .limit(want);
    const copyRows = rows.length
      ? await db
          .select({ clusterId: newsItems.clusterId, id: newsItems.id, title: newsItems.title, description: newsItems.description, publisher: newsItems.publisher })
          .from(newsItems)
          .where(inArray(newsItems.clusterId, rows.map((r) => r.clusterId).filter((c): c is string => Boolean(c))))
      : [];
    const materials = new Map<string, SummaryMaterial | null>();
    const sitemaps = new Map<string, Promise<SitemapEntry[]>>();
    const articlesOf = (domain: string) => {
      if (!sitemaps.has(domain)) sitemaps.set(domain, publisherArticles(domain).catch(() => []));
      return sitemaps.get(domain)!;
    };
    await mapLimit(rows, 6, async (r) => {
      const copies = copyRows.filter((c) => c.clusterId === r.clusterId).sort((a, b) => Number(b.id === r.itemId) - Number(a.id === r.itemId)).slice(0, 5);
      materials.set(r.itemId, await materialFor(r, copies, { articlesOf }));
    });
    const toJudge = rows
      .filter((r) => materials.get(r.itemId))
      .map((r, i) => {
        const s = r.payload as StorySummary;
        const m = materials.get(r.itemId)!;
        return {
          id: `s${i + 1}`,
          row: r,
          text: `HEADLINE: ${r.title} (${r.publisher})\nSOURCE TEXT (${m.basis}):\n${m.text}\n\nSUMMARY\nKey points:\n${s.points.map((p) => `- ${p}`).join("\n")}\nTakeaway: ${s.takeaway ?? "(none)"}`,
        };
      });
    console.log(`summaries ${rows.length} to judge (${rows.length - toJudge.length} whose source could not be rebuilt are judged by code only)`);
    const verdicts = await judge<SummaryVerdict>(SUMMARY_JUDGE, SUMMARY_SCHEMA, toJudge.map(({ id, text }) => ({ id, text })), "summaries");

    const tally = { accurate: 0, onStory: 0, clear4: 0, standalone: 0, concise: 0, takeaway: 0, codeClean: 0, judged: 0 };
    for (const r of rows) {
      tests++;
      const s = r.payload as StorySummary;
      const code = codeProblems(s);
      const j = toJudge.find((t) => t.row.itemId === r.itemId);
      const v = j ? verdicts.get(j.id) : undefined;
      if (v) {
        tally.judged++;
        if (v.accurate) tally.accurate++;
        if (v.on_story) tally.onStory++;
        if (v.clear >= 4) tally.clear4++;
        if (v.standalone) tally.standalone++;
        if (v.concise) tally.concise++;
        if (v.takeaway_specific) tally.takeaway++;
      }
      if (code.length === 0) tally.codeClean++;
      const pass = code.length === 0 && (!v || (v.accurate && v.on_story && v.clear >= 4 && v.standalone && v.takeaway_specific));
      if (!pass) failures++;
      lines.push(JSON.stringify({ kind: "summary", pass, itemId: r.itemId, title: r.title, publisher: r.publisher, basis: s.basis, summary: s, code, verdict: v ?? null }));
    }
    const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((100 * n) / d) : 0}%)`;
    console.log(`\nSUMMARIES  ${rows.length} checked, ${tally.judged} by the judge`);
    console.log(`  accurate            ${pct(tally.accurate, tally.judged)}`);
    console.log(`  about the story     ${pct(tally.onStory, tally.judged)}`);
    console.log(`  clear (4-5 of 5)    ${pct(tally.clear4, tally.judged)}`);
    console.log(`  stands alone        ${pct(tally.standalone, tally.judged)}`);
    console.log(`  concise             ${pct(tally.concise, tally.judged)}`);
    console.log(`  specific takeaway   ${pct(tally.takeaway, tally.judged)}`);
    console.log(`  code checks clean   ${pct(tally.codeClean, rows.length)}`);

    // ---- briefing
    const edition = editionDate(new Date(), null);
    const pieces = await db.select({ scope: newsBriefings.scope, payload: newsBriefings.payload }).from(newsBriefings).where(eq(newsBriefings.editionDate, edition));
    // The briefing's pieces, and the Markets view's "How markets moved" wraps
    // (scope markets_open / markets_close), which are stored alongside them.
    const bullets = pieces.flatMap((p) => {
      const payload = p.payload as Partial<BriefingPiece> & { bullets?: BriefingPiece["headings"][string] };
      if (payload.headings) return Object.entries(payload.headings).flatMap(([heading, list]) => list.map((b) => ({ scope: p.scope, heading, ...b })));
      return (payload.bullets ?? []).map((b) => ({ scope: p.scope, heading: "How markets moved", ...b }));
    });
    const links = [...new Set(bullets.flatMap((b) => b.sources.map((s) => s.link)))];
    const cited = links.length
      ? await db.select({ url: newsItems.url, title: newsItems.title, description: newsItems.description, publisher: newsItems.publisher }).from(newsItems).where(inArray(newsItems.url, links))
      : [];
    const byLink = new Map(cited.map((c) => [c.url, c]));
    // Market bullets cite the day's numbers; the judge gets them to check against.
    // Official daily numbers do not move within a day; a live price may have.
    const numbers = bullets.some((b) => b.data?.length) ? await buildDashboard().then(dataLines).catch(() => []) : [];
    // The writer saw more than one copy's summary - every copy of the cited events is fair source.
    const bulletItems = bullets.map((b, i) => ({
      id: `b${i + 1}`,
      text: `HEADING: ${b.heading}\nBULLET: ${b.text}${b.data?.length ? `\nMARKET DATA (from ${b.data.join(", ")}; live prices may have moved since writing):\n${numbers.filter((l) => b.data!.some((d) => l.text.endsWith(`source ${d}`) || l.text.startsWith(`${d}:`) || l.text.startsWith(`${d} (`))).map((l) => `- ${l.text}`).join("\n")}` : ""}\nCITED STORIES:\n${b.sources
        .map((s) => {
          const c = byLink.get(s.link);
          return `- ${s.title} (${s.publisher})${c?.description ? `: ${c.description}` : ""}`;
        })
        .join("\n")}`,
    }));
    console.log(`\nbriefing  ${bullets.length} bullets in ${pieces.length} pieces for ${edition}`);
    const bv = await judge<BulletVerdict>(BULLET_JUDGE, BULLET_SCHEMA, bulletItems, "briefing");
    const bt = { supported: 0, clear4: 0, standalone: 0, judged: 0 };
    bullets.forEach((b, i) => {
      tests++;
      const v = bv.get(`b${i + 1}`);
      if (v) {
        bt.judged++;
        if (v.supported) bt.supported++;
        if (v.clear >= 4) bt.clear4++;
        if (v.standalone) bt.standalone++;
      }
      const pass = !v || (v.supported && v.clear >= 4 && v.standalone);
      if (!pass) failures++;
      lines.push(JSON.stringify({ kind: "briefing", pass, scope: b.scope, heading: b.heading, text: b.text, sources: b.sources, verdict: v ?? null }));
    });
    console.log(`BRIEFING  ${bullets.length} bullets, ${bt.judged} judged`);
    console.log(`  supported           ${pct(bt.supported, bt.judged)}`);
    console.log(`  clear (4-5 of 5)    ${pct(bt.clear4, bt.judged)}`);
    console.log(`  stands alone        ${pct(bt.standalone, bt.judged)}`);

    // ---- digests: built for real students, not stored
    const students = await db.select({ id: users.id }).from(users).where(eq(users.accountType, "student")).limit(40);
    let built = 0;
    const digestProblems: string[] = [];
    let stories = 0;
    let withSummary = 0;
    for (const s of students) {
      tests++;
      try {
        const d = await buildDigest(db, s.id);
        built++;
        const problems: string[] = [];
        const all = [d.main, ...d.sections.flatMap((x) => x.stories)].filter((x): x is NonNullable<typeof x> => Boolean(x));
        const keys = all.map((x) => x.clusterId ?? x.link);
        if (new Set(keys).size !== keys.length) problems.push("an event appears twice");
        for (const sec of d.sections) if (sec.sector && !d.sectors.includes(sec.sector)) problems.push(`section for ${sec.sector}, not one of the student's industries`);
        for (const x of all) {
          if (!x.title?.trim() || !/^https?:\/\//.test(x.link)) problems.push(`bad story: ${x.title?.slice(0, 40)}`);
          if (x.summary) withSummary++;
          stories++;
        }
        if (problems.length) {
          failures++;
          digestProblems.push(`${s.id}: ${problems.join("; ")}`);
        }
        lines.push(JSON.stringify({ kind: "digest", pass: problems.length === 0, userId: s.id, sections: d.sections.map((x) => `${x.title} (${x.stories.length})`), problems }));
      } catch (err) {
        failures++;
        digestProblems.push(`${s.id}: failed to build: ${err instanceof Error ? err.message : err}`);
        lines.push(JSON.stringify({ kind: "digest", pass: false, userId: s.id, problems: [String(err)] }));
      }
    }
    console.log(`\nDIGESTS  ${built}/${students.length} built; ${stories} stories, ${pct(withSummary, stories)} with a summary`);
    for (const p of digestProblems.slice(0, 10)) console.log(`  PROBLEM ${p}`);

    writeFileSync(outFile, lines.join("\n") + "\n");
    console.log(`\n${tests} tests, ${tests - failures} passed, ${failures} flagged. Every verdict: ${outFile}`);
  } finally {
    await opened.close().catch(() => {});
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
