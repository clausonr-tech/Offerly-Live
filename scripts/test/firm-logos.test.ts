/**
 * Firm logos: what the harvester counts as sharp and as the same company, and
 * that the manifest it writes only ever points somewhere safe to serve.
 *
 * NO LIVE CALLS. Every image here is drawn in the test.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import "./helpers/no-network";
import { decodeDataUri, decodeIco, headerLogoUrls, measure, sameBrand } from "../find-firm-logos";
import { logoDomain, registrableDomain } from "@/lib/firm-logo-domain";

const MARK = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0a2c5a"/><path d="M20 70 L50 20 L80 70 Z M35 62 L65 62 L50 36 Z" fill="#fff"/><circle cx="50" cy="80" r="6" fill="#e0a020"/></svg>`,
);

test("a vector logo counts as sharp at any size", async () => {
  const m = await measure(MARK, "image/svg+xml", "https://x.com/icon.svg", "svg");
  assert.ok(m);
  assert.equal(m.eff, 1024);
  assert.ok(m.aspect < 1.05);
});

test("a real 256px icon measures as 256", async () => {
  const png = await sharp(MARK, { density: 300 }).resize(256, 256).png().toBuffer();
  const m = await measure(png, "image/png", "https://x.com/a.png", "apple");
  assert.ok(m);
  assert.ok(m.eff >= 128, `expected sharp, measured ${m.eff}`);
});

test("a 32px icon stretched to 256 measures as the 32px it really is", async () => {
  const small = await sharp(MARK, { density: 300 }).resize(32, 32).png().toBuffer();
  const stretched = await sharp(small).resize(256, 256, { kernel: "cubic" }).png().toBuffer();
  const m = await measure(stretched, "image/png", "https://x.com/s2.png", "google");
  assert.ok(m);
  assert.ok(m.eff <= 64, `expected blurry, measured ${m.eff}`);
});

test("a small icon padded onto a big canvas measures by its artwork", async () => {
  const small = await sharp(MARK, { density: 300 }).resize(32, 32).png().toBuffer();
  const padded = await sharp(small)
    .extend({ top: 112, bottom: 112, left: 112, right: 112, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const m = await measure(padded, "image/png", "https://x.com/p.png", "google");
  assert.ok(m);
  assert.ok(m.eff <= 64, `expected blurry, measured ${m.eff}`);
});

test("a white mark drawn for a dark header is recognised as unusable on a light tile", async () => {
  const white = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="60" fill="#fff"/></svg>`))
    .png()
    .toBuffer();
  const m = await measure(white, "image/png", "https://x.com/w.png", "link");
  assert.ok(m?.whiteOnly);
});

test("a blank image and an HTML error page are not logos", async () => {
  const blank = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  assert.equal(await measure(blank, "image/png", "https://x.com/b.png", "link"), null);
  assert.equal(await measure(Buffer.from("<html>Not found</html>"), "text/html", "https://x.com/apple-touch-icon.png", "apple"), null);
});

/** A 32-bit BMP .ico, built the way Windows writes one: rows bottom-up, then the AND mask. */
function bmpIco(size: number, paint: (x: number, y: number) => [number, number, number, number]): Buffer {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size;
  header[7] = size;
  header.writeUInt16LE(32, 6 + 6);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = ((size - 1 - y) * size + x) * 4;
      px[o] = b;
      px[o + 1] = g;
      px[o + 2] = r;
      px[o + 3] = a;
    }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  const body = Buffer.concat([dib, px, mask]);
  header.writeUInt32LE(body.length, 6 + 8);
  header.writeUInt32LE(22, 6 + 12);
  return Buffer.concat([header, body]);
}

test("a BMP favicon.ico is decoded, upright, rather than dropped", async () => {
  // Navy top half, transparent bottom half: an upside-down decode would swap them.
  const ico = bmpIco(64, (_x, y) => (y < 32 ? [10, 30, 90, 255] : [0, 0, 0, 0]));
  const out = decodeIco(ico);
  assert.ok(out && "raw" in out);
  assert.equal(out.w, 64);
  assert.deepEqual([...out.raw.subarray(0, 4)], [10, 30, 90, 255]);
  assert.equal(out.raw[(63 * 64) * 4 + 3], 0);
  const m = await measure(ico, "image/x-icon", "https://x.com/favicon.ico", "link");
  assert.ok(m, "the icon should be measured, not rejected as unreadable");
});

test("an icon embedded in the page as a data: URI is decoded; anything but an image is not", async () => {
  const png = await sharp(MARK, { density: 300 }).resize(192, 192).png().toBuffer();
  const got = decodeDataUri(`data:image/png;base64,${png.toString("base64")}`);
  assert.ok(got);
  assert.equal(got.type, "image/png");
  const m = await measure(got.bytes, got.type, got.url, "link");
  assert.ok(m && m.eff >= 96);
  const svg = decodeDataUri(`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')}`);
  assert.equal(svg?.type, "image/svg+xml");
  assert.equal(decodeDataUri("data:text/html;base64,PHNjcmlwdD4="), null);
});

