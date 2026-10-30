/**
 * Free text reaching a paid model is bounded server-side.
 *
 * Before these caps the only bound on the draft brief and the pasted job
 * posting was the 4.4mb server-action body limit, while a quota unit is a row
 * rather than tokens - so one allowed draft or review could carry an arbitrary
 * prompt. Both caps are checked here against a REAL database, and the draft
 * cap is asserted to fire before anything is spent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { users } from "@/db/schema";

const USER_ID = "33333333-3333-4333-8333-333333333333";

async function withStudent(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "caps@example.edu",
      passwordHash: "x",
      name: "Caps Student",
      plan: "pro",
      school: "University of Southern California",
      gradYear: 2028,
    });
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

test("an over-long draft brief field is refused by name", async () => {
  await withStudent(async () => {
    const { generateDraft } = await import("@/app/(app)/drafts/actions");
    const form = new FormData();
    form.set("recipient", "outside");
    form.set("occasion", "cold_outreach");
    form.set("wantToLearn", "x".repeat(2001));
    const result = await generateDraft(undefined, form);
    assert.match(result?.error ?? "", /too long/i);
    assert.match(result?.error ?? "", /What you want to learn from them/);
  });
});

test("extraContext gets its own, larger cap", async () => {
  await withStudent(async () => {
    const { generateDraft } = await import("@/app/(app)/drafts/actions");
    const under = new FormData();
    under.set("recipient", "outside");
    under.set("occasion", "cold_outreach");
    under.set("extraContext", "x".repeat(3999));
    const ok = await generateDraft(undefined, under);
    assert.doesNotMatch(ok?.error ?? "", /too long/i, "under its cap, length is not the complaint");

    const over = new FormData();
    over.set("recipient", "outside");
    over.set("occasion", "cold_outreach");
    over.set("extraContext", "x".repeat(4001));
    const refused = await generateDraft(undefined, over);
    assert.match(refused?.error ?? "", /too long/i);
  });
});

test("a megabyte brief is refused without a session, quota or model call", async () => {
  await withStudent(async () => {
    const { generateDraft } = await import("@/app/(app)/drafts/actions");
    const form = new FormData();
    form.set("recipient", "outside");
    form.set("occasion", "cold_outreach");
    form.set("financeInterest", "x".repeat(1_000_000));
    // No asStudent() wrapper: the cap fires before the session is read, so a
    // huge payload costs nothing at all. (A later gate would throw without a
    // request context, which is what proves the ordering.)
    const result = await generateDraft(undefined, form);
    assert.match(result?.error ?? "", /too long/i);
  });
});

test("an over-long pasted job posting is refused before the upload is stored", async () => {
  await withStudent(async (h) => {
    const { reviewUploadedResume } = await import("@/app/(app)/outreach/resume-actions");
    const form = new FormData();
    form.set("jobDescription", "x".repeat(20_001));
    form.set("resume", new File([new Uint8Array([1, 2, 3])], "cv.pdf", { type: "application/pdf" }));
    const result = await asStudent(h.db, USER_ID, () => reviewUploadedResume(undefined, form), {
      route: "/outreach/email",
    });
    assert.match(result?.error ?? "", /too long/i);
    // Nothing was stored for a refused review.
    const { resumeReviews } = await import("@/db/schema");
    const rows = await h.db.select().from(resumeReviews);
    assert.equal(rows.length, 0, "a refused review leaves no row");
  });
});
