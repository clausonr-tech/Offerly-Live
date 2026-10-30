/**
 * Comments past the first page are reachable.
 *
 * listComments took the oldest 200 and stopped, with no cursor: comment 201 on
 * a row was stored, counted in the tally under the post, and shown to nobody
 * ever. The per-row write cap (COMMENTS_PER_ROW_PER_DAY in feed-actions) bounds
 * how fast ONE account can fill that window and cannot bound a popular thread -
 * twenty-five students saying eight things each is already past it.
 *
 * Asserted here, through the real server action as a signed-in student against
 * a real database:
 *
 *   - the default call is what it always was: oldest first, nothing new in the
 *     arguments, and no caller has to change;
 *   - `after` walks forward through a row's comments, each page starting
 *     exactly where the last one ended, with nothing repeated and nothing
 *     skipped;
 *   - the page size is clamped, so a caller cannot ask for the whole table;
 *   - a malformed cursor is ignored rather than argued with, which hands back
 *     the first page;
 *   - the visibility rule still comes first: a row this viewer may not be shown
 *     has no pages at all (lib/activity visibleEvent).
 *
 * No network; PGlite with the real migrations.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { activityComments, users } from "@/db/schema";

const READER = "77777777-8888-4888-8888-777777777777";
const AUTHOR = "88888888-8888-4888-8888-888888888888";

async function withStudents(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values([
      {
        id: READER,
        email: "reader@example.edu",
        passwordHash: "x",
        name: "A Reader",
        school: "University of Southern California",
        gradYear: 2028,
      },
      {
        id: AUTHOR,
        email: "author@example.edu",
        passwordHash: "x",
        name: "The Author",
        school: "New York University",
        gradYear: 2027,
      },
    ]);
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

/**
 * Comments written straight to the table rather than through addComment: the
 * point here is the READ, and the write caps would refuse the twenty-sixth
 * comment from one account long before a second page exists. Timestamps are
 * spread a second apart and then deliberately collided on the last two, so the
 * cursor's id tiebreaker is exercised rather than assumed.
 */
async function seedComments(h: TestDatabase, eventId: string, n: number): Promise<string[]> {
  const base = new Date("2026-10-01T12:00:00.000Z").getTime();
  const rows = Array.from({ length: n }, (_, i) => ({
    eventId,
    userId: i % 2 === 0 ? READER : AUTHOR,
    body: `comment ${i + 1}`,
    // The last two share a created_at to the millisecond.
    createdAt: new Date(base + Math.min(i, n - 2) * 1000),
  }));
  const written = await h.db.insert(activityComments).values(rows).returning();
  // Returned in the order the action reads them - (created_at, id) - not the
  // order they were inserted in. For the two that share a timestamp that is the
  // id, and a uuid's text order is its byte order, which is what Postgres sorts
  // on. Expecting insertion order here would be asserting the test's own
  // bookkeeping rather than the query's.
  return [...written]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    .map((r) => r.body);
}

/** The cursor the action documents: the last row of the page, as
 *  `<created_at>|<id>`. Built from what a caller already holds. */
const cursorFor = (c: { createdAt: Date | string; id: string }) =>
  `${new Date(c.createdAt).toISOString()}|${c.id}`;

test("the default read is unchanged, and `after` walks past it", async () => {
  await withStudents(async (h) => {
    const { createPost } = await import("@/lib/activity");
    const { listComments } = await import("@/app/(app)/networking/feed-actions");
    const eventId = await createPost(AUTHOR, "Who else is interviewing this week?");
    const bodies = await seedComments(h, eventId, 205);

    // The call every existing caller makes, unchanged: oldest first, 200 of
    // them, in the order a conversation reads.
    const first = await asStudent(h.db, READER, () => listComments(eventId));
    assert.equal(first.length, 200, "the default page is the same 200 as before");
    assert.equal(first[0].body, bodies[0], "oldest first");
    assert.equal(first[199].body, bodies[199]);

    // Which is where the old behaviour ended. The rest of the row:
    const second = await asStudent(h.db, READER, () =>
      listComments(eventId, { after: cursorFor(first[199]) }),
    );
    assert.deepEqual(
      second.map((c) => c.body),
      bodies.slice(200),
      "every comment past the first page, and only those",
    );

    // Nothing repeated across the two pages, and nothing missed.
    const seen = [...first, ...second].map((c) => c.id);
    assert.equal(new Set(seen).size, 205, "205 distinct comments over two pages");

    // And the walk ends rather than looping on its own last row.
    const third = await asStudent(h.db, READER, () =>
      listComments(eventId, { after: cursorFor(second[second.length - 1]) }),
    );
    assert.deepEqual(third, [], "the end of the row is empty, not the start of it again");
  });
});