test("a homepage's logo: its declared schema.org logo, or an <img> that names the firm - never a badge", () => {
  const html = `
    <script type="application/ld+json">{"@type":"Organization","logo":{"@type":"ImageObject","url":"https:\\/\\/acmecap.com\\/img\\/acme.svg"}}</script>
    <img class="site-logo" src="/img/acme-capital-logo.png" alt="Acme Capital">
    <img class="logo" src="/img/finra-brokercheck-logo.png" alt="BrokerCheck">
    <img class="logo" src="/img/nbc-logo.png" alt="As seen on NBC">
    <img class="logo" src="/img/WXIA-NBC-Logo-1.png" alt="Acme Capital on WXIA">
    <img class="logo" src="/img/logo-white.svg" alt="Acme Capital">
    <img src="/img/hero.jpg" alt="Acme Capital team">`;
  const urls = headerLogoUrls(html, "https://acmecap.com/", ["Acme Capital Partners LLC"], "acmecap.com").map((u) => `${u.how} ${u.url}`);
  // The TV station's file is captioned with the firm's name and still kept out;
  // a generic logo file is accepted on its alt text. At most two images.
  assert.deepEqual(urls, [
    "jsonld https://acmecap.com/img/acme.svg",
    "img https://acmecap.com/img/acme-capital-logo.png",
    "img https://acmecap.com/img/logo-white.svg",
  ]);
});

test("a declared logo that is a vendor's file is refused; a short form of the firm's name is accepted", () => {
  const vendor = `<script type="application/ld+json">{"logo":"https://cuadrillacapital.com/wp-content/infodesk-logo.png"}</script>`;
  assert.deepEqual(headerLogoUrls(vendor, "https://cuadrillacapital.com/", ["Cuadrilla Capital, LLC"], "cuadrillacapital.com"), []);
  const citi = `<script type="application/ld+json">{"logo":"https://www.citigroup.com/img/citi-logo.svg"}</script>`;
  assert.equal(headerLogoUrls(citi, "https://www.citigroup.com/", ["Citigroup"], "citigroup.com").length, 1);
  const sp = `<img class="logo" src="/sp-logo.svg" alt="Summit Park">`;
  assert.deepEqual(headerLogoUrls(sp, "https://summitpark.com/", ["Summit Park"], "summitpark.com"), []);
});

test("a logo drawn for a dark header, and a photo, are recognised as such", async () => {
  // White lettering with a small blue mark, on a see-through ground.
  const dark = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect x="5" y="20" width="40" height="60" fill="#1d4ed8"/><rect x="60" y="25" width="230" height="50" fill="#fff"/></svg>`)).png().toBuffer();
  const d = await measure(dark, "image/png", "https://x.com/logo-white.png", "header");
  assert.ok(d?.lightOnClear);
  // Noise stands in for a photograph: hundreds of distinct colours.
  const noise = Buffer.alloc(64 * 64 * 3);
  let seed = 0x9e3779b9;
  for (let i = 0; i < noise.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    noise[i] = seed & 0xff;
  }
  const photo = await sharp(noise, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  const ph = await measure(photo, "image/png", "https://x.com/logo.png", "header");
  assert.ok((ph?.colors ?? 0) > 300, `expected many colours, got ${ph?.colors}`);
});

test("a redirect to the firm's own other domain is the same brand; to a buyer's is not", () => {
  assert.ok(sameBrand(["Goldman Sachs"], "gs.com", "www.goldmansachs.com"));
  assert.ok(sameBrand(["JPMorgan Chase"], "jpmorgan.com", "jpmorganchase.com"));
  assert.ok(sameBrand(["Nikko Asset Management", "Amova Asset Management"], "nikkoam.com", "amova-am.com"));
  assert.ok(!sameBrand(["Acme Advisors"], "acmeadv.com", "bigbuyer.com"));
  assert.ok(!sameBrand(["Smith Capital Partners"], "smithcap.com", "sedoparking.com"));
});

test("social profiles and careers hosts never stand in for the firm", () => {
  assert.equal(logoDomain("uk.linkedin.com/company/some-firm"), "");
  assert.equal(logoDomain("www.facebook.com/somefirm"), "");
  assert.equal(logoDomain("careers.bankofamerica.com"), "bankofamerica.com");
  assert.equal(logoDomain("search.jobs.barclays"), "search.jobs.barclays");
  assert.equal(logoDomain("https://www.Lazard.com/"), "lazard.com");
  assert.equal(registrableDomain("www.schroders.co.uk"), "schroders.co.uk");
});

test("trailing punctuation from hand-entered filings is stripped", () => {
  // Eleven SEC-sourced websites ended in "," or ";" and became manifest keys
  // the crest route could never be asked for.
  assert.equal(logoDomain("consciouswealth.global,"), "consciouswealth.global");
  assert.equal(logoDomain("vaquerowealth.com;"), "vaquerowealth.com");
  assert.equal(logoDomain("example.com."), "example.com");
});

test("the manifest only points at https images and is keyed by logo domain", () => {
  const file = path.join(process.cwd(), "src", "lib", "firm-logos.json");
  if (!existsSync(file)) return;
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, { u?: string; none?: string }>;
  for (const [domain, entry] of Object.entries(manifest)) {
    assert.equal(logoDomain(domain), domain, `${domain} is not a normalised logo domain`);
    if (entry.u)
      // "brandfetch"/"brandfetch:logo" are sentinels, not URLs: /api/crest
      // builds the real address from the environment's client id, so the
      // manifest never embeds it. See scripts/refresh-firm-logos.ts.
      assert.match(
        entry.u,
        /^(https:\/\/|data:image\/|brandfetch(:(icon-svg|symbol|logo|logo-svg))?$)/,
        `${domain} points at ${entry.u.slice(0, 80)}`,
      );
    else assert.ok(entry.none, `${domain} has neither a logo nor a reason for none`);
  }
});
