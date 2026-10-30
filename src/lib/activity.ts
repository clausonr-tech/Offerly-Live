import "server-only";

import { randomUUID } from "crypto";
import { POST_BODY_MAX, POST_TITLE_MAX } from "@/lib/post-limits";

import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getPeerCounts } from "@/lib/peers";
import { deletePostImage } from "@/lib/post-image-storage";
import { activityComments, activityEvents, activityReactions, activitySeen, schools, users } from "@/db/schema";
import { isReactionEmoji, sortReactions, type ReactionSummary } from "@/lib/feed-engagement";
import { getTopFirmLogosFor, getTopFirmsFor } from "@/lib/people";
import { resolveSchoolCrest } from "@/lib/school-crest";

// `schools` is joined twice per row - once for the verified affiliation and
// once for the self-reported pick - so each needs its own alias.
const verifiedSchool = alias(schools, "verified_school");
const claimedSchool = alias(schools, "claimed_school");

export type ActivityKind = "joined" | "streak" | "offer" | "post";

export type FeedItem = {
  id: string;
  kind: ActivityKind;
  userId: string;
  name: string;
  /** Resolved at read time for "joined" rows rather than frozen into the event.
   *  A join post is the closest thing the feed has to an introduction, and a
   *  student who picks their target firms a week after signing up should have
   *  that introduction say so - rather than it being permanently blank because
   *  the row was written before they had any. */
  topFirms: string[];
  school: string | null;
  /** The school's own mail domain, which is what the crest is drawn from.
   *  Verified affiliation wins over a self-reported pick - see
   *  lib/school-crest. */
  schoolDomain: string | null;
  schoolName: string | null;
  /** Their own photo, when they have uploaded one. Overrides the crest. */
  photoUrl: string | null;
  firm: string | null;
  role: string | null;
  streak: number | null;
  /** What the student wrote, for kind "post". Null for the generated kinds. */
  body: string | null;
  /** A post's optional headline. Null for the generated kinds. */
  title: string | null;
  /** URL of the attached image, or null. A URL rather than the storage key,
   *  for the same reason photoUrl below is one: the key is an implementation
   *  detail of the upload directory and has no business reaching a client
   *  component. */
  imageUrl: string | null;
  createdAt: Date;
  isYou: boolean;
  /** How many people they are mutually peered with. Shown beside their name -
   *  it is the cheapest signal in the feed that someone is a real classmate
   *  rather than a stranger who happens to post. */
  peerCount: number;
  /** Already on this viewer's screen before the page they are reading was
   *  opened. The feed lists every unseen row first, then these. */
  seen: boolean;
  /** One line under the name: what they are doing now - a current
   *  internship, otherwise major, school and class year. Null when the
   *  profile says neither. */
  headline: string | null;
  /** Up to five of their top firms, for the logo row under the byline. */
  firmLogos: { name: string; website: string }[];
  /** Emoji tallies, in picker order. */
  reactions: ReactionSummary[];
  commentCount: number;
};

// Streaks only reach the feed once they are worth reading about, and only at
// round numbers. Posting every new personal best would put ten rows in the
// feed on the way up through a single good round.
const STREAK_FLOOR = 5;
const STREAK_STEP = 5;

/** The milestone a streak counts as, or null if it isn't one yet. */
export function streakMilestone(streak: number): number | null {
  if (streak < STREAK_FLOOR) return null;
  return Math.floor(streak / STREAK_STEP) * STREAK_STEP;
}

/**
 * Why createdAt is set here rather than left to the column's defaultNow():
 *
 * `created_at` is `timestamp` without a time zone. Postgres resolves now() into
 * the SESSION time zone before storing it, and PGlite's session is not UTC -
 * it is UTC-5 here - so the stored value is a naive local wall-clock time. The
 * read path then hands that value to JS as if it were UTC. The two disagree by
 * exactly the session offset, and a post made a second ago rendered as "5 hours
 * ago".
 *
 * Passing a JS Date sidesteps the session entirely: the driver serialises it as
 * UTC, which is what the reader already assumes. Both writers on this table do
 * it, so the column is consistent.
 */

