/**
 * Discussions: student threads under Networking, optionally anonymous.
 *
 * The one rule this file exists to hold: an anonymous post's author never
 * leaves the server. Every read goes through `toView`, which turns a row into
 * a display label ("Anonymous", or "Name · USC '27") and a `mine` flag - the
 * author's id is not on the returned object, so no page can pass it to a
 * client component by accident.
 */

import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/db/client";
import { discussionReplies, discussions, firms, users } from "@/db/schema";

export const DISCUSSION_TOPICS = [
  "Interviews",
  "Technicals",
  "Recruiting timeline",
  "Networking",
  "Offers",
  "Internship life",
  "Exit opps",
  "General",
] as const;
export type DiscussionTopic = (typeof DISCUSSION_TOPICS)[number];

export const DISCUSSION_TITLE_MAX = 140;
export const DISCUSSION_BODY_MAX = 4000;
export const REPLY_BODY_MAX = 2000;

export function isTopic(v: unknown): v is DiscussionTopic {
  return typeof v === "string" && (DISCUSSION_TOPICS as readonly string[]).includes(v);
}

type Author = { name: string | null; school: string | null; gradYear: number | null } | null;

/**
 * Who a post shows as. Pure, and tested: this is the function that keeps an
 * anonymous author anonymous.
 */
export function authorLabel(input: {
  anonymous: boolean;
  isSample: boolean;
  sampleAuthor: string | null;
  author: Author;
}): string {
  if (input.anonymous) return "Anonymous";
  if (input.isSample) return input.sampleAuthor?.trim() || "Sample";
  const a = input.author;
  if (!a?.name?.trim()) return "A student";
  const year = a.gradYear ? ` '${String(a.gradYear).slice(-2)}` : "";
  return a.school ? `${a.name.trim()} · ${a.school}${year}` : a.name.trim();
}

export type DiscussionView = {
  id: string;
  title: string;
  body: string;
  topic: string;
  firmName: string | null;
  firmWebsite: string | null;
  author: string;
  anonymous: boolean;
  isSample: boolean;
  replyCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  mine: boolean;
};

export type ReplyView = {
  id: string;
  body: string;
  author: string;
  anonymous: boolean;
  isSample: boolean;
  createdAt: Date;
  mine: boolean;
};

const threadColumns = {
  id: discussions.id,
  authorId: discussions.authorId,
  anonymous: discussions.anonymous,
  title: discussions.title,
  body: discussions.body,
  topic: discussions.topic,
  firmName: discussions.firmName,
  firmWebsite: firms.website,
  isSample: discussions.isSample,
  sampleAuthor: discussions.sampleAuthor,
  replyCount: discussions.replyCount,
  lastActivityAt: discussions.lastActivityAt,
  createdAt: discussions.createdAt,
  authorName: users.name,
  authorSchool: users.school,
  authorGradYear: users.gradYear,
};

type ThreadRow = {
  id: string;
  authorId: string | null;
  anonymous: boolean;
  title: string;
  body: string;
  topic: string;
  firmName: string | null;
  firmWebsite: string | null;
  isSample: boolean;
  sampleAuthor: string | null;
  replyCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  authorName: string | null;
  authorSchool: string | null;
  authorGradYear: number | null;
};

function toView(row: ThreadRow, viewerId: string): DiscussionView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    topic: row.topic,
    firmName: row.firmName,
    firmWebsite: row.firmWebsite || null,
    author: authorLabel({
      anonymous: row.anonymous,
      isSample: row.isSample,
      sampleAuthor: row.sampleAuthor,
      author: { name: row.authorName, school: row.authorSchool, gradYear: row.authorGradYear },
    }),
    anonymous: row.anonymous,
    isSample: row.isSample,
    replyCount: row.replyCount,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    mine: row.authorId === viewerId,
  };
}

/** Newest activity first, optionally narrowed by topic and a search. */
export async function listDiscussions(
  viewerId: string,
  opts: { topic?: string | null; query?: string | null; limit?: number } = {},
): Promise<DiscussionView[]> {
  const db = await getDb();
  const where: SQL[] = [];
  if (opts.topic && isTopic(opts.topic)) where.push(eq(discussions.topic, opts.topic));
  const q = opts.query?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(discussions.title, like), ilike(discussions.body, like), ilike(discussions.firmName, like))!);
  }
  const rows = await db
    .select(threadColumns)
    .from(discussions)
    .leftJoin(users, eq(users.id, discussions.authorId))
    .leftJoin(firms, eq(firms.id, discussions.firmId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(discussions.lastActivityAt))
    .limit(opts.limit ?? 100);
  return rows.map((r) => toView(r, viewerId));
}

