// Uploaded files live in the database (stored_files), not on the local disk:
// the deployed app has no disk that lasts between requests, and a file on one
// developer's machine is invisible to everyone else sharing the database.
//
// Runs against an in-memory PGlite migrated from drizzle/*.sql - never the
// live database. Plus source checks that nothing writes uploads to disk again.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import "./helpers/no-network";
import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { users } from "@/db/schema";
import { MAX_FILE_BYTES } from "@/lib/file-store";
import { deleteResumeFiles, readResumeFile, saveResumeFile } from "@/lib/resume-storage";
import { findStudentResume, readStudentResume } from "@/lib/resume-file";
import { jpeg, metadataOf, png } from "./helpers/images";
import { deleteAvatarFile, readAvatarFile, saveAvatarFile } from "@/lib/avatar-storage";
import { contentTypeFor, deletePostImage, readPostImage, savePostImage } from "@/lib/post-image-storage";

delete process.env.DATABASE_URL;

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
  JPEG = await jpeg();
  PNG = await png();
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

// Real pictures, not magic numbers with filler: an image upload is decoded and
// re-encoded to strip EXIF now (lib/image-sanitise), so bytes that merely begin
// FF D8 FF are refused. The format each one is SERVED as is what these tests
// check, since the stored bytes are the app's own encoding, not the upload.
// Built in `before`, because tsx compiles a .ts test as CJS and has no
// top-level await.
let JPEG: Buffer<ArrayBuffer>;
let PNG: Buffer<ArrayBuffer>;
const PDF = Buffer.from("%PDF-1.4 a resume");
const TOO_BIG = Buffer.alloc(MAX_FILE_BYTES + 1, 0xff);

test("a resume round-trips, and reaches the student through their user row", async () => {
  const stored = await saveResumeFile(new File([PDF], "Jane Resume.pdf"));
  assert.match(stored.storageKey, /^[0-9a-f-]{36}\.pdf$/, "a random key, never the uploaded name");
  assert.deepEqual(stored.bytes, PDF);
  assert.deepEqual(await readResumeFile(stored.storageKey), PDF);

  const [u] = await h.db
    .insert(users)
    .values({ email: "jane@example.edu", passwordHash: "x", resumeStoragePath: stored.storageKey, resumeFilename: "Jane Resume.pdf" })
    .returning();
  const resume = await readStudentResume(await findStudentResume(u.id));
  assert.equal(resume?.filename, "Jane Resume.pdf");
  assert.equal(resume?.mimeType, "application/pdf");
  assert.deepEqual(resume?.bytes, PDF);

  await deleteResumeFiles([stored.storageKey]);
  assert.equal(await readResumeFile(stored.storageKey), null);
  assert.equal(await readStudentResume(await findStudentResume(u.id)), null, "a missing file is null, not a throw");
});

test("a profile photo round-trips as JPEG only, and is removed on delete", async () => {
  const { storageKey } = await saveAvatarFile(new File([JPEG], "me.jpg"));
  assert.equal((await metadataOf((await readAvatarFile(storageKey))!)).format, "jpeg");
  await deleteAvatarFile(storageKey);
  assert.equal(await readAvatarFile(storageKey), null);

  await assert.rejects(saveAvatarFile(new File([PNG], "me.jpg")), /JPEG/);
  assert.equal(await readAvatarFile("../../etc/passwd"), null, "only generated keys are read");
});

test("a post image round-trips as JPEG or PNG with the right type", async () => {
  const stored = await savePostImage(new File([PNG], "shot.png"));
  assert.equal(contentTypeFor(stored.storageKey), "image/png");
  assert.equal((await metadataOf((await readPostImage(stored.storageKey))!)).format, "png");
  await deletePostImage(stored.storageKey);
  assert.equal(await readPostImage(stored.storageKey), null);

  await assert.rejects(savePostImage(new File([PDF], "shot.png")), /JPEG or PNG/);
});

test("every upload is capped under Vercel's 4.5MB body limit", async () => {
  assert.ok(MAX_FILE_BYTES < 4.5 * 1024 * 1024);
  await assert.rejects(saveResumeFile(new File([TOO_BIG], "big.pdf")), /under 4MB/);
  await assert.rejects(saveAvatarFile(new File([TOO_BIG], "big.jpg")), /under 4MB/);
  await assert.rejects(savePostImage(new File([TOO_BIG], "big.png")), /under 4MB/);

  const config = readFileSync("next.config.ts", "utf8");
  const limit = config.match(/bodySizeLimit:\s*"([\d.]+)mb"/)?.[1];
  assert.ok(limit, "next.config.ts sets a server-action body limit");
  const mb = Number(limit);
  assert.ok(mb * 1024 * 1024 > MAX_FILE_BYTES, "the body limit fits a full-size upload");
  assert.ok(mb < 4.5, "the body limit stays under what Vercel accepts");
});

test("no app code reads or writes uploads on the local disk", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && /["']uploads["']|local-data\/uploads/.test(readFileSync(full, "utf8").replace(/^\s*(\/\/|\*).*$/gm, ""))) {
        offenders.push(full);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, [], "uploads belong in stored_files (lib/file-store)");
});
