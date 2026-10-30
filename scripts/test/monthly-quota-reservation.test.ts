/**
 * The monthly allowances, against a REAL database.
 *
 * Two holes these pin shut:
 *
 *   - the allowance was counted from the feature's own rows, every one of
 *     which the student can delete - so deleting a draft or an interview
 *     handed the month back. The append-only feature_usage ledger (0042) is
 *     now counted alongside them, and a deletion cannot lower it.
 *   - the check was read-then-act, so requests fired together all passed the
 *     same count. The use is now taken under a per-student lock.
 *
 * No network and no model: reserveMonthlyUse only touches the database.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { getMonthlyUsage, MONTHLY_QUOTAS, reserveMonthlyUse } from "@/lib/plan-quotas";
import { resumeReviews, users } from "@/db/schema";
import { eq } from "drizzle-orm";

const USER_ID = "44444444-4444-4444-8444-444444444444";
const PRO = { id: USER_ID, email: "quota@example.edu", plan: "pro" as const };
const LIMIT = MONTHLY_QUOTAS.pro.resumeReviews;

async function withPro(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: PRO.email,
      passwordHash: "x",
      name: "Quota Student",
      plan: "pro",
    });
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

async function usedResumeReviews(): Promise<number> {
  const rows = await getMonthlyUsage({ id: USER_ID, plan: "pro" });
  return rows.find((r) => r.feature === "resumeReviews")!.used;
}

test("the month's uses run out at the plan's limit", async () => {
  await withPro(async () => {
    for (let i = 0; i < LIMIT; i++) {
      const r = await reserveMonthlyUse(PRO, "resumeReviews");
      assert.equal(r.ok, true, `use ${i + 1} of ${LIMIT} should be granted`);
    }
    const over = await reserveMonthlyUse(PRO, "resumeReviews");
    assert.equal(over.ok, false);
    if (!over.ok) assert.match(over.error, /used all/i);
  });
});

test("a free plan is refused with the upgrade wording, and takes no use", async () => {
  await withPro(async () => {
    const free = await reserveMonthlyUse({ ...PRO, plan: "free" }, "resumeReviews");
    assert.equal(free.ok, false);
    if (!free.ok) assert.match(free.error, /Offerly Pro/);
    assert.equal(await usedResumeReviews(), 0, "a refusal records nothing");
  });
});

test("a released use is given back - a review that never happened never counted", async () => {
  await withPro(async () => {
    const r = await reserveMonthlyUse(PRO, "resumeReviews");
    assert.equal(r.ok, true);
    assert.equal(await usedResumeReviews(), 1);
    if (r.ok) await r.release();
    assert.equal(await usedResumeReviews(), 0, "the use came back");
  });
});

test("deleting the feature's own row does NOT give the month back", async () => {
  await withPro(async (h) => {
    // What a real review does: take the use, then write its row.
    const r = await reserveMonthlyUse(PRO, "resumeReviews");
    assert.equal(r.ok, true);
    const [row] = await h.db
      .insert(resumeReviews)
      .values({
        userId: USER_ID,
        filename: "cv.pdf",
        storagePath: "k",
        score: 70,
        dimensions: {},
        summary: "s",
        strengths: [],
        improvements: [],
        rewrites: [],
      })
      .returning();
    assert.equal(await usedResumeReviews(), 1);

    // The student deletes the review. The content goes; the month does not.
    await h.db.delete(resumeReviews).where(eq(resumeReviews.id, row.id));
    assert.equal(await usedResumeReviews(), 1, "the ledger still holds the use");
  });
});

test("history written before the ledger existed still counts", async () => {
  await withPro(async (h) => {
    // Rows with no matching ledger entry: the usage from before 0042.
    for (let i = 0; i < 3; i++) {
      await h.db.insert(resumeReviews).values({
        userId: USER_ID,
        filename: `old-${i}.pdf`,
        storagePath: `k${i}`,
        score: 70,
        dimensions: {},
        summary: "s",
        strengths: [],
        improvements: [],
        rewrites: [],
      });
    }
    assert.equal(await usedResumeReviews(), 3, "counted from the domain rows");
  });
});

test("uses fired together cannot all pass the same count", async () => {
  await withPro(async () => {
    // Twice the limit, all at once. Read-then-act let every one of these pass;
    // the per-student lock means exactly LIMIT get through.
    const results = await Promise.all(
      Array.from({ length: LIMIT * 2 }, () => reserveMonthlyUse(PRO, "resumeReviews")),
    );
    const granted = results.filter((r) => r.ok).length;
    assert.equal(granted, LIMIT, `exactly ${LIMIT} uses granted, not ${granted}`);
    assert.equal(await usedResumeReviews(), LIMIT);
  });
});
