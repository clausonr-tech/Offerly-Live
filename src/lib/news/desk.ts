import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { newsClusters, newsItems, newsLabels, newsSectorPicks } from "@/db/schema";
import { findBlockedLanguage } from "../content-limits";
import { runClaude } from "./claude-cli";
import { recordJobUsage } from "./usage";
import { SECTORS, SECTOR_LABELS, type Entity, type Sector } from "./types";
import { NEWS_MODEL } from "./models";

type Db = Awaited<ReturnType<typeof getDb>>;

// Stage 5: the sector desk. Twice a day, for each sector, a stronger model
// looks at the formula's top 25 events side by side and picks the three a
// student should know, each with one question the student could ask a
// professional about it.
//
// This is the one place a model's judgement earns its cost: comparing
// candidates against each other, which a per-story score cannot do.
//
// Why a question and not a summary: the model only has the headline and the
// publisher's short summary. A summary would invite it to fill gaps with
// claims it cannot back; a question asks about the story without asserting
// anything new about it. Each question is still checked: any number in it
// must appear in the story, and it passes the content-limits check.

const DESK_MODEL = NEWS_MODEL;
const CANDIDATES = 25;
const PICKS = 3;

const DESK_SYSTEM = `You are the news desk for one finance sector on Offerly, where university students prepare for careers in finance. You are shown today's top candidate stories for the sector, already filtered for relevance and credibility.

Pick the ${PICKS} stories a professional in this sector would most expect a candidate to know about today. Prefer:
- consequential events (large deals, major firms, rule changes, market-moving news) over routine ones;
- stories several outlets reported over ones only one did;
- confirmed reports over unconfirmed ones (a single outlet citing unnamed sources) - pick an unconfirmed story only when it is clearly the day's most important, and then say "reportedly" in the question;
- variety: never two picks about the same event, and not three picks of the same kind of story unless the day is genuinely dominated by one theme.

For each pick, write one question (at most 30 words) the student could ask a professional in this sector in a coffee chat, to show they follow the news and to learn how an insider sees it. The question must:
- refer to the story specifically (name the firm or the event);
- ask for the professional's view or experience - never a trivia question with a factual answer;
- state no fact that is not in the story as given. Do not add numbers, names or outcomes.
- Never write profanity, a slur, or anything that demeans people for their race, ethnicity, religion, gender, sexuality, disability or background.

Also give a one-sentence reason for each pick (for the editors, never shown to students).
If fewer than ${PICKS} candidates are worth a student's time, pick fewer.`;

