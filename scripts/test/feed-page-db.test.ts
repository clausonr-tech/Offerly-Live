// The /networking live feed (lib/activity getFeedPage) against a REAL database
// (in-memory PGlite, migrated by replaying drizzle/*.sql).
//
// What it pins: posts that exist are shown; unseen rows come first, newest
// first, then seen rows, newest first; "seen" is frozen at the snapshot the
// visit opened with; keyset paging walks every row exactly once, across the
// unseen/seen boundary, with no gaps or repeats; the first page is one page,
// not the history; and a page costs a fixed number of queries, not one per row.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed and there is no
// network.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import "./helpers/no-network";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { activityComments, activityEvents, activityReactions, activitySeen, users } from "@/db/schema";
import { getFeedPage } from "@/lib/activity";

delete process.env.DATABASE_URL;

let h: TestDatabase;
let previousDb: unknown;
let queries = 0;

before(async () => {
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
  // Every statement the app sends goes through client.query.
  const query = h.client.query.bind(h.client);
  h.client.query = ((...args: Parameters<typeof query>) => {
    queries++;
    return query(...args);
  }) as typeof h.client.query;
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

let seq = 0;
const T0 = Date.UTC(2026, 0, 1);
const SNAPSHOT = new Date(T0 + 10_000 * 60_000);

async function reset() {
  await h.db.delete(activityEvents);
  await h.db.delete(users);
}

async function mkUsers(n: number) {
  return h.db
    .insert(users)
    .values(Array.from({ length: n }, (_, i) => ({ email: `feed-${++seq}-${i}@example.edu`, passwordHash: "x", name: `Student ${seq}-${i}` })))
    .returning({ id: users.id, name: users.name });
}

/** `n` posts, one minute apart, newest last; `sameInstant` puts pairs on one timestamp. */
async function mkEvents(authors: { id: string }[], n: number, { sameInstant = false } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    userId: authors[i % authors.length].id,
    kind: "post" as const,
    dedupeKey: `post-${++seq}`,
    body: `Post ${i}`,
    createdAt: new Date(T0 + (sameInstant ? Math.floor(i / 2) : i) * 60_000),
  }));
  const out: { id: string; createdAt: Date }[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    out.push(
      ...(await h.db
        .insert(activityEvents)
        .values(rows.slice(i, i + 500))
        .returning({ id: activityEvents.id, createdAt: activityEvents.createdAt })),
    );
  }
  return out;
}

async function markSeen(viewerId: string, eventIds: string[], seenAt: Date) {
  for (let i = 0; i < eventIds.length; i += 500) {
    await h.db
      .insert(activitySeen)
      .values(eventIds.slice(i, i + 500).map((eventId) => ({ userId: viewerId, eventId, seenAt })));
  }
}

/** The order the feed promises: unseen newest first, then seen newest first. */
function expectedOrder(events: { id: string; createdAt: Date }[], seen: Set<string>) {
  const byNewest = (a: { id: string; createdAt: Date }, b: { id: string; createdAt: Date }) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const visible = events.filter((e) => e.createdAt < SNAPSHOT);
  return [
    ...visible.filter((e) => !seen.has(e.id)).sort(byNewest),
    ...visible.filter((e) => seen.has(e.id)).sort(byNewest),
  ].map((e) => e.id);
}

/** Every page, in order, with the queries each one cost. */
async function walk(viewerId: string, limit?: number) {
  const pages: { ids: string[]; seen: boolean[]; queries: number }[] = [];
  let cursor: string | null = null;
  do {
    const before = queries;
    const page: Awaited<ReturnType<typeof getFeedPage>> = await getFeedPage(viewerId, { cursor, snapshot: SNAPSHOT, limit });
    pages.push({ ids: page.items.map((i) => i.id), seen: page.items.map((i) => i.seen), queries: queries - before });
    cursor = page.nextCursor;
    assert.ok(pages.length < 1000, "paging did not terminate");
  } while (cursor);
  return pages;
}

