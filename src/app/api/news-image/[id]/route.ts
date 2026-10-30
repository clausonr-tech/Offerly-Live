import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getSessionUser } from "@/lib/auth";
import { isUuid } from "@/lib/firm-links";
import { IMAGE_FETCH_LIMIT, IMAGE_FETCH_WINDOW_MS, METERED, checkedImage } from "@/lib/news/image-proxy";
import { rateLimit } from "@/lib/rate-limit";

/**
 * A story's photo, served only if it is byte for byte the photo the pipeline
 * checked (src/lib/news/image-proxy.ts). Signed-in students only, so this is
 * not an open proxy. A miss is a 404, and the card falls back to its tile.
 *
 * A request that would make us download the photo from the publisher again is
 * counted against the signed-in account, by the shared limiter rather than
 * anything of this route's own. Served from memory or shared with a download
 * already in flight, it costs nothing and is not counted - so reading the News
 * page, however many times, is never refused. See image-proxy.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse(null, { status: 401 });
  if (!isUuid(id)) return new NextResponse(null, { status: 404 });
  let retryAfterMs = IMAGE_FETCH_WINDOW_MS;
  const image = await checkedImage(await getDb(), id, async () => {
    const gate = await rateLimit("news:image", user.id, IMAGE_FETCH_LIMIT, IMAGE_FETCH_WINDOW_MS);
    retryAfterMs = gate.retryAfterMs;
    return gate.allowed;
  });
  if (image === METERED) {
    return new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)), "Cache-Control": "private, no-store" },
    });
  }
  if (!image) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, max-age=300" } });
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.type,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
