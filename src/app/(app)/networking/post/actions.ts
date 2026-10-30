"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { createPost } from "@/lib/activity";
import { POSTS_PER_DAY, POST_BODY_MAX, POST_DAY_MS } from "@/lib/post-limits";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";

export type PostState = { error?: string };

/**
 * Publish a student's post to the live feed.
 *
 * Open to every signed-in account, unlike the organisation composer at
 * /networking/compose - that one publishes club and firm programming and is gated on
 * a verified org. This is a person saying something, which needs no approval.
 */
export async function submitPost(_prev: PostState, formData: FormData): Promise<PostState> {
  const user = await getCurrentUser();
  const body = String(formData.get("body") ?? "").trim();

  if (!body) return { error: "Write something first." };
  const blocked = blockedLanguageError([["Your post", body]]);
  if (blocked) return { error: blocked };
  if (body.length > POST_BODY_MAX) {
    return { error: `Keep it under ${POST_BODY_MAX} characters.` };
  }

  // The same daily allowance the dialog composer counts against
  // (compose-actions), and the same bucket - two doors into one feed should
  // not mean twice the posts.
  const perDay = await rateLimit("feed:post", user.id, POSTS_PER_DAY, POST_DAY_MS);
  if (!perDay.allowed) {
    return { error: `You've posted a lot today. Try again in about ${retryAfterText(perDay.retryAfterMs)}.` };
  }

  await createPost(user.id, body);

  // Both surfaces that render this feed, not just the one being returned to -
  // /home shows the same list and would otherwise keep serving a cached copy
  // without the new row.
  revalidatePath("/networking");
  revalidatePath("/networking");
  redirect("/networking");
}
