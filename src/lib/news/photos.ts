import { and, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { newsClusters, newsItems } from "@/db/schema";
import { mapLimit } from "./fetch";
import { sha256 } from "./image-proxy";
import { probeImage, type ImageFormat } from "./image-probe";
import { articleImages, fetchPage, fullSizeUrl, isGenericImageUrl, shareImages } from "./page-image";
import { matchHeadline, publisherArticles, type SitemapEntry } from "./resolve-url";
import { recordJobUsage } from "./usage";
import { PHOTO_BATCH, checkPhotos, photoAccepted, type PhotoVerdict } from "./vision";

type Db = Awaited<ReturnType<typeof getDb>>;

// The photo step: after ranking, give every event on a tab its own photo, or
// an honest tile when none can be found.
//
// Only events a student can see are looked at - a few hundred, not the
// thousand stories a run collects - and each story is looked at once
// (image_checked_at). For each event, its stories are tried lead first, and
// for each story the candidates in the order a publisher intends:
//
//   feed      the photo in the story's own feed item
//   sitemap   the photo the publisher lists with the article in its news
//             sitemap (how Google News stories, whose links hide the
//             publisher's address, get one - see resolve-url.ts)
//   share     the article's share image (og:image), chosen by its editors
//   jsonld    the image in the article's structured data
//   article   every real photo in the article body, top first, never an ad
//             or a rail - tried whenever the ones above fail a check, not
//             only when a page has none
//
// A candidate must then pass, in order: not a placeholder or logo by its
// filename; not a publisher default (the same image on two different events);
// a real, card-sized landscape image that does not declare itself AI-made
// (image-probe.ts); and the vision check (vision.ts), for every source. The
// first that passes is the event's photo. Up to five candidates per event
// reach the vision check, one at a time, so a share image turned down as a
// logo card falls through to a real photo from the article itself. A photo
// already on a card that now fails is removed.
//
// A WordPress resized copy (photo-150x150.jpg) is tried at its original size
// first, so a feed's thumbnail no longer loses the story its photo.
const WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 250;
const TIME_BUDGET_MS = 9 * 60_000;
/**
 * Candidates per event that may reach the vision check, tried in order. Five,
 * not three: with the share image and a crop of it often taking two, three
 * left room for only one of the article's own photos.
 */
export const MAX_CANDIDATES = 5;

type Item = {
  id: string;
  clusterId: string | null;
  sourceId: string;
  origin: string;
  url: string;
  resolvedUrl: string | null;
  title: string;
  publisherDomain: string | null;
  imageUrl: string | null;
  imageCandidate: string | null;
  imageHash: string | null;
  imageCheckedAt: Date | null;
};

type Candidate = { itemId: string; url: string; source: "feed" | "sitemap" | "share" | "jsonld" | "article" };
type Passed = Candidate & { bytes: Buffer; format: ImageFormat; headline: string; clusterId: string };

export type PhotoReport = {
  events: number;
  alreadyHadPhoto: number;
  looked: number;
  resolved: number;
  found: Record<string, number>;
  rejected: Record<string, number>;
  visionCalls: number;
  visionRejected: Record<string, number>;
  noPhoto: number;
  defaultsCleared: number;
  /** A few of the vision check's verdicts, to see what it turned down and why. */
  samples: string[];
  stopped?: string;
};

function isGoogleLink(url: string): boolean {
  return /^https?:\/\/news\.google\.com\//i.test(url);
}

export async function runPhotos(
  db: Db,
  opts: {
    limit?: number;
    now?: Date;
    model?: string;
    /**
     * Look again at events whose stories were all checked and got no photo -
     * for after the finding or checking rules change, since a checked story
     * is otherwise never looked at again. Only stories last checked BEFORE
     * this time: a recheck marks what it looks at as checked now, so the next
     * run with the same time moves on to the next batch instead of re-reading
     * the same top `limit` (as the first version did, 5 October 2026).
     * Highest-ranked first, `limit` a run.
     */
    recheckCheckedBefore?: Date;
  } = {},
): Promise<PhotoReport> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const report: PhotoReport = { events: 0, alreadyHadPhoto: 0, looked: 0, resolved: 0, found: {}, rejected: {}, visionCalls: 0, visionRejected: {}, noPhoto: 0, defaultsCleared: 0, samples: [] };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const clusters = await db
    .select({ id: newsClusters.id, leadItemId: newsClusters.leadItemId, scores: newsClusters.scores })
    .from(newsClusters)
    .where(gte(newsClusters.lastSeenAt, since));
  const onATab = clusters.filter((c) => Object.keys((c.scores as Record<string, number>) ?? {}).some((k) => k !== "unconfirmed"));
  report.events = onATab.length;
  if (onATab.length === 0) return report;

  const items: Item[] = [];
  for (let i = 0; i < onATab.length; i += 500) {
    items.push(
      ...(await db
        .select({
          id: newsItems.id,
          clusterId: newsItems.clusterId,
          sourceId: newsItems.sourceId,
          origin: newsItems.origin,
          url: newsItems.url,
          resolvedUrl: newsItems.resolvedUrl,
          title: newsItems.title,
          publisherDomain: newsItems.publisherDomain,
          imageUrl: newsItems.imageUrl,
          imageCandidate: newsItems.imageCandidate,
          imageHash: newsItems.imageHash,
          imageCheckedAt: newsItems.imageCheckedAt,
        })
        .from(newsItems)
        .where(and(inArray(newsItems.clusterId, onATab.slice(i, i + 500).map((c) => c.id)), isNull(newsItems.hiddenAt)))),
    );
  }
  const byCluster = new Map<string, Item[]>();
  for (const it of items) if (it.clusterId) byCluster.set(it.clusterId, [...(byCluster.get(it.clusterId) ?? []), it]);

  if (opts.recheckCheckedBefore) {
    // Only in memory: a story is marked checked again when it is looked at,
    // so the ones past this run's limit keep their old mark until a later
    // recheck reaches them - and the ones it did look at are now newer than
    // the cut-off, so a later run with the same cut-off skips them.
    const before = opts.recheckCheckedBefore.getTime();
    for (const its of byCluster.values()) {
      if (its.some((it) => it.imageUrl)) continue;
      for (const it of its) if (it.imageCheckedAt && it.imageCheckedAt.getTime() < before) it.imageCheckedAt = null;
    }
  }

  // Which events use which image, to spot a publisher's site-wide default.
  const imageUse = new Map<string, Set<string>>();
  const noteUse = (url: string, clusterId: string) => imageUse.set(url, (imageUse.get(url) ?? new Set()).add(clusterId));
  for (const it of items) for (const u of [it.imageUrl, it.imageCandidate]) if (u && it.clusterId) noteUse(u, it.clusterId);
  const sharedDefault = (url: string, clusterId: string) => [...(imageUse.get(url) ?? [])].some((c) => c !== clusterId);

  const best = (c: (typeof onATab)[number]) => Math.max(0, ...Object.entries((c.scores as Record<string, number>) ?? {}).filter(([k]) => k !== "unconfirmed").map(([, v]) => v));
  const pending = onATab
    .filter((c) => {
      const its = byCluster.get(c.id) ?? [];
      if (its.some((it) => it.imageUrl && it.imageHash && it.imageCheckedAt)) {
        report.alreadyHadPhoto++;
        return false;
      }
      return its.some((it) => !it.imageCheckedAt);
    })
    .sort((a, b) => best(b) - best(a))
    .slice(0, opts.limit ?? DEFAULT_LIMIT);

  // One sitemap read per publisher per run, however many of its stories need one.
  const sitemaps = new Map<string, Promise<SitemapEntry[]>>();
  const articlesOf = (domain: string) => {
    if (!sitemaps.has(domain)) sitemaps.set(domain, publisherArticles(domain, now).catch(() => []));
    return sitemaps.get(domain)!;
  };

  const itemUpdates = new Map<string, { resolvedUrl?: string; clearImage?: boolean }>();
  const leadFirst = (clusterId: string, leadId: string) =>
    [...(byCluster.get(clusterId) ?? [])].filter((it) => !it.imageCheckedAt).sort((a, b) => Number(b.id === leadId) - Number(a.id === leadId));

  /** Up to MAX_CANDIDATES for an event that pass every check short of the vision check. */
  async function candidatesFor(cluster: (typeof pending)[number]): Promise<Passed[]> {
    const passed: Passed[] = [];
    const tried = new Set<string>();
    for (const item of leadFirst(cluster.id, cluster.leadItemId)) {
      if (passed.length >= MAX_CANDIDATES || Date.now() - started > TIME_BUDGET_MS) break;
      itemUpdates.set(item.id, itemUpdates.get(item.id) ?? {});
      if (item.origin === "edgar" || item.origin === "regulator") continue;

      const tryOne = async (c: Candidate): Promise<boolean> => {
        if (tried.has(c.url)) return false;
        const original = fullSizeUrl(c.url);
        if (original && !tried.has(original) && (await tryOne({ ...c, url: original }))) return true;
        tried.add(c.url);
        if (isGenericImageUrl(c.url)) return bump(report.rejected, "placeholder_or_logo"), false;
        if (sharedDefault(c.url, cluster.id)) return bump(report.rejected, "publisher_default"), false;
        const probe = await probeImage(c.url);
        if (!probe.ok) {
          bump(report.rejected, probe.reason);
          if (c.source === "feed" && item.imageUrl === c.url) itemUpdates.get(item.id)!.clearImage = true;
          return false;
        }
        passed.push({ ...c, bytes: probe.bytes, format: probe.info.format, headline: item.title, clusterId: cluster.id });
        return true;
      };

      const full = () => passed.length >= MAX_CANDIDATES;
      for (const feed of [item.imageUrl, item.imageCandidate]) {
        if (feed && !full()) await tryOne({ itemId: item.id, url: feed, source: "feed" });
      }
      if (full()) break;

      let page: string | null = item.resolvedUrl ?? (isGoogleLink(item.url) ? null : item.url);
      if (!page && item.publisherDomain) {
        const entry = matchHeadline(item.title, await articlesOf(item.publisherDomain));
        if (entry) {
          page = entry.loc;
          report.resolved++;
          itemUpdates.get(item.id)!.resolvedUrl = entry.loc;
          if (entry.image) await tryOne({ itemId: item.id, url: entry.image, source: "sitemap" });
        }
      }
      if (!page || full()) continue;

      // The share image first - one per story is enough, the rest are usually
      // crops of it - then every photo in the article body, so a share image
      // the vision check turns down still leaves the article's own photos.
      const head = await fetchPage(page);
      if (!head.ok) continue;
      for (const c of shareImages(head.html, head.finalUrl)) {
        if (full()) break;
        if (await tryOne({ itemId: item.id, url: c.url, source: c.source })) break;
      }
      if (full()) continue;
      const whole = await fetchPage(page, { wholePage: true });
      if (!whole.ok) continue;
      for (const c of articleImages(whole.html, whole.finalUrl)) {
        if (full()) break;
        await tryOne({ itemId: item.id, url: c.url, source: "article" });
      }
    }
    return passed;
  }

  const perCluster = new Map<string, Passed[]>();
  await mapLimit(pending, 8, async (cluster) => {
    if (Date.now() - started > TIME_BUDGET_MS) return;
    report.looked++;
    perCluster.set(cluster.id, await candidatesFor(cluster));
  });
  if (Date.now() - started > TIME_BUDGET_MS) report.stopped = "time budget reached; the rest continue next run";

  // Decide each event's photo: the vision check looks at its first candidate,
  // and at the next only if the one before was turned down.
  const chosen = new Map<string, Passed>();
  const verdicts = new Map<string, PhotoVerdict>();
  const runVision = async (batch: Passed[]) => {
    const groups: Passed[][] = [];
    for (let i = 0; i < batch.length; i += PHOTO_BATCH) groups.push(batch.slice(i, i + PHOTO_BATCH));
    let failures = 0;
    await mapLimit(groups, 2, async (group) => {
      if (failures >= 2) return;
      const result = await checkPhotos(group.map((p) => ({ key: `${p.clusterId}|${p.url}`, headline: p.headline, bytes: p.bytes, format: p.format })), { model: opts.model });
      report.visionCalls++;
      if (result.usage) {
        await recordJobUsage(db, {
          feature: "newsPhotoCheck",
          model: result.model,
          engine: "claude-cli",
          items: group.length,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
          costUsd: result.usage.costUsd,
          ok: result.ok,
          error: result.error ?? null,
        });
      }
      if (!result.ok) {
        failures++;
        report.stopped = `photo check failed: ${result.error}`;
        return;
      }
      for (const [k, v] of result.verdicts) {
        verdicts.set(k, v);
        const p = group.find((g) => `${g.clusterId}|${g.url}` === k);
        if (p && report.samples.length < 40) report.samples.push(`${photoAccepted(v) ? "shown " : "TURNED DOWN"} ${v.kind}${v.fitsHeadline ? "" : " (not fitting)"}: ${v.note} | ${p.headline.slice(0, 70)} | ${p.url}`);
      }
    });
  };

  // Round n checks each still-undecided event's nth candidate. An event moves
  // to its next candidate only when the check looked and turned this one down
  // - if the check itself failed, the event keeps its unchecked stories for
  // next run.
  let undecided = [...perCluster.keys()].filter((id) => (perCluster.get(id) ?? []).length > 0);
  for (let round = 0; round < MAX_CANDIDATES && undecided.length > 0; round++) {
    const batch = undecided.map((id) => perCluster.get(id)![round]).filter((p): p is Passed => Boolean(p));
    if (batch.length === 0) break;
    await runVision(batch);
    const next: string[] = [];
    for (const p of batch) {
      const v = verdicts.get(`${p.clusterId}|${p.url}`);
      if (v && photoAccepted(v)) chosen.set(p.clusterId, p);
      else {
        bump(report.visionRejected, v ? (v.fitsHeadline ? v.kind : `${v.kind}, not fitting`) : "no_verdict");
        if (v) next.push(p.clusterId);
      }
    }
    undecided = next;
  }

  // A photo two events now share is a default, whichever was saved first.
  for (const p of chosen.values()) noteUse(p.url, p.clusterId);

  const checkedAt = new Date();
  const visionFailed = Boolean(report.stopped?.startsWith("photo check failed"));
  for (const [clusterId, passed] of perCluster) {
    const photo = chosen.get(clusterId);
    if (photo && sharedDefault(photo.url, clusterId)) {
      bump(report.rejected, "publisher_default");
      chosen.delete(clusterId);
    }
    const winner = chosen.get(clusterId);
    if (winner) bump(report.found, winner.source);
    else report.noPhoto++;
    // When the vision check could not run, stories whose candidate never got
    // a verdict stay unchecked, so the next run looks at them again.
    const awaitingVerdict = visionFailed && passed.some((p) => !verdicts.has(`${p.clusterId}|${p.url}`));
    for (const item of leadFirst(clusterId, "")) {
      const update = itemUpdates.get(item.id);
      if (!update) continue;
      const isWinner = winner?.itemId === item.id;
      // A photo this story already showed that did not win - it failed a check
      // or the vision check turned it down - comes off the card.
      const clear = !isWinner && item.imageUrl && (update.clearImage || !awaitingVerdict);
      await db
        .update(newsItems)
        .set({
          ...(update.resolvedUrl ? { resolvedUrl: update.resolvedUrl } : {}),
          ...(isWinner
            ? { imageUrl: winner!.url, imageSource: winner!.source, imageHash: sha256(winner!.bytes) }
            : clear
              ? { imageUrl: null, imageSource: null, imageHash: null }
              : {}),
          ...(awaitingVerdict && !isWinner ? {} : { imageCheckedAt: checkedAt }),
        })
        .where(eq(newsItems.id, item.id));
    }
  }

  report.defaultsCleared = await clearSharedDefaults(db, since);
  return report;
}

/**
 * A photo shown on two different events is a publisher's default image, not
 * either story's photo. Cleared from both; they show a tile instead.
 */
async function clearSharedDefaults(db: Db, since: Date): Promise<number> {
  const shared = await db
    .select({ url: newsItems.imageUrl })
    .from(newsItems)
    .where(and(isNotNull(newsItems.imageUrl), isNotNull(newsItems.clusterId), gte(newsItems.publishedAt, since)))
    .groupBy(newsItems.imageUrl)
    .having(sql`count(distinct ${newsItems.clusterId}) > 1`);
  const urls = shared.map((r) => r.url!).filter(Boolean);
  if (urls.length === 0) return 0;
  const cleared = await db
    .update(newsItems)
    .set({ imageUrl: null, imageSource: "default_rejected", imageHash: null })
    .where(inArray(newsItems.imageUrl, urls))
    // Bare .returning(): the partial-column overload does not typecheck
    // against the union of the two database drivers (see ingest.ts).
    .returning();
  return cleared.length;
}
