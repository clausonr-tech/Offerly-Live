/**
 * An uploaded photo reaches other people as a picture and nothing else.
 *
 * Avatars and post images were stored exactly as uploaded: the magic-number
 * check proved the first bytes were FF D8 FF and then saved the file verbatim.
 * A photo from a phone carries EXIF, and EXIF carries GPS coordinates, so a
 * student who used a camera photo as their profile picture published their
 * home or campus location to every signed-in user who loaded their profile -
 * the app's own privacy draft records this as an open product change (P-102).
 *
 * Both save paths now go through lib/image-sanitise, which decodes and
 * re-encodes. These tests are on the real storage modules, against a real
 * database, with real image bytes - not on the sanitiser alone, because the
 * thing worth proving is that the bytes the app SERVES carry nothing.
 *
 * No network: sharp and PGlite only.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { jpeg, jpegWithGps, metadataOf, png } from "./helpers/images";
import { readAvatarFile, saveAvatarFile } from "@/lib/avatar-storage";
import { readPostImage, savePostImage } from "@/lib/post-image-storage";
import { MAX_IMAGE_DIMENSION, sanitiseImage } from "@/lib/image-sanitise";

let h: TestDatabase;
let restore: () => void;

before(async () => {
  h = await createTestDb();
  restore = installAsAppDb(h.db);
});

after(async () => {
  restore();
  await h.close();
});

test("a phone photo loses its GPS coordinates before it is stored", async () => {
  const uploaded = await jpegWithGps({ width: 40, height: 24 });
  const beforeStrip = await metadataOf(uploaded);
  assert.ok(beforeStrip.hasExif, "the fixture should carry EXIF, or this test proves nothing");

  const { storageKey } = await saveAvatarFile(new File([uploaded], "me.jpg"));
  const served = await readAvatarFile(storageKey);
  assert.ok(served, "the photo was stored");

  const m = await metadataOf(served);
  assert.equal(m.hasExif, false, "EXIF - and the GPS coordinates in it - was served to other users");
  assert.equal(m.hasXmp, false);
  assert.equal(m.hasIptc, false);
  assert.equal(m.hasIcc, false);
  assert.equal(m.format, "jpeg", "still a JPEG, which is what the route's content-type says");

  // The bytes are genuinely different: the test would also pass if the file
  // simply never arrived, so check it is the picture and not the upload.
  assert.notDeepEqual(Buffer.from(served), uploaded);
});

test("a post image loses its metadata too - these are shown to everyone", async () => {
  const uploaded = await jpegWithGps({ width: 40, height: 24 });
  const { storageKey } = await savePostImage(new File([uploaded], "offer.jpg"));
  const served = await readPostImage(storageKey);
  assert.ok(served);
  assert.equal((await metadataOf(served)).hasExif, false);
});

test("the orientation tag is applied, not just deleted, so photos are not sideways", async () => {
  // orientation 6 means "rotate 90° on display", so a 40x24 upload is a 24x40
  // picture. Dropping the tag without applying it leaves it 40x24 and wrong.
  const uploaded = await jpegWithGps({ width: 40, height: 24 });
  const clean = await sanitiseImage(uploaded, "jpg");
  const m = await metadataOf(clean);
  assert.equal(m.width, 24, "the EXIF rotation was dropped instead of applied");
  assert.equal(m.height, 40);
  assert.equal(m.orientation, undefined, "an orientation tag survived");
});

test("a picture larger than the app ever displays is brought down to size", async () => {
  const huge = await png({ width: MAX_IMAGE_DIMENSION + 600, height: 100 });
  const m = await metadataOf(await sanitiseImage(huge, "png"));
  assert.equal(m.width, MAX_IMAGE_DIMENSION);
  // Proportions are kept: "inside" never crops and never stretches.
  assert.ok(m.height && m.height < 100, "the aspect ratio was not kept");
});

test("a small picture is left at its own size, not enlarged", async () => {
  const m = await metadataOf(await sanitiseImage(await png({ width: 16, height: 16 }), "png"));
  assert.deepEqual([m.width, m.height], [16, 16]);
});

test("a file that opens with the right bytes but is not a picture is refused", async () => {
  // This is the whole gap the magic-number check left: three bytes of header
  // and then anything at all. Storing it meant serving it back under
  // content-type image/jpeg.
  const notAnImage = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("<script>alert(1)</script>".repeat(40)),
  ]);
  await assert.rejects(saveAvatarFile(new File([notAnImage], "me.jpg")), /could not be read/);

  const notAPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("not a png at all"),
  ]);
  await assert.rejects(savePostImage(new File([notAPng], "shot.png")), /could not be read/);
});

test("an ordinary image still round-trips, in both formats", async () => {
  const a = await saveAvatarFile(new File([await jpeg()], "me.jpg"));
  assert.equal((await metadataOf((await readAvatarFile(a.storageKey))!)).format, "jpeg");

  const p = await savePostImage(new File([await png()], "shot.png"));
  const servedPng = await readPostImage(p.storageKey);
  assert.equal((await metadataOf(servedPng!)).format, "png", "a PNG upload must stay a PNG");
});

test("the sanitiser refuses a format neither caller should ever hand it", async () => {
  // Both save paths sniff the magic number first, so this can only be reached
  // by a future caller that sniffs a third format or sniffs one wrongly. It is
  // checked in the sanitiser anyway, because what sharp would do with an SVG is
  // render it through librsvg - a decoder with its own stream of advisories
  // (including the one that moved this dependency to 0.35.5) and the ability to
  // be asked for external resources. The guarantee belongs next to the decode,
  // not in each caller's sniff.
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="/etc/passwd"/></svg>`,
  );
  await assert.rejects(sanitiseImage(svg, "png"), /could not be read/);

  // A GIF is a real picture and sharp reads it happily; it is still not one of
  // the two formats these routes serve.
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  await assert.rejects(sanitiseImage(gif, "png"), /could not be read/);

  // And the two that are allowed still work, in either direction.
  assert.equal((await metadataOf(await sanitiseImage(await jpeg(), "jpg"))).format, "jpeg");
  assert.equal((await metadataOf(await sanitiseImage(await png(), "png"))).format, "png");
});
