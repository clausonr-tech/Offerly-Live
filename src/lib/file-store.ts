import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { storedFiles } from "@/db/schema";

/**
 * Where uploaded files live: the stored_files table.
 *
 * Not the local disk, which is what this replaced. The deployed app runs on
 * servers with no disk that lasts from one request to the next, and in local
 * development a file written to one person's machine is invisible to everyone
 * else pointed at the same database - so a resume uploaded on either showed
 * as missing everywhere else.
 *
 * The callers own what a file may be (size, type, the random key) - see
 * lib/resume-storage, lib/avatar-storage and lib/post-image-storage. This
 * module only stores and returns bytes.
 */

export type FileKind = "resume" | "avatar" | "post-image";

/**
 * The most any one file may be. Vercel refuses a request or response body over
 * 4.5MB, and every upload and download passes through one, so a larger file
 * could be neither saved nor served on the deployed app.
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export async function putStoredFile(kind: FileKind, key: string, contentType: string, bytes: Buffer): Promise<void> {
  const db = await getDb();
  await db
    .insert(storedFiles)
    .values({ kind, key, contentType, bytes, byteSize: bytes.length })
    .onConflictDoUpdate({
      target: [storedFiles.kind, storedFiles.key],
      set: { contentType, bytes, byteSize: bytes.length },
    });
}

/** The file, or null when nothing is stored under that key. */
export async function getStoredFile(
  kind: FileKind,
  key: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const db = await getDb();
  const [row] = await db
    .select({ bytes: storedFiles.bytes, contentType: storedFiles.contentType })
    .from(storedFiles)
    .where(and(eq(storedFiles.kind, kind), eq(storedFiles.key, key)))
    .limit(1);
  if (!row) return null;
  // postgres-js returns a Buffer, PGlite a plain Uint8Array.
  return { bytes: Buffer.from(row.bytes), contentType: row.contentType };
}

/** Removes files. Missing keys are ignored - the goal is that they are gone. */
export async function deleteStoredFiles(kind: FileKind, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await getDb();
  await db.delete(storedFiles).where(and(eq(storedFiles.kind, kind), inArray(storedFiles.key, keys)));
}