/**
 * Writes one feed row. Every call is idempotent on (user, kind, dedupeKey) -
 * a retried signup, or an application flipped out of and back into `offer`,
 * silently does nothing the second time rather than posting again.
 *
 * Never throws into the caller. These are all side effects hanging off actions
 * the student actually came to do: failing to post "reached a 15 streak" must
 * not fail the round that earned it.
 */
async function record(row: {
  userId: string;
  kind: ActivityKind;
  dedupeKey: string;
  firm?: string | null;
  role?: string | null;
  streak?: number | null;
  body?: string | null;
}) {
  try {
    const db = await getDb();
    await db
      .insert(activityEvents)
      .values({
        userId: row.userId,
        kind: row.kind,
        dedupeKey: row.dedupeKey,
        firm: row.firm ?? null,
        role: row.role ?? null,
        streak: row.streak ?? null,
        body: row.body ?? null,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error("[activity] failed to record", row.kind, err);
  }
}

export function recordJoined(userId: string) {
  return record({ userId, kind: "joined", dedupeKey: userId });
}

/** `applicationId` is the dedupe key, so one application can only ever
 *  announce one offer however many times its status is edited. */
export function recordOffer(userId: string, applicationId: string, firm: string, role: string) {
  return record({ userId, kind: "offer", dedupeKey: applicationId, firm, role });
}

export async function recordStreak(userId: string, bestStreak: number) {
  const milestone = streakMilestone(bestStreak);
  if (milestone === null) return;
  await record({ userId, kind: "streak", dedupeKey: String(milestone), streak: milestone });
}

/** The longest post the feed will take. Long enough for a real update, short
 *  enough that one post cannot own the whole column. Defined in a leaf module
 *  so the client-side composer can read the same number - see lib/post-limits. */
export { POST_BODY_MAX } from "@/lib/post-limits";

/**
 * A post written by a student, as opposed to a milestone recorded for them.
 *
 * Unlike every other writer here this one DOES throw, and is awaited by its
 * caller. The others are side effects hanging off something else the student
 * came to do, where failing silently is right - losing "reached a 15 streak"
 * must not fail the round that earned it. This is the thing the student came
 * to do, so if it fails they have to be told.
 *
 * The dedupe key is random rather than derived: posting the same sentence
 * twice is a thing people legitimately do, and the unique index exists to stop
 * a retried signup double-announcing, not to stop that.
 */
export async function createPost(
  userId: string,
  body: string,
  /** Both optional: a one-line update needs neither, and requiring a headline
   *  on "Superday at Evercore next week - anyone else going?" would just mean
   *  reading the same sentence twice. */
  extras: { title?: string | null; imagePath?: string | null } = {},
): Promise<string> {
  const text = body.trim();
  const title = extras.title?.trim() || null;
  // A post has to carry SOMETHING readable. An image on its own is allowed -
  // a screenshot of a rejection email is a real post - but an empty box is not.
  if (!text && !title && !extras.imagePath) throw new Error("Write something first.");

  const db = await getDb();
  const [row] = await db
    .insert(activityEvents)
    .values({
      userId,
      kind: "post",
      dedupeKey: randomUUID(),
      body: text ? text.slice(0, POST_BODY_MAX) : null,
      title: title ? title.slice(0, POST_TITLE_MAX) : null,
      imagePath: extras.imagePath ?? null,
      createdAt: new Date(),
    })
    // Bare .returning(), not the partial-column overload - this driver does
    // not support that form, matching the rest of the codebase's convention.
    .returning();

  return row.id;
}

/** The columns every feed read selects, and the joins that feed them. */
function feedSelect<E extends Record<string, SQL>>(db: Awaited<ReturnType<typeof getDb>>, extra: E = {} as E) {
  return db
    .select({
      ...extra,
      id: activityEvents.id,
      kind: activityEvents.kind,
      firm: activityEvents.firm,
      role: activityEvents.role,
      streak: activityEvents.streak,
      body: activityEvents.body,
      title: activityEvents.title,
      imagePath: activityEvents.imagePath,
      createdAt: activityEvents.createdAt,
      // The same instant as text, to the microsecond, for the paging cursor.
      // A JS Date keeps milliseconds only, and a cursor rounded down would
      // skip rows written in the same millisecond as the last one shown.
      createdAtText: sql<string>`${activityEvents.createdAt}::text`,
      userId: activityEvents.userId,
      name: users.name,
      school: users.school,
      major: users.major,
      gradYear: users.gradYear,
      internships: users.internships,
      avatarStoragePath: users.avatarStoragePath,
      verifiedDomain: verifiedSchool.emailDomain,
      verifiedName: verifiedSchool.name,
      claimedDomain: claimedSchool.emailDomain,
      claimedName: claimedSchool.name,
    })
    .from(activityEvents)
    .innerJoin(users, eq(users.id, activityEvents.userId))
    // Two joins rather than a coalesce so the trust order stays visible in the
    // read path: which crest a row gets is decided by resolveSchoolCrest, not
    // buried in SQL. Both are left joins - most accounts have neither.
    .leftJoin(verifiedSchool, eq(verifiedSchool.id, users.schoolId))
    .leftJoin(claimedSchool, eq(claimedSchool.id, users.claimedSchoolId));
}

type FeedRow = Awaited<ReturnType<ReturnType<typeof feedSelect<Record<never, SQL>>>["execute"]>>[number];

/**
 * Which rows this viewer may be shown. Every feed read goes through it.
 *
 * "joined", "streak" and "post" are things a student did on Offerly on
 * purpose, in public. An "offer" row is not: it is written as a side effect of
 * editing a status in the private application tracker (recordOffer, from
 * applications/actions), and which firm made someone an offer is the most
 * sensitive line in that tracker - something a student types for themselves,
 * and the sort of thing that changes how a classmate treats them. Publishing
 * it to every signed-in student off the back of a dropdown, with no notice at
 * the point of entry and no way to take it back, is not consent.
 *
 * So the row stays - the author still sees their own milestone, and the
 * dedupe key still makes it idempotent - but nobody else is shown it. The
 * proper fix is an explicit, default-off "announce my offers" choice on the
 * tracker; that needs a column, so this is the honest default until then.
 */
function visibleToViewer(viewerId: string): SQL {
  return or(ne(activityEvents.kind, "offer"), eq(activityEvents.userId, viewerId))!;
}

/** One feed row as this viewer may see it. Null covers both "no such row" and
 *  "not yours to read" - see visibleEvent. */
export type VisibleEvent = { id: string; userId: string; kind: ActivityKind; imagePath: string | null };

/**
 * Looks one feed row up THROUGH the visibility rule above, and is the only way
 * the engagement paths are allowed to find a row.
 *
 * getFeed and getFeedPage applied visibleToViewer from the start, but every
 * other path that touches activity_events looked a row up by id alone:
 * toggleReaction and addComment checked only that the id existed, listComments
 * read a row's comments without looking at the row at all, markFeedSeen
 * selected its own ids straight out of the table, and /api/post-image joined
 * on the event id. Ids are random uuids and none of those paths hands back the
 * offer's firm or role, so this closed no live leak - but a student who came by
 * an offer row's id could react to it, comment under it, read what others had
 * commented and mark it seen: writing into, and reading around, a row they are
 * forbidden to be shown. Permission to read a row and permission to act on it
 * are the same permission.
 *
 * Null rather than a thrown error, and the same null for a row that is not
 * there as for one that is hidden: a guessed id must not be able to tell the
 * two apart.
 */
export async function visibleEvent(viewerId: string, eventId: string): Promise<VisibleEvent | null> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return null;
  const db = await getDb();
  const [row] = await db
    .select({
      id: activityEvents.id,
      userId: activityEvents.userId,
      kind: activityEvents.kind,
      imagePath: activityEvents.imagePath,
    })
    .from(activityEvents)
    .where(and(eq(activityEvents.id, eventId), visibleToViewer(viewerId)))
    .limit(1);
  return row ? { ...row, kind: row.kind as ActivityKind } : null;
}

/** The line under a name. A current internship says the most about someone;
 *  failing that, what they study, where, and when they finish. */
function headlineFor(r: Pick<FeedRow, "internships" | "major" | "school" | "gradYear">): string | null {
  const now = (r.internships ?? []).find((i) => i.current && i.role && i.firm);
  if (now) return `${now.role} at ${now.firm}`;
  const year = r.gradYear ? ` '${String(r.gradYear).slice(-2)}` : "";
  if (r.major && r.school) return `${r.major} · ${r.school}${year}`;
  if (r.school) return `Student at ${r.school}${year}`;
  return r.major ?? null;
}

/** Turns a page of rows into feed items, with everything that is batched per
 *  page rather than fetched per row. */
async function toFeedItems(viewerId: string, rows: FeedRow[], seenIds: Set<string>): Promise<FeedItem[]> {
  const ids = rows.map((r) => r.id);
  // One extra query for the whole page of join posts, not one per row.
  const joinUserIds = [...new Set(rows.filter((r) => r.kind === "joined").map((r) => r.userId))];
  const authorIds = [...new Set(rows.map((r) => r.userId))];
  const [topFirms, firmLogos, peerCounts, reactions, commentCounts] = await Promise.all([
    getTopFirmsFor(joinUserIds),
    getTopFirmLogosFor(authorIds, 5),
    // One batched query for the whole page rather than one per row.
    getPeerCounts(rows.map((r) => r.userId)),
    getReactionSummaries(viewerId, ids),
    getCommentCounts(ids),
  ]);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as ActivityKind,
    userId: r.userId,
    topFirms: r.kind === "joined" ? (topFirms.get(r.userId) ?? []) : [],
    // A student who never filled in a name still has to be referable to.
    name: r.name?.trim() || "A student",
    school: r.school,
    schoolDomain: resolveSchoolCrest(r)?.domain ?? null,
    schoolName: resolveSchoolCrest(r)?.name ?? null,
    // A URL, not the storage key - the key is an implementation detail of the
    // upload directory and has no business reaching a client component. The
    // first few characters of it ride along as a version, though, and that
    // part is load-bearing: the route answers `immutable, max-age=1y`, so
    // without something in the URL that changes when the photo does, a
    // replaced or removed picture stays on every other student's screen for a
    // year. The key is a fresh uuid per upload, so this changes every time.
    photoUrl: r.avatarStoragePath
      ? `/api/avatar/${r.userId}?v=${r.avatarStoragePath.slice(0, 8)}`
      : null,
    firm: r.firm,
    role: r.role,
    streak: r.streak,
    body: r.body,
    title: r.title,
    // Addressed by event id, not storage key, so the key stays server-side.
    // No cache-busting suffix is needed here where the avatar needs one: a
    // post's image is written once with the row and never replaced, so the
    // URL's bytes cannot change under the immutable cache header.
    imageUrl: r.imagePath ? `/api/post-image/${r.id}` : null,
    createdAt: r.createdAt,
    isYou: r.userId === viewerId,
    peerCount: peerCounts.get(r.userId) ?? 0,
    seen: seenIds.has(r.id),
    headline: headlineFor(r),
    firmLogos: firmLogos.get(r.userId) ?? [],
    reactions: reactions.get(r.id) ?? [],
    commentCount: commentCounts.get(r.id) ?? 0,
  }));
}

