/**
 * What the training corpus and the sealed email archive keep, and for how
 * long - driven through the real server actions, against a REAL database.
 *
 * Two holes these pin shut:
 *
 *   - deleting a draft deleted only the draft. email_archive.draft_id is ON
 *     DELETE SET NULL, so the sealed copy survived with a null draft id, and
 *     training_examples.source_id is not a foreign key, so the example
 *     survived too - while the published privacy policy says deleting a draft
 *     deletes both.
 *   - the "delivered" capture (marking a draft sent, or copying it) loaded the
 *     contact without their firm, so the de-identifier was never given one and
 *     the recipient's employer was stored verbatim - and because the row
 *     upserts on (task, source_id), that write REPLACED the correctly redacted
 *     one the save path had made.
 *
 * No network and no model: every path here is database-only.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";

import "./helpers/no-network";
import "./helpers/as-student";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { contacts, emailArchive, emailDrafts, trainingExamples, users } from "@/db/schema";
import { POLICY_VERSION } from "@/lib/policy";

const USER_ID = "66666666-6666-4666-8666-666666666666";
const FIRM = "Goldman Sachs & Co.";

type Fixture = { draftId: string; contactId: string };

async function withOptedInStudent(fn: (h: TestDatabase, f: Fixture) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  const key = process.env.EMAIL_ARCHIVE_KEY;
  process.env.EMAIL_ARCHIVE_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "corpus@example.edu",
      passwordHash: "x",
      name: "Dara Okonkwo",
      school: "State University",
      plan: "pro",
      // Opted in to Training Use under the current policy, which is the only
      // state in which anything is captured at all.
      consentedPolicyVersion: POLICY_VERSION,
      trainingChoice: "opted_in",
      trainingChoicePolicyVersion: POLICY_VERSION,
    });
    const [contact] = await h.db
      .insert(contacts)
      .values({ userId: USER_ID, name: "José Álvarez", firm: FIRM, email: "jose@example.com" })
      .returning();
    const [draft] = await h.db
      .insert(emailDrafts)
      .values({
        userId: USER_ID,
        contactId: contact.id,
        kind: "cold_outreach",
        templateId: "cold_email",
        subject: `Quick question about ${FIRM}`,
        body: `Hi José, I would love to learn about Goldman Sachs. Best, Dara`,
        modelSubject: `Quick question about ${FIRM}`,
        modelBody: `Hi José, I would love to learn about Goldman Sachs. Best, Dara`,
      })
      .returning();
    await fn(h, { draftId: draft.id, contactId: contact.id });
  } finally {
    if (key === undefined) delete process.env.EMAIL_ARCHIVE_KEY;
    else process.env.EMAIL_ARCHIVE_KEY = key;
    restore();
    await h.close();
  }
}

/** deleteDraft ends in redirect(), which the next/navigation stub throws. */
async function expectRedirect(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, /NEXT_REDIRECT/);
}

test("the delivered capture redacts the recipient's firm", async () => {
  await withOptedInStudent(async (h, f) => {
    const { recordDraftCopied } = await import("@/app/(app)/drafts/actions");
    await asStudent(h.db, USER_ID, () =>
      recordDraftCopied(f.draftId, {
        to: "jose@example.com",
        subject: `Quick question about ${FIRM}`,
        body: "Hi José, I would love to learn about Goldman Sachs. Best, Dara",
      }),
    );

    const rows = await h.db.select().from(trainingExamples).where(eq(trainingExamples.userId, USER_ID));
    assert.equal(rows.length, 1, "one example per source draft");
    const stored = JSON.stringify(rows[0]);
    assert.equal(rows[0].outcome, "delivered");
    assert.ok(!stored.includes("Goldman"), `the employer survived: ${stored}`);
    assert.ok(!stored.includes("José"), `the recipient survived: ${stored}`);
    assert.ok(stored.includes("[FIRM]"), stored);
    assert.ok(stored.includes("[CONTACT]"), stored);
  });
});

