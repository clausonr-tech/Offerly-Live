import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { newsBriefings, newsClusters, newsItems, newsLabels } from "@/db/schema";
import { findBlockedLanguage } from "../content-limits";
import { bulletIsGrounded } from "./grounding";
import { buildDashboard, dataLines } from "../market-data/board";
import { runClaude } from "./claude-cli";
import { verifySummaries } from "./summary";
import { hiddenLinks } from "./takedown";
import { editionDate } from "./digest";
import { mapLimit } from "./fetch";
import { SECTORS, SECTOR_LABELS, type Sector } from "./types";
import { recordJobUsage } from "./usage";
import { NEWS_MODEL } from "./models";

type Db = Awaited<ReturnType<typeof getDb>>;

// The daily briefing: what happened, in short bullets a student can read in a
// minute. Written by a model twice a day (with the sector desk), from the
// stories the pipeline collected and nothing else:
//
//   general      deals and markets overall, the US economy, the global economy,
//                government and policy, and hiring and recruiting news
//   each sector  that sector's deals, its market moves and its trends
//
// A student's briefing is the general piece plus the pieces for their
// industries - assembled in code, so no model runs per student and every
// student with the same interests reads the same checked text.
//
// Every bullet names the stories it came from, and is dropped unless: those
// stories were in the list the model was given, every number in it appears
// in one of them, it is short, and it passes content-limits.

const BRIEFING_MODEL = NEWS_MODEL;
const WINDOW_HOURS = 36;
const GENERAL_STORIES = 45;
const SECTOR_STORIES = 25;
const MAX_WORDS = 32;
const MAX_PER_HEADING = 4;

const GENERAL_HEADINGS = {
  deals: "Deals",
  markets: "Markets today",
  what_it_means: "What the moves mean",
  economy_us: "US economy",
  economy_global: "Global economy",
  policy: "Government and policy",
  recruiting: "Hiring and recruiting",
} as const;
const SECTOR_HEADINGS = {
  deals: "Deals",
  markets: "Market moves",
  trends: "Trends",
} as const;
type GeneralKey = keyof typeof GENERAL_HEADINGS;
type SectorKey = keyof typeof SECTOR_HEADINGS;

type BriefingSource = { title: string; link: string; publisher: string };
export type BriefingBullet = {
  text: string;
  sources: BriefingSource[];
  /** The data sources a market bullet's numbers came from ("US Treasury", "Alpaca (IEX)"). */
  data?: string[];
};
export type BriefingPiece = { scope: string; generatedAt: string; headings: Record<string, BriefingBullet[]> };

type StoryRow = { ref: string; clusterId: string; title: string; summary: string | null; publisher: string; link: string; storyType: string | null; publishedAt: Date };

const RULES = `You write a short daily briefing for university students recruiting into finance (investment banking, private equity, sales and trading and the rest). They are smart but new to the industry.

How to write:
- One fact per bullet. At most 25 words. Lead with who and what: the company, the number, the move.
- Every bullet stands on its own: name the country, company or person. Never "inflation rose to 4%" without saying where, never "the firm" without saying which. If a story does not say which country or company it is about, leave it out rather than guess.
- Write dollar amounts as $30 billion, not US$30 billion.
- Plain English. If a term needs knowing (basis points, dry powder, a BDC), add a 2-4 word gloss in parentheses the first time.
- No hype, no opinion, no predictions of your own, no "this could mean". Say what happened. (what_it_means has its own rules, below.)
- Use ONLY the stories listed for what happened: every event, number, cause and judgement must be in them. If the stories do not support a heading, return an empty list for it.
- Identifying context may come from general knowledge only when you are certain it is true: who a well-known person or institution is, which country it is from, what an abbreviation stands for (a16z is Andreessen Horowitz). Nothing else.
- Say in 2-4 words what an unfamiliar company does ("Edens, a shopping-centre owner") when the stories say it; explain any term a newcomer would not know.
- Every bullet cites the ids of the 1-3 stories it comes from, in "stories", and when DATA is given, the DATA ids its numbers come from, in "data".
- A story reported as a rumour ("in talks", "said to", "considering") stays a rumour: write "is in talks to", not "agreed to".
- Pick what matters most to someone interviewing next week; skip minor items. At most 4 bullets per heading, fewer is fine.
- Never write profanity, a slur, or anything that demeans people for their race, ethnicity, religion, gender, sexuality, disability or background. No em dashes.`;

