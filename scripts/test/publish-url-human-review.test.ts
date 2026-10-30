/**
 * A person's verdict is not a machine's to revisit.
 *
 * `backfillThinListings` in scripts/monitor-run.ts re-reads the detail page of
 * every stored listing with a thin description and rewrites the row from the
 * fresh classification. It wrote `review_status` UNCONDITIONALLY: it never
 * read `reviewed_by` and never checked whether a person had already decided.
 * So a listing an admin had REJECTED, whose detail page later served a long
 * description that classified as publishable, was flipped to `auto_approved`
 * with `promoted_posting_id` still null - and promote-approved-listings, which
 * selects exactly that and checks no reviewer field, published it to students
 * in the same hourly run. It runs unattended via launchd, hourly, on every
 * source, and it was the one script in this family that did not enforce the
 * rule adjudicate-rejections.ts and reclassify-listings.ts both state in so
 * many words (security review, 10 October 2026).
 *
 * `reviewed_by` is the only discriminator there is: rejectListing writes the
 * same status string the classifier does.
 *
 * Asserted three ways - the policy helper, the real table (the WHERE clause
 * has to be the guard too, or an admin deciding between the read and the
 * write loses), and the script's source, because the helper only helps if the
 * caller uses it.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { detectedListings, firmMonitoringSources, firms, monitoringTiers, users } from "@/db/schema";
import { reviewStatusAfterReread } from "@/lib/monitoring/classify";
import type { listingReviewStatusEnum } from "@/db/schema";

delete process.env.DATABASE_URL;

describe("the policy", () => {
  const relevant = { relevant: true, needsHumanReview: false, recruitingCycle: 2027 };
  const uncertain = { relevant: true, needsHumanReview: true, recruitingCycle: 2027 };
  const irrelevant = { relevant: false, needsHumanReview: false, recruitingCycle: 2027 };
  const noCycle = { relevant: true, needsHumanReview: false, recruitingCycle: null };

  test("an undecided row is re-judged on the rule a first read uses", () => {
    assert.equal(reviewStatusAfterReread(relevant, { reviewedBy: null }), "auto_approved");
    /**
     * BINARY, as the first-read path in monitor-run.ts is: a listing that is
     * not publishable without review is rejected with a reason, not queued.
     * This asserted `pending_review` until the queue was removed - `reviewed_by`
     * was NULL on all 21,716 rows, so it had never once been worked. The two
     * cases below are the two ways this helper used to disagree with the path
     * it is supposed to mirror.
     */
    assert.equal(reviewStatusAfterReread(uncertain, { reviewedBy: null }), "rejected");
    assert.equal(reviewStatusAfterReread(noCycle, { reviewedBy: null }), "rejected");
    assert.equal(reviewStatusAfterReread(irrelevant, { reviewedBy: null }), "rejected");
  });

  test("nothing automated routes a listing to pending_review", () => {
    for (const c of [relevant, uncertain, irrelevant, noCycle]) {
      assert.notEqual(
        reviewStatusAfterReread(c, { reviewedBy: null }),
        "pending_review",
        "the re-read path put a listing back in a queue nobody works",
      );
    }
  });

  test("a row a person decided is never re-judged, whichever way it would go", () => {
    for (const c of [relevant, uncertain, irrelevant, noCycle]) {
      assert.equal(
        reviewStatusAfterReread(c, { reviewedBy: "11111111-1111-1111-1111-111111111111" }),
        null,
        "the machine overwrote a human verdict",
      );
    }
  });
});

