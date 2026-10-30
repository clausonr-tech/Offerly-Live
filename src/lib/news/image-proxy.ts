import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { newsItems } from "@/db/schema";
import { NEWS_USER_AGENT } from "./fetch";
import { readCapped, safeFetch } from "./safe-fetch";

type Db = Awaited<ReturnType<typeof getDb>>;

// Serving a story's photo to a student, through Offerly rather than straight
// from the publisher (security review, 30 September 2026).
//
// The photo step checks a photo's bytes once - its size, its metadata, and the
// vision check - and records their sha256. If the student's browser then loaded
// the publisher's URL itself, the host could send it something else: a clean
// photo to our checker, anything to browsers. So the photo comes through here,
// is fetched with the same request the checker made, and is served only if the
// bytes are the ones that were checked. Otherwise the card shows its tile.
//
// Publishers never see a student's address.
//
// WHAT BOUNDS THE PUBLISHER FETCHES (security review, 10 October 2026)
//
// This used to fetch the publisher once per request, with nothing kept and
// nothing counted: the "private, max-age=86400" header is a hint a browser
// honours and a script ignores, so a signed-in account could ask for the same
// few story ids in a loop and have the server download each photo again every
// time - our function time, our bandwidth, and a burst of our requests
// arriving at the publisher, who may then block us and leave every card a
// tile. Three things bound it now, and none of them changes what a student
// sees:
//
//   - the checked bytes are kept in memory for a few minutes, so the same
//     photo asked for twice is downloaded once. The database row is still read
//     every time, so a story taken down in between stops being served at once;
//   - requests that arrive for one story while its fetch is in flight share
//     that fetch rather than starting their own;
//   - a fetch that has to happen is counted against the account asking, by the
//     shared rate limiter. Only real downloads are counted, so ordinary
//     reading is never refused: the whole News page is a few dozen photos and
//     a repeat within the window costs nothing.

const IMAGE_ROUTE = "/api/news-image";
const MAX_BYTES = 4_000_000;

/**
 * Publisher downloads one account may cause. Far above a day's reading - the
 * News page and every sector tab together are a few hundred distinct photos,
 * and each is downloaded once per window however often it is asked for.
 */
export const IMAGE_FETCH_LIMIT = 200;
export const IMAGE_FETCH_WINDOW_MS = 10 * 60_000;

const CACHE_TTL_MS = 5 * 60_000;
/** Enough for a page of cards; one photo is at most MAX_BYTES of it. */
const CACHE_MAX_BYTES = 16_000_000;

type Photo = { bytes: Buffer; type: string };

// Insertion-ordered, so the oldest entry is the first one a Map iterates.
const cache = new Map<string, { photo: Photo; hash: string; at: number }>();
const inFlight = new Map<string, Promise<Photo | null | "metered">>();

function cached(itemId: string, hash: string, now: number): Photo | null {
  const hit = cache.get(itemId);
  if (!hit) return null;
  // A re-checked photo gets a new hash; the old bytes are then not the photo.
  if (hit.hash !== hash || now - hit.at > CACHE_TTL_MS) {
    cache.delete(itemId);
    return null;
  }
  return hit.photo;
}

function keep(itemId: string, hash: string, photo: Photo, now: number): void {
  cache.delete(itemId);
  cache.set(itemId, { photo, hash, at: now });
  let held = 0;
  for (const entry of cache.values()) held += entry.photo.bytes.length;
  for (const [key, entry] of cache) {
    if (held <= CACHE_MAX_BYTES) break;
    held -= entry.photo.bytes.length;
    cache.delete(key);
  }
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function imagePath(itemId: string): string {
  return `${IMAGE_ROUTE}/${itemId}`;
}

/** The request the photo check and this proxy both make, so a host sees one identical request. */
async function fetchImageBytes(url: string, timeoutMs = 12_000): Promise<{ bytes: Buffer; type: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { res } = await safeFetch(url, { signal: controller.signal, headers: { "User-Agent": NEWS_USER_AGENT, Accept: "image/*" } });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/") || type.includes("svg")) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await readCapped(res, MAX_BYTES, "reject");
    return bytes ? { bytes, type: type.split(";")[0].trim() } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A request that would cost a publisher download was refused by its account's meter. */
export const METERED = "metered" as const;

/**
 * The checked photo for a story: null when there is none or the host now sends
 * different bytes, METERED when the bytes are not in hand and `meter` says the
 * account asking has caused too many downloads. `meter` is consulted only when
 * a download is actually needed.
 */
export async function checkedImage(db: Db, itemId: string): Promise<Photo | null>;
export async function checkedImage(db: Db, itemId: string, meter: () => Promise<boolean>): Promise<Photo | null | typeof METERED>;
export async function checkedImage(
  db: Db,
  itemId: string,
  meter?: () => Promise<boolean>,
): Promise<Photo | null | typeof METERED> {
  const [item] = await db
    .select({ url: newsItems.imageUrl, hash: newsItems.imageHash })
    .from(newsItems)
    .where(and(eq(newsItems.id, itemId), isNull(newsItems.hiddenAt), isNotNull(newsItems.imageHash)));
  if (!item?.url || !item.hash) return null;

  const now = Date.now();
  const hit = cached(itemId, item.hash, now);
  if (hit) return hit;

  // A request for a photo already being fetched waits for that fetch rather
  // than starting a second one. If the account that started it was over its
  // meter, this request goes on to try its own - one account at its limit must
  // not refuse another student's photo.
  const sharing = inFlight.get(itemId);
  if (sharing) {
    const shared = await sharing;
    if (shared !== METERED) return shared;
  }

  const { url, hash } = item;
  const fetching = (async () => {
    if (meter && !(await meter())) return METERED;
    const got = await fetchImageBytes(url);
    if (!got || sha256(got.bytes) !== hash) return null;
    keep(itemId, hash, got, Date.now());
    return got;
  })();
  inFlight.set(itemId, fetching);
  // Identity-checked, so a later fetch for the same story is not cleared here.
  void fetching.finally(() => {
    if (inFlight.get(itemId) === fetching) inFlight.delete(itemId);
  }).catch(() => {});
  return await fetching;
}