const GENERAL_GUIDE = `Headings:
- deals: the biggest M&A, IPOs, financings, fund raises and buyouts across finance.
- markets: how markets moved: the main stock indexes, the biggest companies, Treasury yields, the dollar and other currencies, oil and gold. Copy yields, exchange rates, oil and economic numbers exactly from DATA, with their date ("the 10-year yield closed at 4.26% on Monday"). DATA has no stock prices: a stock index's or company's move, and its number, comes only from a cited story. Give a reason only if a cited story reports it.
- what_it_means: 3 or 4 bullets, one for each of the day's biggest moves (yields, the dollar, oil, stocks), on what it means for economic policy and the other topics a student gets asked about: the Fed's next rate decision, mortgage and borrowing costs, government borrowing, trade and tariffs, company deals and financing. For each, use a reported effect when a story gives one, and otherwise how it usually works. Only two kinds of bullet: (1) an effect a cited story reports ("traders now see a Fed rate rise as more likely, Reuters said"); (2) how it usually works, worded that way and tied to a move in DATA or a story ("higher Treasury yields usually push up mortgage and corporate borrowing costs"). Never a forecast, advice or opinion of your own.
- economy_us: US data and the Fed - inflation, jobs, growth, rates.
- economy_global: other economies and central banks - Europe, China, Japan, the UK, emerging markets.
- policy: governments, regulators and courts - new rules, enforcement, tariffs, appointments, elections that move markets.
- recruiting: hiring, layoffs, pay, bonuses, internships and people moves at finance firms.`;

const SECTOR_GUIDE = (sector: Sector) => `This briefing is for students interested in ${SECTOR_LABELS[sector]}. Headings:
- deals: the ${SECTOR_LABELS[sector]} deals, fund raises and financings in these stories.
- markets: how this part of the market moved - prices, volumes, fundraising, returns - and why.
- trends: shifts in the industry - strategy, regulation, technology, people - worth knowing for an interview.`;

function schemaFor(keys: string[], withData = false) {
  const bullet = {
    type: "object",
    properties: {
      text: { type: "string" },
      stories: { type: "array", items: { type: "string" } },
      ...(withData ? { data: { type: "array", items: { type: "string" } } } : {}),
    },
    required: withData ? ["text", "stories", "data"] : ["text", "stories"],
  };
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, { type: "array", items: bullet }])),
    required: keys,
  };
}

export { bulletIsGrounded } from "./grounding";

/** A model's bullet as it may be shown, with what it cites as text for the check, or null. */
function checkBullet(
  raw: { text: unknown; stories: unknown; data?: unknown },
  byRef: Map<string, StoryRow>,
  data: Map<string, string> = new Map(),
): { bullet: BriefingBullet; grounds: string } | null {
  const text = typeof raw.text === "string" ? raw.text.trim().replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ") : "";
  if (!text || text.split(" ").length > MAX_WORDS) return null;
  if (findBlockedLanguage(text)) return null;
  const refs = Array.isArray(raw.stories) ? raw.stories.filter((r): r is string => typeof r === "string") : [];
  const stories = [...new Set(refs)].map((r) => byRef.get(r)).filter((s): s is StoryRow => Boolean(s)).slice(0, 3);
  const dataRefs = [...new Set(Array.isArray(raw.data) ? raw.data.filter((r): r is string => typeof r === "string" && data.has(r)) : [])];
  if (stories.length === 0 && dataRefs.length === 0) return null;
  const lines = dataRefs.map((r) => data.get(r)!);
  if (!bulletIsGrounded(text, [...stories, ...lines.map((l) => ({ title: l, summary: null }))])) return null;
  // One link per outlet: two cited stories from the same publisher read as a stutter.
  const sources = stories.filter((s, i) => stories.findIndex((x) => x.publisher === s.publisher) === i);
  const dataSources = [...new Set(lines.map((l) => l.match(/source (.+)$/)?.[1]).filter((x): x is string => Boolean(x)))];
  return {
    bullet: { text, sources: sources.map((s) => ({ title: s.title, link: s.link, publisher: s.publisher })), ...(dataSources.length ? { data: dataSources } : {}) },
    grounds: [...lines.map((l) => `DATA: ${l}`), ...stories.map((s) => `STORY (${s.publisher}): ${s.title}. ${s.summary ?? ""}`)].join("\n"),
  };
}

