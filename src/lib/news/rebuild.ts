import { eq, gte, inArray, isNull, notInArray, and } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { firms, newsClusters, newsItemFirms, newsItems, newsLabels, newsSources } from "@/db/schema";
import { clusterStories, publisherCount, type ClusterInput } from "./cluster";
import { normaliseFirmName } from "./firm-index";
import { isUnconfirmed } from "./quality";
import { scoreEvent } from "./rank";
import { isSector, type Entity, type Sector } from "./types";

type Db = Awaited<ReturnType<typeof getDb>>;

// Stages 3 and 4 against the database: group the last week's relevant stories
// into events, score each event for every tab, and store the result for the
// page to read. Recomputed from scratch every run - it is a few hundred rows,
// and recomputing means a label fix or a prior change shows up on the next run
// with no migration of stored state.

const WINDOW_DAYS = 7;
const TIER_RANK: Record<string, number> = { major: 3, primary: 2, trade: 2 };

type Member = ClusterInput & {
  tier: string;
  sourceSectors: string[];
  labelSectors: Sector[];
  specialties: string[];
  primarySector: Sector | null;
  worthiness: number;
  imageUrl: string | null;
  description: string | null;
  hasDescription: boolean;
  firmIds: string[];
};

export type RebuildReport = { stories: number; clusters: number; multiOutlet: number; belowFloor: number; perSector: Record<string, number> };

export async function rebuildClusters(db: Db, now: Date = new Date()): Promise<RebuildReport> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 3_600_000);
  const rows = await db
    .select({
      id: newsItems.id,
      title: newsItems.title,
      description: newsItems.description,
      publisher: newsItems.publisher,
      alsoPublishedBy: newsItems.alsoPublishedBy,
      imageUrl: newsItems.imageUrl,
      publishedAt: newsItems.publishedAt,
      tier: newsSources.tier,
      sourceSectors: newsSources.sectors,
      sectors: newsLabels.sectors,
      specialties: newsLabels.specialties,
      primarySector: newsLabels.primarySector,
      storyType: newsLabels.storyType,
      worthiness: newsLabels.worthiness,
      entities: newsLabels.entities,
      amountUsd: newsLabels.amountUsd,
    })
    .from(newsItems)
    .innerJoin(newsLabels, eq(newsLabels.itemId, newsItems.id))
    .innerJoin(newsSources, eq(newsSources.id, newsItems.sourceId))
    .where(and(gte(newsItems.publishedAt, since), eq(newsLabels.relevant, true), isNull(newsItems.hiddenAt)));

  const links = rows.length
    ? await db
        .select({ itemId: newsItemFirms.itemId, firmId: newsItemFirms.firmId, verified: firms.hasVerifiedProgram })
        .from(newsItemFirms)
        .innerJoin(firms, eq(firms.id, newsItemFirms.firmId))
        .where(inArray(newsItemFirms.itemId, rows.map((r) => r.id)))
    : [];
  const firmsByItem = new Map<string, { firmId: string; verified: boolean }[]>();
  for (const l of links) firmsByItem.set(l.itemId, [...(firmsByItem.get(l.itemId) ?? []), l]);

  const members: Member[] = rows.map((r) => {
    const linked = firmsByItem.get(r.id) ?? [];
    const entities = (r.entities as Entity[]) ?? [];
    return {
      id: r.id,
      title: r.title,
      publisher: r.publisher,
      alsoPublishedBy: r.alsoPublishedBy,
      publishedAt: r.publishedAt,
      storyType: r.storyType,
      amountUsd: r.amountUsd,
      // Who the story is about: linked firms, plus the named entities for the
      // firms the directory does not have.
      actors: [...linked.map((l) => `firm:${l.firmId}`), ...entities.map((e) => `name:${normaliseFirmName(e.name)}`)],
      tier: r.tier,
      sourceSectors: r.sourceSectors,
      labelSectors: r.sectors.filter(isSector),
      specialties: r.specialties ?? [],
      primarySector: isSector(r.primarySector) ? r.primarySector : null,
      worthiness: r.worthiness ?? 1,
      imageUrl: r.imageUrl,
      description: r.description,
      hasDescription: Boolean(r.description),
      firmIds: linked.map((l) => l.firmId),
    };
  });
  const byId = new Map(members.map((m) => [m.id, m]));
  const verifiedFirms = new Set(links.filter((l) => l.verified).map((l) => l.firmId));

  const groups = clusterStories(members);
  const report: RebuildReport = { stories: members.length, clusters: groups.size, multiOutlet: 0, belowFloor: 0, perSector: {} };

  for (const [clusterId, group] of groups) {
    const full = group.map((g) => byId.get(g.id)!);
    const lead = [...full].sort(
      (a, b) =>
        (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) ||
        Number(Boolean(b.imageUrl)) - Number(Boolean(a.imageUrl)) ||
        Number(b.hasDescription) - Number(a.hasDescription) ||
        a.publishedAt.getTime() - b.publishedAt.getTime(),
    )[0];

    // A sector is open to this event only through a member that is both
    // labelled for it and from a source trusted for it. A trade site's story
    // about something outside its specialty does not carry it onto that tab.
    const eligible = new Set<Sector>();
    for (const m of full) {
      for (const s of m.labelSectors) {
        if (m.tier !== "trade" || m.sourceSectors.includes(s)) eligible.add(s);
      }
    }
    const primaryVotes = new Map<Sector, number>();
    for (const m of full) if (m.primarySector) primaryVotes.set(m.primarySector, (primaryVotes.get(m.primarySector) ?? 0) + 1);
    const primary = lead.primarySector ?? [...primaryVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const pubs = publisherCount(full);
    if (pubs > 1) report.multiOutlet++;

    const bestTier = full.some((m) => m.tier === "major") ? "major" : full.some((m) => m.tier === "primary") ? "primary" : "trade";
    const scores = scoreEvent(
      {
        worthiness: Math.max(...full.map((m) => m.worthiness)),
        storyType: lead.storyType,
        eligibleSectors: [...eligible],
        primarySector: primary,
        bestTier,
        publisherCount: pubs,
        salientFirm: full.some((m) => m.firmIds.some((f) => verifiedFirms.has(f))),
        amountUsd: full.find((m) => m.amountUsd)?.amountUsd ?? null,
        firstSeenAt: full[0].publishedAt,
        unconfirmed: isUnconfirmed(full, pubs),
      },
      now,
    );
    for (const s of Object.keys(scores)) report.perSector[s] = (report.perSector[s] ?? 0) + 1;
    if (Object.keys(scores).length === 0) report.belowFloor++;

    const values = {
      leadItemId: lead.id,
      storyType: lead.storyType,
      primarySector: primary,
      sectors: [...eligible],
      specialties: [...new Set(full.flatMap((m) => m.specialties))],
      publisherCount: pubs,
      firstSeenAt: full[0].publishedAt,
      lastSeenAt: full[full.length - 1].publishedAt,
      scores,
      rankedAt: now,
    };
    await db.insert(newsClusters).values({ id: clusterId, ...values }).onConflictDoUpdate({ target: newsClusters.id, set: values });
    await db.update(newsItems).set({ clusterId }).where(inArray(newsItems.id, full.map((m) => m.id)));
  }

  // Events that no longer exist (merged into another, or aged out) go.
  const keep = [...groups.keys()];
  if (keep.length) await db.delete(newsClusters).where(notInArray(newsClusters.id, keep));
  else await db.delete(newsClusters);
  return report;
}
