"use server";

import { and, asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { activityComments, activityReactions, users } from "@/db/schema";
import {
  deleteOwnFeedItem,
  getFeedPage,
  getReactionSummaries,
  visibleEvent,
  type FeedItem,
} from "@/lib/activity";
import { blockedLanguageError } from "@/lib/content-limits";
import { getCurrentUser } from "@/lib/current-user";
import { COMMENT_MAX, isReactionEmoji, type FeedComment, type ReactionSummary } from "@/lib/feed-engagement";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * What one account may write into other people's conversations.
 *
 * The read side pages now (listComments below), so a comment past the first
 * 200 is reachable rather than written into a void. The caps stay, and for the
 * reason they were written: one scripted account filling the first pages of
 * everybody's threads makes the surface useless long before it makes the
 * database big. The shared surface is the thing being protected here.
 *
 * Two windows, because they answer different abuse: the hourly one bounds the
 * total, the per-row one stops the whole allowance being aimed at one post.
 * Both are far past a real conversation - the chattiest student on the
 * busiest day of recruiting season is nowhere near either.
 */
const COMMENTS_PER_HOUR = 120;
const COMMENTS_PER_ROW_PER_DAY = 25;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The next page of the live feed, for the infinite scroll. `snapshot` is the
 * moment the feed was opened, handed back unchanged on every page so the
 * unseen/seen split stays the same for the whole visit (see getFeedPage).
 */
export async function loadFeedPage(input: {
  cursor: string;
  snapshot: string;
}): Promise<{ items: FeedItem[]; nextCursor: string | null }> {
  const user = await getCurrentUser();
  const snapshot = new Date(input.snapshot);
  if (Number.isNaN(snapshot.getTime())) return { items: [], nextCursor: null };
  return getFeedPage(user.id, { cursor: input.cursor, snapshot });
}

/**
 * Adds the viewer's reaction, or takes it back if they had already left that
 * emoji. Returns the row's tallies as they now stand, so the chip the student
 * clicked settles on the real count rather than a guess.
 */
export async function toggleReaction(eventId: string, emoji: string): Promise<ReactionSummary[]> {
  const user = await getCurrentUser();
  if (!UUID.test(eventId) || !isReactionEmoji(emoji)) return [];
  const db = await getDb();

  const removed = await db
    .delete(activityReactions)
    .where(
      and(
        eq(activityReactions.eventId, eventId),
        eq(activityReactions.userId, user.id),
        eq(activityReactions.emoji, emoji),
      ),
    )
    .returning();
  if (removed.length === 0) {
    // Looked up as this viewer may see it, not merely as existing: a row they
    // are not shown is not a row they may react to (lib/activity visibleEvent).
    // Taking a reaction BACK is unconditional above, deliberately - a row that
    // became invisible must not trap the reaction already on it.
    if (!(await visibleEvent(user.id, eventId))) return [];
    await db.insert(activityReactions).values({ eventId, userId: user.id, emoji }).onConflictDoNothing();
  }
  return (await getReactionSummaries(user.id, [eventId])).get(eventId) ?? [];
}

/**
 * How many comments one read returns.
 *
 * The same 200 this has always returned, so an ordinary open of a thread is
 * byte-for-byte the request it was before. It is now a PAGE rather than a
 * ceiling: `after` walks past it (see listComments).
 *
 * Also the hard maximum. A caller-supplied page size is clamped to it, because
 * every row carries a name, a school and a photo URL and the reason a limit is
 * here at all is the size of one response.
 */
const COMMENT_PAGE_SIZE = 200;

/**
 * A row's comments, oldest first - read top to bottom like a conversation.
 *
 * PAST THE FIRST 200.
 * This used to take the oldest 200 and stop, with no way to ask for the rest:
 * comment 201 on a row was stored, counted in the tally under the post, and
 * shown to nobody ever. The write caps above (COMMENTS_PER_ROW_PER_DAY) bound
 * how fast one account can fill that window, but they cannot bound a popular
 * thread - 25 students saying eight things each is already past it.
 *
 * `after` is keyset paging on (created_at, id), the same shape getFeedPage
 * uses and for the same reason: a comment posted while someone reads cannot
 * shift the page under them, which an OFFSET would. It is the last row of the
 * previous page, as `<created_at>|<id>` - both halves of what the caller
 * already holds - and anything that is not those two things is ignored rather
 * than argued with, which hands back the first page.
 *
 * Default behaviour is unchanged: no `after`, 200 rows, oldest first.
 */
export async function listComments(
  eventId: string,
  page: { after?: string | null; limit?: number } = {},
): Promise<FeedComment[]> {
  const user = await getCurrentUser();
  if (!UUID.test(eventId)) return [];
  // This used to read the comments without looking at the row that carries
  // them at all, so a row the viewer may not be shown still handed back the
  // conversation underneath it - names, schools and photos included.
  if (!(await visibleEvent(user.id, eventId))) return [];

  // A page size the caller may lower but never raise, and never to nothing.
  const limit = Math.min(
    COMMENT_PAGE_SIZE,
    Math.max(1, Number.isFinite(page.limit) ? Math.trunc(page.limit as number) : COMMENT_PAGE_SIZE),
  );
  // Split on the LAST separator: a uuid holds no "|", so this is unambiguous.
  const raw = typeof page.after === "string" ? page.after : "";
  const cut = raw.lastIndexOf("|");
  const afterAt = cut === -1 ? "" : raw.slice(0, cut);
  const afterId = cut === -1 ? "" : raw.slice(cut + 1);
  // A timestamp literal and a uuid, nothing else. Both ride as parameters, but
  // there is no reason to let anything else reach the query at all - the same
  // rule decodeCursor applies in lib/activity.
  const after =
    // A trailing Z is allowed because that is the shape a caller holds: these
    // rows go to the client as JSON, where a Date is an ISO string. Postgres
    // ignores the zone on a cast to `timestamp`, which is the column's type,
    // and the stored value is UTC - so the two agree.
    // The shape test is not enough on its own: "9999-99-99T1.1" matches it and
    // then fails the cast, which throws out of the action instead of being
    // ignored the way a malformed cursor is meant to be. Date.parse settles
    // whether it is a real instant.
    /^\d{4}-\d{2}-\d{2}[ T][\d:.]+Z?$/.test(afterAt) &&
    !Number.isNaN(Date.parse(afterAt)) &&
    UUID.test(afterId)
      ? sql`(${activityComments.createdAt} > ${afterAt}::timestamp or (${activityComments.createdAt} = ${afterAt}::timestamp and ${activityComments.id} > ${afterId}::uuid))`
      : undefined;

  const db = await getDb();
  const rows = await db
    .select({
      id: activityComments.id,
      userId: activityComments.userId,
      body: activityComments.body,
      createdAt: activityComments.createdAt,
      // Explicit columns: `users` also carries password and verification
      // hashes, phone and resume text (see lib/people).
      name: users.name,
      school: users.school,
      avatarStoragePath: users.avatarStoragePath,
    })
    .from(activityComments)
    .innerJoin(users, eq(users.id, activityComments.userId))
    .where(and(eq(activityComments.eventId, eventId), after))
    // The id is the tiebreaker the cursor needs: two comments can share a
    // created_at, and an order that does not separate them would show one of
    // them twice or neither.
    .orderBy(asc(activityComments.createdAt), asc(activityComments.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name?.trim() || "A student",
    school: r.school,
    photoUrl: r.avatarStoragePath ? `/api/avatar/${r.userId}?v=${r.avatarStoragePath.slice(0, 8)}` : null,
    body: r.body,
    createdAt: r.createdAt,
    isYou: r.userId === user.id,
  }));
}

