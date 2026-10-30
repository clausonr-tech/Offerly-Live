/**
 * A feed row is resolved by id in exactly one place, and that place applies the
 * visibility rule.
 *
 * `visibleEvent` in lib/activity exists because permission to READ a row and
 * permission to ACT on it are the same permission: every other path used to
 * look a row up by id alone, so a student who came by an offer row's id could
 * react to it, comment under it, read the conversation underneath and mark it
 * seen - writing into, and reading around, a row they are forbidden to be
 * shown. people-privacy.test.ts covers the feed reads themselves; this covers
 * the engagement paths, and pins the rule for the ones added next.
 *
 * Two halves:
 *
 *   - behaviour, through the real server actions as a signed-in student: an
 *     offer row's id gets the same nothing as a row that does not exist;
 *   - the source, so a path added later cannot quietly reintroduce a by-id
 *     lookup. Every file that queries activity_events is listed here with what
 *     it does, and a new one fails this test until it is either routed through
 *     visibleEvent or written down.
 *
 * No network; PGlite with the real migrations.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { activityReactions, activitySeen, activityComments, users } from "@/db/schema";

const STUDENT = "12121212-3434-4434-8434-121212121212";
const AUTHOR = "34343434-3434-4434-8434-343434343434";
const APPLICATION = "56565656-3434-4434-8434-565656565656";

async function withPeople(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values([
      {
        id: STUDENT,
        email: "curious@example.edu",
        passwordHash: "x",
        name: "A Curious Student",
        school: "University of Southern California",
        gradYear: 2028,
      },
      {
        id: AUTHOR,
        email: "offered@example.edu",
        passwordHash: "x",
        name: "Someone With An Offer",
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

test("an offer row's id buys nothing: no reaction, no comment, no seen-mark", async () => {
  await withPeople(async (h) => {
    const { recordOffer } = await import("@/lib/activity");
    const { toggleReaction, addComment, listComments } = await import(
      "@/app/(app)/networking/feed-actions"
    );
    const { markFeedSeen } = await import("@/lib/activity");

    await recordOffer(AUTHOR, APPLICATION, "Evercore", "Summer Analyst");
    const [offer] = await h.db.query.activityEvents.findMany({ limit: 1 });
    assert.ok(offer, "the offer row is written - the author sees their own milestone");

    // Every engagement path, with the id in hand.
    assert.deepEqual(
      await asStudent(h.db, STUDENT, () => toggleReaction(offer.id, "🎉")),
      [],
      "no reaction on a row this student may not be shown",
    );
    const comment = await asStudent(h.db, STUDENT, () => addComment(offer.id, "congrats!"));
    assert.ok(
      "error" in comment && /no longer here/i.test(comment.error),
      "and the same answer a missing row gives, so a guessed id learns nothing",
    );
    assert.deepEqual(
      await asStudent(h.db, STUDENT, () => listComments(offer.id)),
      [],
      "and nothing of the conversation underneath it",
    );
    await markFeedSeen(STUDENT, [offer.id]);

    // Nothing was written against the row by any of them.
    assert.equal((await h.db.select().from(activityReactions)).length, 0, "no reaction row");
    assert.equal((await h.db.select().from(activityComments)).length, 0, "no comment row");
    assert.equal((await h.db.select().from(activitySeen)).length, 0, "no seen row");

    // And the author is unaffected - this is a visibility rule, not a freeze.
    const mine = await asStudent(h.db, AUTHOR, () => toggleReaction(offer.id, "🎉"));
    assert.equal(mine.length, 1, "the author may react to their own row");
    assert.equal((await h.db.select().from(activityReactions)).length, 1);
  });
});

test("the retraction a tracker edit relies on removes the row it announced", async () => {
  await withPeople(async () => {
    const { recordOffer, retractOffer, visibleEvent, getFeed } = await import("@/lib/activity");
    await recordOffer(AUTHOR, APPLICATION, "Evercore", "Summer Analyst");
    const [row] = (await getFeed(AUTHOR)).filter((i) => i.kind === "offer");
    assert.ok(row, "announced");

    assert.equal(await retractOffer(AUTHOR, APPLICATION), true, "and taken back down");
    assert.equal(
      await visibleEvent(AUTHOR, row.id),
      null,
      "the row is gone for its author too, not merely hidden",
    );
  });
});

/**
 * Every file that queries activity_events, and what it does with it.
 *
 * A by-id lookup belongs in lib/activity, behind visibleEvent. The others here
 * are scoped to one account's own rows, which is a different question and a
 * safe one. A file not on this list fails the test below: either route it
 * through visibleEvent or add it here saying why it does not need to be.
 */