/** A model's bullet as it may be shown, or null. */
export function validateBullet(raw: { text: unknown; stories: unknown; data?: unknown }, byRef: Map<string, StoryRow>, data?: Map<string, string>): BriefingBullet | null {
  return checkBullet(raw, byRef, data)?.bullet ?? null;
}

async function storiesFor(db: Db, key: string, limit: number, now: Date): Promise<StoryRow[]> {
  const since = new Date(now.getTime() - WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({
      clusterId: newsClusters.id,
      title: newsItems.title,
      summary: newsItems.description,
      publisher: newsItems.publisher,
      link: newsItems.url,
      storyType: newsLabels.storyType,
      publishedAt: newsItems.publishedAt,
    })
    .from(newsClusters)
    .innerJoin(newsItems, eq(newsItems.id, newsClusters.leadItemId))
    .leftJoin(newsLabels, eq(newsLabels.itemId, newsItems.id))
    .where(and(gte(newsClusters.firstSeenAt, since), sql`${newsClusters.scores} ? ${key}`, isNull(newsItems.hiddenAt)))
    .orderBy(desc(sql`(${newsClusters.scores} ->> ${key})::float`))
    .limit(limit);
  return rows.map((r, i) => ({ ...r, ref: `s${i + 1}` }));
}

function storyList(stories: StoryRow[]): string {
  return stories
    .map((s) => `[${s.ref}] ${s.title} (${s.publisher}, ${s.storyType ?? "news"})${s.summary ? `\n     ${s.summary.slice(0, 280)}` : ""}`)
    .join("\n");
}

async function writePiece(db: Db, scope: "general" | Sector, now: Date, model: string): Promise<{ piece: BriefingPiece | null; error?: string }> {
  const stories = await storiesFor(db, scope === "general" ? "main" : scope, scope === "general" ? GENERAL_STORIES : SECTOR_STORIES, now);
  if (stories.length < 3) return { piece: null, error: "too few stories" };
  const keys = scope === "general" ? (Object.keys(GENERAL_HEADINGS) as GeneralKey[]) : (Object.keys(SECTOR_HEADINGS) as SectorKey[]);
  // The general piece gets the market numbers too, each from its source (market-data/).
  const lines = scope === "general" ? await buildDashboard(now).then(dataLines).catch(() => []) : [];
  const result = await runClaude<Record<string, { text: unknown; stories: unknown; data?: unknown }[]>>({
    model,
    system: `${RULES}\n\n${scope === "general" ? GENERAL_GUIDE : SECTOR_GUIDE(scope)}`,
    prompt: `${lines.length ? `DATA (market numbers, each with its date and source):\n${lines.map((l) => `[${l.id}] ${l.text}`).join("\n")}\n\n` : ""}Today's stories:\n\n${storyList(stories)}\n\nWrite the briefing.`,
    schema: schemaFor(keys, lines.length > 0),
    timeoutMs: 240_000,
  });
  await recordJobUsage(db, {
    feature: "newsBriefing",
    model: result.model,
    engine: "claude-cli",
    items: stories.length,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheWriteTokens: result.usage.cacheWriteTokens,
    costUsd: result.usage.costUsd,
    ok: result.ok,
    error: result.ok ? null : result.error,
  });
  if (!result.ok) return { piece: null, error: result.error };
  const byRef = new Map(stories.map((s) => [s.ref, s]));
  const data = new Map(lines.map((l) => [l.id, l.text]));
  const headings: Record<string, BriefingBullet[]> = {};
  const toCheck: { key: string; bullet: BriefingBullet; grounds: string }[] = [];
  for (const key of keys) {
    const checked = (result.data[key] ?? []).map((b) => checkBullet(b, byRef, data)).filter((b): b is NonNullable<typeof b> => Boolean(b)).slice(0, MAX_PER_HEADING);
    // The market headings, where numbers and "what it means" come in, are checked
    // against what each bullet cites before anything is stored.
    if (scope === "general" && (key === "markets" || key === "what_it_means")) toCheck.push(...checked.map((c) => ({ key, ...c })));
    else headings[key] = checked.map((c) => c.bullet);
  }
  if (toCheck.length) {
    const verified = await verifySummaries(
      toCheck.map((c, i) => ({ ref: `m${i + 1}`, title: GENERAL_HEADINGS[c.key as GeneralKey], material: { title: "", text: c.grounds, basis: "feed" as const }, summary: { points: [c.bullet.text], takeaway: null, basis: "feed" as const } })),
      // Kept as written or dropped: a "corrected" forecast would only restate a number.
      { mechanism: true, repair: false, requireUseful: false },
    );
    if (verified.usage) {
      await recordJobUsage(db, {
        feature: "newsBriefingCheck",
        model: verified.model,
        engine: "claude-cli",
        items: toCheck.length,
        inputTokens: verified.usage.inputTokens,
        outputTokens: verified.usage.outputTokens,
        cacheReadTokens: verified.usage.cacheReadTokens,
        cacheWriteTokens: verified.usage.cacheWriteTokens,
        costUsd: verified.usage.costUsd,
        ok: verified.ok,
        error: verified.error ?? null,
      });
    }
    // A check that could not run shows none of these rather than unchecked ones.
    toCheck.forEach((c, i) => {
      const ok = verified.ok ? verified.results.get(`m${i + 1}`) : null;
      headings[c.key] = [...(headings[c.key] ?? []), ...(ok ? [{ ...c.bullet, text: ok.points[0] }] : [])];
    });
  }
  return { piece: { scope, generatedAt: now.toISOString(), headings } };
}

export type BriefingRunReport = { scope: string; bullets: number; error?: string }[];

/** Write today's general piece and one per sector, and store them. */
export async function runBriefing(db: Db, opts: { now?: Date; model?: string; scopes?: ("general" | Sector)[] } = {}): Promise<BriefingRunReport> {
  const now = opts.now ?? new Date();
  const edition = editionDate(now, null);
  const scopes: ("general" | Sector)[] = opts.scopes ?? ["general", ...SECTORS];
  const report: BriefingRunReport = [];
  let failures = 0;
  await mapLimit(scopes, 3, async (scope) => {
    if (failures >= 2) return void report.push({ scope, bullets: 0, error: "skipped after two failures" });
    const { piece, error } = await writePiece(db, scope, now, opts.model ?? BRIEFING_MODEL);
    if (!piece) {
      if (error !== "too few stories") failures++;
      return void report.push({ scope, bullets: 0, error });
    }
    await db
      .insert(newsBriefings)
      .values({ editionDate: edition, scope, payload: piece })
      .onConflictDoUpdate({ target: [newsBriefings.editionDate, newsBriefings.scope], set: { payload: piece, createdAt: new Date() } });
    report.push({ scope, bullets: Object.values(piece.headings).flat().length });
  });
  return report;
}

/**
 * Whether today's general briefing has been written. Every run checks, so a
 * desk run that failed or a laptop asleep at desk time costs the digest its
 * briefing for half an hour, not the whole day.
 */
export async function briefingWritten(db: Db, now: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ scope: newsBriefings.scope })
    .from(newsBriefings)
    .where(and(eq(newsBriefings.editionDate, editionDate(now, null)), eq(newsBriefings.scope, "general")))
    .limit(1);
  return Boolean(row);
}