/** Emoji tallies for a page of rows, and which of them the viewer left. */
export async function getReactionSummaries(
  viewerId: string,
  eventIds: string[],
): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  if (eventIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({
      eventId: activityReactions.eventId,
      emoji: activityReactions.emoji,
      count: sql<number>`count(*)::int`,
      mine: sql<boolean>`bool_or(${activityReactions.userId} = ${viewerId})`,
    })
    .from(activityReactions)
    .where(inArray(activityReactions.eventId, eventIds))
    .groupBy(activityReactions.eventId, activityReactions.emoji);
  for (const r of rows) {
    if (!isReactionEmoji(r.emoji)) continue;
    const list = out.get(r.eventId) ?? [];
    list.push({ emoji: r.emoji, count: Number(r.count), mine: !!r.mine });
    out.set(r.eventId, list);
  }
  for (const [id, list] of out) out.set(id, sortReactions(list));
  return out;
}

async function getCommentCounts(eventIds: string[]): Promise<Map<string, number>> {
  if (eventIds.length === 0) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ eventId: activityComments.eventId, count: sql<number>`count(*)::int` })
    .from(activityComments)
    .where(inArray(activityComments.eventId, eventIds))
    .groupBy(activityComments.eventId);
  return new Map(rows.map((r) => [r.eventId, Number(r.count)]));
}

