"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { blockedLanguageError } from "@/lib/content-limits";
import { getCurrentUserId } from "@/lib/current-user";
import {
  DISCUSSION_BODY_MAX,
  DISCUSSION_TITLE_MAX,
  REPLY_BODY_MAX,
  addReply,
  createDiscussion,
  deleteOwnDiscussion,
  deleteOwnReply,
  isTopic,
} from "@/lib/discussions";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";

export type DiscussionFormState = { error?: string; ok?: boolean } | undefined;

/**
 * What one account may add to the discussions board in a window.
 *
 * Replies are the sharper of the two: addReply sets lastActivityAt = now() and
 * the board is ordered by it, so every reply bumps its thread back to the top.
 * Without a bound, one account could keep its own thread pinned there
 * indefinitely, and getDiscussion reads every reply a thread has - so a
 * thread's render cost for every other student is whoever replied most.
 *
 * Two windows for replies, as with feed comments: the hourly one bounds the
 * total, the per-thread one stops the whole allowance going into one thread.
 * All three numbers are far past a real conversation.
 */
const DISCUSSIONS_PER_DAY = 25;
const REPLIES_PER_HOUR = 120;
const REPLIES_PER_THREAD_PER_DAY = 30;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Start a thread. Anonymous is the author's tick, per post. */
export async function startDiscussion(_prev: DiscussionFormState, fd: FormData): Promise<DiscussionFormState> {
  const userId = await getCurrentUserId();
  const title = String(fd.get("title") ?? "").trim();
  const body = String(fd.get("body") ?? "").trim();
  const topic = String(fd.get("topic") ?? "");
  const firmName = String(fd.get("firm") ?? "").trim().slice(0, 100) || null;
  const anonymous = fd.get("anonymous") === "on";

  if (!title) return { error: "Give it a title." };
  if (!body) return { error: "Say a bit more in the body." };
  if (title.length > DISCUSSION_TITLE_MAX) return { error: `Keep the title under ${DISCUSSION_TITLE_MAX} characters.` };
  if (body.length > DISCUSSION_BODY_MAX) return { error: `Keep it under ${DISCUSSION_BODY_MAX} characters.` };
  if (!isTopic(topic)) return { error: "Pick a topic." };
  const blocked = blockedLanguageError([
    ["Title", title],
    ["Your post", body],
    ["Firm", firmName ?? ""],
  ]);
  if (blocked) return { error: blocked };

  const perDay = await rateLimit("discussion:new", userId, DISCUSSIONS_PER_DAY, DAY_MS);
  if (!perDay.allowed) {
    return {
      error: `You've started a lot of discussions today. Try again in about ${retryAfterText(perDay.retryAfterMs)}.`,
    };
  }

  const id = await createDiscussion({ authorId: userId, anonymous, title, body, topic, firmName });
  revalidatePath("/networking/discussions");
  revalidatePath("/networking");
  redirect(`/networking/discussions/${id}`);
}

export async function postReply(_prev: DiscussionFormState, fd: FormData): Promise<DiscussionFormState> {
  const userId = await getCurrentUserId();
  const discussionId = String(fd.get("discussionId") ?? "");
  const body = String(fd.get("body") ?? "").trim();
  const anonymous = fd.get("anonymous") === "on";

  if (!body) return { error: "Write something first." };
  if (body.length > REPLY_BODY_MAX) return { error: `Keep it under ${REPLY_BODY_MAX} characters.` };
  const blocked = blockedLanguageError([["Your reply", body]]);
  if (blocked) return { error: blocked };

  const burst = await rateLimit("discussion:reply", userId, REPLIES_PER_HOUR, HOUR_MS);
  if (!burst.allowed) {
    return { error: `You've replied a lot just now. Try again in about ${retryAfterText(burst.retryAfterMs)}.` };
  }
  // Colon-joined, never a NUL - see the note in feed-actions.ts addComment:
  // rate_events.subject is Postgres `text` and a NUL byte would quietly drop
  // the limiter to its per-process fallback.
  const inThread = await rateLimit(
    "discussion:reply:thread",
    `${userId}:${discussionId}`,
    REPLIES_PER_THREAD_PER_DAY,
    DAY_MS,
  );
  if (!inThread.allowed) {
    return {
      error: `You've said a lot in this thread today. Try again in about ${retryAfterText(inThread.retryAfterMs)}.`,
    };
  }

  const ok = await addReply({ discussionId, authorId: userId, anonymous, body });
  if (!ok) return { error: "That discussion no longer exists." };
  revalidatePath(`/networking/discussions/${discussionId}`);
  revalidatePath("/networking/discussions");
  revalidatePath("/networking");
  return { ok: true };
}

export async function removeDiscussion(id: string): Promise<void> {
  const userId = await getCurrentUserId();
  await deleteOwnDiscussion(userId, id);
  revalidatePath("/networking/discussions");
  revalidatePath("/networking");
  redirect("/networking/discussions");
}

export async function removeReply(replyId: string): Promise<void> {
  const userId = await getCurrentUserId();
  const discussionId = await deleteOwnReply(userId, replyId);
  if (discussionId) revalidatePath(`/networking/discussions/${discussionId}`);
  revalidatePath("/networking/discussions");
}