test("a small page can be asked for, a huge one cannot", async () => {
  await withStudents(async (h) => {
    const { createPost } = await import("@/lib/activity");
    const { listComments } = await import("@/app/(app)/networking/feed-actions");
    const eventId = await createPost(AUTHOR, "Superday tomorrow");
    const bodies = await seedComments(h, eventId, 210);

    const five = await asStudent(h.db, READER, () => listComments(eventId, { limit: 5 }));
    assert.deepEqual(
      five.map((c) => c.body),
      bodies.slice(0, 5),
      "a caller may read fewer",
    );

    // Walking the whole row five at a time reaches the end and stops there.
    let cursor: string | null = null;
    const walked: string[] = [];
    for (let page = 0; page < 60; page++) {
      const rows: Awaited<ReturnType<typeof listComments>> = await asStudent(h.db, READER, () =>
        listComments(eventId, { after: cursor, limit: 5 }),
      );
      if (!rows.length) break;
      walked.push(...rows.map((c) => c.body));
      cursor = cursorFor(rows[rows.length - 1]);
    }
    assert.deepEqual(walked, bodies, "every comment on the row, once, in order");

    // The ceiling holds whatever is asked for - the reason there is a limit at
    // all is the size of one response, and every row carries a name, a school
    // and a photo URL.
    for (const limit of [10_000, Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
      const rows = await asStudent(h.db, READER, () => listComments(eventId, { limit }));
      assert.ok(rows.length <= 200, `limit ${limit} returned ${rows.length}`);
      assert.ok(rows.length >= 1, `limit ${limit} returned nothing at all`);
    }
  });
});

test("a cursor that is not one is ignored, not obeyed", async () => {
  await withStudents(async (h) => {
    const { createPost } = await import("@/lib/activity");
    const { listComments } = await import("@/app/(app)/networking/feed-actions");
    const eventId = await createPost(AUTHOR, "Any Evercore news?");
    const bodies = await seedComments(h, eventId, 4);

    for (const after of [
      "",
      "not-a-cursor",
      "2026-10-01T12:00:00.000Z",
      "|",
      // The shapes worth refusing on purpose rather than by accident: the
      // timestamp half and the id half both reach SQL.
      "2026-10-01T12:00:00.000Z|not-a-uuid",
      "'; drop table activity_comments; --|77777777-8888-4888-8888-777777777777",
      "2026-10-01T12:00:00.000Z') or true --|77777777-8888-4888-8888-777777777777",
      // Passes the shape test and is not a real instant. These reached the
      // ::timestamp cast and threw out of the action rather than being ignored
      // the way every other malformed cursor is.
      "9999-99-99T1.1|77777777-8888-4888-8888-777777777777",
      "0000-00-00 00:00:00|77777777-8888-4888-8888-777777777777",
      "2026-13-45T99:99:99.999Z|77777777-8888-4888-8888-777777777777",
    ]) {
      const rows = await asStudent(h.db, READER, () => listComments(eventId, { after }));
      assert.deepEqual(
        rows.map((c) => c.body),
        bodies,
        `a bad cursor (${after || "empty"}) hands back the first page`,
      );
    }

    // And the table is still there, which is the other half of that.
    assert.equal((await h.db.select().from(activityComments)).length, 4);
  });
});

test("paging does not reach a row the viewer may not be shown", async () => {
  await withStudents(async (h) => {
    const { recordOffer } = await import("@/lib/activity");
    const { listComments } = await import("@/app/(app)/networking/feed-actions");
    // An offer row is shown to its author and to nobody else (visibleToViewer
    // in lib/activity): it is written as a side effect of a private tracker
    // edit, not published on purpose.
    await recordOffer(AUTHOR, "99999999-8888-4888-8888-999999999999", "Evercore", "Summer Analyst");
    const [offer] = await h.db.query.activityEvents.findMany({ limit: 1 });
    assert.ok(offer, "the offer row was written");
    const bodies = await seedComments(h, offer.id, 3);
    assert.equal(bodies.length, 3, "and it has comments under it");

    for (const page of [{}, { after: "2026-10-01T12:00:00.000Z|77777777-8888-4888-8888-777777777777" }, { limit: 1 }]) {
      assert.deepEqual(
        await asStudent(h.db, READER, () => listComments(offer.id, page)),
        [],
        "no page of a hidden row is readable",
      );
    }
    // Its own author still reads it, so the check is on visibility and not on
    // the paging arguments.
    const mine = await asStudent(h.db, AUTHOR, () => listComments(offer.id, { limit: 2 }));
    assert.equal(mine.length, 2);
  });
});