export async function getDiscussion(
  viewerId: string,
  id: string,
): Promise<{ thread: DiscussionView; replies: ReplyView[] } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = await getDb();
  const [row] = await db
    .select(threadColumns)
    .from(discussions)
    .leftJoin(users, eq(users.id, discussions.authorId))
    .leftJoin(firms, eq(firms.id, discussions.firmId))
    .where(eq(discussions.id, id))
    .limit(1);
  if (!row) return null;

  const replyRows = await db
    .select({
      id: discussionReplies.id,
      authorId: discussionReplies.authorId,
      anonymous: discussionReplies.anonymous,
      body: discussionReplies.body,
      isSample: discussionReplies.isSample,
      sampleAuthor: discussionReplies.sampleAuthor,
      createdAt: discussionReplies.createdAt,
      authorName: users.name,
      authorSchool: users.school,
      authorGradYear: users.gradYear,
    })
    .from(discussionReplies)
    .leftJoin(users, eq(users.id, discussionReplies.authorId))
    .where(eq(discussionReplies.discussionId, id))
    .orderBy(discussionReplies.createdAt);

  return {
    thread: toView(row, viewerId),
    replies: replyRows.map((r) => ({
      id: r.id,
      body: r.body,
      author: authorLabel({
        anonymous: r.anonymous,
        isSample: r.isSample,
        sampleAuthor: r.sampleAuthor,
        author: { name: r.authorName, school: r.authorSchool, gradYear: r.authorGradYear },
      }),
      anonymous: r.anonymous,
      isSample: r.isSample,
      createdAt: r.createdAt,
      mine: r.authorId === viewerId,
    })),
  };
}

/** A typed firm name matched exactly (case-insensitive) against the directory. */
export async function matchFirm(name: string): Promise<string | null> {
  const n = name.trim();
  if (!n) return null;
  const db = await getDb();
  const [row] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(and(sql`lower(${firms.name}) = lower(${n})`, eq(firms.isDemo, false)))
    .limit(1);
  return row?.id ?? null;
}

export async function createDiscussion(input: {
  authorId: string;
  anonymous: boolean;
  title: string;
  body: string;
  topic: DiscussionTopic;
  firmName: string | null;
}): Promise<string> {
  const db = await getDb();
  const firmId = input.firmName ? await matchFirm(input.firmName) : null;
  const [row] = await db
    .insert(discussions)
    .values({
      authorId: input.authorId,
      anonymous: input.anonymous,
      title: input.title,
      body: input.body,
      topic: input.topic,
      firmId,
      firmName: input.firmName,
    })
    .returning();
  return row.id;
}

/** A reply, and the thread's count and activity time, together. */
export async function addReply(input: {
  discussionId: string;
  authorId: string;
  anonymous: boolean;
  body: string;
}): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const bumped = await tx
      .update(discussions)
      .set({ replyCount: sql`${discussions.replyCount} + 1`, lastActivityAt: new Date() })
      .where(eq(discussions.id, input.discussionId))
      .returning();
    if (!bumped.length) return false;
    await tx.insert(discussionReplies).values(input);
    return true;
  });
}

/** Deletes only the viewer's own thread. Replies go with it (cascade). */
export async function deleteOwnDiscussion(viewerId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const gone = await db
    .delete(discussions)
    .where(and(eq(discussions.id, id), eq(discussions.authorId, viewerId)))
    .returning();
  return gone.length > 0;
}

/** Deletes only the viewer's own reply, and takes it off the thread's count. */
export async function deleteOwnReply(viewerId: string, replyId: string): Promise<string | null> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(discussionReplies)
      .where(and(eq(discussionReplies.id, replyId), eq(discussionReplies.authorId, viewerId)))
      .returning();
    if (!gone) return null;
    await tx
      .update(discussions)
      .set({ replyCount: sql`greatest(${discussions.replyCount} - 1, 0)` })
      .where(eq(discussions.id, gone.discussionId));
    return gone.discussionId;
  });
}
