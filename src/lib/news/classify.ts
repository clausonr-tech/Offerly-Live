import { and, asc, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { firms, newsItemFirms, newsItems, newsLabels, newsSources } from "@/db/schema";
import { runClaude, type CliResult } from "./claude-cli";
import { CLASSIFIER_MODEL, CLASSIFIER_SCHEMA, CLASSIFIER_SYSTEM, CLASSIFIER_VERSION, PACK_SIZE, storiesPrompt, type PromptStory } from "./classifier-prompt";
import { FirmIndex } from "./firm-index";
import { mapLimit } from "./fetch";
import { recordJobUsage } from "./usage";
import { ABSTAIN_REASONS, ENTITY_ROLES, REGIONS, SECTOR_LABELS, SPECIALTIES_BY_SECTOR, STORY_TYPES, isSector, type Entity, type Sector } from "./types";

type Db = Awaited<ReturnType<typeof getDb>>;


// Stage 2: the classifier. Fifteen stories per call, one shared prompt, and
// then a set of checks in code that a model's answer has to pass before it is
// stored. The checks are the point - a label is only as trustworthy as the
// validation behind it, and the model is told nothing it could not verify.

export type ModelItem = {
  id: string;
  relevant: boolean;
  abstain: string | null;
  sectors: string[];
  specialties?: string[];
  story_type: string;
  worthiness: number;
  entities: { name: string; role: string }[];
  amount_usd: number | null;
  region: string;
};

export type ValidLabel = {
  relevant: boolean;
  abstain: string | null;
  sectors: Sector[];
  /** From the onboarding list, and only ones that belong to the story's own sectors. */
  specialties: string[];
  storyType: string;
  worthiness: number;
  entities: Entity[];
  amountUsd: number | null;
  region: string;
};

function squash(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

// A money figure somewhere in the text: "$2.2bn", "€500 million", "£1.3 billion", "USD 40m".
const MONEY_RE = /([$€£]\s?\d)|(\b\d[\d.,]*\s?(bn|billion|mn|million|m|trillion|tn)\b)|(\b(usd|eur|gbp)\s?\d)/i;

/**
 * One model answer, checked against the story it was about. Anything the text
 * does not support is removed rather than trusted: an entity whose name is not
 * in the headline or summary, an amount with no money figure in the text, a
 * sector that is not one of the fourteen. Returns null when the answer is
 * unusable, and the story is retried on the next run.
 */
export function validateLabel(item: ModelItem, story: { title: string; description: string | null }): ValidLabel | null {
  if (typeof item.relevant !== "boolean") return null;
  const text = squash(`${story.title} ${story.description ?? ""}`);
  const rawText = `${story.title} ${story.description ?? ""}`;

  const sectors = [...new Set(item.sectors ?? [])].filter(isSector).slice(0, 3);
  // other_finance is for stories with no better home - never an extra label.
  const cleaned = sectors.length > 1 ? sectors.filter((s) => s !== "other_finance") : sectors;
  if (item.relevant && cleaned.length === 0) return null;

  const entities: Entity[] = [];
  for (const e of item.entities ?? []) {
    const name = String(e?.name ?? "").trim();
    if (!name || !(ENTITY_ROLES as readonly string[]).includes(e.role)) continue;
    if (!text.includes(squash(name))) continue; // not in the text: invented or "corrected"
    if (!entities.some((x) => squash(x.name) === squash(name))) entities.push({ name, role: e.role as Entity["role"] });
  }

  const amount = typeof item.amount_usd === "number" && item.amount_usd > 0 && MONEY_RE.test(rawText) ? item.amount_usd : null;
  const storyType = (STORY_TYPES as readonly string[]).includes(item.story_type) ? item.story_type : "other";
  // No sector is added here. A rule that put every M&A or IPO story on the
  // investment banking tab was needed while the classifier was Haiku (which
  // ignored that instruction); with Sonnet it only cost precision - IB went
  // from 70.6% to 87.5% when it was removed (RESULTS.md, 29 September 2026).


  // A specialty only counts inside a sector the story is in: "Reinsurance" on
  // a story labelled private equity alone is dropped, not kept as a stray tag.
  const allowed = new Set(cleaned.flatMap((s) => SPECIALTIES_BY_SECTOR[s]));
  const specialties = item.relevant ? [...new Set(item.specialties ?? [])].filter((x) => allowed.has(x)).slice(0, 3) : [];

  return {
    relevant: item.relevant,
    abstain: item.relevant ? null : (ABSTAIN_REASONS as readonly string[]).includes(item.abstain ?? "") ? item.abstain : "not_finance",
    sectors: item.relevant ? cleaned : [],
    specialties,
    storyType,
    worthiness: Math.min(4, Math.max(1, Math.round(Number(item.worthiness) || 1))),
    entities: entities.slice(0, 5),
    amountUsd: amount,
    region: (REGIONS as readonly string[]).includes(item.region) ? item.region : "global",
  };
}

type Story = { id: string; title: string; description: string | null; publisher: string; sourceId: string };

function specialty(source: { tier: string; sectors: string[] } | undefined): string {
  if (!source) return "general";
  if (source.tier === "primary") return "regulator or official filing";
  if (source.tier === "major") return "national newsroom";
  return `trade press: ${source.sectors.map((s) => SECTOR_LABELS[s as Sector] ?? s).join(", ")}`;
}

export type PackOutcome = {
  labels: Map<string, ValidLabel>;
  missing: string[];
  result: CliResult<{ items: ModelItem[] }>;
};

/** Labels one pack of stories. Pure apart from the model call, so the eval can run it too. */
export async function classifyPack(
  stories: Story[],
  sources: Map<string, { tier: string; sectors: string[] }>,
  opts: { model?: string } = {},
): Promise<PackOutcome> {
  const shortIds = stories.map((_, i) => `s${i + 1}`);
  const promptStories: PromptStory[] = stories.map((s, i) => ({
    id: shortIds[i],
    headline: s.title,
    summary: s.description,
    publisher: s.publisher,
    specialty: specialty(sources.get(s.sourceId)),
  }));
  const result = await runClaude<{ items: ModelItem[] }>({
    model: opts.model ?? CLASSIFIER_MODEL,
    system: CLASSIFIER_SYSTEM,
    prompt: storiesPrompt(promptStories),
    schema: CLASSIFIER_SCHEMA,
  });

  const labels = new Map<string, ValidLabel>();
  if (result.ok) {
    for (const item of result.data.items ?? []) {
      const i = shortIds.indexOf(item.id);
      if (i === -1 || labels.has(stories[i].id)) continue;
      const valid = validateLabel(item, stories[i]);
      if (valid) labels.set(stories[i].id, valid);
    }
  }
  return { labels, missing: stories.filter((s) => !labels.has(s.id)).map((s) => s.id), result };
}

export type ClassifyReport = {
  packs: number;
  labeled: number;
  failed: number;
  relevant: number;
  costUsd: number;
  stoppedBecause?: string;
};

export async function runClassify(db: Db, opts: { limit?: number; concurrency?: number; model?: string } = {}): Promise<ClassifyReport> {
  const report: ClassifyReport = { packs: 0, labeled: 0, failed: 0, relevant: 0, costUsd: 0 };
  // New and failed stories first; then, within the last three days, stories
  // whose label came from an older prompt. A prompt change (the specialty tags
  // of 30 September 2026, say) reaches everything still on a tab within a few
  // runs, without relabelling stories that have already aged off.
  const recent = new Date(Date.now() - 72 * 3_600_000);
  const pending = await db
    .select({ id: newsItems.id, title: newsItems.title, description: newsItems.description, publisher: newsItems.publisher, sourceId: newsItems.sourceId })
    .from(newsItems)
    .leftJoin(newsLabels, eq(newsLabels.itemId, newsItems.id))
    .where(
      or(
        eq(newsItems.status, "new"),
        and(eq(newsItems.status, "failed"), lt(newsItems.classifyAttempts, 3)),
        and(eq(newsItems.status, "labeled"), gte(newsItems.publishedAt, recent), ne(newsLabels.classifierVersion, CLASSIFIER_VERSION)),
      ),
    )
    .orderBy(asc(sql`case when ${newsItems.status} = 'labeled' then 1 else 0 end`), desc(newsItems.publishedAt))
    .limit(opts.limit ?? 900);
  if (pending.length === 0) return report;

  const sourceRows = await db.select({ id: newsSources.id, tier: newsSources.tier, sectors: newsSources.sectors }).from(newsSources);
  const sources = new Map(sourceRows.map((s) => [s.id, s]));
  const firmIndex = new FirmIndex(
    await db.select({ id: firms.id, name: firms.name, hasVerifiedProgram: firms.hasVerifiedProgram }).from(firms),
  );

  const packs: Story[][] = [];
  for (let i = 0; i < pending.length; i += PACK_SIZE) packs.push(pending.slice(i, i + PACK_SIZE));

  let stop: string | undefined;
  let consecutiveFailures = 0;
  await mapLimit(packs, opts.concurrency ?? 3, async (pack) => {
    if (stop) return;
    const outcome = await classifyPack(pack, sources, { model: opts.model });
    const { result } = outcome;
    report.packs++;
    report.costUsd += result.usage.costUsd;
    await recordJobUsage(db, {
      feature: "newsClassify",
      model: result.model,
      engine: "claude-cli",
      items: pack.length,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      costUsd: result.usage.costUsd,
      ok: result.ok,
      error: result.ok ? null : `${result.failure}: ${result.error}`.slice(0, 500),
    });
    // Signed out or not installed: every remaining pack would fail the same
    // way, so stop and say so once rather than burning through the queue.
    if (!result.ok && (result.failure === "not_logged_in" || result.failure === "not_installed")) {
      stop = result.error;
      return;
    }
    // Two failed calls in a row (timeouts after the laptop slept, the model
    // unreachable) - stop labelling for this run. The stories stay "new" and
    // the next run picks them up, instead of this one spending four minutes
    // per pack finding out the same thing.
    consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= 2) {
      stop = `two model calls in a row failed (last: ${result.ok ? "" : result.failure}); the rest wait for the next run`;
      return;
    }

    for (const story of pack) {
      const label = outcome.labels.get(story.id);
      if (!label) continue;
      await db
        .insert(newsLabels)
        .values({
          itemId: story.id,
          classifierVersion: CLASSIFIER_VERSION,
          model: result.model,
          relevant: label.relevant,
          abstain: label.abstain,
          primarySector: label.sectors[0] ?? null,
          sectors: label.sectors,
          specialties: label.specialties,
          storyType: label.storyType,
          worthiness: label.worthiness,
          entities: label.entities,
          amountUsd: label.amountUsd,
          region: label.region,
        })
        .onConflictDoUpdate({
          target: newsLabels.itemId,
          set: {
            classifierVersion: CLASSIFIER_VERSION,
            model: result.model,
            relevant: label.relevant,
            abstain: label.abstain,
            primarySector: label.sectors[0] ?? null,
            sectors: label.sectors,
            specialties: label.specialties,
            storyType: label.storyType,
            worthiness: label.worthiness,
            entities: label.entities,
            amountUsd: label.amountUsd,
            region: label.region,
            labeledAt: new Date(),
          },
        });
      for (const entity of label.entities) {
        const firmId = firmIndex.lookup(entity.name);
        if (firmId) {
          await db.insert(newsItemFirms).values({ itemId: story.id, firmId, role: entity.role }).onConflictDoNothing();
        }
      }
      report.labeled++;
      if (label.relevant) report.relevant++;
    }
    if (outcome.missing.length) {
      report.failed += outcome.missing.length;
      const rows = await db.select({ id: newsItems.id, attempts: newsItems.classifyAttempts }).from(newsItems).where(inArray(newsItems.id, outcome.missing));
      for (const r of rows) {
        await db.update(newsItems).set({ status: "failed", classifyAttempts: r.attempts + 1 }).where(eq(newsItems.id, r.id));
      }
    }
    const done = pack.filter((s) => outcome.labels.has(s.id)).map((s) => s.id);
    if (done.length) await db.update(newsItems).set({ status: "labeled" }).where(inArray(newsItems.id, done));
  });
  if (stop) report.stoppedBecause = stop;
  return report;
}
