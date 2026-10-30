import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { resumeReviews, storedFiles, users } from "@/db/schema";
import { rateLimit } from "./rate-limit";
import { extensionOf, isAllowedResume, RESUME_TYPES_LABEL } from "./resume-formats";
import { deleteStoredFiles, getStoredFile, MAX_FILE_BYTES, putStoredFile } from "./file-store";

/**
 * Confirms the uploaded bytes really are the kind of file the name claims,
 * by the file's own leading bytes rather than its extension or the
 * Content-Type the browser volunteered - both of which the uploader controls.
 * Same reasoning as avatar-storage's isJpeg, extended to every resume type.
 *
 * A file that is served back inline (see /r/[token], /api/resume/current and
 * the firm resume route) must not be, say, an HTML document wearing a .pdf
 * name. The serving routes already sandbox and send X-Content-Type-Options:
 * nosniff; this is the matching upload-time check so the two ends agree.
 *
 * Text is the one exception: a .txt is inherently safe to store and is served
 * as text/plain with nosniff, which a browser will not reinterpret as markup,
 * so there is no signature to demand and no legitimate text resume to reject.
 */
export function resumeBytesMatchExtension(name: string, bytes: Uint8Array): boolean {
  const ext = extensionOf(name);
  const at = (offset: number, sig: readonly number[]) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

  switch (ext) {
    case ".txt":
      return true;
    case ".pdf": {
      // "%PDF" - tolerate a few leading bytes (BOM/whitespace) some tools add.
      const head = bytes.subarray(0, 1024);
      for (let i = 0; i + 4 <= head.length; i++) {
        if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) {
          return true;
        }
      }
      return false;
    }
    case ".docx":
      // OOXML is a zip: "PK\x03\x04" (also the empty/spanned zip markers).
      return at(0, [0x50, 0x4b, 0x03, 0x04]) || at(0, [0x50, 0x4b, 0x05, 0x06]) || at(0, [0x50, 0x4b, 0x07, 0x08]);
    case ".doc":
      // Legacy Word is an OLE compound file.
      return at(0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case ".png":
      return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case ".jpg":
    case ".jpeg":
      return at(0, [0xff, 0xd8, 0xff]);
    case ".webp":
      // "RIFF" .... "WEBP"
      return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]);
    default:
      return false;
  }
}

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain",
};

export function resumeContentType(name: string): string {
  return MIME_TYPES[extensionOf(name)] ?? "application/octet-stream";
}

export type StoredResume = { originalName: string; storageKey: string };

/**
 * How many resume files one student may store in an hour.
 *
 * A stored file is 4MB of shared database, and every upload path stores
 * before it knows whether what follows will succeed - a review that is
 * refused, a read that fails, a tab that is closed. Uploading a resume a few
 * times while iterating on it is ordinary; a hundred times in an hour is not
 * a student working on their resume.
 */
const UPLOADS_PER_HOUR = 20;

/**
 * How long a stored resume is left alone before it counts as abandoned.
 *
 * A file is stored before the row that points at it exists: the review path
 * saves the PDF, calls the model, and only then writes the resume_reviews
 * row. For those seconds the file is referenced by nothing, so the sweep must
 * not be able to pull it out from under a review that is still running.
 * Fifteen minutes is far longer than any upload takes to be claimed and short
 * enough that a refused review's file does not sit around.
 */
const ORPHAN_GRACE_MS = 15 * 60 * 1000;

/**
 * Removes stored resumes that nothing points at any more.
 *
 * stored_files has no owner column, so "whose file is this?" is answered the
 * only way it can be: a resume blob is wanted if a user row or a resume
 * review names its key. Every other resume blob older than the grace period
 * is an upload that was refused, failed or abandoned after the bytes were
 * saved - most of which never counted against any quota, so nothing else
 * bounds how many a student can leave behind. Best-effort: losing a sweep is
 * never worth failing the upload that triggered it.
 */
export async function sweepOrphanResumeFiles(now = new Date()): Promise<void> {
  try {
    const db = await getDb();
    await db
      .delete(storedFiles)
      .where(
        and(
          eq(storedFiles.kind, "resume"),
          lt(storedFiles.createdAt, new Date(now.getTime() - ORPHAN_GRACE_MS)),
          sql`not exists (select 1 from ${users} where ${users.resumeStoragePath} = ${storedFiles.key})`,
          sql`not exists (select 1 from ${resumeReviews} where ${resumeReviews.storagePath} = ${storedFiles.key})`,
        ),
      );
  } catch (e) {
    console.error("[resume-storage] orphan sweep failed", e);
  }
}

// Saves an uploaded resume under a random key (never the user-supplied name,
// so two "resume.pdf" uploads cannot collide) and returns what to persist on
// the user row, plus the bytes so the caller can read the file without
// fetching it straight back.
//
// `ownerId` is the student the upload belongs to, when the caller knows it:
// it is what the hourly bound is counted against. Callers that pass nothing
// are still bounded by the sweep below, which is the backstop for a file no
// row ever claims.
export async function saveResumeFile(file: File, ownerId?: string): Promise<StoredResume & { bytes: Buffer }> {
  if (!isAllowedResume(file.name)) {
    throw new Error(`Resume must be a ${RESUME_TYPES_LABEL}.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Resume must be under 4MB.");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!resumeBytesMatchExtension(file.name, bytes)) {
    throw new Error(`That file does not look like a ${RESUME_TYPES_LABEL}. Please upload the original document.`);
  }

  // Checked after the cheap checks and before the bytes are written: the
  // point of the bound is the storage, not the validation.
  if (ownerId) {
    const { allowed } = await rateLimit("resume-upload", ownerId, UPLOADS_PER_HOUR, 60 * 60 * 1000);
    if (!allowed) {
      throw new Error("That's a lot of resume uploads in one hour. Try again later.");
    }
  }

  const storageKey = `${randomUUID()}${extensionOf(file.name)}`;
  await putStoredFile("resume", storageKey, resumeContentType(file.name), bytes);
  // After the new file is safely stored, not before: the sweep's job is the
  // files left behind by earlier uploads, and it must never be a reason this
  // one fails.
  await sweepOrphanResumeFiles();

  return { originalName: file.name, storageKey, bytes };
}

/** A stored resume's bytes, or null when the key holds no file. */
export async function readResumeFile(storageKey: string): Promise<Buffer | null> {
  return (await getStoredFile("resume", storageKey))?.bytes ?? null;
}

/** Best-effort cleanup of resumes nothing points at any more. */
export async function deleteResumeFiles(storageKeys: string[]): Promise<void> {
  await deleteStoredFiles("resume", storageKeys).catch(() => undefined);
}
