import "server-only";
import { randomUUID } from "node:crypto";
import { deleteStoredFiles, getStoredFile, MAX_FILE_BYTES, putStoredFile } from "./file-store";
import { sanitiseImage } from "./image-sanitise";

/**
 * Images attached to feed posts.
 *
 * Deliberately a near-copy of lib/avatar-storage rather than a shared
 * abstraction over both: the two differ in what they accept (an avatar is
 * JPEG only; a post image takes PNG too, because screenshots are PNG and a
 * screenshot is most of what gets attached to a recruiting post) and in where
 * they are served from. Folding them together would mean a options bag on
 * every call and one file that has to be right for two callers.
 */

/** Extension and served content-type, keyed by what the bytes actually are. */
const TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
} as const;

type PostImageExt = keyof typeof TYPES;

/**
 * What the file IS, from its own first bytes - never its name and never the
 * Content-Type the browser volunteered, both of which are supplied by whoever
 * is uploading and can say anything. Every JPEG starts FF D8 FF; every PNG
 * starts with the eight-byte signature below.
 */
function sniff(bytes: Uint8Array): PostImageExt | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > 8 && PNG.every((b, i) => bytes[i] === b)) return "png";
  return null;
}

/** The keys this module generates, and the only shape it will read back. */
const KEY_PATTERN = /^[0-9a-f-]{36}\.(jpg|png)$/i;

export function contentTypeFor(storageKey: string): string | null {
  const ext = storageKey.split(".").pop()?.toLowerCase();
  return ext && ext in TYPES ? TYPES[ext as PostImageExt] : null;
}

export async function savePostImage(file: File): Promise<{ storageKey: string }> {
  if (file.size === 0) throw new Error("That file is empty.");
  if (file.size > MAX_FILE_BYTES) throw new Error("Image must be under 4MB.");

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = sniff(buffer);
  if (!ext) throw new Error("Image must be a JPEG or PNG.");

  // Random name, never the supplied one: a user-chosen filename is a path
  // traversal waiting to happen, and two people attaching "screenshot.png"
  // must not collide. Same reasoning as saveAvatarFile and saveResumeFile.
  // Re-encoded, never the uploaded bytes: a screenshot is harmless but a
  // camera photo carries EXIF GPS, and these are shown to every signed-in
  // user. See lib/image-sanitise.
  const clean = await sanitiseImage(buffer, ext);

  const storageKey = `${randomUUID()}.${ext}`;
  await putStoredFile("post-image", storageKey, TYPES[ext], clean);
  return { storageKey };
}

/** Reads a stored image, or null when the key does not resolve to one. */
export async function readPostImage(storageKey: string): Promise<Buffer | null> {
  // The key is generated here and is always a bare uuid.ext, so anything
  // carrying a separator did not come from this module.
  if (!KEY_PATTERN.test(storageKey)) return null;
  return (await getStoredFile("post-image", storageKey))?.bytes ?? null;
}

/** Best-effort cleanup when a post is deleted or an upload is abandoned. */
export async function deletePostImage(storageKey: string | null | undefined) {
  if (!storageKey || !KEY_PATTERN.test(storageKey)) return;
  // Losing the file is not worth failing whatever operation removed the row.
  await deleteStoredFiles("post-image", [storageKey]).catch(() => undefined);
}
