import "server-only";
import sharp from "sharp";

/**
 * Re-encodes an uploaded image so that what gets stored is only the picture.
 *
 * A photo taken on a phone carries EXIF, and EXIF carries GPS coordinates, the
 * camera's serial number and the capture time. Avatars and post images were
 * stored as uploaded - the magic-number check proved the bytes were an image
 * and then saved them verbatim - so a student who attached a photo from their
 * phone published their home or campus location to every signed-in user, and
 * the app's own privacy draft records that as an open product change (P-102,
 * rows G and J of legal/drafts/privacy-policy.md).
 *
 * Decoding and re-encoding is the only reliable strip: there is no short list
 * of segments to remove, because a JPEG can carry EXIF, XMP, IPTC, a Photoshop
 * resource block and arbitrary COM comments, and a PNG can carry eXIf plus any
 * number of text chunks. sharp writes none of them unless asked to.
 *
 * Three other things fall out of the same pass:
 *
 *   - a decompression bomb is refused. The 4MB upload cap bounds the FILE, not
 *     the picture: a few hundred kilobytes of PNG can decode to tens of
 *     gigabytes of pixels. `limitInputPixels` makes that a rejected upload
 *     rather than a dead server.
 *   - the orientation is baked in. EXIF says "rotate this 90°", so stripping
 *     EXIF naively turns every portrait phone photo on its side; `.rotate()`
 *     with no argument applies the tag and then the tag is gone.
 *   - anything hidden after the image data - a polyglot that is a valid JPEG
 *     and also a valid zip or HTML document - does not survive, because only
 *     the decoded pixels are carried across.
 *
 * Unreadable input is refused rather than stored: bytes that start FF D8 FF but
 * are not a picture are not something to serve back to people.
 */

/**
 * The longest edge kept. Large enough that a photo still looks like a photo at
 * any size the app displays (the biggest is the profile header), small enough
 * that one upload cannot cost the image route megabytes per request.
 */
export const MAX_IMAGE_DIMENSION = 2048;

/**
 * The most pixels this will decode. Well above any real photo - a 50MP camera
 * is more than any phone - and far below the size a crafted file asks for.
 */
const MAX_INPUT_PIXELS = 50_000_000;

export type SanitisedFormat = "jpg" | "png";

/**
 * The picture, re-encoded, with no metadata of any kind and no more than
 * MAX_IMAGE_DIMENSION on its longest edge. Throws a message fit to show the
 * person uploading when the bytes cannot be read as the format they claim.
 */
export async function sanitiseImage(bytes: Buffer, format: SanitisedFormat): Promise<Buffer> {
  try {
    // animated: false - a multi-frame file is reduced to its first frame, so an
    // APNG cannot smuggle frames past the size cap.
    const input = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false });

    // What sharp thinks it is, before anything decodes it. Both callers sniff
    // the magic number first, so this should never disagree - and that is
    // exactly why it is checked here instead of trusted there. sharp opens far
    // more than two formats, and one of them is SVG, which it renders through
    // librsvg: a library with its own stream of vulnerabilities (the advisory
    // that moved this dependency to 0.35.5 was one) and the ability to be asked
    // to pull in external resources. A caller that one day sniffs a third
    // format, or sniffs it wrongly, must not be the only thing standing between
    // an upload and that decoder.
    const { format: actual } = await input.metadata();
    if (actual !== "jpeg" && actual !== "png") throw new Error(`refusing to decode ${actual ?? "unknown"}`);

    const pipeline = input
      .rotate()
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      });

    // No withMetadata() anywhere: that is the call that would copy EXIF across,
    // and its absence is the whole point of this module.
    const out =
      format === "jpg"
        ? await pipeline.jpeg({ quality: 86, chromaSubsampling: "4:2:0" }).toBuffer()
        : await pipeline.png({ compressionLevel: 9 }).toBuffer();

    if (out.length === 0) throw new Error("empty output");
    return out;
  } catch {
    throw new Error("That image could not be read. Try saving it again and re-uploading.");
  }
}
