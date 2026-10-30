import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { firms, newsItemFirms, newsItems } from "@/db/schema";
import { canRead } from "./access";
import { imagePath } from "./image-proxy";
import { summariesFor, type StorySummary } from "./summary";

type Db = Awaited<ReturnType<typeof getDb>>;

// What a story card needs beyond its lead story: the event's photo, which may
// come from any outlet's copy (Reuters' copy can carry the photo a Bloomberg
// lead cannot), and, for a card with no photo, the firm the event is about -
// its logo is the card's tile - and the short summary its panel opens to.

export type CardExtras = {
  imageUrl: string | null;
  firmName: string | null;
  firmDomain: string | null;
  /** Every firm linked to the event, the main party first - so a digest card labelled with one firm can show that firm's logo. */
  firms: { name: string; domain: string | null }[];
  /** Key points and takeaway for the story's panel, when the pipeline has written them. */
  summary: StorySummary | null;
};

/** Photo and firm for each event, keyed by cluster id. */
export async function cardExtras(db: Db, clusters: { id: string; leadItemId?: string }[]): Promise<Map<string, CardExtras>> {
  const out = new Map<string, CardExtras>();
  if (clusters.length === 0) return out;
  const ids = clusters.map((c) => c.id);
  const lead = new Map(clusters.map((c) => [c.id, c.leadItemId]));

  // Only a photo the photo step checked (it has the checked bytes' hash), and
  // only through Offerly's image route, which serves those exact bytes.
  const photos = await db
    .select({ clusterId: newsItems.clusterId, itemId: newsItems.id })
    .from(newsItems)
    .where(and(inArray(newsItems.clusterId, ids), isNotNull(newsItems.imageUrl), isNotNull(newsItems.imageHash), isNull(newsItems.hiddenAt)));
  const photoOf = new Map<string, string>();
  for (const p of photos) {
    if (!p.clusterId) continue;
    // The lead story's own photo wins; otherwise the first copy that has one.
    if (!photoOf.has(p.clusterId) || lead.get(p.clusterId) === p.itemId) photoOf.set(p.clusterId, imagePath(p.itemId));
  }

  const linked = await db
    .select({ clusterId: newsItems.clusterId, role: newsItemFirms.role, name: firms.name, website: firms.website })
    .from(newsItemFirms)
    .innerJoin(newsItems, eq(newsItems.id, newsItemFirms.itemId))
    .innerJoin(firms, eq(firms.id, newsItemFirms.firmId))
    .where(inArray(newsItems.clusterId, ids));
  const firmsOf = new Map<string, { name: string; domain: string | null; rank: number }[]>();
  const ROLE_ORDER = ["acquirer", "target", "issuer", "subject", "investor", "advisor", "lender"];
  const rank = (role: string | null) => {
    const i = ROLE_ORDER.indexOf(role ?? "");
    return i === -1 ? ROLE_ORDER.length : i;
  };
  for (const f of linked) {
    if (!f.clusterId) continue;
    const list = firmsOf.get(f.clusterId) ?? [];
    if (!list.some((x) => x.name === f.name)) list.push({ name: f.name, domain: domainOf(f.website), rank: rank(f.role) });
    firmsOf.set(f.clusterId, list);
  }

  const summaries = await summariesFor(db, clusters.map((c) => ({ id: c.id, itemId: c.leadItemId })));

  for (const id of ids) {
    const list = (firmsOf.get(id) ?? []).sort((a, b) => a.rank - b.rank).map(({ name, domain }) => ({ name, domain }));
    out.set(id, { imageUrl: photoOf.get(id) ?? null, firmName: list[0]?.name ?? null, firmDomain: list[0]?.domain ?? null, firms: list, summary: summaries.get(id) ?? null });
  }
  return out;
}

function domainOf(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website.includes("://") ? website : `https://${website}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export type ReadableCopy = {
  itemId: string;
  title: string;
  link: string;
  source: string;
  sourceDomain: string | null;
  publishedAt: Date;
};

/**
 * For each event, the first report of it (earliest published) that a student
 * with these subscriptions can open - a free outlet's, or one they pay for.
 * Events with no such copy are absent from the map.
 */
export async function readableCopies(db: Db, clusterIds: string[], access: readonly string[]): Promise<Map<string, ReadableCopy>> {
  const out = new Map<string, ReadableCopy>();
  if (clusterIds.length === 0) return out;
  const rows = await db
    .select({
      clusterId: newsItems.clusterId,
      itemId: newsItems.id,
      title: newsItems.title,
      link: newsItems.url,
      source: newsItems.publisher,
      sourceDomain: newsItems.publisherDomain,
      publishedAt: newsItems.publishedAt,
    })
    .from(newsItems)
    .where(and(inArray(newsItems.clusterId, clusterIds), isNull(newsItems.hiddenAt)))
    .orderBy(asc(newsItems.publishedAt));
  for (const r of rows) {
    if (!r.clusterId || out.has(r.clusterId) || !canRead(r.sourceDomain, access)) continue;
    out.set(r.clusterId, { itemId: r.itemId, title: r.title, link: r.link, source: r.source, sourceDomain: r.sourceDomain, publishedAt: r.publishedAt });
  }
  return out;
}