/**
 * The global feed, newest first. `before` is the previous page's oldest
 * timestamp - keyset paging rather than an offset, so rows written while
 * someone is scrolling cannot shift the page under them.
 *
 * Kept for the parked /home page; /networking reads getFeedPage below, which
 * adds the unseen-first ordering.
 */
export async function getFeed(
  viewerId: string,
  limit = 24,
  before?: Date,
): Promise<FeedItem[]> {
  const db = await getDb();
  const rows = await feedSelect(db)
    .where(
      and(
        before ? lt(activityEvents.createdAt, before) : undefined,
        visibleToViewer(viewerId),
      ),
    )
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit);
  return toFeedItems(viewerId, rows, new Set());
}

/** How many rows the live feed loads at a time. */
const FEED_PAGE_SIZE = 15;

/**
 * Where the next page starts: which group (0 = unseen, 1 = seen), and the last
 * row shown in it. Opaque to the client - it only hands it back.
 */
type FeedCursor = { g: 0 | 1; t: string; id: string };

function encodeCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string | null | undefined): FeedCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as FeedCursor;
    if ((c.g !== 0 && c.g !== 1) || typeof c.t !== "string" || !/^[0-9a-f-]{36}$/i.test(c.id)) return null;
    // A timestamp literal, nothing else - it is interpolated as a parameter,
    // but there is no reason to pass anything else through at all.
    if (!/^\d{4}-\d{2}-\d{2}[ T][\d:.]+$/.test(c.t)) return null;
    return c;
  } catch {
    return null;
  }
}