test("deleting a draft deletes its archived copy and its training example", async () => {
  await withOptedInStudent(async (h, f) => {
    const actions = await import("@/app/(app)/drafts/actions");
    // Send it first, so both the archive row and the example exist.
    await asStudent(h.db, USER_ID, () =>
      actions.recordDraftCopied(f.draftId, {
        to: "jose@example.com",
        subject: "Quick question",
        body: "Hi José, thanks. Best, Dara",
      }),
    );
    assert.equal(
      (await h.db.select().from(emailArchive).where(eq(emailArchive.draftId, f.draftId))).length,
      1,
      "the sent email was archived",
    );
    assert.equal((await h.db.select().from(trainingExamples).where(eq(trainingExamples.userId, USER_ID))).length, 1);

    await expectRedirect(() => asStudent(h.db, USER_ID, () => actions.deleteDraft(f.draftId)));

    assert.equal((await h.db.select().from(emailDrafts).where(eq(emailDrafts.id, f.draftId))).length, 0, "the draft is gone");
    assert.equal(
      (await h.db.select().from(emailArchive).where(eq(emailArchive.userId, USER_ID))).length,
      0,
      "no archive row orphaned with a null draft id",
    );
    assert.equal(
      (await h.db.select().from(trainingExamples).where(eq(trainingExamples.userId, USER_ID))).length,
      0,
      "no training example left behind",
    );
  });
});

test("deleting one draft leaves another student's rows, and the account's other drafts, alone", async () => {
  await withOptedInStudent(async (h, f) => {
    const other = "77777777-7777-4777-8777-777777777777";
    await h.db.insert(users).values({
      id: other,
      email: "other@example.edu",
      passwordHash: "x",
      name: "Someone Else",
      consentedPolicyVersion: POLICY_VERSION,
      trainingChoice: "opted_in",
      trainingChoicePolicyVersion: POLICY_VERSION,
    });
    const [theirDraft] = await h.db
      .insert(emailDrafts)
      .values({ userId: other, kind: "cold_outreach", subject: "s", body: "b" })
      .returning();
    await h.db.insert(emailArchive).values({ userId: other, draftId: theirDraft.id, emailType: "cold_email" });
    await h.db.insert(trainingExamples).values({
      userId: other,
      task: "email_draft",
      outcome: "accepted",
      policyVersion: POLICY_VERSION,
      sourceId: theirDraft.id,
      promptContext: {},
      modelOutput: {},
    });

    // And a second draft of our own, with its own archive row.
    const [mine] = await h.db
      .insert(emailDrafts)
      .values({ userId: USER_ID, kind: "cold_outreach", subject: "keep", body: "me" })
      .returning();
    await h.db.insert(emailArchive).values({ userId: USER_ID, draftId: mine.id, emailType: "cold_email" });
    await h.db.insert(emailArchive).values({ userId: USER_ID, draftId: f.draftId, emailType: "cold_email" });

    const { deleteDraft } = await import("@/app/(app)/drafts/actions");
    await expectRedirect(() => asStudent(h.db, USER_ID, () => deleteDraft(f.draftId)));

    assert.equal((await h.db.select().from(emailArchive).where(eq(emailArchive.userId, other))).length, 1);
    assert.equal((await h.db.select().from(trainingExamples).where(eq(trainingExamples.userId, other))).length, 1);
    assert.equal(
      (await h.db
        .select()
        .from(emailArchive)
        .where(and(eq(emailArchive.userId, USER_ID), eq(emailArchive.draftId, mine.id)))).length,
      1,
      "the student's other draft keeps its archived copy",
    );
  });
});

test("another student's draft id cannot delete anything of theirs", async () => {
  await withOptedInStudent(async (h, f) => {
    const other = "88888888-8888-4888-8888-888888888888";
    await h.db.insert(users).values({ id: other, email: "third@example.edu", passwordHash: "x", name: "Third" });
    const [theirs] = await h.db
      .insert(emailDrafts)
      .values({ userId: other, kind: "cold_outreach", subject: "s", body: "b" })
      .returning();
    await h.db.insert(emailArchive).values({ userId: other, draftId: theirs.id, emailType: "cold_email" });
    await h.db.insert(trainingExamples).values({
      userId: other,
      task: "email_draft",
      outcome: "accepted",
      policyVersion: POLICY_VERSION,
      sourceId: theirs.id,
      promptContext: {},
      modelOutput: {},
    });

    const { deleteDraft } = await import("@/app/(app)/drafts/actions");
    await expectRedirect(() => asStudent(h.db, USER_ID, () => deleteDraft(theirs.id)));

    assert.equal((await h.db.select().from(emailDrafts).where(eq(emailDrafts.id, theirs.id))).length, 1);
    assert.equal((await h.db.select().from(emailArchive).where(eq(emailArchive.userId, other))).length, 1);
    assert.equal((await h.db.select().from(trainingExamples).where(eq(trainingExamples.userId, other))).length, 1);
    // And our own draft is untouched by someone else's id.
    assert.equal((await h.db.select().from(emailDrafts).where(eq(emailDrafts.id, f.draftId))).length, 1);
  });
});
