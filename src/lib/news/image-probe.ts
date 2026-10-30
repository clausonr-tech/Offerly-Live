import { NEWS_USER_AGENT } from "./fetch";
import { readCapped, safeFetch } from "./safe-fetch";
import { aiImageMarker } from "./quality";

// What a candidate photo actually is, read from its own bytes: the format and
// the pixel size. A URL says nothing reliable - a "1200x630" in a filename can
// sit on a 150px thumbnail, and a .jpg can be a tracking pixel.

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "avif" | "other";
export type ImageInfo = { format: ImageFormat; width: number | null; height: number | null };

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Format and dimensions from the first bytes of an image file. Width and height are null when the header is cut short. */
export function imageInfo(buf: Buffer): ImageInfo {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // Markers with no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      if (JPEG_SOF.has(marker)) return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { format: "jpeg", width: null, height: null };
  }
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("latin1", 0, 4) === "GIF8") {
    return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return { format: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const [b0, b1, b2, b3] = [buf[21], buf[22], buf[23], buf[24]];
      return { format: "webp", width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (chunk === "VP8X") return { format: "webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return { format: "webp", width: null, height: null };
  }
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp" && /avi[fs]/.test(buf.toString("latin1", 8, 12))) {
    const ispe = buf.indexOf("ispe", 0, "latin1");
    if (ispe > 0 && ispe + 16 <= buf.length) return { format: "avif", width: buf.readUInt32BE(ispe + 8), height: buf.readUInt32BE(ispe + 12) };
    return { format: "avif", width: null, height: null };
  }
  return { format: "other", width: null, height: null };
}

// A card is 16:9. A photo narrower than 500px blurs at card size, and one
// taller than it is wide loses the subject's face to the crop.
const MIN_WIDTH = 500;
const MIN_HEIGHT = 260;
export const MIN_ASPECT = 1.1;
export const MAX_ASPECT = 2.6;
const MAX_BYTES = 4_000_000;

export type ProbeResult =
  | { ok: true; info: ImageInfo; bytes: Buffer }
  | { ok: false; reason: "unreachable" | "not_an_image" | "too_large" | "too_small" | "wrong_shape" | "animated_or_vector" | "ai_generated" };

/** Size and shape rules alone, for a photo whose dimensions are known. */
export function shapeProblem(info: ImageInfo): "too_small" | "wrong_shape" | "animated_or_vector" | null {
  if (info.format === "gif" || info.format === "other") return "animated_or_vector";
  if (!info.width || !info.height) return "too_small";
  if (info.width < MIN_WIDTH || info.height < MIN_HEIGHT) return "too_small";
  const aspect = info.width / info.height;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return "wrong_shape";
  return null;
}

/**
 * Download a candidate photo and check it is a real, card-sized, landscape
 * image that does not say an AI made it. The bytes come back for the vision
 * check, so the photo is fetched once.
 */
export async function probeImage(url: string, timeoutMs = 12_000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { res } = await safeFetch(url, { signal: controller.signal, headers: { "User-Agent": NEWS_USER_AGENT, Accept: "image/*" } });
    const skip = async (reason: "unreachable" | "not_an_image" | "animated_or_vector" | "too_large") => {
      await res.body?.cancel().catch(() => {});
      return { ok: false as const, reason };
    };
    if (!res.ok) return skip("unreachable");
    const type = res.headers.get("content-type") ?? "";
    if (type && !type.startsWith("image/")) return skip("not_an_image");
    if (/svg/.test(type)) return skip("animated_or_vector");
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return skip("too_large");
    // Read at most MAX_BYTES whatever the server claims - a chunked response has no length to check.
    const bytes = await readCapped(res, MAX_BYTES, "reject");
    if (!bytes) return { ok: false, reason: "too_large" };
    const info = imageInfo(bytes);
    const shape = shapeProblem(info);
    if (shape) return { ok: false, reason: shape };
    if (aiImageMarker(bytes.subarray(0, 524_288).toString("latin1"))) return { ok: false, reason: "ai_generated" };
    return { ok: true, info, bytes };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
