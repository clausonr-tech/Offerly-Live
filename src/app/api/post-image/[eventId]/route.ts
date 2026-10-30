import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { storedFiles } from "@/db/schema";
import { visibleEvent } from "@/lib/activity";
import { getCurrentUser } from "@/lib/current-user";
import { contentTypeFor } from "@/lib/post-image-storage";

/**
 * Serves the image attached to one feed post.
 *
 * Behind the session, like /api/avatar and like every page that renders the
 * feed. The feed is visible to signed-in students, which is not the same as
 * being on the open internet - an unauthenticated route here would turn an
 * attachment meant for classmates into something anyone could enumerate.
 *
 * Addressed by EVENT id rather than by storage key, so the key never appears
 * in a URL and the lookup goes through a row that exists. A key in the path
 * would be a second, parallel way to reach the file, valid even after the post
 * it belonged to was deleted.
 *
 * And the row is found through visibleEvent, the one lookup every engagement
 * path uses, rather than by id alone. This route used to join the event to its
 * stored file in a single query with no visibility predicate - which was the
 * last reachable read of an activity_events row that did not ask whether the
 * viewer may be shown it. Two reads instead of one joined read, in exchange
 * for the rule being stated in one place: the session is already resolved per
 * request, and the first read is an indexed primary-key hit.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return new Response("Not found", { status: 404 });

  const user = await getCurrentUser(); // redirects when signed out
  const event = await visibleEvent(user.id, eventId);
  const type = event?.imagePath ? contentTypeFor(event.imagePath) : null;
  if (!event?.imagePath || !type) return new Response("Not found", { status: 404 });

  const db = await getDb();
  const [file] = await db
    .select({ bytes: storedFiles.bytes })
    .from(storedFiles)
    .where(and(eq(storedFiles.kind, "post-image"), eq(storedFiles.key, event.imagePath)))
    .limit(1);
  if (!file) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": type,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
