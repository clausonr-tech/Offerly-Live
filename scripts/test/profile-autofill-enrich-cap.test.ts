/**
 * The LinkedIn profile-autofill paid lookup is capped per account.
 *
 * Reproduces the credit-burn loop: a profile that fills nothing (its education
 * is for a different school, no About/headline) leaves major and About me
 * empty, so every saved link re-triggers the paid /person/enrich call. Without
 * a cap that is unbounded; with it the paid calls stop at ENRICH_LIMIT.
 *
 * No network: global fetch is replaced by a counting stub for this file only.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { fillEmptyProfileFromLinkedIn } from "@/lib/profile-autofill";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

const ENRICH_URL = "https://api.crustdata.com/person/enrich";
const USER_ID = "11111111-1111-4111-8111-111111111111";

test("paid LinkedIn enrichment is capped per account even when nothing fills", async () => {
  const h: TestDatabase = await createTestDb();
  const restore = installAsAppDb(h.db);
  const prevKey = process.env.CRUSTDATA_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.CRUSTDATA_API_KEY = "dummy-test-key";

  let enrichCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url?: string }).url ?? String(input);
    if (url === ENRICH_URL) {
      enrichCalls++;
      // A profile that fills nothing: education for a different school, no
      // About/headline, so major and About me stay empty.
      const payload = [
        {
          basic_profile: { headline: "", summary: "" },
          education: { schools: [{ school: "Different College", field_of_study: "Art", end_year: 2020 }] },
        },
      ];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "x-credits-used": "1" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "student@example.edu",
      passwordHash: "not-a-real-hash",
      name: "Test Student",
      plan: "free",
      school: "University of Southern California",
      major: "",
      aboutMe: "",
    });

    for (let i = 0; i < 6; i++) {
      const filled = await fillEmptyProfileFromLinkedIn(
        USER_ID,
        `https://www.linkedin.com/in/test-${i}`,
      );
      assert.deepEqual(filled, {}, "a non-matching profile fills nothing");
    }

    assert.equal(enrichCalls, 3, "paid enrichment is capped at 3 per account per day");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.CRUSTDATA_API_KEY;
    else process.env.CRUSTDATA_API_KEY = prevKey;
    restore();
    await h.close();
  }
});

test("provider profile text is language-checked before it is stored", async () => {
  // users.about_me and users.major are shown on the public profile, in the
  // student directory and in the firms' matching options, so the project rule
  // is that they carry the blocked-language check. This text is not typed by
  // the student: it is whatever is on the LinkedIn profile the URL pointed at,
  // and that URL is only host-checked, never proved to be theirs.
  const h: TestDatabase = await createTestDb();
  const restore = installAsAppDb(h.db);
  const prevKey = process.env.CRUSTDATA_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.CRUSTDATA_API_KEY = "dummy-test-key";

  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url?: string }).url ?? String(input);
    if (url !== ENRICH_URL) throw new Error(`unexpected fetch to ${url}`);
    const payload = [
      {
        // One of the project's own profanity fixtures (scripts/content-limits-test.ts).
        basic_profile: { headline: "", summary: "this is bullshit" },
        education: {
          schools: [
            { school: "University of Southern California", field_of_study: "Economics", end_year: 2028 },
          ],
        },
      },
    ];
    return new Response(JSON.stringify(payload), { status: 200, headers: { "x-credits-used": "1" } });
  }) as typeof fetch;

  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "checked@example.edu",
      passwordHash: "not-a-real-hash",
      name: "Checked Student",
      plan: "free",
      school: "University of Southern California",
      major: "",
      aboutMe: "",
    });

    const filled = await fillEmptyProfileFromLinkedIn(USER_ID, "https://www.linkedin.com/in/checked");

    // The clean field still fills; only the one that fails the check is dropped.
    assert.equal(filled.major, "Economics", "a clean value still fills");
    assert.equal(filled.aboutMe, undefined, "the value with profanity is not stored");

    const [row] = await h.db
      .select({ aboutMe: users.aboutMe, major: users.major })
      .from(users)
      .where(eq(users.id, USER_ID));
    assert.equal(row.aboutMe, "", "nothing blocked reached the column");
    assert.equal(row.major, "Economics");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.CRUSTDATA_API_KEY;
    else process.env.CRUSTDATA_API_KEY = prevKey;
    restore();
    await h.close();
  }
});