/**
 * One page of the live feed for this viewer: every row they have not seen,
 * newest first, then every row they have, newest first.
 *
 * "Seen" is judged against `snapshot` - the moment the feed was opened - not
 * against now. Rows are marked seen as the student scrolls past them, and if
 * each page re-read the live state, a row seen on page one would reappear in
 * the seen group on page three. Freezing the split at open time gives every
 * row exactly one place for the whole visit; the next visit sees the new
 * split.
 *
 * Keyset paging throughout (group, created_at, id), so rows posted while
 * someone scrolls never shift a page under them.
 */
export async function getFeedPage(
  viewerId: string,
  opts: { cursor?: string | null; snapshot: Date; limit?: number },
): Promise<{ items: FeedItem[]; nextCursor: string | null }> {
  const limit = opts.limit ?? FEED_PAGE_SIZE;
  const cursor = decodeCursor(opts.cursor);
  const db = await getDb();

  // Two queries, one per group, rather than one query ordered by a computed
  // "seen" flag. No index can serve an ORDER BY on a value derived from a left
  // join, so that version scanned every row before the snapshot, joined each
  // to the viewer's seen rows and sorted the lot to keep sixteen - linear in
  // the size of the whole feed (EXPLAIN at 100k rows: a full scan and a
  // 100,000-row sort). Each group on its own is a plain (created_at, id) walk
  // that stops after one page.
  const seenBefore = and(
    eq(activitySeen.eventId, activityEvents.id),
    eq(activitySeen.userId, viewerId),
    lt(activitySeen.seenAt, opts.snapshot),
  );
  // Strictly after the cursor in (created_at desc, id desc) order. A row
  // comparison, so the index range starts at the cursor instead of filtering.
  const pastCursor = (c: FeedCursor | null) =>
    c ? sql`(${activityEvents.createdAt}, ${activityEvents.id}) < (${c.t}::timestamp, ${c.id}::uuid)` : undefined;
  const newestFirst = [desc(activityEvents.createdAt), desc(activityEvents.id)] as const;

  // One extra row answers "is there another page" without a count query.
  const rows: (FeedRow & { seen: boolean })[] = [];
  if (!cursor || cursor.g === 0) {
    const unseen = await feedSelect(db)
      .where(
        and(
          lt(activityEvents.createdAt, opts.snapshot),
          pastCursor(cursor),
          sql`not exists (select 1 from ${activitySeen} where ${seenBefore})`,
          // An offer is shown to its author and to nobody else. main's rewrite
          // of this query for indexed paging did not carry the predicate, and
          // both of its branches need it: without it, paging the feed hands
          // back the offer rows the single-query version refuses.
          visibleToViewer(viewerId),
        ),
      )
      .orderBy(...newestFirst)
      .limit(limit + 1);
    rows.push(...unseen.map((r) => ({ ...r, seen: false })));
  }
  // Only reached once the unseen rows run out inside this page - including
  // exactly at its end, where the seen group decides whether a next page exists.
  if (rows.length <= limit) {
    const seen = await feedSelect(db)
      .innerJoin(activitySeen, seenBefore)
      .where(
        and(
          lt(activityEvents.createdAt, opts.snapshot),
          pastCursor(cursor?.g === 1 ? cursor : null),
          visibleToViewer(viewerId),
        ),
      )
      .orderBy(...newestFirst)
      .limit(limit + 1 - rows.length);
    rows.push(...seen.map((r) => ({ ...r, seen: true })));
  }

  const seenIds = new Set(rows.filter((r) => r.seen).map((r) => r.id));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ g: last.seen ? 1 : 0, t: last.createdAtText, id: last.id })
      : null;

  return { items: await toFeedItems(viewerId, page, seenIds), nextCursor };
}

