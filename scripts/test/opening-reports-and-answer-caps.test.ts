/**
 * Two cross-student write paths, bounded, against a REAL database.
 *
 *   - reportOpening's "the firm generally" option stores programCategory NULL,
 *     and Postgres treats NULLs as distinct in a unique index - so the
 *     ON CONFLICT upsert never matched and every press inserted ANOTHER row,
 *     making one student look like as many corroborating sightings as they
 *     pressed the button. The corroboration count is shown to every student on
 *     the firm page.
 *   - the Settings "recruiting answers" save walked the question bank and
 *     trusted raw FormData, so the columns the student directory, the activity
 *     headline and the firms' matching options all read were bounded only by
 *     the 4.4mb action body.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { firms, studentOpeningReports, users } from "@/db/schema";
import { defaultCycleYear } from "@/app/(app)/discovery/firm/[slug]/cycles";
import { eq } from "drizzle-orm";

const USER_ID = "66666666-6666-4666-8666-666666666666";
const FIRM_ID = "77777777-7777-4777-8777-777777777777";

async function withStudent(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "reporter@example.edu",
      passwordHash: "x",
      name: "Reporter",
      plan: "free",
      gradYear: 2028,
    });
    await h.db.insert(firms).values({
      id: FIRM_ID,
      name: "Evercore",
      slug: "evercore",
      headquarters: "New York, NY",
      keyOffices: "New York",
      description: "Independent investment bank.",
      website: "https://evercore.com",
    });
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

function reportForm(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("firmId", FIRM_ID);
  f.set("slug", "evercore");
  // "" is the deliberate "the firm generally" option - the NULL category.
  f.set("programCategory", "");
  f.set("cycleYear", String(defaultCycleYear()));
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

test("'the firm generally' reports from one student stay one row", async () => {
  await withStudent(async (h) => {
    const { reportOpening } = await import("@/app/(app)/discovery/firm/[slug]/actions");
    for (let i = 0; i < 4; i++) {
      const out = await asStudent(h.db, USER_ID, () => reportOpening(undefined, reportForm({ note: `seen ${i}` })), {
        route: "/discovery/firm/evercore",
      });
      assert.ok(out?.success, `press ${i + 1} should be accepted: ${out?.error ?? ""}`);
    }
    const rows = await h.db
      .select()
      .from(studentOpeningReports)
      .where(eq(studentOpeningReports.reportedByUserId, USER_ID));
    assert.equal(rows.length, 1, "one student, one sighting - not four");
    assert.equal(rows[0].note, "seen 3", "the latest correction is kept");
  });
});

test("an over-long note is refused and nothing is written", async () => {
  await withStudent(async (h) => {
    const { reportOpening } = await import("@/app/(app)/discovery/firm/[slug]/actions");
    const out = await asStudent(
      h.db,
      USER_ID,
      () => reportOpening(undefined, reportForm({ note: "x".repeat(501) })),
      { route: "/discovery/firm/evercore" },
    );
    assert.match(out?.error ?? "", /under 500 characters/);
    const rows = await h.db.select().from(studentOpeningReports);
    assert.equal(rows.length, 0);
  });
});

test("the Settings answer save refuses an answer past its ceiling", async () => {
  await withStudent(async (h) => {
    const { saveRecruitingAnswers } = await import("@/app/(app)/settings/recruiting-actions");
    const form = new FormData();
    form.set("major", "x".repeat(201));
    const out = await asStudent(h.db, USER_ID, () => saveRecruitingAnswers(undefined, form), {
      route: "/settings",
    });
    assert.match(out?.error ?? "", /too long/i);
    const [row] = await h.db.select({ major: users.major }).from(users).where(eq(users.id, USER_ID));
    assert.notEqual(row.major, "x".repeat(201), "nothing oversized was stored");
  });
});

test("the Settings answer save refuses too many items in one answer", async () => {
  await withStudent(async (h) => {
    const { saveRecruitingAnswers } = await import("@/app/(app)/settings/recruiting-actions");
    const form = new FormData();
    for (let i = 0; i < 61; i++) form.append("targetLocations", `City ${i}`);
    const out = await asStudent(h.db, USER_ID, () => saveRecruitingAnswers(undefined, form), {
      route: "/settings",
    });
    assert.match(out?.error ?? "", /more than this answer can hold/i);
  });
});

test("a sector that is not a real category is not stored", async () => {
  await withStudent(async (h) => {
    const { saveRecruitingAnswers } = await import("@/app/(app)/settings/recruiting-actions");
    const form = new FormData();
    form.append("preferredCategories", "investment_banking");
    form.append("preferredCategories", "not_a_real_sector");
    await asStudent(h.db, USER_ID, () => saveRecruitingAnswers(undefined, form), { route: "/settings" });
    const [row] = await h.db
      .select({ cats: users.preferredCategories })
      .from(users)
      .where(eq(users.id, USER_ID));
    assert.deepEqual(row.cats, ["investment_banking"], "the made-up sector is dropped");
  });
});
