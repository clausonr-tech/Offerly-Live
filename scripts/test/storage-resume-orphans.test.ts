/**
 * A stored resume that nothing points at does not accumulate.
 *
 * Every upload path writes the bytes into stored_files before it knows
 * whether what follows will succeed: the review path saves the PDF, then
 * checks the pasted job description, then calls the model, and only then
 * writes the resume_reviews row that names the file. A refusal after the save
 * - a blocked word in the posting, a model failure - used to leave 4MB in a
 * table with no owner column, no per-user cap and no sweeper, and most of
 * those refusals never counted against any quota.
 *
 * So two bounds, both tested here against a real Postgres (in-memory PGlite
 * with the real schema): the files nothing references are swept once they are
 * old enough to be certain nobody is still working on them, and one student
 * may only store so many resumes in an hour.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { and, eq, sql } from "drizzle-orm";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { resumeReviews, storedFiles, users } from "@/db/schema";
import { saveResumeFile, sweepOrphanResumeFiles } from "@/lib/resume-storage";

delete process.env.DATABASE_URL;

const PDF = Buffer.from("%PDF-1.4 a resume");
const upload = (name = "resume.pdf") => new File([PDF], name);

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

const student = (h: TestDatabase, email: string) =>
  h.db.insert(users).values({ email, passwordHash: "x" }).returning();

/** Pretends the file was stored long enough ago to be past the grace period. */
async function backdate(h: TestDatabase, key: string, minutesAgo: number): Promise<void> {
  await h.db
    .update(storedFiles)
    .set({ createdAt: new Date(Date.now() - minutesAgo * 60_000) })
    .where(and(eq(storedFiles.kind, "resume"), eq(storedFiles.key, key)));
}

const resumeKeys = async (h: TestDatabase) =>
  (await h.db.select({ key: storedFiles.key }).from(storedFiles).where(eq(storedFiles.kind, "resume"))).map((r) => r.key);

test("a file nothing points at is swept once it is past the grace period", async () => {
  await withDb(async (h) => {
    const orphan = await saveResumeFile(upload());
    await backdate(h, orphan.storageKey, 60);

    await sweepOrphanResumeFiles();
    assert.deepEqual(await resumeKeys(h), [], "the abandoned upload is gone");
  });
});

test("a file a review or a user row names is left alone, however old", async () => {
  await withDb(async (h) => {
    const [u] = await student(h, "jane@example.edu");
    const theirs = await saveResumeFile(upload());
    const reviewed = await saveResumeFile(upload("old.pdf"));
    await h.db.update(users).set({ resumeStoragePath: theirs.storageKey }).where(eq(users.id, u.id));
    await h.db.insert(resumeReviews).values({
      userId: u.id,
      filename: "old.pdf",
      storagePath: reviewed.storageKey,
      score: 70,
      dimensions: [],
      summary: "fine",
      strengths: [],
      improvements: [],
      rewrites: [],
    });
    await backdate(h, theirs.storageKey, 60 * 24 * 90);
    await backdate(h, reviewed.storageKey, 60 * 24 * 90);

    await sweepOrphanResumeFiles();
    assert.deepEqual(
      (await resumeKeys(h)).sort(),
      [theirs.storageKey, reviewed.storageKey].sort(),
      "the resume on the profile and the one a review still needs both stay",
    );
  });
});

test("a file stored moments ago is never swept - a review may still be running", async () => {
  await withDb(async (h) => {
    // This is the window the review path lives in: the bytes are saved, the
    // model is running, and the resume_reviews row does not exist yet.
    const inFlight = await saveResumeFile(upload());
    await sweepOrphanResumeFiles();
    assert.deepEqual(await resumeKeys(h), [inFlight.storageKey], "the in-flight upload survives its own sweep");
  });
});

test("storing a resume sweeps what earlier uploads left behind", async () => {
  await withDb(async (h) => {
    const abandoned = [await saveResumeFile(upload()), await saveResumeFile(upload()), await saveResumeFile(upload())];
    for (const a of abandoned) await backdate(h, a.storageKey, 30);
    assert.equal((await resumeKeys(h)).length, 3);

    // No scheduled job and no cron: the next upload is what collects them.
    const current = await saveResumeFile(upload());
    assert.deepEqual(await resumeKeys(h), [current.storageKey]);
  });
});

test("one student can only store so many resumes in an hour", async () => {
  await withDb(async (h) => {
    const [u] = await student(h, "keen@example.edu");
    for (let i = 0; i < 20; i++) {
      const stored = await saveResumeFile(upload(), u.id);
      // Each one is unreferenced, so keep them out of the sweep's way by
      // leaving them young - the bound under test is the hourly one.
      assert.ok(stored.storageKey);
    }
    await assert.rejects(saveResumeFile(upload(), u.id), /a lot of resume uploads/);

    const [{ n }] = await h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(storedFiles)
      .where(eq(storedFiles.kind, "resume"));
    assert.equal(Number(n), 20, "the refused upload stored nothing");
  });
});

test("the bound is per student: another student is unaffected", async () => {
  await withDb(async (h) => {
    const [a] = await student(h, "a@example.edu");
    const [b] = await student(h, "b@example.edu");
    for (let i = 0; i < 20; i++) await saveResumeFile(upload(), a.id);
    await assert.rejects(saveResumeFile(upload(), a.id), /a lot of resume uploads/);
    const theirs = await saveResumeFile(upload(), b.id);
    assert.ok(theirs.storageKey, "b's first upload goes through");
  });
});
