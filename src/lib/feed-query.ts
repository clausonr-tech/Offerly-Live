import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { posts, clubs, firms, schools } from "@/db/schema";
import { getFollowing } from "@/lib/follows";
import type { FeedFilters, FeedPost, FeedSort } from "@/lib/feed";

// 12, not 10: the feed renders three tiles per row, so a page of 12 lands as
// four complete rows instead of leaving a ragged one mid-scroll.
export const PAGE_SIZE = 12;

// A keyset cursor: the sort key of the last row plus its id, which breaks
// ties. Offset pagination would skip or repeat rows as new posts arrive
// mid-scroll, which is exactly what an infinite feed does all the time.
export type FeedCursor = { key: string; id: string };

export function encodeCursor(c: FeedCursor): string {
  return `${c.key}~${c.id}`;
}

export function decodeCursor(raw: string | null | undefined): FeedCursor | null {
  if (!raw) return null;
  const i = raw.lastIndexOf("~");
  if (i <= 0) return null;
  return { key: raw.slice(0, i), id: raw.slice(i + 1) };
}

// "Happening soonest" has to place undated announcements somewhere. Coalescing
// a null date to 'infinity' sorts them last and - more importantly - gives the
// keyset cursor a single non-null column to compare against, which a plain
// `nulls last` ordering does not.
const soonKey = sql`coalesce(${posts.startsAt}, 'infinity'::timestamp)`;

