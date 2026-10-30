/**
 * The sent-email archive's 24-month limit, against a REAL database.
 *
 * The hole this pins shut: the published Privacy Policy retention table and AI
 * notice 7.6 promise that an archived email is kept "in any case 24 months
 * after each email is archived", and nothing in the repository enforced it.
 * Rows were written on every send and deleted only when the student opted out
 * of Training Use or deleted their account - no age-based delete anywhere in
 * src, scripts or the migrations, and no cron declared - so the oldest sealed
 * email would have been kept indefinitely.
 *
 * No network and no keys needed: the purge only reads created_at.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import {
  ARCHIVE_RETENTION_MONTHS,
  archiveExpiryCutoff,
  purgeExpiredArchives,
} from "@/lib/email-archive";
import { emailArchive, emailDrafts, users } from "@/db/schema";

const USER_ID = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function monthsBefore(date: Date, months: number, extraDays = 0): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() - months);
  d.setDate(d.getDate() - extraDays);
  return d;
}

async function withArchive(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "retention@example.edu",
      passwordHash: "x",
      name: "Retention Student",
    });
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

async function archived(h: TestDatabase, when: Date, emailType = "cold_email"): Promise<string> {
  const [row] = await h.db
    .insert(emailArchive)
    .values({ userId: USER_ID, emailType, generatedCiphertext: "v1.a.b.c", createdAt: when })
    .returning();
  return row.id;
}

test(`the cutoff is exactly ${ARCHIVE_RETENTION_MONTHS} months back`, async () => {
  assert.equal(ARCHIVE_RETENTION_MONTHS, 24, "the published policy says 24 months");
  assert.deepEqual(archiveExpiryCutoff(NOW), monthsBefore(NOW, 24));
});

test("emails past 24 months are deleted and younger ones are kept", async () => {
  await withArchive(async (h) => {
    const ancient = await archived(h, monthsBefore(NOW, 48));
    const justOver = await archived(h, monthsBefore(NOW, 24, 1));
    const justUnder = await archived(h, monthsBefore(NOW, 23));
    const fresh = await archived(h, NOW);

    const gone = await purgeExpiredArchives(NOW);
    assert.equal(gone, 2, "the two past their 24 months");

    const left = (await h.db.select().from(emailArchive).where(eq(emailArchive.userId, USER_ID))).map((r) => r.id);
    assert.deepEqual(left.sort(), [justUnder, fresh].sort());
    assert.ok(!left.includes(ancient) && !left.includes(justOver));
  });
});

test("a purge with nothing expired deletes nothing", async () => {
  await withArchive(async (h) => {
    await archived(h, monthsBefore(NOW, 6));
    assert.equal(await purgeExpiredArchives(NOW), 0);
    assert.equal((await h.db.select().from(emailArchive)).length, 1);
  });
});

test("an expired email goes whether or not its draft still exists", async () => {
  await withArchive(async (h) => {
    const [draft] = await h.db
      .insert(emailDrafts)
      .values({ userId: USER_ID, kind: "cold_outreach", subject: "s", body: "b" })
      .returning();
    await h.db.insert(emailArchive).values({
      userId: USER_ID,
      draftId: draft.id,
      emailType: "cold_email",
      createdAt: monthsBefore(NOW, 30),
    });
    // And one already orphaned by an older deletion (draft_id set to null).
    await archived(h, monthsBefore(NOW, 30), "follow_up");

    assert.equal(await purgeExpiredArchives(NOW), 2);
    assert.equal((await h.db.select().from(emailArchive)).length, 0);
    assert.equal(
      (await h.db.select().from(emailDrafts).where(eq(emailDrafts.id, draft.id))).length,
      1,
      "the draft itself is not retention's business",
    );
  });
});

test("the sweep runs when an email is archived", async () => {
  await withArchive(async (h) => {
    await h.db.insert(users).values({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "writer@example.edu",
      passwordHash: "x",
      name: "Writer",
      consentedPolicyVersion: (await import("@/lib/policy")).POLICY_VERSION,
      trainingChoice: "opted_in",
      trainingChoicePolicyVersion: (await import("@/lib/policy")).POLICY_VERSION,
    });
    const expired = await archived(h, monthsBefore(new Date(), 30));

    const key = process.env.EMAIL_ARCHIVE_KEY;
    process.env.EMAIL_ARCHIVE_KEY = Buffer.alloc(32, 3).toString("base64");
    try {
      const { archiveGenerated } = await import("@/lib/email-archive");
      const [draft] = await h.db
        .insert(emailDrafts)
        .values({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "cold_outreach", subject: "s", body: "b" })
        .returning();
      await archiveGenerated({
        userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        draftId: draft.id,
        emailType: "cold_email",
        content: { subject: "s", body: "b" },
      });
      const rows = await h.db.select().from(emailArchive);
      assert.ok(!rows.some((r) => r.id === expired), "the write swept the expired row");
      assert.equal(rows.length, 1, "and kept the one it just wrote");
    } finally {
      if (key === undefined) delete process.env.EMAIL_ARCHIVE_KEY;
      else process.env.EMAIL_ARCHIVE_KEY = key;
    }
  });
});
