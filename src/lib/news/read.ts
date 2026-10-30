import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { newsClusters, newsItems, newsSectorPicks } from "@/db/schema";
import { LOCKED_PENALTY, LOCKED_SHARE, canRead, capLocked, paidPublisherOf } from "./access";
import { cardExtras, readableCopies } from "./card-extras";
import type { StorySummary } from "./summary";
import type { Sector } from "./types";

type Db = Awaited<ReturnType<typeof getDb>>;

// What the News page reads: the ranked events for one tab, one card per event,
// led by the story from the best source. The sector desk's picks, when it has
// run in the last day, go first with their question.

export type TabStory = {
  /** The lead story's id - what a student's report points at. */
  id: string;
  title: string;
  link: string;
  source: string;
  sourceDomain: string | null;
  publishedAt: string | null;
  imageUrl: string | null;
  /** How many outlets reported this event. Shown when more than one. */
  outlets: number;
  paywall: boolean;
  /**
   * Paid, and not one of the student's subscriptions - the card says
   * "Subscriber". Without a student (the eval, the audit) every paid story is.
   */
  locked: boolean;
  /** The desk's suggested question, on its picks only. */
  question: string | null;
  /** One outlet citing unnamed sources, not yet confirmed by another or a filing. */
  unconfirmed: boolean;
  /** An opinion or analysis piece about the sector, not a report of an event. */
  opinion: boolean;
  /** For the tile a card shows when there is no photo: the event's sector and firm. */
  sector: string | null;
  firmName: string | null;
  firmDomain: string | null;
  /** Key points and takeaway for the panel the card opens, when written. */
  summary: StorySummary | null;
};

const FRESH_HOURS = 72;
// Regulators publish a few times a week; their releases stay on a tab for a week.
const PRIMARY_FRESH_HOURS = 7 * 24;
// A sector tab with fewer fresh stories than this looks back a week instead.
// Slow sectors (market infrastructure, consulting) can go three days with a
// handful of real stories; showing last week's is better than a bare tab. The
// ranking already decays with age, so older stories only fill space - they
// never outrank fresh ones.
const THIN_TAB = 8;
const SLOW_SECTOR_HOURS = 7 * 24;
// No publisher more than twice in a row, so the busiest feed cannot bury the rest.
const MAX_STREAK = 2;

function paywalled(domain: string | null): boolean {
  return paidPublisherOf(domain) !== null;
}

export function limitStreaks<T extends { source: string }>(items: T[], maxStreak = MAX_STREAK): T[] {
  const queue = [...items];
  const out: T[] = [];
  while (queue.length) {
    const last = out.slice(-maxStreak);
    const streaked = last.length === maxStreak && last.every((x) => x.source === last[0].source);
    const i = streaked ? queue.findIndex((x) => x.source !== last[0].source) : 0;
    out.push(queue.splice(i === -1 ? 0 : i, 1)[0]);
  }
  return out;
}

/** Whether the pipeline has ranked anything recently enough to be trusted over the old feed. */
export async function pipelineIsLive(db: Db, withinHours: number, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - withinHours * 3_600_000);
  const [row] = await db.select({ id: newsClusters.id }).from(newsClusters).where(gte(newsClusters.rankedAt, since)).limit(1);
  return Boolean(row);
}

/**
 * One tab's stories. Given the student's paid subscriptions (`access`; an
 * empty list for none), a story they cannot open is swapped for a readable
 * outlet's copy of the same event when there is one, and otherwise moves down
 * and is capped (access.ts). Without `access` the tab is ranked as it stands.
 * `storyType` narrows it to one kind of story - the Markets view is the Top
 * stories ranking of markets_macro stories.
 */

/** The lead-story row every tab query selects, scored for one tab `key`. */
function tabStoryColumns(key: string) {
  return {
    clusterId: newsClusters.id,
    itemId: newsItems.id,
    score: sql<number>`coalesce((${newsClusters.scores} ->> ${key})::float, 0)`,
    outlets: newsClusters.publisherCount,
    scores: newsClusters.scores,
    storyType: newsClusters.storyType,
    primarySector: newsClusters.primarySector,
    title: newsItems.title,
    link: newsItems.url,
    source: newsItems.publisher,
    sourceDomain: newsItems.publisherDomain,
    publishedAt: newsItems.publishedAt,
    imageUrl: newsItems.imageUrl,
  };
}

