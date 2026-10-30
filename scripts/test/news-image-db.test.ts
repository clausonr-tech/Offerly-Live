/**
 * The photo route serves only the bytes the photo check passed. PGlite migrated
 * by replaying drizzle/*.sql; the publisher is a fake fetch. No network.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { newsClusters, newsItems, newsSources } from "@/db/schema";
import { checkedImage, imagePath, sha256 } from "@/lib/news/image-proxy";
import { readTab } from "@/lib/news/read";

let h: TestDatabase;
const realFetch = globalThis.fetch;
// A public address, so the safe fetch lets it through without a DNS lookup.
const PHOTO_URL = "http://93.184.216.34/photo.jpg";
let served = Buffer.from("the photo that was checked");

before(async () => {
  h = await createTestDb();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) !== PHOTO_URL) throw new Error(`unexpected fetch ${String(input)}`);
    return new Response(new Uint8Array(served), { headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  await h.db.insert(newsSources).values({ id: "wire", name: "Wire", domain: "wire.example", tier: "major", sectors: [], kind: "rss", url: "https://wire.example/feed" });
});
after(async () => {
  globalThis.fetch = realFetch;
  await h.close();
});

async function mkStory(over: Partial<typeof newsItems.$inferInsert> = {}) {
  const key = String(Math.random());
  const [item] = await h.db
    .insert(newsItems)
    .values({ sourceId: "wire", urlHash: key, url: `https://wire.example/${key}`, title: "Deal", publisher: "Wire", publisherDomain: "wire.example", publishedAt: new Date(), titleKey: key, origin: "rss", status: "labeled", imageUrl: PHOTO_URL, ...over })
    .returning();
  const [cluster] = await h.db.insert(newsClusters).values({ leadItemId: item.id, sectors: [], firstSeenAt: new Date(), lastSeenAt: new Date(), scores: { main: 1 } }).returning();
  await h.db.update(newsItems).set({ clusterId: cluster.id }).where(eq(newsItems.id, item.id));
  return item.id;
}

test("the route serves a checked photo only while the host still sends the checked bytes", async () => {
  const checked = Buffer.from("the photo that was checked");
  served = checked;
  const id = await mkStory({ imageHash: sha256(checked) });
  assert.deepEqual((await checkedImage(h.db, id))?.bytes, served);

  served = Buffer.from("something else, sent to browsers only");
  // A second story, because bytes that passed the check are held in memory for
  // a few minutes (image-proxy.ts) - asking again for the SAME story is
  // answered from that copy rather than by downloading from the host again.
  const other = await mkStory({ imageHash: sha256(checked) });
  assert.equal(await checkedImage(h.db, other), null, "different bytes: no photo, the card shows its tile");
  assert.deepEqual((await checkedImage(h.db, id))?.bytes, checked, "and the story already served keeps the bytes that passed");
});

test("a photo with no check on record, or on a hidden story, is never served", async () => {
  served = Buffer.from("the photo that was checked");
  assert.equal(await checkedImage(h.db, await mkStory({ imageHash: null })), null);
  assert.equal(await checkedImage(h.db, await mkStory({ imageHash: sha256(served), hiddenAt: new Date() })), null);
});

test("cards point at the image route, never at the publisher's photo address", async () => {
  const checked = await mkStory({ imageHash: sha256(Buffer.from("x")) });
  await mkStory({ imageHash: null });
  const cards = await readTab(h.db, null, 30);
  assert.ok(cards.every((c) => c.imageUrl === null || c.imageUrl.startsWith("/api/news-image/")));
  assert.ok(cards.some((c) => c.imageUrl === imagePath(checked)));
  assert.ok(!cards.some((c) => c.imageUrl === PHOTO_URL));
});
