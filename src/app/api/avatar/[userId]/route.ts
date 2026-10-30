import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { readAvatarFile } from "@/lib/avatar-storage";

/**
 * Serves a student's uploaded photo.
 *
 * Behind the session, like every other page: these appear next to names in the
 * feed and on public profiles WITHIN the app, which is not the same as being
 * on the open internet. An unauthenticated route here would turn a photo
 * someone uploaded for their classmates into one anybody could enumerate by
 * user id.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ userId: string }> }) {
  await getCurrentUser(); // redirects when signed out

  const { userId } = await ctx.params;
  const db = await getDb();
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { avatarStoragePath: true },
  });
  if (!row?.avatarStoragePath) return new Response("Not found", { status: 404 });

  const bytes = await readAvatarFile(row.avatarStoragePath);
  if (!bytes) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/jpeg",
      // Private, because the response is per-viewer authenticated. immutable is
      // safe despite that: the storage key changes on every upload, so a new
      // photo is a new URL rather than a stale cache entry.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
