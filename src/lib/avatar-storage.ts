import "server-only";
import { randomUUID } from "node:crypto";
import { deleteStoredFiles, getStoredFile, MAX_FILE_BYTES, putStoredFile } from "./file-store";
import { sanitiseImage } from "./image-sanitise";

/**
 * JPEG only, checked by the file's own first bytes rather than its name or the
 * Content-Type the browser volunteered.
 *
 * Both of those are supplied by whoever is uploading: a .jpg extension and an
 * image/jpeg type can be put on anything. The magic number cannot - every JPEG
 * starts FF D8 FF - so this is the one check that says the bytes really are an
 * image before they are stored somewhere the app will serve them back.
 */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** The keys this module generates, and the only shape it will read back. */
const KEY_PATTERN = /^[0-9a-f-]{36}\.jpg$/i;

export type StoredAvatar = { storageKey: string };

export async function saveAvatarFile(file: File): Promise<StoredAvatar> {
  if (file.size === 0) throw new Error("That file is empty.");
  if (file.size > MAX_FILE_BYTES) throw new Error("Photo must be under 4MB.");

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!isJpeg(buffer)) throw new Error("Photo must be a JPEG (.jpg).");

  // Random name, never the one supplied: two people uploading "me.jpg" must
  // not collide. Same reasoning as saveResumeFile.
  // Re-encoded, never the uploaded bytes: a phone photo carries EXIF GPS, and
  // the magic number only proves the file opens with FF D8 FF. See
  // lib/image-sanitise.
  const clean = await sanitiseImage(buffer, "jpg");

  const storageKey = `${randomUUID()}.jpg`;
  await putStoredFile("avatar", storageKey, "image/jpeg", clean);
  return { storageKey };
}

/** Reads a stored avatar, or null when the key does not resolve to one. */
export async function readAvatarFile(storageKey: string): Promise<Buffer | null> {
  if (!KEY_PATTERN.test(storageKey)) return null;
  return (await getStoredFile("avatar", storageKey))?.bytes ?? null;
}

/** Best-effort cleanup when a photo is replaced or removed. */
export async function deleteAvatarFile(storageKey: string | null | undefined) {
  if (!storageKey || !KEY_PATTERN.test(storageKey)) return;
  // Losing the old photo is not worth failing the upload that replaced it.
  await deleteStoredFiles("avatar", [storageKey]).catch(() => undefined);
}