const DESK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["picks"],
  properties: {
    picks: {
      type: "array",
      maxItems: PICKS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "reason"],
        properties: { id: { type: "string" }, question: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

type Candidate = { id: string; clusterId: string; headline: string; summary: string | null; publisher: string; outlets: number; unconfirmed: boolean; storyType: string | null; entities: Entity[]; amountUsd: number | null; ageHours: number };

/** Numbers in the question must be numbers the story states. */
function questionIsGrounded(question: string, story: { headline: string; summary: string | null }): boolean {
  const source = `${story.headline} ${story.summary ?? ""}`.toLowerCase();
  const numbers = question.match(/\d[\d.,]*/g) ?? [];
  return numbers.every((n) => source.includes(n.replace(/[.,]$/, "").toLowerCase()));
}

export function validateQuestion(question: string, story: { headline: string; summary: string | null }): string | null {
  const q = question.trim().replace(/\s+/g, " ");
  if (!q || q.split(" ").length > 35) return null;
  if (findBlockedLanguage(q)) return null;
  if (!questionIsGrounded(q, story)) return null;
  return q;
}

async function candidatesFor(db: Db, sector: Sector, now: Date): Promise<Candidate[]> {
  const since = new Date(now.getTime() - 72 * 3_600_000);
  const rows = await db
    .select({
      clusterId: newsClusters.id,
      score: sql<number>`(${newsClusters.scores} ->> ${sector})::float`,
      unconfirmed: sql<boolean>`${newsClusters.scores} ? 'unconfirmed'`,
      outlets: newsClusters.publisherCount,
      storyType: newsClusters.storyType,
      firstSeenAt: newsClusters.firstSeenAt,
      headline: newsItems.title,
      summary: newsItems.description,
      publisher: newsItems.publisher,
      entities: newsLabels.entities,
      amountUsd: newsLabels.amountUsd,
    })
    .from(newsClusters)
    .innerJoin(newsItems, eq(newsItems.id, newsClusters.leadItemId))
    .innerJoin(newsLabels, eq(newsLabels.itemId, newsItems.id))
    .where(and(gte(newsClusters.firstSeenAt, since), sql`${newsClusters.scores} ? ${sector}`))
    .orderBy(desc(sql`(${newsClusters.scores} ->> ${sector})::float`))
    .limit(CANDIDATES);
  return rows.map((r, i) => ({
    id: `c${i + 1}`,
    clusterId: r.clusterId,
    headline: r.headline,
    summary: r.summary,
    publisher: r.publisher,
    outlets: r.outlets,
    unconfirmed: Boolean(r.unconfirmed),
    storyType: r.storyType,
    entities: (r.entities as Entity[]) ?? [],
    amountUsd: r.amountUsd,
    ageHours: Math.round((now.getTime() - r.firstSeenAt.getTime()) / 3_600_000),
  }));
}

export type DeskReport = { sector: Sector; candidates: number; picks: number; questions: number; error?: string };

export async function runDesk(db: Db, opts: { sectors?: Sector[]; now?: Date } = {}): Promise<DeskReport[]> {
  const now = opts.now ?? new Date();
  const runId = now.toISOString();
  const reports: DeskReport[] = [];
  for (const sector of opts.sectors ?? SECTORS) {
    const candidates = await candidatesFor(db, sector, now);
    const report: DeskReport = { sector, candidates: candidates.length, picks: 0, questions: 0 };
    reports.push(report);
    if (candidates.length === 0) continue;

    const prompt =
      `Sector: ${SECTOR_LABELS[sector]}\n\nCandidates (best first by our formula):\n` +
      candidates
        .map((c) =>
          JSON.stringify({
            id: c.id,
            headline: c.headline,
            ...(c.summary ? { summary: c.summary } : {}),
            publisher: c.publisher,
            outlets_reporting: c.outlets,
            ...(c.unconfirmed ? { unconfirmed: true } : {}),
            story_type: c.storyType,
            ...(c.amountUsd ? { amount_usd: c.amountUsd } : {}),
            hours_ago: c.ageHours,
          }),
        )
        .join("\n");
    const result = await runClaude<{ picks: { id: string; question: string; reason: string }[] }>({
      model: DESK_MODEL,
      system: DESK_SYSTEM,
      prompt,
      schema: DESK_SCHEMA,
    });
    await recordJobUsage(db, {
      feature: "newsDesk",
      model: result.model,
      engine: "claude-cli",
      items: candidates.length,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      costUsd: result.usage.costUsd,
      ok: result.ok,
      error: result.ok ? null : `${result.failure}: ${result.error}`.slice(0, 500),
    });
    if (!result.ok) {
      report.error = `${result.failure}: ${result.error}`;
      if (result.failure === "not_logged_in" || result.failure === "not_installed") break;
      continue;
    }

    const seen = new Set<string>();
    let rank = 0;
    for (const pick of result.data.picks ?? []) {
      const c = candidates.find((x) => x.id === pick.id);
      if (!c || seen.has(c.clusterId) || rank >= PICKS) continue;
      seen.add(c.clusterId);
      const question = validateQuestion(String(pick.question ?? ""), c);
      await db.insert(newsSectorPicks).values({
        sector,
        runId,
        clusterId: c.clusterId,
        rank: ++rank,
        question,
        reason: String(pick.reason ?? "").slice(0, 300),
      });
      report.picks++;
      if (question) report.questions++;
    }
  }
  return reports;
}

export { inArray };