export async function readTab(
  db: Db,
  sector: Sector | null,
  limit: number,
  now: Date = new Date(),
  access?: readonly string[],
  opts: { storyType?: string } = {},
): Promise<TabStory[]> {
  const key = sector ?? "main";
  const fresh = new Date(now.getTime() - FRESH_HOURS * 3_600_000);
  const primaryFresh = new Date(now.getTime() - PRIMARY_FRESH_HOURS * 3_600_000);

  const load = (window: ReturnType<typeof or>) =>
    db
      .select(tabStoryColumns(key))
      .from(newsClusters)
      .innerJoin(newsItems, eq(newsItems.id, newsClusters.leadItemId))
      // A taken-down story leaves the tab at once, before the next rebuild regroups without it.
      .where(and(sql`${newsClusters.scores} ? ${key}`, window, isNull(newsItems.hiddenAt), opts.storyType ? eq(newsClusters.storyType, opts.storyType) : undefined))
      .orderBy(desc(sql`(${newsClusters.scores} ->> ${key})::float`))
      // Room to demote locked stories and still fill the tab.
      .limit(limit * (access ? 3 : 2));

  let rows = await load(
    or(gte(newsClusters.firstSeenAt, fresh), and(eq(newsItems.origin, "regulator"), gte(newsClusters.firstSeenAt, primaryFresh))),
  );
  if (sector && rows.length < THIN_TAB) {
    rows = await load(gte(newsClusters.firstSeenAt, new Date(now.getTime() - SLOW_SECTOR_HOURS * 3_600_000)));
  }

  // What the student can open: swap in a readable copy where one exists.
  const locked = new Set<string>();
  if (access) {
    const needCopy = rows.filter((r) => !canRead(r.sourceDomain, access)).map((r) => r.clusterId);
    const copies = await readableCopies(db, needCopy, access);
    rows = rows
      .map((r) => {
        if (canRead(r.sourceDomain, access)) return r;
        const copy = copies.get(r.clusterId);
        if (copy) return { ...r, itemId: copy.itemId, title: copy.title, link: copy.link, source: copy.source, sourceDomain: copy.sourceDomain, publishedAt: copy.publishedAt };
        locked.add(r.clusterId);
        return { ...r, score: Number(r.score) * LOCKED_PENALTY };
      })
      .sort((a, b) => Number(b.score) - Number(a.score));
    rows = capLocked(rows, (r) => locked.has(r.clusterId), Math.ceil(limit * LOCKED_SHARE));
  }

  let picks: { clusterId: string; question: string | null }[] = [];
  if (sector) {
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const recent = await db
      .select({ clusterId: newsSectorPicks.clusterId, question: newsSectorPicks.question, runId: newsSectorPicks.runId, rank: newsSectorPicks.rank })
      .from(newsSectorPicks)
      .where(and(eq(newsSectorPicks.sector, sector), gte(newsSectorPicks.pickedAt, since)))
      .orderBy(desc(newsSectorPicks.pickedAt));
    const run = recent[0]?.runId;
    picks = recent.filter((p) => p.runId === run).sort((a, b) => a.rank - b.rank);
  }

  // Photos and firms for every event this tab could show, in one query each.
  const extras = await cardExtras(db, [...rows.map((r) => ({ id: r.clusterId, leadItemId: r.itemId })), ...picks.map((p) => ({ id: p.clusterId }))]);
  // The photo is always the checked one, through the image route - never the
  // publisher's URL straight from the row.
  const extrasFor = (clusterId: string) => {
    const e = extras.get(clusterId);
    return { imageUrl: e?.imageUrl ?? null, firmName: e?.firmName ?? null, firmDomain: e?.firmDomain ?? null, summary: e?.summary ?? null };
  };

  const toStory = (r: (typeof rows)[number], question: string | null = null): TabStory => ({
    ...extrasFor(r.clusterId),
    sector: r.primarySector,
    id: r.itemId,
    title: r.title,
    link: r.link,
    source: r.source,
    sourceDomain: r.sourceDomain,
    publishedAt: r.publishedAt.toISOString(),
    outlets: r.outlets,
    paywall: paywalled(r.sourceDomain),
    locked: access ? !canRead(r.sourceDomain, access) : paywalled(r.sourceDomain),
    question,
    unconfirmed: Boolean((r.scores as Record<string, number> | null)?.unconfirmed),
    opinion: r.storyType === "commentary",
  });

  const picked = new Set(picks.map((p) => p.clusterId));
  let pickedStories: TabStory[] = [];
  if (picks.length) {
    // A pick can fall outside the top rows by now (a fresher story overtook
    // it), so its lead story is fetched directly rather than looked up in rows.
    const pickedRows = await db
      .select(tabStoryColumns(key))
      .from(newsClusters)
      .innerJoin(newsItems, eq(newsItems.id, newsClusters.leadItemId))
      .where(and(inArray(newsClusters.id, [...picked]), isNull(newsItems.hiddenAt)));
    // A pick the student cannot open is shown through a readable copy, or
    // gives up its place at the top and competes with the rest.
    if (access) {
      const copies = await readableCopies(db, pickedRows.filter((r) => !canRead(r.sourceDomain, access)).map((r) => r.clusterId), access);
      for (let i = 0; i < pickedRows.length; i++) {
        const r = pickedRows[i];
        if (canRead(r.sourceDomain, access)) continue;
        const copy = copies.get(r.clusterId);
        if (copy) pickedRows[i] = { ...r, itemId: copy.itemId, title: copy.title, link: copy.link, source: copy.source, sourceDomain: copy.sourceDomain, publishedAt: copy.publishedAt };
        else picked.delete(r.clusterId);
      }
    }
    pickedStories = picks
      .filter((p) => picked.has(p.clusterId))
      .map((p) => pickedRows.find((r) => r.clusterId === p.clusterId) && toStory(pickedRows.find((r) => r.clusterId === p.clusterId)!, p.question))
      .filter((s): s is TabStory => Boolean(s));
  }

  const rest = limitStreaks(rows.filter((r) => !picked.has(r.clusterId)).map((r) => toStory(r)));
  return [...pickedStories, ...rest].slice(0, limit);
}
