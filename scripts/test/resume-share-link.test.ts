/**
 * The Resume Link can be turned off, replaced, and runs out.
 *
 * /r/<token> serves a student's resume to anyone holding the link, with no
 * session: the token is the whole credential. The privacy policy promises the
 * student can turn it off ("the old link stops working immediately") and
 * replace it - but nothing in the codebase wrote users.resume_share_token at
 * all, so a token already in the table was permanent, survived every resume
 * replacement, and ended only when the account was deleted.
 *
 * This covers the writing half (lib/resume-share), the route's answers, and
 * the two ways a link's life is bounded: a token minted now carries the day
 * it was issued, and the undateable tokens that predate the fix share one
 * sunset. An expired link says so rather than 404ing, because "not found" is
 * the wrong thing to tell a recruiter who was sent a working link last term.
 *
 * Real Postgres (in-memory PGlite with the real schema), no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { users } from "@/db/schema";
import { saveResumeFile } from "@/lib/resume-storage";
import {
  LEGACY_TOKEN_SUNSET,
  resolveResumeShareLink,
  revokeResumeShareLink,
  rotateResumeShareLink,
  tokenExpired,
  tokenIssuedAt,
} from "@/lib/resume-share";

delete process.env.DATABASE_URL;

const PDF = Buffer.from("%PDF-1.4 a resume");
/** A token of the shape the removed writer left in the table: hex, undateable. */
const LEGACY_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const DAY = 86_400_000;

async function withDb(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

/** A student with a resume on file and the given share token. */
async function sharingStudent(h: TestDatabase, token: string | null, email = "jane@example.edu"): Promise<string> {
  const resume = await saveResumeFile(new File([PDF], "resume.pdf"));
  const [u] = await h.db
    .insert(users)
    .values({
      email,
      passwordHash: "x",
      resumeStoragePath: resume.storageKey,
      resumeFilename: "resume.pdf",
      resumeShareToken: token,
    })
    .returning();
  return u.id;
}

const open = async (token: string) => {
  const { GET } = await import("@/app/r/[token]/route");
  return GET(new Request(`https://offerly.test/r/${token}`), { params: Promise.resolve({ token }) });
};

test("a link that predates the fix still opens, and serves the resume inline", async () => {
  await withDb(async (h) => {
    await sharingStudent(h, LEGACY_TOKEN);
    const res = await open(LEGACY_TOKEN);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/pdf");
    assert.match(res.headers.get("Content-Disposition") ?? "", /^inline; filename="resume\.pdf"$/);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF);
  });
});

test("turning it off stops the link working - the whole point of a revocable token", async () => {
  await withDb(async (h) => {
    const userId = await sharingStudent(h, LEGACY_TOKEN);
    assert.equal((await open(LEGACY_TOKEN)).status, 200);

    await revokeResumeShareLink(userId);

    assert.equal((await open(LEGACY_TOKEN)).status, 404);
    assert.deepEqual(await resolveResumeShareLink(LEGACY_TOKEN), { status: "missing" });
    const [row] = await h.db.select({ token: users.resumeShareToken }).from(users).where(eq(users.id, userId));
    assert.equal(row.token, null, "the credential is not just ignored, it is gone from the row");
  });
});

test("replacing it gives a new link and kills the old one", async () => {
  await withDb(async (h) => {
    const userId = await sharingStudent(h, LEGACY_TOKEN);
    const fresh = await rotateResumeShareLink(userId);

    assert.notEqual(fresh, LEGACY_TOKEN);
    assert.ok(fresh.length >= 16, "long enough for the route to look it up at all");
    assert.equal((await open(LEGACY_TOKEN)).status, 404, "the forwarded link is dead");
    assert.equal((await open(fresh)).status, 200, "the new one works");
  });
});

test("a minted token says when it was issued, and runs out", async () => {
  await withDb(async (h) => {
    const issuedOn = new Date("2026-10-10T12:00:00Z");
    const userId = await sharingStudent(h, null);
    const token = await rotateResumeShareLink(userId, issuedOn);

    const issued = tokenIssuedAt(token);
    assert.ok(issued, "the token carries its own date");
    assert.ok(Math.abs(issued.getTime() - issuedOn.getTime()) < DAY, "to the day");

    assert.equal((await resolveResumeShareLink(token, new Date(issuedOn.getTime() + 30 * DAY))).status, "ok");
    assert.equal((await resolveResumeShareLink(token, new Date(issuedOn.getTime() + 200 * DAY))).status, "expired");
  });
});

test("the tokens that cannot be dated all end at the sunset - and say so", async () => {
  await withDb(async (h) => {
    await sharingStudent(h, LEGACY_TOKEN);
    assert.equal(tokenIssuedAt(LEGACY_TOKEN), null, "nothing in the old token records when it was handed out");
    assert.equal(tokenExpired(LEGACY_TOKEN, new Date(LEGACY_TOKEN_SUNSET.getTime() - DAY)), false);
    assert.equal(tokenExpired(LEGACY_TOKEN, LEGACY_TOKEN_SUNSET), true);

    const after = await resolveResumeShareLink(LEGACY_TOKEN, new Date(LEGACY_TOKEN_SUNSET.getTime() + DAY));
    assert.equal(after.status, "expired");
  });
});

test("an expired link gets an explanation, not a 404", async () => {
  await withDb(async (h) => {
    const userId = await sharingStudent(h, null);
    // Issued last year: expired by its own date, whatever today is.
    const stale = await rotateResumeShareLink(userId, new Date(Date.now() - 400 * DAY));

    const res = await open(stale);
    assert.equal(res.status, 410, "gone, not missing");
    assert.match(await res.text(), /expired/i);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });
});

test("an unknown token is not found, and a short one is not even looked up", async () => {
  await withDb(async (h) => {
    await sharingStudent(h, LEGACY_TOKEN);
    assert.deepEqual(await resolveResumeShareLink("f".repeat(32)), { status: "missing" });
    assert.deepEqual(await resolveResumeShareLink("short"), { status: "missing" });
    assert.equal((await open("short")).status, 404);
  });
});

test("one link cannot be pulled on forever: fetches are bounded per student", async () => {
  await withDb(async (h) => {
    await sharingStudent(h, LEGACY_TOKEN);
    let allowed = 0;
    let throttled = 0;
    for (let i = 0; i < 130; i++) {
      const out = await resolveResumeShareLink(LEGACY_TOKEN);
      if (out.status === "ok") allowed++;
      else if (out.status === "throttled") throttled++;
    }
    assert.ok(allowed > 0 && allowed <= 120, `served ${allowed} times in an hour`);
    assert.ok(throttled > 0, "and then refused");
  });
});