/**
 * Takes one of the author's OWN feed rows back down.
 *
 * The table was write-once: record() and createPost() only ever inserted, and
 * nothing in the app deleted a row - so a post published by mistake, or an
 * offer announced by a status change the student did not realise was public,
 * stood for as long as the account did. Something a person published about
 * themselves has to be retractable by them.
 *
 * Scoped to the author's own row by the same WHERE as the delete, so a guessed
 * id gets nothing: a row that is not theirs reads exactly like one that is not
 * there. Comments, reactions and seen-marks go with it on the schema's
 * cascades; the attached image is removed from the file store too, because
 * nothing else ever will.
 *
 * Returns whether a row was actually removed.
 */
export async function deleteOwnFeedItem(userId: string, eventId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return false;
  const db = await getDb();
  const [gone] = await db
    .delete(activityEvents)
    .where(and(eq(activityEvents.id, eventId), eq(activityEvents.userId, userId)))
    .returning();
  if (!gone) return false;
  await deletePostImage(gone.imagePath);
  return true;
}

/**
 * Removes the announcement an application made when it reached "offer",
 * for the student whose application it is.
 *
 * The counterpart to recordOffer: that one is idempotent on the application
 * id, so this leaves the tracker free to announce again if the status is set
 * back to offer later. Meant to be called when an application stops being an
 * offer, or is deleted - without it, reverting a status left the announcement
 * standing for good.
 */
export async function retractOffer(userId: string, applicationId: string | string[]): Promise<boolean> {
  const ids = (Array.isArray(applicationId) ? applicationId : [applicationId]).filter(Boolean);
  if (ids.length === 0) return false;
  const db = await getDb();
  // A list in one statement, because untracking a whole firm can carry every
  // role a student tracks there - and the tracker holds up to 5,000 rows, so a
  // round trip each would be 5,000 writes from one click, each taking one of
  // the eight web connections in turn. Chunked at 500 for the same reason
  // lib/firm-delivery chunks: one statement with 5,000 parameters is its own
  // problem. Always scoped to this caller's own rows and to kind = offer, which
  // is what makes taking the ids in bulk safe at all.
  let removed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const rows = await db
      .delete(activityEvents)
      .where(
        and(
          eq(activityEvents.userId, userId),
          eq(activityEvents.kind, "offer"),
          batch.length === 1 ? eq(activityEvents.dedupeKey, batch[0]) : inArray(activityEvents.dedupeKey, batch),
        ),
      )
      .returning();
    removed += rows.length;
  }
  return removed > 0;
}

/**
 * Records rows as on this viewer's screen. One statement: the insert selects
 * its own ids from activity_events, so an unknown or deleted id is simply not
 * there to insert, with no separate existence check first.
 *
 * The select carries visibleToViewer for the same reason the single-row
 * lookups now go through visibleEvent: a row this viewer may not be shown is
 * not a row they can have seen, and marking one would have written a durable
 * per-viewer record against it. This path takes up to a hundred ids at a time,
 * so the predicate is applied set-wise here rather than one visibleEvent call
 * per id - it is the same predicate, in the same place in the query.
 */
export async function markFeedSeen(viewerId: string, eventIds: string[]): Promise<void> {
  const ids = [...new Set(eventIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
  if (ids.length === 0) return;
  const db = await getDb();
  await db.execute(sql`
    insert into ${activitySeen} (user_id, event_id)
    select ${viewerId}::uuid, ${activityEvents.id} from ${activityEvents}
    where ${activityEvents.id} in ${ids} and ${visibleToViewer(viewerId)}
    on conflict do nothing`);
}