describe("against the real table", () => {
  let h: TestDatabase;
  let restore: () => void;

  before(async () => {
    h = await createTestDb();
    restore = installAsAppDb(h.db);
  });
  after(async () => {
    restore();
    await h.close();
  });

  let seq = 0;

  /** The admin whose verdict the backfill must not revisit. */
  async function mkReviewer() {
    const [u] = await h.db
      .insert(users)
      .values({ email: `reviewer-${++seq}-${Date.now()}@example.edu`, passwordHash: "x", name: "Reviewer" })
      .returning();
    return u.id;
  }

  type Stored = (typeof listingReviewStatusEnum)["enumValues"][number];

  async function mkListing(reviewStatus: Stored, reviewedBy: string | null) {
    const n = ++seq;
    const [firm] = await h.db
      .insert(firms)
      .values({
        slug: `review-guard-${n}-${Date.now()}`,
        name: `Firm ${n}`,
        headquarters: "New York",
        keyOffices: "New York",
        website: "example.com",
        description: "A test firm.",
      })
      .returning();
    const [tier] = await h.db
      .insert(monitoringTiers)
      .values({ name: `standard-${n}-${Date.now()}`, checkIntervalMinutes: 60, description: "test", sortOrder: n })
      .returning();
    const [source] = await h.db
      .insert(firmMonitoringSources)
      .values({
        firmId: firm.id,
        careersUrl: `https://careers.example.com/${n}`,
        sourceType: "generic_html",
        connectorId: "generic",
        sectorCategory: "investment_banking",
        tierId: tier.id,
      })
      .returning();
    const [listing] = await h.db
      .insert(detectedListings)
      .values({
        sourceId: source.id,
        externalJobId: `ext-${n}`,
        contentHash: `hash-${n}`,
        title: "2027 Summer Analyst - New York",
        descriptionRaw: "2027 Summer Analyst - New York",
        listingUrl: `https://careers.example.com/${n}/role`,
        applicationUrl: `https://careers.example.com/${n}/role`,
        reviewStatus,
        reviewedBy,
        reviewedAt: reviewedBy ? new Date() : null,
      })
      .returning();
    return listing;
  }

  /** What the backfill now does: evidence always, verdict only when nobody
   *  decided - and the guard repeated in the WHERE clause. */
  async function backfill(id: string, status: "rejected" | "pending_review" | "auto_approved" | null) {
    await h.db
      .update(detectedListings)
      .set({ descriptionRaw: "x".repeat(400), updatedAt: new Date() })
      .where(eq(detectedListings.id, id));
    if (status) {
      await h.db
        .update(detectedListings)
        .set({ reviewStatus: status, updatedAt: new Date() })
        .where(and(eq(detectedListings.id, id), isNull(detectedListings.reviewedBy)));
    }
  }

  test("a human-rejected listing stays rejected, and the fresh description is still stored", async () => {
    const row = await mkListing("rejected", await mkReviewer());
    const status = reviewStatusAfterReread({ relevant: true, needsHumanReview: false, recruitingCycle: 2027 }, { reviewedBy: row.reviewedBy });
    await backfill(row.id, status);

    const after = await h.db.query.detectedListings.findFirst({ where: eq(detectedListings.id, row.id) });
    assert.equal(after?.reviewStatus, "rejected", "a human rejection was overwritten");
    assert.equal(after?.promotedPostingId, null);
    assert.equal(after?.descriptionRaw.length, 400, "the enrichment was lost along with the guard");
  });

  test("a human-approved listing is not sent back to pending either", async () => {
    const row = await mkListing("approved", await mkReviewer());
    const status = reviewStatusAfterReread({ relevant: true, needsHumanReview: true, recruitingCycle: 2027 }, { reviewedBy: row.reviewedBy });
    await backfill(row.id, status);
    const after = await h.db.query.detectedListings.findFirst({ where: eq(detectedListings.id, row.id) });
    assert.equal(after?.reviewStatus, "approved");
  });

  test("the WHERE clause alone holds, even if the helper is bypassed", async () => {
    const row = await mkListing("rejected", await mkReviewer());
    // Deliberately passing the status a caller that forgot the helper would.
    await backfill(row.id, "auto_approved");
    const after = await h.db.query.detectedListings.findFirst({ where: eq(detectedListings.id, row.id) });
    assert.equal(after?.reviewStatus, "rejected", "the atomic guard did not hold");
  });

  test("an undecided thin listing is still re-judged - the backfill keeps working", async () => {
    const row = await mkListing("pending_review", null);
    const status = reviewStatusAfterReread({ relevant: true, needsHumanReview: false, recruitingCycle: 2027 }, { reviewedBy: row.reviewedBy });
    assert.equal(status, "auto_approved");
    await backfill(row.id, status);
    const after = await h.db.query.detectedListings.findFirst({ where: eq(detectedListings.id, row.id) });
    assert.equal(after?.reviewStatus, "auto_approved");
  });
});

describe("the caller", () => {
  const SRC = path.join(process.cwd(), "scripts/monitor-run.ts");

  test("backfillThinListings does not write reviewStatus without the guard", () => {
    const src = fs.readFileSync(SRC, "utf8");
    const start = src.indexOf("async function backfillThinListings");
    assert.ok(start > 0, "backfillThinListings has been renamed - update this test");
    const body = src.slice(start, src.indexOf("\nasync function main(", start));

    // The verdict goes through the policy helper...
    assert.match(body, /reviewStatusAfterReread\(/, "the backfill no longer uses the review-status policy");
    // ...and the write is guarded on reviewedBy in SQL as well.
    assert.match(
      body,
      /isNull\(\s*schema\.detectedListings\.reviewedBy\s*\)/,
      "the backfill's reviewStatus update is not guarded on reviewedBy",
    );
    // And nothing computes the status inline any more, which is how it got out
    // of step with the sibling scripts in the first place.
    assert.equal(
      /reviewStatus:\s*!\w+\.relevant/.test(body),
      false,
      "the backfill is computing reviewStatus inline again",
    );
  });

  test("the promote step still refuses to publish what it always refused", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "scripts/promote-approved-listings.ts"), "utf8");
    assert.match(src, /blockedLanguageError\(/);
    assert.match(src, /hasPublishableUrls\(/);
  });
});