describe("getFeedPage", () => {
  test("an empty feed is one empty page with nothing after it", async () => {
    await reset();
    const [viewer] = await mkUsers(1);
    const page = await getFeedPage(viewer.id, { snapshot: SNAPSHOT });
    assert.deepEqual(page, { items: [], nextCursor: null });
  });

  test("existing posts are shown, with their author, reactions and comment counts", async () => {
    await reset();
    const [viewer, author] = await mkUsers(2);
    const events = await mkEvents([author], 3);
    await h.db.insert(activityReactions).values({ eventId: events[2].id, userId: viewer.id, emoji: "🔥" });
    await h.db.insert(activityComments).values({ eventId: events[2].id, userId: viewer.id, body: "Congrats" });

    const page = await getFeedPage(viewer.id, { snapshot: SNAPSHOT });
    assert.deepEqual(
      page.items.map((i) => i.id),
      [events[2].id, events[1].id, events[0].id],
    );
    assert.equal(page.nextCursor, null);
    const top = page.items[0];
    assert.equal(top.name, author.name);
    assert.equal(top.body, "Post 2");
    assert.deepEqual(top.reactions, [{ emoji: "🔥", count: 1, mine: true }]);
    assert.equal(top.commentCount, 1);
  });

  test("unseen rows come first, then seen ones, each newest first, split at the snapshot", async () => {
    await reset();
    const [viewer, author] = await mkUsers(2);
    const events = await mkEvents([author], 40, { sameInstant: true });
    // Seen before the visit opened: counts as seen. Seen during it: still new.
    const seenBefore = events.filter((_, i) => i % 3 === 0).map((e) => e.id);
    const seenDuring = events.filter((_, i) => i % 3 === 1).slice(0, 4).map((e) => e.id);
    await markSeen(viewer.id, seenBefore, new Date(SNAPSHOT.getTime() - 1000));
    await markSeen(viewer.id, seenDuring, new Date(SNAPSHOT.getTime() + 1000));
    // Posted after the visit opened: not in this visit's feed at all.
    await h.db.insert(activityEvents).values({
      userId: author.id,
      kind: "post",
      dedupeKey: `late-${++seq}`,
      body: "late",
      createdAt: new Date(SNAPSHOT.getTime() + 5000),
    });

    const pages = await walk(viewer.id);
    const shown = pages.flatMap((p) => p.ids);
    const seen = new Set(seenBefore);
    assert.deepEqual(shown, expectedOrder(events, seen));
    assert.deepEqual(
      pages.flatMap((p) => p.seen),
      shown.map((id) => seen.has(id)),
    );
  });

  test("a page that ends exactly where the unseen rows run out still leads on to the seen ones", async () => {
    await reset();
    const [viewer, author] = await mkUsers(2);
    const events = await mkEvents([author], 25);
    const seen = events.slice(0, 10).map((e) => e.id);
    await markSeen(viewer.id, seen, new Date(SNAPSHOT.getTime() - 1000));

    const pages = await walk(viewer.id);
    assert.deepEqual(
      pages.map((p) => p.ids.length),
      [15, 10],
    );
    assert.ok(pages[0].seen.every((s) => !s));
    assert.ok(pages[1].seen.every((s) => s));
    assert.deepEqual(pages.flatMap((p) => p.ids), expectedOrder(events, new Set(seen)));
  });

  test("a large feed loads one page at a time, walks every row once, and costs the same per page", async () => {
    await reset();
    const [viewer, ...authors] = await mkUsers(31);
    const events = await mkEvents(authors, 1000);
    const seen = events.filter((_, i) => i % 4 === 0 || i > 900).map((e) => e.id);
    await markSeen(viewer.id, seen, new Date(SNAPSHOT.getTime() - 1000));

    const first = await getFeedPage(viewer.id, { snapshot: SNAPSHOT });
    assert.equal(first.items.length, 15);
    assert.ok(first.nextCursor);

    const pages = await walk(viewer.id);
    const shown = pages.flatMap((p) => p.ids);
    assert.equal(new Set(shown).size, 1000, "a row was repeated or skipped");
    assert.deepEqual(shown, expectedOrder(events, new Set(seen)));

    // A fixed handful of batched queries per page - never one per row. The
    // page that crosses from unseen to seen may cost one more.
    const costs = pages.map((p) => p.queries);
    assert.ok(Math.max(...costs) <= 7, `a page cost ${Math.max(...costs)} queries: ${costs.join(",")}`);
    assert.ok(Math.max(...costs) - Math.min(...costs) <= 1, `page cost varied: ${costs.join(",")}`);
  });
});