export type AddCommentResult = { error: string } | { comment: FeedComment; count: number };

/** Posts a comment under a feed row, checked like any other words a student writes. */
export async function addComment(eventId: string, body: string): Promise<AddCommentResult> {
  const user = await getCurrentUser();
  if (!UUID.test(eventId)) return { error: "That post is no longer here." };
  const text = String(body ?? "").trim();
  if (!text) return { error: "Write something first." };
  if (text.length > COMMENT_MAX) return { error: `Keep it under ${COMMENT_MAX} characters.` };
  const blocked = blockedLanguageError([["Your comment", text]]);
  if (blocked) return { error: blocked };

  const db = await getDb();
  // Same answer for a row that is hidden as for one that is gone: there is
  // nothing to learn from guessing ids (lib/activity visibleEvent).
  if (!(await visibleEvent(user.id, eventId))) return { error: "That post is no longer here." };

  // Counted against the signed-in account, resolved from the session - never
  // against anything in the request.
  const burst = await rateLimit("feed:comment", user.id, COMMENTS_PER_HOUR, HOUR_MS);
  if (!burst.allowed) {
    return { error: `You've commented a lot just now. Try again in about ${retryAfterText(burst.retryAfterMs)}.` };
  }
  // Joined with a colon, never a NUL: rate_events.subject is Postgres `text`,
  // and a NUL byte makes the limiter's insert throw and fall back to its much
  // weaker per-process memory count. Both halves are uuids.
  const onThisRow = await rateLimit(
    "feed:comment:row",
    `${user.id}:${eventId}`,
    COMMENTS_PER_ROW_PER_DAY,
    DAY_MS,
  );
  if (!onThisRow.allowed) {
    return {
      error: `You've said a lot on this post today. Try again in about ${retryAfterText(onThisRow.retryAfterMs)}.`,
    };
  }

  const [row] = await db.insert(activityComments).values({ eventId, userId: user.id, body: text }).returning();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityComments)
    .where(eq(activityComments.eventId, eventId));

  return {
    count: Number(count),
    comment: {
      id: row.id,
      userId: user.id,
      name: user.name?.trim() || "You",
      school: user.school,
      photoUrl: user.avatarStoragePath ? `/api/avatar/${user.id}?v=${user.avatarStoragePath.slice(0, 8)}` : null,
      body: row.body,
      createdAt: row.createdAt,
      isYou: true,
    },
  };
}

/**
 * Takes one of the viewer's own feed rows back down - a post they regret, or
 * an offer announcement they did not mean to publish.
 *
 * Someone else's row is refused the same way a missing one is: there is
 * nothing to learn from guessing ids. Both surfaces that render this feed are
 * revalidated, as publishing does.
 */
export async function deleteFeedItem(eventId: string): Promise<{ error?: string; ok?: boolean }> {
  const user = await getCurrentUser();
  if (!UUID.test(eventId)) return { error: "That post is no longer here." };
  const gone = await deleteOwnFeedItem(user.id, eventId);
  if (!gone) return { error: "That post is no longer here." };
  revalidatePath("/networking");
  revalidatePath("/home");
  return { ok: true };
}

/** Deletes one of the viewer's own comments. Returns the row's new count. */
export async function deleteComment(commentId: string): Promise<number | null> {
  const user = await getCurrentUser();
  if (!UUID.test(commentId)) return null;
  const db = await getDb();
  const [gone] = await db
    .delete(activityComments)
    .where(and(eq(activityComments.id, commentId), eq(activityComments.userId, user.id)))
    .returning();
  if (!gone) return null;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityComments)
    .where(eq(activityComments.eventId, gone.eventId));
  return Number(count);
}
