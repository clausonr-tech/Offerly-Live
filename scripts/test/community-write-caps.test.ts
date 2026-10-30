/**
 * The community write surfaces are bounded per account, and a follow target
 * has to be one of the three real kinds.
 *
 * What these cover, all through the real server actions as a signed-in
 * student, against a real database:
 *
 *   - feed comments. listComments takes the OLDEST 200 with no paging, so one
 *     account taking all 200 means nobody else's comment is ever shown again
 *     on that row.
 *   - discussion replies. Every reply sets lastActivityAt = now() and the
 *     board sorts on it, so replies were a free way to keep a thread pinned at
 *     the top; getDiscussion also reads every reply a thread has.
 *   - feed posts and their images. An image is up to 4MB of bytea in the
 *     shared database and nothing deleted it.
 *   - toggleFollow's `kind`. The TypeScript union is compile-time only: an
 *     unknown kind reached the insert with all three target columns NULL,
 *     which the partial unique indexes do not dedupe and unfollowTarget
 *     cannot find again to delete. One loop, unbounded permanent rows.
 *
 * No network; PGlite with the real migrations, so rate_events and the follows
 * indexes are the real ones.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { activityComments, discussionReplies, discussions, follows, users } from "@/db/schema";
import { eq } from "drizzle-orm";

const STUDENT = "44444444-5555-4555-8555-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";

async function withStudent(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values([
      {
        id: STUDENT,
        email: "writer@example.edu",
        passwordHash: "x",
        name: "A Busy Student",
        school: "University of Southern California",
        gradYear: 2028,
      },
      {
        id: OTHER,
        email: "reader@example.edu",
        passwordHash: "x",
        name: "Someone Else",
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

/** Fill a rate-limit bucket to the brim without going through the feature, so
 *  the boundary can be asserted without writing hundreds of rows. */
async function fillBucket(bucket: string, subject: string, times: number): Promise<void> {
  const { rateLimit } = await import("@/lib/rate-limit");
  for (let i = 0; i < times; i++) await rateLimit(bucket, subject, times, 24 * 60 * 60_000);
}

test("a comment is counted per account and per row, and the row cap refuses the next one", async () => {
  await withStudent(async (h) => {
    const { createPost } = await import("@/lib/activity");
    const { addComment, listComments } = await import("@/app/(app)/networking/feed-actions");
    const eventId = await createPost(OTHER, "Anyone else heard back from Evercore?");

    const first = await asStudent(h.db, STUDENT, () => addComment(eventId, "Not yet - good luck!"));
    assert.ok(!("error" in first), "a normal comment still posts");

    // Both windows recorded, each keyed on the server-resolved account.
    const { rateEvents } = await import("@/db/schema");
    const perRow = await h.db
      .select()
      .from(rateEvents)
      .where(eq(rateEvents.bucket, "feed:comment:row"));
    assert.equal(perRow.length, 1);
    assert.ok(perRow[0].subject.startsWith(STUDENT), "keyed by the commenter");
    assert.ok(perRow[0].subject.includes(eventId), "and the row they are commenting on");

    await fillBucket("feed:comment:row", `${STUDENT}:${eventId}`, 25);
    const refused = await asStudent(h.db, STUDENT, () => addComment(eventId, "and another thing"));
    assert.ok("error" in refused && /a lot on this post today/i.test(refused.error));

    const stored = await h.db
      .select()
      .from(activityComments)
      .where(eq(activityComments.eventId, eventId));
    assert.equal(stored.length, 1, "the refused comment was not written");
    // And the feature is untouched for everyone else.
    const asOther = await asStudent(h.db, OTHER, () => addComment(eventId, "I got mine today"));
    assert.ok(!("error" in asOther), "another student is not caught by someone else's cap");
    const shown = await asStudent(h.db, OTHER, () => listComments(eventId));
    assert.equal(shown.length, 2);
  });
});

test("the hourly comment cap bounds one account across every row", async () => {
  await withStudent(async (h) => {
    const { createPost } = await import("@/lib/activity");
    const { addComment } = await import("@/app/(app)/networking/feed-actions");
    const a = await createPost(OTHER, "First post");
    const b = await createPost(OTHER, "Second post");

    await fillBucket("feed:comment", STUDENT, 120);
    for (const id of [a, b]) {
      const refused = await asStudent(h.db, STUDENT, () => addComment(id, "hello"));
      assert.ok("error" in refused && /commented a lot just now/i.test(refused.error));
    }
  });
});

