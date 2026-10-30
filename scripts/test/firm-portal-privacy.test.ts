/**
 * Two things a firm is told about students, both narrowed.
 *
 *   - Analytics floors every student-valued count at MIN_GROUP and says so on
 *     the page ("groups under 5"), but the click counters were printed raw.
 *     recordEngagement writes one row per student per target per ten minutes,
 *     so "Clicks 1" next to "Students: Fewer than 5" said one student clicked
 *     - the precise thing the floor exists to prevent. Asserted at the source,
 *     the way practice-workflows.test.ts asserts its own import rules, because
 *     the leak was in what the page printed rather than in what the lib
 *     returned.
 *   - Student matching told a firm which students had it "on their shortlist"
 *     from user_top_firms with no predicate on `source` - so the app's own
 *     ai_matched suggestions counted as the student's choice, and added +5 to
 *     the student's rank for it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { firms, userTopFirms, users } from "@/db/schema";
import { findMatchingStudents } from "@/lib/firm-matching";
import { EMPTY_CRITERIA } from "@/lib/firm-matching-rules";
import { POLICY_VERSION } from "@/lib/policy";

const ANALYTICS_PAGE = path.join(process.cwd(), "src/app/firms/(portal)/analytics/page.tsx");

/** Every student-derived count the Analytics page prints. */
const COUNTED_FIELDS = [
  "t.notified",
  "t.applyClicks",
  "t.applyClickStudents",
  "t.eventClicks",
  "t.calendarAdds",
  "p.notified",
  "p.applyClicks",
  "p.students",
  "e.notified",
  "e.clicks",
  "e.calendarAdds",
  "w.count",
];

test("the Analytics page never prints a student-derived count unfloored", () => {
  const src = fs.readFileSync(ANALYTICS_PAGE, "utf8");
  const unfloored: string[] = [];
  for (const field of COUNTED_FIELDS) {
    // Every occurrence must sit directly inside countLabel( or visibleCount(.
    let from = 0;
    for (;;) {
      const at = src.indexOf(field, from);
      if (at === -1) break;
      from = at + field.length;
      const before = src.slice(Math.max(0, at - 14), at);
      if (!/(countLabel|visibleCount)\($/.test(before)) {
        unfloored.push(`${field} at offset ${at} (preceded by "${before.trim()}")`);
      }
    }
  }
  assert.deepEqual(
    unfloored,
    [],
    `these counts reach the page unfloored - wrap them in countLabel()/visibleCount():\n  ${unfloored.join("\n  ")}`,
  );
});

const FIRM_ID = "88888888-8888-4888-8888-888888888888";
const MANUAL_ID = "99999999-9999-4999-8999-999999999999";
const AI_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function withSharingStudents(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(firms).values({
      id: FIRM_ID,
      name: "Evercore",
      slug: "evercore",
      headquarters: "New York, NY",
      keyOffices: "New York",
      description: "Independent investment bank.",
      website: "https://evercore.com",
    });
    // Both students are opted in to firm sharing on the current policy.
    for (const [id, email] of [
      [MANUAL_ID, "manual@example.edu"],
      [AI_ID, "ai@example.edu"],
    ] as const) {
      await h.db.insert(users).values({
        id,
        email,
        passwordHash: "x",
        name: email,
        accountType: "student",
        isDemo: false,
        firmSharingOptedInAt: new Date(),
        firmSharingPolicyVersion: POLICY_VERSION,
        consentedPolicyVersion: POLICY_VERSION,
        gradYear: 2028,
        preferredCategories: ["investment_banking"],
      });
    }
    // One student put the firm on their own list; the app suggested it to the other.
    await h.db.insert(userTopFirms).values({ userId: MANUAL_ID, firmId: FIRM_ID, source: "manual" });
    await h.db
      .insert(userTopFirms)
      .values({ userId: AI_ID, firmId: FIRM_ID, source: "ai_matched", reason: "suggested" });
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

test("only a firm the student chose counts as their shortlist", async () => {
  await withSharingStudents(async () => {
    const matched = await findMatchingStudents(FIRM_ID, EMPTY_CRITERIA, false, 50);
    const byEmail = new Map(matched.map((m) => [m.name, m]));
    assert.equal(matched.length, 2, "both opted-in students are matched");

    const manual = byEmail.get("manual@example.edu");
    const ai = byEmail.get("ai@example.edu");
    assert.ok(manual && ai, "both students came back");

    const says = (m: typeof manual) => JSON.stringify(m).includes("shortlist");
    assert.equal(says(manual), true, "the student's own pick is reported");
    assert.equal(says(ai), false, "an app suggestion is not reported as their pick");
  });
});

// The shape a firm's queries select from `users`. A bearer capability or a
// field the consent copy does not cover must never be in it, whether or not
// today's serialiser happens to drop it before the client.
test("the firm-facing profile shape carries no secrets", async () => {
  const { SHARED_PROFILE } = await import("@/lib/firm-sharing");
  const selected = Object.keys(SHARED_PROFILE);
  const forbidden = [
    "resumeShareToken", // a link anyone holding it can fetch the resume with
    "passwordHash",
    "gpaBand", // onboarding promises GPA is never shown to anyone
    "sponsorshipNeeded",
    "phone",
    "resumeText",
    "hometown",
    "stripeCustomerId",
    "stripeSubscriptionId",
    "schoolEmail",
    "pendingSchoolEmail",
    "schoolVerificationCodeHash",
  ];
  const leaked = forbidden.filter((f) => selected.includes(f));
  assert.deepEqual(leaked, [], `these must not be selected for a firm: ${leaked.join(", ")}`);
});
