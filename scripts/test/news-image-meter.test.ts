/**
 * What bounds the publisher downloads behind /api/news-image/[id].
 *
 * The route used to fetch the photo from the publisher once per request, with
 * nothing kept and nothing counted, so a signed-in account could ask for the
 * same few story ids in a loop and have the server download each photo again
 * every time. Three things bound it now: the checked bytes are kept for a few
 * minutes, requests arriving during a fetch share it, and a download that has
 * to happen is counted against the account by the shared limiter.
 *
 * A REAL database (PGlite migrated by replaying drizzle/*.sql, so rate_events
 * and its index are the real ones) and a counting fake publisher. No network.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { newsClusters, newsItems, newsSources, rateEvents, users } from "@/db/schema";
import { IMAGE_FETCH_LIMIT, IMAGE_FETCH_WINDOW_MS, METERED, checkedImage, sha256 } from "@/lib/news/image-proxy";
import { rateLimit } from "@/lib/rate-limit";

let h: TestDatabase;
let restore: () => void;
const realFetch = globalThis.fetch;
// A public address, so the safe fetch lets it through without a DNS lookup.
const PHOTO_URL = "http://93.184.216.34/photo.jpg";
const PHOTO = Buffer.from("the photo that was checked");
let fetches = 0;
/** Set to hold every fake download until the test lets it finish. */
let held: Promise<void> | null = null;

before(async () => {
  h = await createTestDb();
  restore = installAsAppDb(h.db);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) !== PHOTO_URL) throw new Error(`unexpected fetch ${String(input)}`);
    fetches += 1;
    if (held) await held;
    return new Response(new Uint8Array(PHOTO), { headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  await h.db.insert(newsSources).values({ id: "wire", name: "Wire", domain: "wire.example", tier: "major", sectors: [], kind: "rss", url: "https://wire.example/feed" });
});
after(async () => {
  globalThis.fetch = realFetch;
  restore();
  await h.close();
});

async function mkStory(): Promise<string> {
  const key = String(Math.random());
  const [item] = await h.db
    .insert(newsItems)
    .values({ sourceId: "wire", urlHash: key, url: `https://wire.example/${key}`, title: "Deal", publisher: "Wire", publishedAt: new Date(), titleKey: key, origin: "rss", status: "labeled", imageUrl: PHOTO_URL, imageHash: sha256(PHOTO) })
    .returning();
  const [cluster] = await h.db.insert(newsClusters).values({ leadItemId: item.id, sectors: [], firstSeenAt: new Date(), lastSeenAt: new Date(), scores: { main: 1 } }).returning();
  await h.db.update(newsItems).set({ clusterId: cluster.id }).where(eq(newsItems.id, item.id));
  return item.id;
}

async function mkUser(): Promise<string> {
  const [u] = await h.db
    .insert(users)
    .values({ email: `img-${Math.random()}@example.com`, passwordHash: "x", name: "Student" })
    .returning({ id: users.id });
  return u.id;
}

/** The meter the route installs, with a count of how often it was consulted. */
function meterFor(userId: string) {
  const calls = { n: 0 };
  const meter = async () => {
    calls.n += 1;
    const gate = await rateLimit("news:image", userId, IMAGE_FETCH_LIMIT, IMAGE_FETCH_WINDOW_MS);
    return gate.allowed;
  };
  return { meter, calls };
}

test("asking for the same photo again costs no download and is not counted", async () => {
  const id = await mkStory();
  const userId = await mkUser();
  const { meter, calls } = meterFor(userId);
  fetches = 0;

  const first = await checkedImage(h.db, id, meter);
  assert.notEqual(first, METERED);
  assert.deepEqual(first === METERED ? null : first?.bytes, PHOTO);
  for (let i = 0; i < 25; i++) {
    const again = await checkedImage(h.db, id, meter);
    assert.deepEqual(again === METERED ? null : again?.bytes, PHOTO, "the photo is still served");
  }
  assert.equal(fetches, 1, "26 requests, one download");
  assert.equal(calls.n, 1, "and only the download was counted");
  const counted = await h.db.select().from(rateEvents).where(eq(rateEvents.subject, userId));
  assert.equal(counted.length, 1);
});

test("a story taken down after its photo was served stops being served at once", async () => {
  const id = await mkStory();
  const { meter } = meterFor(await mkUser());
  assert.notEqual(await checkedImage(h.db, id, meter), null, "served, and now held in memory");
  await h.db.update(newsItems).set({ hiddenAt: new Date(), hiddenReason: "admin" }).where(eq(newsItems.id, id));
  assert.equal(await checkedImage(h.db, id, meter), null, "the row is read every time, so the takedown lands");
});

test("requests arriving while a photo is being fetched share that one fetch", async () => {
  const id = await mkStory();
  const { meter, calls } = meterFor(await mkUser());
  fetches = 0;
  let release: () => void = () => {};
  held = new Promise<void>((go) => (release = go));
  const waiting = [checkedImage(h.db, id, meter), checkedImage(h.db, id, meter), checkedImage(h.db, id, meter)];
  // Let all three requests reach checkedImage, then let the download finish.
  await new Promise((go) => setTimeout(go, 50));
  release();
  const got = await Promise.all(waiting);
  held = null;
  for (const one of got) assert.deepEqual(one === METERED ? null : one?.bytes, PHOTO);
  assert.equal(fetches, 1, "three parallel requests, one download");
  assert.equal(calls.n, 1, "and one count");
});

test("an account past its download limit gets no photo rather than another download", async () => {
  const id = await mkStory();
  const userId = await mkUser();
  const { meter } = meterFor(userId);
  // The account's window is already full. Written straight into the limiter's
  // own table rather than by making IMAGE_FETCH_LIMIT real requests.
  await h.db.insert(rateEvents).values(
    Array.from({ length: IMAGE_FETCH_LIMIT }, () => ({ bucket: "news:image", subject: userId, createdAt: new Date() })),
  );
  fetches = 0;
  assert.equal(await checkedImage(h.db, id, meter), METERED, "refused, and the card falls back to its tile");
  assert.equal(fetches, 0, "no publisher download happened");

  // Another account is unaffected, and the same story still works for it.
  const other = meterFor(await mkUser());
  const got = await checkedImage(h.db, id, other.meter);
  assert.deepEqual(got === METERED ? null : got?.bytes, PHOTO);
});

test("the limit is set well above a day's reading", () => {
  assert.ok(IMAGE_FETCH_LIMIT >= 100, "the News page and its tabs are a few hundred distinct photos");
  assert.ok(IMAGE_FETCH_WINDOW_MS <= 60 * 60_000, "and a refused account is not shut out for long");
});
