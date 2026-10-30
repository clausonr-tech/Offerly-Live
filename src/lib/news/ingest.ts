import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { newsItems, newsLabels, newsSources } from "@/db/schema";
import { EDGAR_FEED, edgarStories, edgarUserAgent, parseEdgarAtom } from "./edgar";
import { fetchText, mapLimit } from "./fetch";
import { MAX_AGE_HOURS, REGULATOR_MAX_AGE_HOURS, filterItem, titleKey, trimDescription, urlHash } from "./filters";
import { parseFeed, parseGoogleNews } from "./parse";
import { GOOGLE_MAJOR_SITES, SOURCE_SEEDS } from "./sources";
import type { Entity, ItemOrigin, RawItem, Sector, SourceKind, StoryType } from "./types";

type Db = Awaited<ReturnType<typeof getDb>>;
type SourceRow = typeof newsSources.$inferSelect;

// Collection: every approved source, fetched, filtered and deduplicated into
// news_items. No model runs here - everything this step drops is a story the
// classifier is never paid to read.

/**
 * Writes the reviewed registry (sources.ts) into news_sources. New entries go
 * in approved; existing ones get their name, URL and sectors refreshed but keep
 * their status, so a source someone retired stays retired across a re-seed.
 */
export async function seedSources(db: Db): Promise<number> {
  for (const s of SOURCE_SEEDS) {
    await db
      .insert(newsSources)
      .values({
        id: s.id,
        name: s.name,
        domain: s.domain,
        tier: s.tier,
        sectors: s.sectors,
        kind: s.kind,
        url: s.url,
        region: s.region ?? "global",
        paywall: s.paywall ?? false,
        status: "approved",
        notes: s.notes ?? null,
        approvedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: newsSources.id,
        set: { name: s.name, domain: s.domain, tier: s.tier, sectors: s.sectors, kind: s.kind, url: s.url, region: s.region ?? "global", paywall: s.paywall ?? false },
      });
  }
  return SOURCE_SEEDS.length;
}

export type SourceReport = {
  id: string;
  kind: SourceKind;
  ok: boolean;
  error?: string;
  fetched: number;
  inserted: number;
  merged: number;
  duplicate: number;
  dropped: Record<string, number>;
};

type Candidate = RawItem & {
  origin: ItemOrigin;
  filingForm?: string;
  edgar?: { storyType: StoryType; sectors: Sector[]; worthiness: number; entities: Entity[] };
};

async function collect(source: SourceRow): Promise<{ items: Candidate[]; error?: string }> {
  if (source.kind === "edgar") {
    const ua = edgarUserAgent();
    if (!ua) return { items: [], error: "NEWS_SEC_CONTACT is not set; the SEC refuses anonymous requests" };
    const res = await fetchText(EDGAR_FEED(source.url), { userAgent: ua });
    if (!res.ok) return { items: [], error: res.error };
    return {
      items: edgarStories(parseEdgarAtom(res.text)).map((s) => ({
        ...s,
        origin: "edgar" as const,
        filingForm: s.form,
        edgar: { storyType: s.storyType, sectors: s.sectors, worthiness: s.worthiness, entities: s.entities },
      })),
    };
  }

  if (source.kind === "google_site") {
    const params = new URLSearchParams({ q: source.url, hl: "en-US", gl: "US", ceid: "US:en" });
    const res = await fetchText(`https://news.google.com/rss/search?${params}`);
    if (!res.ok) return { items: [], error: res.error };
    return { items: parseGoogleNews(res.text).map((i) => ({ ...i, origin: "google" as const })) };
  }

  const res = await fetchText(source.url);
  if (!res.ok) return { items: [], error: res.error };
  const origin: ItemOrigin = source.kind === "regulator" ? "regulator" : "rss";
  return {
    items: parseFeed(res.text, { publisher: source.name, domain: source.domain }).map((i) => ({ ...i, origin })),
  };
}

/**
 * Which publishers a Google News source may bring in. The sector searches
 * (domain news.google.com) are limited to the majors; a publisher the scout
 * added through its own site search brings in only itself.
 */
export function googleResultAllowed(source: SourceRow, domain: string | null): boolean {
  if (source.domain === "news.google.com") return isMajorSite(domain);
  return Boolean(domain && (domain === source.domain || domain.endsWith("." + source.domain)));
}

function isMajorSite(domain: string | null): boolean {
  if (!domain) return false;
  return GOOGLE_MAJOR_SITES.some((d) => domain === d || domain.endsWith("." + d));
}