// ---- reading: one student's briefing

export type StudentBriefing = {
  generatedAt: string;
  sections: { key: string; title: string; bullets: BriefingBullet[] }[];
};

const MAX_DEALS = 5;
const MAX_MARKETS = 4;

/**
 * The student's briefing: their industries' deals, then how markets moved and
 * what the moves mean (for every student), their industries' own market moves,
 * then the economy, policy and recruiting. A student with no industries gets
 * the general deals. Null when no briefing was written in the last
 * day and a half.
 */
export function assembleBriefing(pieces: BriefingPiece[], sectors: Sector[]): StudentBriefing | null {
  const general = pieces.find((p) => p.scope === "general");
  const mine = sectors.map((s) => pieces.find((p) => p.scope === s)).filter((p): p is BriefingPiece => Boolean(p));
  if (!general && mine.length === 0) return null;

  // The same deal can appear under two industries; show it once.
  const seen = new Set<string>();
  const once = (bullets: BriefingBullet[]) =>
    bullets.filter((b) => {
      const key = b.sources[0]?.link ?? b.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const interleave = (lists: BriefingBullet[][], max: number) => {
    const out: BriefingBullet[] = [];
    for (let i = 0; out.length < max && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i] && out.length < max) out.push(l[i]);
    return out;
  };

  const deals = once(mine.length ? interleave(mine.map((p) => p.headings.deals ?? []), MAX_DEALS) : (general?.headings.deals ?? []));
  const g = (k: GeneralKey) => once(general?.headings[k] ?? []);
  // Every student gets how markets moved and what it means; their industries' own market moves follow.
  const marketsToday = g("markets");
  const meaning = g("what_it_means");
  const yours = once(mine.length ? interleave(mine.map((p) => [...(p.headings.markets ?? []), ...(p.headings.trends ?? [])]), MAX_MARKETS) : []);
  const sections = [
    { key: "deals", title: mine.length ? "Deals in your industries" : "Deals", bullets: deals },
    { key: "markets", title: GENERAL_HEADINGS.markets, bullets: marketsToday },
    { key: "what_it_means", title: GENERAL_HEADINGS.what_it_means, bullets: meaning },
    { key: "your_markets", title: "Your industries' markets", bullets: yours },
    { key: "economy_us", title: GENERAL_HEADINGS.economy_us, bullets: g("economy_us") },
    { key: "economy_global", title: GENERAL_HEADINGS.economy_global, bullets: g("economy_global") },
    { key: "policy", title: GENERAL_HEADINGS.policy, bullets: g("policy") },
    { key: "recruiting", title: GENERAL_HEADINGS.recruiting, bullets: g("recruiting") },
  ].filter((s) => s.bullets.length > 0);
  if (sections.length === 0) return null;
  const newest = [general, ...mine].filter(Boolean).map((p) => p!.generatedAt).sort().at(-1)!;
  return { generatedAt: newest, sections };
}

/**
 * A stored piece with taken-down stories removed, the way digest.ts does it
 * for a stored edition. The hiddenAt check when a piece is WRITTEN cannot help
 * a piece that was written before the takedown, and a piece is served for up
 * to WINDOW_HOURS - so a story hidden as a wrong rumour kept being cited, in
 * the model's own words, for a day and a half (security review, 10 October
 * 2026). A bullet that cited only hidden stories goes with them: its sentence
 * is about that story, and without the link a student cannot check it. A
 * market bullet standing on the day's numbers cites no story and stays.
 */
async function withoutHiddenStories(db: Db, pieces: BriefingPiece[]): Promise<BriefingPiece[]> {
  const links = pieces.flatMap((p) => Object.values(p.headings).flat().flatMap((b) => b.sources.map((s) => s.link)));
  const hidden = await hiddenLinks(db, [...new Set(links)]);
  if (hidden.size === 0) return pieces;
  return pieces.map((piece) => ({
    ...piece,
    headings: Object.fromEntries(
      Object.entries(piece.headings).map(([heading, bullets]) => [
        heading,
        (bullets ?? []).flatMap((b) => {
          const sources = b.sources.filter((s) => !hidden.has(s.link));
          if (sources.length === 0 && b.sources.length > 0) return [];
          return [{ ...b, sources }];
        }),
      ]),
    ),
  }));
}

export async function getBriefing(db: Db, sectors: Sector[], now: Date = new Date()): Promise<StudentBriefing | null> {
  const since = new Date(now.getTime() - WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({ scope: newsBriefings.scope, payload: newsBriefings.payload, createdAt: newsBriefings.createdAt })
    .from(newsBriefings)
    .where(and(gte(newsBriefings.createdAt, since), inArray(newsBriefings.scope, ["general", ...sectors])))
    .orderBy(desc(newsBriefings.createdAt));
  // The newest piece per scope.
  const latest = new Map<string, BriefingPiece>();
  for (const r of rows) if (!latest.has(r.scope)) latest.set(r.scope, r.payload as BriefingPiece);
  return assembleBriefing(await withoutHiddenStories(db, [...latest.values()]), sectors);
}
