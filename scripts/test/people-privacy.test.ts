/**
 * What one student is allowed to learn about another, against a REAL database.
 *
 * Two privacy boundaries used to leak here, and this file is how they stay
 * shut:
 *
 *   - `users` is one table for three kinds of account. A firm signs up with a
 *     self-typed name and org_approved = false, before anyone has vetted it,
 *     and that row was listed to every student under "Students on Offerly",
 *     readable at /u/<id>, and reachable as a message recipient.
 *   - an application reaching "offer" in the private tracker published the
 *     firm and the role to every student - on their profile, on their
 *     directory card, and as a row in the global feed - with no consent step
 *     and no way to take it back.
 *
 * PGlite with the real migrations: the account_type enum, the feed's indexes
 * and the applications table are the real ones. No network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { applications, messages, users } from "@/db/schema";

const STUDENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_STUDENT = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const RECRUITER = "cccccccc-1111-4111-8111-cccccccccccc";

async function withPeople(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values([
      {
        id: STUDENT,
        email: "student@example.edu",
        passwordHash: "x",
        name: "A Real Student",
        school: "University of Southern California",
        gradYear: 2028,
      },
      {
        id: OTHER_STUDENT,
        email: "other@example.edu",
        passwordHash: "x",
        name: "Another Student",
        school: "New York University",
        gradYear: 2027,
      },
      {
        // Exactly what firm signup writes before approval: a self-typed name
        // and org_approved = false (lib/firm-auth).
        id: RECRUITER,
        email: "recruiter@bank.example",
        passwordHash: "x",
        name: "Totally A Student",
        accountType: "firm",
        orgApproved: false,
      },
    ]);
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

test("the People directory lists students only, never a firm account", async () => {
  await withPeople(async () => {
    const { getDirectoryMembers } = await import("@/lib/people");
    const members = await getDirectoryMembers(STUDENT);
    const ids = members.map((m) => m.id);
    assert.deepEqual(ids, [OTHER_STUDENT], "only the other student is in the directory");
    assert.ok(!ids.includes(RECRUITER), "an un-approved firm account is not a classmate");
    assert.ok(!ids.includes(STUDENT), "and the viewer is still left out of their own directory");
  });
});

test("a firm account's profile is not readable by a student who has no thread with them", async () => {
  await withPeople(async () => {
    const { getPublicProfile } = await import("@/lib/people");
    assert.equal(
      await getPublicProfile(RECRUITER, STUDENT),
      null,
      "a firm row reads like a missing one",
    );
    assert.ok(
      await getPublicProfile(OTHER_STUDENT, STUDENT),
      "another student's profile still opens",
    );
  });
});

test("but a recruiter who messaged the student stays readable, so the student can answer", async () => {
  await withPeople(async (h) => {
    const { getPublicProfile } = await import("@/lib/people");
    await h.db.insert(messages).values({
      senderId: RECRUITER,
      recipientId: STUDENT,
      body: "We'd like to talk about our summer analyst programme.",
    });
    const profile = await getPublicProfile(RECRUITER, STUDENT);
    assert.ok(profile, "the thread's counterpart is readable");
    // And only to that student - nobody else gained anything.
    assert.equal(await getPublicProfile(RECRUITER, OTHER_STUDENT), null);
  });
});

test("a student cannot be sent a message by posting a firm account's id as the recipient", async () => {
  await withPeople(async () => {
    const { sendMessage } = await import("@/lib/people");
    const refused = await sendMessage(STUDENT, RECRUITER, "hello?");
    assert.match(refused.error ?? "", /no longer has an account/);
    const allowed = await sendMessage(STUDENT, OTHER_STUDENT, "hey, are you going to the superday?");
    assert.equal(allowed.error, undefined, "student to student still works");
    // A firm SENDING to a student is the firm portal's own flow and is untouched.
    const fromFirm = await sendMessage(RECRUITER, STUDENT, "Following up on your application.");
    assert.equal(fromFirm.error, undefined, "only the recipient is checked");
  });
});

test("an offer in the private tracker is shown to its owner and to nobody else", async () => {
  await withPeople(async (h) => {
    const { getPublicProfile, getDirectoryMembers } = await import("@/lib/people");
    await h.db.insert(applications).values({
      userId: OTHER_STUDENT,
      firm: "Evercore",
      role: "Summer Analyst",
      status: "offer",
      appliedDate: "2026-01-15",
    });

    const theirs = await getPublicProfile(OTHER_STUDENT, OTHER_STUDENT);
    assert.deepEqual(
      theirs?.internships,
      [{ firm: "Evercore", role: "Summer Analyst" }],
      "their own profile still shows it",
    );

    const asSeenByAnother = await getPublicProfile(OTHER_STUDENT, STUDENT);
    assert.deepEqual(asSeenByAnother?.internships, [], "another student learns nothing");

    // And nothing offer-shaped reaches the directory card at all.
    const members = await getDirectoryMembers(STUDENT);
    const serialised = JSON.stringify(members);
    assert.ok(!serialised.includes("Evercore"), "no firm name from an offer on a member card");
    assert.ok(!serialised.includes("Summer Analyst"), "and no role either");
  });
});

test("an offer's feed row is readable by its author only", async () => {
  await withPeople(async () => {
    const { recordOffer, getFeedPage, getFeed, createPost } = await import("@/lib/activity");
    await recordOffer(OTHER_STUDENT, "dddddddd-1111-4111-8111-dddddddddddd", "Evercore", "Summer Analyst");
    await createPost(OTHER_STUDENT, "Anyone else interviewing this week?");

    const snapshot = new Date(Date.now() + 60_000);
    const mine = await getFeedPage(OTHER_STUDENT, { snapshot });
    assert.ok(mine.items.some((i) => i.kind === "offer"), "the author still sees their own milestone");

    const theirs = await getFeedPage(STUDENT, { snapshot });
    assert.ok(
      theirs.items.some((i) => i.kind === "post"),
      "every other kind of row is still a public feed",
    );
    assert.ok(!theirs.items.some((i) => i.kind === "offer"), "but not someone else's offer");

    // The parked /home feed reads the same table through getFeed.
    const home = await getFeed(STUDENT);
    assert.ok(!home.some((i) => i.kind === "offer"), "and not there either");
  });
});

test("an author can take their own feed row back down, and nobody else can", async () => {
  await withPeople(async () => {
    const { createPost, deleteOwnFeedItem, retractOffer, recordOffer, getFeed } = await import(
      "@/lib/activity"
    );
    const postId = await createPost(OTHER_STUDENT, "Posted this by mistake.");

    assert.equal(
      await deleteOwnFeedItem(STUDENT, postId),
      false,
      "someone else's row is refused like a missing one",
    );
    assert.ok((await getFeed(STUDENT)).some((i) => i.id === postId), "and is still standing");

    assert.equal(await deleteOwnFeedItem(OTHER_STUDENT, postId), true);
    assert.ok(!(await getFeed(STUDENT)).some((i) => i.id === postId), "gone for everyone");

    // An offer announcement is retractable by application id, so reverting a
    // status can take the announcement with it.
    const applicationId = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
    await recordOffer(OTHER_STUDENT, applicationId, "Evercore", "Summer Analyst");
    assert.equal(await retractOffer(STUDENT, applicationId), false, "not someone else's");
    assert.equal(await retractOffer(OTHER_STUDENT, applicationId), true);
    assert.equal(await retractOffer(OTHER_STUDENT, applicationId), false, "and it is idempotent");
  });
});