async function store(db: Db, source: SourceRow, candidates: Candidate[], now: Date): Promise<SourceReport> {
  const report: SourceReport = { id: source.id, kind: source.kind as SourceKind, ok: true, fetched: candidates.length, inserted: 0, merged: 0, duplicate: 0, dropped: {} };
  const drop = (reason: string) => (report.dropped[reason] = (report.dropped[reason] ?? 0) + 1);

  const kept: (Candidate & { hash: string; key: string })[] = [];
  const seenInBatch = new Set<string>();
  for (const c of candidates) {
    // Google returns whatever it likes for a site: query now and then; only the
    // newsrooms actually asked for may through.
    if (c.origin === "google" && !googleResultAllowed(source, c.publisherDomain)) {
      drop("not_a_queried_site");
      continue;
    }
    const verdict = filterItem(c, now, c.origin === "regulator" ? REGULATOR_MAX_AGE_HOURS : MAX_AGE_HOURS);
    if (!verdict.keep) {
      drop(verdict.reason);
      continue;
    }
    const hash = urlHash(c.url);
    if (seenInBatch.has(hash)) continue;
    seenInBatch.add(hash);
    kept.push({ ...c, hash, key: titleKey(c.title) });
  }
  if (kept.length === 0) return report;


  const existingByHash = new Set(
    (await db.select({ h: newsItems.urlHash }).from(newsItems).where(inArray(newsItems.urlHash, kept.map((k) => k.hash)))).map((r) => r.h),
  );
  // Same headline from another publisher in the last two days: the same story,
  // syndicated. It becomes corroboration on the first copy rather than a card of its own.
  const since = new Date(now.getTime() - 48 * 3_600_000);
  const sameTitle = await db
    .select({ id: newsItems.id, key: newsItems.titleKey, publisher: newsItems.publisher, also: newsItems.alsoPublishedBy })
    .from(newsItems)
    .where(and(inArray(newsItems.titleKey, kept.map((k) => k.key)), gte(newsItems.publishedAt, since)));
  const byKey = new Map(sameTitle.map((r) => [r.key, r]));

  // Photos. A feed's photo is kept only as a candidate: nothing shows it
  // until the photo step (photos.ts) has measured it, checked its metadata for
  // AI and had the vision check look at it - for every source, vetted or not.
  const feedPhotos = new Map<string, string>();
  for (const c of kept) {
    if (c.imageUrl) feedPhotos.set(c.hash, c.imageUrl);
    c.imageUrl = null;
  }

  for (const c of kept) {
    if (existingByHash.has(c.hash)) {
      report.duplicate++;
      continue;
    }
    const twin = byKey.get(c.key);
    if (twin) {
      if (twin.publisher !== c.publisher && !twin.also.includes(c.publisher)) {
        await db
          .update(newsItems)
          .set({ alsoPublishedBy: sql`array_append(${newsItems.alsoPublishedBy}, ${c.publisher})` })
          .where(eq(newsItems.id, twin.id));
        twin.also.push(c.publisher);
        report.merged++;
      } else {
        report.duplicate++;
      }
      continue;
    }

    const [row] = await db
      .insert(newsItems)
      .values({
        sourceId: source.id,
        urlHash: c.hash,
        url: c.url,
        title: c.title,
        description: trimDescription(c.description, c.title),
        publisher: c.publisher || source.name,
        publisherDomain: c.publisherDomain,
        imageUrl: c.imageUrl,
        imageCandidate: feedPhotos.get(c.hash) ?? null,
        publishedAt: c.publishedAt!,
        titleKey: c.key,
        origin: c.origin,
        filingForm: c.filingForm ?? null,
        // A filing's story type is already known, so it is never sent to the model.
        status: c.edgar ? "skipped" : "new",
      })
      .onConflictDoNothing({ target: newsItems.urlHash })
      // Bare .returning(): the partial-column overload does not typecheck
      // against the union of the two database drivers (see activity.ts).
      .returning();
    if (!row) {
      report.duplicate++;
      continue;
    }
    report.inserted++;
    byKey.set(c.key, { id: row.id, key: c.key, publisher: c.publisher, also: [] });

    if (c.edgar) {
      await db.insert(newsLabels).values({
        itemId: row.id,
        classifierVersion: "edgar-rules-v1",
        model: "none",
        relevant: true,
        primarySector: c.edgar.sectors[0],
        sectors: c.edgar.sectors,
        storyType: c.edgar.storyType,
        worthiness: c.edgar.worthiness,
        entities: c.edgar.entities,
        region: "us",
      });
    }
  }
  return report;
}

export async function runIngest(
  db: Db,
  opts: { now?: Date; onlySources?: string[]; concurrency?: number } = {},
): Promise<SourceReport[]> {
  const now = opts.now ?? new Date();
  let sources = await db.select().from(newsSources).where(eq(newsSources.status, "approved"));
  sources = sources.filter((s) => s.tier !== "blocked");
  if (opts.onlySources) sources = sources.filter((s) => opts.onlySources!.includes(s.id));

  return mapLimit(sources, opts.concurrency ?? 8, async (source) => {
    const { items, error } = await collect(source);
    const report: SourceReport = error
      ? { id: source.id, kind: source.kind as SourceKind, ok: false, error, fetched: 0, inserted: 0, merged: 0, duplicate: 0, dropped: {} }
      : await store(db, source, items, now);

    const newest = items.reduce<Date | null>((m, i) => (i.publishedAt && (!m || i.publishedAt > m) ? i.publishedAt : m), null);
    await db
      .update(newsSources)
      .set({
        lastFetchedAt: now,
        ...(newest && (!source.lastItemAt || newest > source.lastItemAt) ? { lastItemAt: newest } : {}),
        consecutiveFailures: error ? sql`${newsSources.consecutiveFailures} + 1` : 0,
      })
      .where(eq(newsSources.id, source.id));
    return report;
  });
}

/**
 * Approved sources that have gone quiet: failing three runs in a row, or no
 * story in 48 hours - a week for regulators, who publish a few times a week.
 */
export async function silentSources(db: Db, now: Date = new Date()) {
  const rows = await db.select().from(newsSources).where(eq(newsSources.status, "approved"));
  return rows.filter((s) => {
    if (s.kind === "edgar") return false;
    const quietHours = s.kind === "regulator" ? REGULATOR_MAX_AGE_HOURS : 48;
    return s.consecutiveFailures >= 3 || (s.lastItemAt && s.lastItemAt.getTime() < now.getTime() - quietHours * 3_600_000);
  });
}
