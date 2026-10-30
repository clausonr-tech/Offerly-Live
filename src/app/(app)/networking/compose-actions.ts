"use server";

import { revalidatePath } from "next/cache";

import { blockedLanguageError } from "@/lib/content-limits";
import { getCurrentUser } from "@/lib/current-user";
import { createPost } from "@/lib/activity";
import {
  POSTS_PER_DAY,
  POST_BODY_MAX,
  POST_DAY_MS,
  POST_IMAGES_PER_DAY,
  POST_TITLE_MAX,
} from "@/lib/post-limits";
import { deletePostImage, savePostImage } from "@/lib/post-image-storage";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";

export type ComposeState = { error?: string; ok?: boolean };

/**
 * Publish a student's post to the live feed, from the dialog on /networking.
 *
 * Distinct from post/actions.ts's `submitPost`, which backs the standalone
 * /networking/post page: that one redirects afterwards, which is right for a
 * page you navigated to and wrong for a dialog you opened over the feed you
 * are already reading. This one returns a state the dialog closes on, and
 * revalidates so the feed underneath re-renders with the new row in place.
 *
 * Open to every signed-in account, unlike the organisation composer at
 * /networking/compose - that publishes club and firm programming and is gated
 * on a verified org. This is a person saying something, which needs no
 * approval.
 */
export async function publishPost(
  _prev: ComposeState,
  formData: FormData,
): Promise<ComposeState> {
  const user = await getCurrentUser();

  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const file = formData.get("image");
  const image = file instanceof File && file.size > 0 ? file : null;

  // A post must carry something. An image on its own counts - a screenshot of
  // a superday invite is a real post - but an empty dialog is not.
  if (!title && !body && !image) return { error: "Add a title, some text, or an image." };

  if (title.length > POST_TITLE_MAX) {
    return { error: `Keep the title under ${POST_TITLE_MAX} characters.` };
  }
  if (body.length > POST_BODY_MAX) {
    return { error: `Keep it under ${POST_BODY_MAX} characters.` };
  }

  const blocked = blockedLanguageError([
    ["Title", title],
    ["Your post", body],
  ]);
  if (blocked) return { error: blocked };

  // Checked BEFORE the image is written, so a refused post never leaves bytes
  // behind. Counted against the signed-in account, resolved from the session.
  const perDay = await rateLimit("feed:post", user.id, POSTS_PER_DAY, POST_DAY_MS);
  if (!perDay.allowed) {
    return {
      error: `You've posted a lot today. Try again in about ${retryAfterText(perDay.retryAfterMs)}.`,
    };
  }
  if (image) {
    const images = await rateLimit(
      "feed:post-image",
      user.id,
      POST_IMAGES_PER_DAY,
      POST_DAY_MS,
    );
    if (!images.allowed) {
      return {
        error: `You've attached a lot of images today. Try again in about ${retryAfterText(images.retryAfterMs)}, or post without one.`,
      };
    }
  }

  // The image is written to disk BEFORE the row is inserted, because the row
  // has to carry its storage key. If the insert then fails, the file is
  // orphaned - so it is cleaned up rather than left behind. The reverse order
  // is worse: a row pointing at a file that was never written renders as a
  // broken image forever.
  let imagePath: string | null = null;
  if (image) {
    try {
      imagePath = (await savePostImage(image)).storageKey;
    } catch (err) {
      // savePostImage throws messages written to be read by a student
      // ("Image must be under 5MB."), so this is safe to surface directly.
      return { error: err instanceof Error ? err.message : "That image could not be read." };
    }
  }

  try {
    await createPost(user.id, body, { title, imagePath });
  } catch (err) {
    await deletePostImage(imagePath);
    return { error: err instanceof Error ? err.message : "Could not publish that." };
  }

  // Both surfaces that render this feed, not just the one being posted from -
  // /home shows the same list and would otherwise keep serving a cached copy
  // without the new row.
  revalidatePath("/networking");
  revalidatePath("/home");

  return { ok: true };
}