const ACTIVITY_EVENT_READERS: Record<string, string> = {
  "lib/activity.ts":
    "The only by-id lookup (visibleEvent), plus the feed reads, which carry the same predicate set-wise.",
  "app/(app)/profile/actions.ts":
    "Selects the image paths of the signed-in account's OWN rows, by user id, so the files can be deleted with the account.",
  "app/(app)/networking/page.tsx": "A comment about the feed; no query.",
};

test("untracking takes the announcement with it, on both untrack paths", async () => {
  // Four writes move an application off "offer", and the first pass wired the
  // retraction into two of them. These are the other two. Nothing cascades: an
  // offer event finds its application through a plain text dedupe key with no
  // foreign key, so without the call the student's own feed keeps announcing an
  // offer for a role that is no longer on their tracker and that they cannot
  // open from it.
  for (const how of ["one role", "the whole firm"] as const) {
    await withPeople(async (h) => {
      const { recordOffer } = await import("@/lib/activity");
      const { activityEvents, applications } = await import("@/db/schema");
      const { and, eq } = await import("drizzle-orm");
      const offerRows = () =>
        h.db
          .select({ id: activityEvents.id })
          .from(activityEvents)
          .where(and(eq(activityEvents.userId, AUTHOR), eq(activityEvents.kind, "offer")));
      const [app] = await h.db
        .insert(applications)
        .values({ userId: AUTHOR, firm: "Evercore", role: "Summer Analyst", status: "offer" })
        .returning();
      await recordOffer(AUTHOR, app.id, "Evercore", "Summer Analyst");
      assert.equal((await offerRows()).length, 1, "the offer was announced");

      if (how === "one role") {
        const { untrackApplication } = await import("@/app/(app)/applications/actions");
        const out = await asStudent(h.db, AUTHOR, () =>
          untrackApplication({ firm: "Evercore", role: "Summer Analyst" }),
        );
        assert.equal(out.untracked, true);
      } else {
        const { untrackFirm } = await import("@/app/(app)/applications/untrack-actions");
        // A second role at the same firm, also announced: untracking the firm
        // takes both down, and the retraction is one statement rather than one
        // per row. The 100-firm match page can put nine roles behind one click.
        const [second] = await h.db
          .insert(applications)
          .values({ userId: AUTHOR, firm: "Evercore", role: "Off-Cycle Analyst", status: "offer" })
          .returning();
        await recordOffer(AUTHOR, second.id, "Evercore", "Off-Cycle Analyst");
        assert.equal((await offerRows()).length, 2, "both offers were announced");

        const out = await asStudent(h.db, AUTHOR, () => untrackFirm("Evercore"));
        assert.equal(out.removed, 2);
      }

      assert.deepEqual(await offerRows(), [], `untracking ${how} left the offer announced`);
    });
  }
});

test("nothing outside lib/activity resolves a feed row by id", () => {
  const SRC = path.join(__dirname, "..", "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(SRC);

  const unexpected: string[] = [];
  for (const file of files) {
    const rel = path.relative(SRC, file);
    if (rel === path.join("db", "schema.ts")) continue;
    if (!fs.readFileSync(file, "utf8").includes("activityEvents")) continue;
    if (!(rel in ACTIVITY_EVENT_READERS)) unexpected.push(rel);
  }

  assert.deepEqual(
    unexpected,
    [],
    "these query activity_events and are not accounted for: route the lookup through " +
      "visibleEvent in lib/activity, or add it to ACTIVITY_EVENT_READERS with the reason",
  );
});
