import { getSessionUser } from "@/lib/auth";
import { markFeedSeen } from "@/lib/activity";

/**
 * Records feed rows as seen (lib/activity markFeedSeen).
 *
 * A route rather than a server action on purpose. Next runs a page's server
 * actions one at a time, and these are sent every few seconds while a student
 * scrolls - as an action, each one held up the next page of the feed, a
 * reaction or a comment behind it. A plain request runs alongside them, and
 * `keepalive` lets the last batch finish after the tab is closed.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response(null, { status: 401 });
  let ids: unknown;
  try {
    ids = ((await req.json()) as { ids?: unknown }).ids;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!Array.isArray(ids)) return new Response(null, { status: 400 });
  await markFeedSeen(user.id, ids.filter((id): id is string => typeof id === "string"));
  return new Response(null, { status: 204 });
}