test("replies cannot keep one thread pinned to the top of the board", async () => {
  await withStudent(async (h) => {
    const { createDiscussion } = await import("@/lib/discussions");
    const { postReply } = await import("@/app/(app)/networking/discussions/actions");
    const discussionId = await createDiscussion({
      authorId: OTHER,
      anonymous: false,
      title: "Superday prep",
      body: "What did people get asked?",
      topic: "Interviews",
      firmName: null,
    });

    const reply = (body: string) => {
      const fd = new FormData();
      fd.set("discussionId", discussionId);
      fd.set("body", body);
      return asStudent(h.db, STUDENT, () => postReply(undefined, fd));
    };

    assert.deepEqual(await reply("Mostly technicals."), { ok: true });

    await fillBucket("discussion:reply:thread", `${STUDENT}:${discussionId}`, 30);
    const refused = await reply("bump");
    assert.match(refused?.error ?? "", /a lot in this thread today/i);

    const stored = await h.db
      .select()
      .from(discussionReplies)
      .where(eq(discussionReplies.discussionId, discussionId));
    assert.equal(stored.length, 1, "the bump was not written");
    // The bump works by moving lastActivityAt, so that must not have moved either.
    const [thread] = await h.db.select().from(discussions).where(eq(discussions.id, discussionId));
    assert.equal(thread.replyCount, 1, "and the thread's own counters stand still");
  });
});

test("starting discussions is bounded per day", async () => {
  await withStudent(async (h) => {
    const { startDiscussion } = await import("@/app/(app)/networking/discussions/actions");
    await fillBucket("discussion:new", STUDENT, 25);
    const fd = new FormData();
    fd.set("title", "One more thread");
    fd.set("body", "Something to discuss.");
    fd.set("topic", "Interviews");
    const refused = await asStudent(h.db, STUDENT, () => startDiscussion(undefined, fd));
    assert.match(refused?.error ?? "", /a lot of discussions today/i);
    assert.equal((await h.db.select().from(discussions)).length, 0, "and nothing was written");
  });
});

test("posting to the feed is bounded per day, and images on top of that", async () => {
  await withStudent(async (h) => {
    const { publishPost } = await import("@/app/(app)/networking/compose-actions");
    const { activityEvents } = await import("@/db/schema");

    const withText = () => {
      const fd = new FormData();
      fd.set("body", "Interviewing at Evercore next week.");
      return asStudent(h.db, STUDENT, () => publishPost({}, fd));
    };
    assert.deepEqual(await withText(), { ok: true }, "a normal post still publishes");

    // The image allowance is the tighter of the two: a PNG costs up to 4MB of
    // bytea each time, so it is bounded separately from plain text.
    await fillBucket("feed:post-image", STUDENT, 12);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]);
    const withImage = new FormData();
    withImage.set("body", "A screenshot");
    withImage.set("image", new File([png], "shot.png", { type: "image/png" }));
    const refusedImage = await asStudent(h.db, STUDENT, () => publishPost({}, withImage));
    assert.match(refusedImage.error ?? "", /a lot of images today/i);
    assert.match(refusedImage.error ?? "", /post without one/i, "and says what still works");

    // Text-only still goes through until its own, larger allowance runs out.
    assert.deepEqual(await withText(), { ok: true });
    await fillBucket("feed:post", STUDENT, 40);
    const refused = await withText();
    assert.match(refused.error ?? "", /posted a lot today/i);

    assert.equal(
      (await h.db.select().from(activityEvents).where(eq(activityEvents.userId, STUDENT))).length,
      2,
      "only the two allowed posts were written",
    );
  });
});

test("an unknown follow kind writes nothing at all", async () => {
  await withStudent(async (h) => {
    const { toggleFollow } = await import("@/app/(app)/networking/actions");
    const { isFollowTarget } = await import("@/lib/follows");

    for (let i = 0; i < 3; i++) {
      await asStudent(h.db, STUDENT, () =>
        // Exactly what a hand-made request can post: the typed union is a
        // compile-time promise about our own callers, not about the wire.
        toggleFollow({
          kind: "bogus" as unknown as "user",
          id: "66666666-7777-4777-8777-666666666666",
          following: false,
        }),
      );
    }
    assert.equal(
      (await h.db.select().from(follows)).length,
      0,
      "no target-less row, however many times it is called",
    );

    assert.ok(!isFollowTarget({ kind: "bogus", id: "66666666-7777-4777-8777-666666666666" }));
    assert.ok(!isFollowTarget({ kind: "user", id: "not-a-uuid" }));
    assert.ok(isFollowTarget({ kind: "user", id: "66666666-7777-4777-8777-666666666666" }));
  });
});

test("following a real person still works, exactly once", async () => {
  await withStudent(async (h) => {
    const { toggleFollow } = await import("@/app/(app)/networking/actions");
    const follow = () =>
      asStudent(h.db, STUDENT, () => toggleFollow({ kind: "user", id: OTHER, following: false }));

    await follow();
    await follow();
    const rows = await h.db.select().from(follows).where(eq(follows.followerId, STUDENT));
    assert.equal(rows.length, 1, "deduped, as it always was");
    assert.equal(rows[0].followingUserId, OTHER);
    assert.equal(rows[0].clubId, null);
    assert.equal(rows[0].firmId, null);

    // And unfollowing still finds it again.
    await asStudent(h.db, STUDENT, () => toggleFollow({ kind: "user", id: OTHER, following: true }));
    assert.equal((await h.db.select().from(follows)).length, 0);
  });
});