// firms.website is stored as a root domain, clubs.websiteUrl as whatever the
// club typed. Normalise both to a bare hostname for the logo lookup, and
// return null rather than a guess when there is nothing usable - an invented
// domain would render some unrelated company's logo next to the post.
function toDomain(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`);
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export async function fetchFeedPage(opts: {
  viewerId: string;
  viewerSchoolId: string | null;
  filters: FeedFilters;
  cursor?: string | null;
}): Promise<{ items: FeedPost[]; nextCursor: string | null }> {
  const { viewerId, viewerSchoolId, filters } = opts;
  const sort: FeedSort = filters.sort ?? "new";
  const db = await getDb();

  const conditions: SQL[] = [];
  if (filters.category) conditions.push(eq(posts.category, filters.category));
  if (filters.type) conditions.push(eq(posts.type, filters.type));

  const [orgKind, orgId] = (filters.org ?? "").split(":");
  if (orgKind === "club" && orgId) conditions.push(eq(posts.clubId, orgId));
  if (orgKind === "firm" && orgId) conditions.push(eq(posts.firmId, orgId));

  // A post marked "Only my school" is visible to that school alone, whatever
  // the reader's filters: it carries a school id, and a reader at another
  // school (or none) never gets it back. This was once applied only under the
  // "My school" filter, which left school-only posts readable by everyone.
  const visible = viewerSchoolId ? or(isNull(posts.schoolId), eq(posts.schoolId, viewerSchoolId)) : isNull(posts.schoolId);
  if (visible) conditions.push(visible);

  const when = filters.when ?? "all";
  const now = new Date();
  if (when === "upcoming") {
    const scope = or(gte(posts.startsAt, now), isNull(posts.startsAt));
    if (scope) conditions.push(scope);
  } else if (when === "past") {
    conditions.push(lt(posts.startsAt, now));
  }

  // "Following" narrows to the orgs the viewer follows. An empty follow list
  // must return nothing rather than everything, so this pushes an
  // always-false condition rather than skipping the clause.
  if (filters.following) {
    const following = await getFollowing(viewerId);
    const clubIds = [...following.clubs];
    const firmIds = [...following.firms];
    if (clubIds.length === 0 && firmIds.length === 0) {
      conditions.push(sql`false`);
    } else {
      const parts: SQL[] = [];
      if (clubIds.length) parts.push(inArray(posts.clubId, clubIds));
      if (firmIds.length) parts.push(inArray(posts.firmId, firmIds));
      const scope = parts.length === 1 ? parts[0] : or(...parts);
      if (scope) conditions.push(scope);
    }
  }

  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    // Row-value comparison, so the tie-break on id is part of the same
    // predicate the index can serve.
    if (sort === "new") {
      conditions.push(
        sql`(${posts.publishedAt}, ${posts.id}) < (${cursor.key}::timestamp, ${cursor.id}::uuid)`,
      );
    } else if (sort === "old") {
      conditions.push(
        sql`(${posts.publishedAt}, ${posts.id}) > (${cursor.key}::timestamp, ${cursor.id}::uuid)`,
      );
    } else {
      conditions.push(
        sql`(${soonKey}, ${posts.id}) > (${cursor.key}::timestamp, ${cursor.id}::uuid)`,
      );
    }
  }

  const orderBy =
    sort === "new"
      ? [desc(posts.publishedAt), desc(posts.id)]
      : sort === "old"
        ? [asc(posts.publishedAt), asc(posts.id)]
        : [asc(soonKey), asc(posts.id)];

  // One extra row is fetched purely to answer "is there another page" without
  // a second count query.
  const rows = await db
    .select()
    .from(posts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(PAGE_SIZE + 1);

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  // Poster names resolved in separate batched queries rather than a relational
  // `with` - the auth module found nested relational loads crash PGlite's WASM
  // engine outright.
  const clubIds = [...new Set(page.map((r) => r.clubId).filter((v): v is string => !!v))];
  const firmIds = [...new Set(page.map((r) => r.firmId).filter((v): v is string => !!v))];
  const [clubRows, firmRows] = await Promise.all([
    clubIds.length ? db.select().from(clubs).where(inArray(clubs.id, clubIds)) : [],
    firmIds.length ? db.select().from(firms).where(inArray(firms.id, firmIds)) : [],
  ]);
  const clubById = new Map(clubRows.map((c) => [c.id, c]));
  const firmById = new Map(firmRows.map((f) => [f.id, f]));

  // Two reasons to load a school: the post's own audience label, and the crest
  // standing in as a club's logo when the club has no site of its own.
  const schoolIds = [
    ...new Set(
      [
        ...page.map((r) => r.schoolId),
        ...clubRows.map((c) => c.schoolId),
      ].filter((v): v is string => !!v),
    ),
  ];
  const schoolRows = schoolIds.length
    ? await db.select().from(schools).where(inArray(schools.id, schoolIds))
    : [];
  const schoolById = new Map(schoolRows.map((s) => [s.id, s]));

  const items: FeedPost[] = page.map((p) => ({
    id: p.id,
    type: p.type,
    title: p.title,
    body: p.body,
    category: p.category,
    orgName:
      (p.clubId ? clubById.get(p.clubId)?.name : null) ??
      (p.firmId ? firmById.get(p.firmId)?.name : null) ??
      "Unknown organisation",
    orgDomain: (() => {
      if (p.firmId) return toDomain(firmById.get(p.firmId)?.website);
      if (p.clubId) {
        const club = clubById.get(p.clubId);
        const own = toDomain(club?.websiteUrl);
        if (own) return own;
        return club?.schoolId ? (schoolById.get(club.schoolId)?.emailDomain ?? null) : null;
      }
      return null;
    })(),
    location: p.location,
    linkUrl: p.linkUrl,
    linkLabel: p.linkLabel,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    publishedAt: p.publishedAt,
    schoolName: p.schoolId ? (schoolById.get(p.schoolId)?.name ?? null) : null,
    isMine: p.authorUserId === viewerId,
  }));

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          key:
            sort === "soon"
              ? (last.startsAt ? last.startsAt.toISOString() : "infinity")
              : last.publishedAt.toISOString(),
          id: last.id,
        })
      : null;

  return { items, nextCursor };
}

export type { FeedFilters, FeedPost, FeedSort } from "@/lib/feed";
