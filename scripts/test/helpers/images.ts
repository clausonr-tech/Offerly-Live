/**
 * Real image bytes for tests.
 *
 * The storage modules used to accept anything beginning with the right magic
 * number, so eight hand-written bytes were a usable "JPEG". They are now
 * decoded and re-encoded to strip EXIF (lib/image-sanitise), so a test needs a
 * file that actually opens - and, for the metadata tests, one that actually
 * carries GPS coordinates.
 *
 * Built with sharp rather than checked in as base64 so the fixtures say what
 * they are.
 */

import sharp from "sharp";

export type Pixels = { width: number; height: number };

/** A plain JPEG of a solid colour, with no metadata at all. */
export async function jpeg({ width, height }: Pixels = { width: 8, height: 8 }) {
  // Buffer.from, so the result is a Buffer<ArrayBuffer> that `new File([...])`
  // accepts; sharp types its own output as Buffer<ArrayBufferLike>.
  const create = { width, height, channels: 3 as const, background: { r: 200, g: 40, b: 40 } };
  return Buffer.from(await sharp({ create }).jpeg().toBuffer());
}

/** A plain PNG of a solid colour, with no metadata at all. */
export async function png({ width, height }: Pixels = { width: 8, height: 8 }) {
  const create = { width, height, channels: 4 as const, background: { r: 20, g: 90, b: 200, alpha: 1 } };
  return Buffer.from(await sharp({ create }).png().toBuffer());
}

/**
 * A JPEG carrying what a phone writes: GPS coordinates, the camera model and an
 * orientation tag. This is the file that leaked - sharp's withMetadata({ exif })
 * writes the same EXIF block a camera does.
 *
 * The coordinates are Anthropic's San Francisco office, picked only because a
 * recognisable address makes a leak obvious in a failure message.
 */
export async function jpegWithGps(size: Pixels = { width: 32, height: 32 }) {
  return Buffer.from(await sharp({
    create: { width: size.width, height: size.height, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .withMetadata({
      // 6 = rotate 90° clockwise on display. Stripping EXIF without applying
      // this is how a portrait photo ends up sideways.
      orientation: 6,
      exif: {
        IFD0: { Model: "iPhone 15 Pro", Make: "Apple" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "37/1 46/1 2988/100",
          GPSLongitudeRef: "W",
          GPSLongitude: "122/1 23/1 5400/100",
        },
      },
    })
    .jpeg()
    .toBuffer());
}

/** Whatever EXIF, XMP, IPTC and ICC a buffer still carries, for assertions. */
export async function metadataOf(bytes: Uint8Array): Promise<{
  format?: string;
  width?: number;
  height?: number;
  orientation?: number;
  hasExif: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
  hasIcc: boolean;
}> {
  const m = await sharp(bytes).metadata();
  return {
    format: m.format,
    width: m.width,
    height: m.height,
    orientation: m.orientation,
    hasExif: Boolean(m.exif?.length),
    hasXmp: Boolean(m.xmp),
    hasIptc: Boolean(m.iptc?.length),
    hasIcc: Boolean(m.icc?.length),
  };
}
