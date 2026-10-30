/**
 * Find every firm's real, sharp logo and record it in src/lib/firm-logos.json.
 *
 *   npx tsx --conditions=react-server scripts/find-firm-logos.ts                    # every firm, resumable
 *   npx tsx --conditions=react-server scripts/find-firm-logos.ts --only lazard.com,evercore.com
 *   npx tsx --conditions=react-server scripts/find-firm-logos.ts --skip-wikidata    # everything but Wikidata, for when it is pacing us
 *
 * The browser stage reaches the internet through the render proxy, which is
 * server-only code, so the stages that use it need --conditions=react-server.
 * These three do not touch the browser and run without it:
 *
 *   npx tsx scripts/find-firm-logos.ts --pick             # re-decide from the cache, no network
 *   npx tsx scripts/find-firm-logos.ts --skip-browser
 *   npx tsx scripts/find-firm-logos.ts --sheet top        # contact sheet of the chosen logos
 *
 * --conditions=react-server is needed by, and only by, the stage that opens a
 * real browser: it loads the crawler's own filtering proxy
 * (lib/monitoring/render-proxy), which is server-only code. The modes above
 * that render nothing - --pick, --sheet, --skip-browser - run without it, and
 * the browser stage says so rather than rendering unfiltered. See getBrowser.
 *
 * Why it exists: FirmLogo used to ask Google's favicon service in the
 * browser, and the answer is often a 16-32px icon stretched to 256 - which is
 * where the blurry logos came from. Firms publish far better: an SVG icon, a
 * 180px apple-touch-icon, 192/512px web-manifest icons. Wikidata holds the
 * vector logo of most well-known firms, keyed by their official website.
 *
 * What "accurate" means here, because a wrong logo is worse than none:
 *  - Only the firm's own domain is asked. A homepage that redirects to an
 *    unrelated company (an acquired firm now on its buyer's site, a parked
 *    domain) is recorded as "none" - its icon belongs to someone else.
 *  - Wikidata is matched on the item's official website AND its name, never
 *    on name alone.
 *  - An icon shared by many unrelated firms is a site builder's or a parking
 *    page's default, not a logo, and is thrown out.
 *  - Blank images, and white marks drawn for a dark header (invisible on our
 *    light tile), are thrown out.
 *
 * What "sharp" means: not the file's pixel size, which is easily faked by
 * upscaling. Each image is measured for the resolution its detail actually
 * survives at, and the logo is picked on that.
 *
 * Stages, each cached under local-data/firm-logos/ so a stopped run resumes:
 *   1. site     the homepage's declared icons, apple-touch-icon, web manifest,
 *               and Google's crawl of the domain - each fetched and measured
 *   2. wikidata official-website matches, batched; their logos measured
 *   3. pick     choose per domain, write the manifest and a review report
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer";
import sharp, { type OverlayOptions } from "sharp";

import { FIRM_SEEDS } from "@/lib/firm-content";
import { logoDomain, registrableDomain } from "@/lib/firm-logo-domain";
// Type only, and the module is loaded with a dynamic import inside getBrowser
// rather than statically. lib/monitoring/render-proxy starts with
// `import "server-only"`, which THROWS unless node is run with
// --conditions=react-server, and two things import this file that are not:
// scripts/refresh-firm-logos.ts (for `measure` and `tileScore`) and the
// documented `npx tsx scripts/find-firm-logos.ts --pick`. A static import
// would break both of those at load time over a browser neither one launches.
import type { RenderProxy } from "@/lib/monitoring/render-proxy";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
// Wikimedia asks API clients to identify themselves, with a way to reach the
// operator (https://meta.wikimedia.org/wiki/User-Agent_policy).
const WIKI_UA = "OfferlyLogoFinder/1.0 (https://github.com/clausonr-tech/Offerly; firm logos for a student careers directory)";

const CACHE_DIR = path.join(process.cwd(), "local-data", "firm-logos");
const SITE_CACHE = path.join(CACHE_DIR, "site.jsonl");
const WIKI_CACHE = path.join(CACHE_DIR, "wikidata.jsonl");
const APP_CACHE = path.join(CACHE_DIR, "apps.jsonl");
const HEADER_CACHE = path.join(CACHE_DIR, "header.jsonl");
const BROWSER_CACHE = path.join(CACHE_DIR, "browser.jsonl");
const REPORT = path.join(CACHE_DIR, "report.csv");
const MANIFEST = path.join(process.cwd(), "src", "lib", "firm-logos.json");

/** Below this effective resolution a logo is not recorded: the letter tile is cleaner than a blur. */
const MIN_EFFECTIVE = 32;
/** An icon this many unrelated domains share is a platform default. */
const GENERIC_AT = 4;

// ---------------------------------------------------------------- fetching

type Got = { bytes: Buffer; type: string; url: string };

/**
 * One GET, retried on the failures that pass: a dropped connection, a
 * timeout, a 429 or a 5xx. The first full run lost BlackRock, AQR and
 * Vanguard to exactly these - all three answered fine minutes later. A 403 or
 * 404 is an answer, not a blip, and is not retried.
 */
async function get(url: string, maxBytes: number, ua = UA, timeout = 12_000): Promise<Got | null> {
  let wait = 0;
  // Wikimedia answers 429 as routine pacing (Retry-After: 4), so it gets more tries.
  const attempts = WIKIMEDIA.test(new URL(url).hostname) ? 6 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // The server's own Retry-After when it sent one (capped at a minute),
    // otherwise 1.5s then 4.5s.
    if (attempt) await new Promise((r) => setTimeout(r, wait || 1500 * 3 ** (attempt - 1)));
    const got = await getOnce(url, maxBytes, ua, timeout);
    if (typeof got === "object") return got;
    if (got !== "retry" && typeof got !== "number") return null;
    wait = typeof got === "number" ? got : 0;
  }
  return null;
}

/**
 * Wikimedia (Wikidata, Commons, the image server) rate-limits identified bot
 * traffic, and after the first full run it answered this script with 429 on
 * every request. Its rules are followed, not dodged: all requests to its
 * hosts share one queue at one a second, whatever the concurrency elsewhere,
 * and a Retry-After is honoured. The name search is slow for it - hours - and
 * resumable for the same reason.
 */
const WIKIMEDIA = /(^|\.)(wikidata|wikimedia|wikipedia)\.org$/;
const WIKIMEDIA_GAP_MS = 1000;
let wikimediaNext = 0;

async function wikimediaTurn(url: string) {
  if (!WIKIMEDIA.test(new URL(url).hostname)) return;
  const now = Date.now();
  const at = Math.max(now, wikimediaNext);
  wikimediaNext = at + WIKIMEDIA_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** The response, null for a real refusal, or a retry - with the wait the server asked for, in ms, when it said. */
async function getOnce(url: string, maxBytes: number, ua: string, timeout: number): Promise<Got | null | "retry" | number> {
  await wikimediaTurn(url);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": ua, accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 429 || res.status >= 500) {
      const after = Number(res.headers.get("retry-after"));
      return after > 0 ? Math.min(after, 60) * 1000 : "retry";
    }
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), type: res.headers.get("content-type") ?? "", url: res.url };
  } catch {
    return "retry";
  }
}

/**
 * An icon embedded in the page itself (`<link rel="icon" href="data:...">`)
 * - White Oak Wealth's is a sharp 256px PNG that way. Images only, and small:
 * the manifest stores it whole, and /api/crest serves it without a fetch.
 */
export function decodeDataUri(href: string): Got | null {
  const m = /^data:(image\/[a-z0-9.+-]+)(;[a-z0-9=-]+)*?(;base64)?,([\s\S]*)$/i.exec(href);
  if (!m || href.length > 270_000) return null;
  try {
    const bytes = m[3] ? Buffer.from(m[4], "base64") : Buffer.from(decodeURIComponent(m[4]), "utf8");
    return bytes.length && bytes.length <= 200_000 ? { bytes, type: m[1].toLowerCase(), url: href } : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- measuring

export type Measured = {
  url: string;
  from: "svg" | "manifest" | "apple" | "link" | "google" | "wikidata" | "app" | "header";
  /** Pixel size of the file (SVG: as rasterised for measuring). */
  w: number;
  h: number;
  /** Resolution the artwork's detail actually holds up at. SVG: 1024. */
  eff: number;
  /** Longer side over shorter side of the painted area. */
  aspect: number;
  /** Painted pixels are nearly all white - drawn for a dark background. */
  whiteOnly: boolean;
  /**
   * Mostly white artwork on a see-through ground: a logo drawn for a dark
   * header, whose white lettering would vanish on our light tile even though
   * a coloured part of it (Vergent's blue V) still shows.
   */
  lightOnClear?: boolean;
  /** Distinct colours in a sample of the artwork. A logo has a handful; a photo, hundreds. */
  colors?: number;
  /** Average hash of the artwork on white, for spotting platform defaults. */
  ahash: string;
  sha: string;
};

const isSvg = (b: Buffer, type: string) =>
  type.includes("svg") || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?(<!doctype[^>]*>\s*)?<svg[\s>]/i.test(b.subarray(0, 600).toString("utf8"));

/**
 * The largest size the artwork can be shrunk to and grown back from without
 * visibly changing. An honest 32px icon padded or stretched onto 256px comes
 * back as ~32; a real 256px icon stays 256.
 */
async function effectiveResolution(rgba: Buffer, w: number, h: number): Promise<number> {
  const side = Math.min(w, h);
  const original = sharp(rgba, { raw: { width: w, height: h, channels: 4 } });
  let best = side;
  for (let s = Math.floor(side / 2); s >= 16; s = Math.floor(s / 2)) {
    const small = await original.clone().resize(Math.max(1, Math.round((w * s) / side)), Math.max(1, Math.round((h * s) / side)), { kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
    const back = await sharp(small.data, { raw: { width: small.info.width, height: small.info.height, channels: 4 } })
      .resize(w, h, { kernel: "lanczos3" })
      .raw()
      .toBuffer();
    let err = 0;
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3] / 255;
      const b = back[i + 3] / 255;
      // Compare as composited on white, so a transparent border counts as the
      // white it will be drawn on.
      for (let c = 0; c < 3; c++) err += Math.abs(rgba[i + c] * a + 255 * (1 - a) - (back[i + c] * b + 255 * (1 - b)));
      n += 3;
    }
    // Mean error per channel under ~2.5/255: nothing a viewer would see was lost.
    if (err / n > 2.5) break;
    best = s;
  }
  return best;
}

/**
 * The largest image in a .ico, which sharp cannot read at all - the reason
 * thousands of favicons (McKinsey's has a 256px PNG inside) were being
 * dropped. Entries are either an embedded PNG or a headerless BMP: rows
 * bottom-up, padded to 4 bytes, then a 1-bit AND mask for transparency.
 */
export function decodeIco(b: Buffer): { png: Buffer } | { raw: Buffer; w: number; h: number } | null {
  if (b.length < 22 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null;
  const n = b.readUInt16LE(4);
  let best = -1;
  let bestKey = -1;
  for (let i = 0; i < n && 6 + i * 16 + 16 <= b.length; i++) {
    const e = 6 + i * 16;
    const key = (b[e] || 256) * 100 + b.readUInt16LE(e + 6);
    if (key > bestKey) {
      bestKey = key;
      best = e;
    }
  }
  if (best < 0) return null;
  const size = b.readUInt32LE(best + 8);
  const off = b.readUInt32LE(best + 12);
  if (off + Math.min(size, 8) > b.length) return null;
  const data = b.subarray(off, Math.min(b.length, off + size));
  if (data.subarray(0, 4).toString("hex") === "89504e47") return { png: Buffer.from(data) };
  if (data.length < 40) return null;
  const w = data.readInt32LE(4);
  const h = Math.abs(data.readInt32LE(8)) / 2;
  const bpp = data.readUInt16LE(14);
  if (w <= 0 || h <= 0 || w > 512 || h > 512) return null;
  const headerSize = data.readUInt32LE(0);
  const colours = bpp <= 8 ? data.readUInt32LE(32) || 1 << bpp : 0;
  const palette = headerSize;
  const pixels = palette + colours * 4;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const mask = pixels + stride * h;
  const raw = Buffer.alloc(w * h * 4);
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const row = pixels + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r = 0, g = 0, bl = 0, a = 255;
      if (bpp === 32) {
        bl = data[row + x * 4]; g = data[row + x * 4 + 1]; r = data[row + x * 4 + 2]; a = data[row + x * 4 + 3];
        if (a) anyAlpha = true;
      } else if (bpp === 24) {
        bl = data[row + x * 3]; g = data[row + x * 3 + 1]; r = data[row + x * 3 + 2];
      } else if (bpp <= 8) {
        const bit = x * bpp;
        const idx = (data[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        bl = data[palette + idx * 4]; g = data[palette + idx * 4 + 1]; r = data[palette + idx * 4 + 2];
      } else return null;
      raw[o] = r ?? 0; raw[o + 1] = g ?? 0; raw[o + 2] = bl ?? 0; raw[o + 3] = a;
    }
  }
  // Below 32 bits - or a 32-bit icon that left its alpha empty - the AND mask
  // is the transparency.
  if (bpp < 32 || !anyAlpha) {
    for (let y = 0; y < h; y++) {
      const row = mask + (h - 1 - y) * maskStride;
      for (let x = 0; x < w; x++) {
        const transparent = row + (x >> 3) < data.length ? (data[row + (x >> 3)] >> (7 - (x & 7))) & 1 : 0;
        raw[(y * w + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { raw, w, h };
}

export async function measure(bytes: Buffer, type: string, url: string, from: Measured["from"]): Promise<Measured | null> {
  try {
    const svg = isSvg(bytes, type);
    if (!svg && !/^image\//.test(type) && !/\.(png|ico|jpe?g|gif|webp)(\?|$)/i.test(url) && type !== "application/octet-stream") return null;
    // Measured at up to 512px: a 4000px Commons original holds no more detail
    // at tile size, and would only make the measuring slow.
    const ico = svg ? null : decodeIco(bytes);
    const source = !ico
      ? sharp(bytes, svg ? { density: 300 } : { pages: 1 })
      : "png" in ico
        ? sharp(ico.png)
        : sharp(ico.raw, { raw: { width: ico.w, height: ico.h, channels: 4 } });
    let img = svg
      ? source.resize(512, 512, { fit: "inside" })
      : source.resize(512, 512, { fit: "inside", withoutEnlargement: true });
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    if (w < 8 || h < 8) return null;

    // The painted area: pixels that are neither transparent nor near-white.
    let minX = w, minY = h, maxX = -1, maxY = -1, painted = 0, white = 0, opaque = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 32) continue;
        opaque++;
        const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (lum > 235) {
          white++;
          continue;
        }
        painted++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    // Blank, or a lone dot: nothing to show.
    if (painted < w * h * 0.01) {
      // ...unless it is a white mark on transparency, which is real artwork,
      // just not for a light tile. Recorded so the picker can say why.
      if (white > w * h * 0.03 && opaque < w * h * 0.9) {
        return { url, from, w, h, eff: 0, aspect: 1, whiteOnly: true, ahash: "", sha: sha(bytes) };
      }
      return null;
    }
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    const eff = svg ? 1024 : await effectiveResolution(data, w, h);
    const lightOnClear = opaque < w * h * 0.9 && white > opaque * 0.45;
    const palette = new Set<number>();
    const stride = Math.max(1, Math.floor((w * h) / 4096));
    for (let p = 0; p < w * h; p += stride) {
      const i = p * 4;
      if (data[i + 3] < 128) continue;
      palette.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
    }

    img = sharp(data, { raw: { width: w, height: h, channels: 4 } });
    const tiny = await img.flatten({ background: "#ffffff" }).resize(16, 16, { fit: "contain", background: "#ffffff" }).greyscale().raw().toBuffer();
    const mean = tiny.reduce((a, b) => a + b, 0) / tiny.length;
    let bits = "";
    for (const v of tiny) bits += v > mean ? "1" : "0";
    const ahash = BigInt("0b" + bits).toString(16).padStart(64, "0");

    return {
      url,
      from,
      w,
      h,
      // The detail the PAINTED area carries, scaled from the whole file's.
      eff: svg ? eff : Math.round((eff * Math.min(cw, ch)) / Math.min(w, h)) || eff,
      aspect: Math.max(cw, ch) / Math.max(1, Math.min(cw, ch)),
      whiteOnly: false,
      lightOnClear,
      colors: palette.size,
      ahash,
      sha: sha(bytes),
    };
  } catch {
    return null;
  }
}

const sha = (b: Buffer) => createHash("sha1").update(b).digest("hex").slice(0, 16);

// ------------------------------------------------------------------ brand

const FILLER = new Set(
  "the of and & a an llc inc lp llp ltd plc co corp corporation company companies group holdings holding partners partner capital management managers manager advisors advisers advisory investment investments asset assets financial finance securities fund funds global international wealth trust bank banking services america american usa us na sa ag".split(" "),
);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !FILLER.has(t));
}

const label = (host: string) => registrableDomain(host).split(".")[0].replace(/[^a-z0-9]/g, "");

/**
 * Whether `to` is plausibly the same brand as a firm that files `from` as its
 * website - a redirect from gs.com to goldmansachs.com, not from an acquired
 * firm's domain to its buyer's.
 */
export function sameBrand(names: string[], from: string, to: string): boolean {
  const a = label(from);
  const b = label(to);
  if (!a || !b) return false;
  if (a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b))) return true;
  for (const n of names) {
    const tokens = nameTokens(n);
    if (tokens.some((t) => t.length >= 4 && b.includes(t))) return true;
    const words = n.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
    const acronym = words.filter((w) => !["the", "of", "and"].includes(w)).map((w) => w[0]).join("");
    if (acronym.length >= 2 && (b === acronym || b.startsWith(acronym))) return true;
  }
  return false;
}

/** Whether a Wikidata label names the same firm as one of ours. */
function sameName(names: string[], wikiLabel: string): boolean {
  const w = nameTokens(wikiLabel);
  if (!w.length) return false;
  return names.some((n) => {
    const t = nameTokens(n);
    return t.length > 0 && (t[0] === w[0] || t.join("") === w.join("") || w.join("").includes(t.join("")));
  });
}

// ------------------------------------------------------------ stage 1: site

type SiteRow = {
  domain: string;
  /** Registrable host the homepage finally landed on, "" if it never loaded. */
  landed: string;
  moved: boolean;
  candidates: Measured[];
};

function iconLinks(html: string, base: string): { href: string; from: Measured["from"]; size: number }[] {
  const out: { href: string; from: Measured["from"]; size: number }[] = [];
  const abs = (href: string) => {
    try {
      return new URL(href.replace(/&amp;/g, "&"), base).toString();
    } catch {
      return null;
    }
  };
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel=["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href) continue;
    if (/(^|\s)manifest(\s|$)/.test(rel)) {
      const u = abs(href);
      if (u) out.push({ href: u, from: "manifest", size: -1 });
      continue;
    }
    // mask-icon is a single-colour silhouette for Safari's pinned tabs.
    if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
    const u = abs(href);
    if (!u) continue;
    const svg = /\.svg(\?|$)/i.test(u) || /image\/svg/i.test(tag);
    const size = svg ? 9999 : Number(/\bsizes=["']?(\d+)x\d+/i.exec(tag)?.[1] ?? (rel.includes("apple") ? 180 : 0));
    out.push({ href: u, from: svg ? "svg" : rel.includes("apple") ? "apple" : "link", size });
  }
  const tile = /<meta[^>]+name=["']msapplication-TileImage["'][^>]*content=["']([^"']+)/i.exec(html)?.[1];
  if (tile) {
    const u = abs(tile);
    if (u) out.push({ href: u, from: "link", size: 144 });
  }
  return out;
}

async function manifestIcons(url: string): Promise<{ href: string; size: number }[]> {
  const got = await get(url, 200_000);
  if (!got) return [];
  try {
    const m = JSON.parse(got.bytes.toString("utf8")) as { icons?: { src: string; sizes?: string; purpose?: string }[] };
    return (m.icons ?? [])
      // A maskable icon is cropped to a circle by the OS: padded and often re-coloured.
      .filter((i) => i.src && !/maskable/.test(i.purpose ?? "") && !/monochrome/.test(i.purpose ?? ""))
      .map((i) => ({ href: new URL(i.src, got.url).toString(), size: Number(/(\d+)x\d+/.exec(i.sizes ?? "")?.[1] ?? 0) }));
  } catch {
    return [];
  }
}

/**
 * Redirects a person checked and found to be the same brand, which the name
 * rule cannot see: "TD" is too short to match on, and a rebrand changes the
 * name entirely. Each one is the firm's own new home, not an acquirer's.
 */
const SAME_BRAND_REDIRECTS = new Map([
  ["tdcowen.com", "tdsecurities.com"], // Cowen is TD Cowen, TD Securities' US arm
  ["abrdn.com", "aberdeeninvestments.com"], // abrdn renamed itself back to Aberdeen
  ["newyorklifeinvestments.com", "nylim.com"], // New York Life Investment Management
]);

async function siteCandidates(domain: string, names: string[]): Promise<SiteRow> {
  let page = await get(`https://${domain}/`, 600_000);
  if (!page && !domain.startsWith("www.")) page = await get(`https://www.${domain}/`, 600_000);
  const landedHost = page ? new URL(page.url).hostname : "";
  const landed = landedHost ? registrableDomain(landedHost) : "";
  const moved =
    !!landed &&
    landed !== registrableDomain(domain) &&
    SAME_BRAND_REDIRECTS.get(domain) !== landed &&
    !sameBrand(names, domain, landedHost);

  const wanted: { href: string; from: Measured["from"] }[] = [];
  if (page && !moved) {
    const base = page.url;
    const origin = new URL(base).origin;
    const links = iconLinks(page.bytes.toString("utf8"), base);
    for (const l of links.filter((l) => l.from === "manifest").slice(0, 1)) {
      for (const i of (await manifestIcons(l.href)).sort((a, b) => b.size - a.size).slice(0, 2)) wanted.push({ href: i.href, from: "manifest" });
    }
    for (const l of links.filter((l) => l.from !== "manifest").sort((a, b) => b.size - a.size).slice(0, 4)) wanted.push(l);
    wanted.push({ href: `${origin}/apple-touch-icon.png`, from: "apple" });
    // Often never linked from the page, and often the only multi-size icon.
    wanted.push({ href: `${origin}/favicon.ico`, from: "link" });
  }
  // Google's crawl of the domain: often the only answer for a site that
  // refuses scripted requests, and it follows the same redirect we checked.
  if (!moved) wanted.push({ href: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`, from: "google" });

  const seen = new Set<string>();
  const candidates: Measured[] = [];
  for (const c of wanted) {
    if (seen.has(c.href) || !/^(https:\/\/|data:image\/)/i.test(c.href)) continue;
    seen.add(c.href);
    const img = c.href.startsWith("data:") ? decodeDataUri(c.href) : await get(c.href, 3_000_000);
    if (!img) continue;
    // A redirect off to another company's CDN is fine; to another company's
    // HOMEPAGE (an HTML answer) is not an image and fails measure() anyway.
    // Google answers with a redirect to a gstatic URL full of volatile
    // parameters; the request URL is the stable one to record.
    const url = c.from === "google" ? c.href : img.url;
    const m = await measure(img.bytes, img.type, url, c.from === "link" && isSvg(img.bytes, img.type) ? "svg" : c.from);
    if (m) candidates.push(m);
  }
  return { domain, landed, moved, candidates };
}

// -------------------------------------------------------- stage 2: wikidata

type WikiRow = { domain: string; qid: string; label: string; candidates: Measured[]; files?: string[] };

async function sparql(query: string): Promise<{ results: { bindings: Record<string, { value: string }>[] } } | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await wikimediaTurn("https://query.wikidata.org/sparql");
    const res = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { "user-agent": WIKI_UA, accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (res?.ok) return res.json();
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  return null;
}

/** Items whose official website is one of these domains, with their logo files. */
async function wikidataBatch(domains: string[]): Promise<{ domain: string; qid: string; label: string; files: string[] }[] | null> {
  const urls = domains.flatMap((d) => [`https://${d}`, `https://${d}/`, `http://${d}`, `http://${d}/`, `https://www.${d}`, `https://www.${d}/`, `http://www.${d}`, `http://www.${d}/`]);
  const q = `SELECT ?item ?site ?label ?logo ?icon WHERE {
    VALUES ?site { ${urls.map((u) => `<${u}>`).join(" ")} }
    ?item wdt:P856 ?site .
    OPTIONAL { ?item wdt:P154 ?logo }
    OPTIONAL { ?item wdt:P8972 ?icon }
    OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "en") }
  }`;
  const data = await sparql(q);
  // Null, not [] - a failed query is not "no match", and must not be cached as one.
  if (!data) return null;
  const byItem = new Map<string, { domain: string; qid: string; label: string; files: Set<string> }>();
  for (const b of data.results.bindings) {
    const host = new URL(b.site.value).hostname.replace(/^www\./, "");
    const domain = domains.find((d) => d === host) ?? host;
    const qid = b.item.value.split("/").pop()!;
    const key = `${domain}|${qid}`;
    const row = byItem.get(key) ?? { domain, qid, label: b.label?.value ?? "", files: new Set<string>() };
    // The small logo/icon first: it is the square mark a tile wants.
    if (b.icon) row.files.add(b.icon.value);
    if (b.logo) row.files.add(b.logo.value);
    byItem.set(key, row);
  }
  return [...byItem.values()].filter((r) => r.files.size).map((r) => ({ ...r, files: [...r.files] }));
}

/**
 * A Commons file's 500px thumbnail URL, asked of Commons' API rather than
 * guessed. Not Special:FilePath: as a special page it answers a script's
 * second quick request with 429, which left the run idle in backoff. The
 * API is lenient, and the URL it returns is on upload.wikimedia.org, which
 * serves the bytes. 500 is one of Wikimedia's standard thumbnail widths.
 */
async function commonsPng(fileUrl: string): Promise<string | null> {
  const name = decodeURIComponent(fileUrl.split("/").pop()!).replace(/_/g, " ");
  const got = await get(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url&iiurlwidth=500&titles=${encodeURIComponent(`File:${name}`)}`,
    200_000,
    WIKI_UA,
    20_000,
  );
  try {
    const pages = got ? (JSON.parse(got.bytes.toString("utf8")).query?.pages ?? {}) : {};
    const info = (Object.values(pages)[0] as { imageinfo?: { thumburl?: string; url?: string }[] } | undefined)?.imageinfo?.[0];
    return info?.thumburl ?? info?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Wikidata items for a firm found by NAME, kept only when one of the item's
 * official websites is on the firm's own registrable domain. For firms whose
 * listed site is not the bare root - Vanguard's is investor.vanguard.com -
 * and which the exact-URL batch therefore misses. The domain check is what
 * keeps a namesake out.
 */
// Null when a request failed, so the firm is searched again rather than
// cached as having no match.
async function wikidataByName(domain: string, names: string[]): Promise<{ qid: string; label: string; files: string[] }[] | null> {
  const api = "https://www.wikidata.org/w/api.php?format=json&";
  const json = async (url: string) => {
    const got = await get(url, 2_000_000, WIKI_UA, 20_000);
    try {
      return got ? JSON.parse(got.bytes.toString("utf8")) : null;
    } catch {
      return null;
    }
  };
  const query = names[0].replace(/\s*\(.*?\)\s*/g, " ").replace(/,?\s+(llc|inc|lp|l\.p\.|ltd|corp|co)\.?$/i, "").trim();
  const found = await json(`${api}action=wbsearchentities&language=en&type=item&limit=5&search=${encodeURIComponent(query)}`);
  if (!found) return null;
  const ids: string[] = (found.search ?? []).map((r: { id: string }) => r.id);
  if (!ids.length) return [];
  const ents = await json(`${api}action=wbgetentities&props=claims|labels&languages=en&ids=${ids.join("|")}`);
  if (!ents) return null;
  const out: { qid: string; label: string; files: string[] }[] = [];
  type Claim = { mainsnak?: { datavalue?: { value?: unknown } } };
  const values = (claims: Record<string, Claim[]> | undefined, p: string) =>
    (claims?.[p] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter((v): v is string => typeof v === "string");
  for (const [qid, e] of Object.entries((ents?.entities ?? {}) as Record<string, { claims?: Record<string, Claim[]>; labels?: { en?: { value: string } } }>)) {
    const sites = values(e.claims, "P856");
    const ours = sites.some((u) => {
      try {
        return registrableDomain(new URL(u).hostname) === registrableDomain(domain);
      } catch {
        return false;
      }
    });
    const files = [...values(e.claims, "P8972"), ...values(e.claims, "P154")];
    if (ours && files.length) out.push({ qid, label: e.labels?.en?.value ?? "", files });
  }
  return out;
}

// ------------------------------------------------------------ stage 3: pick

/**
 * How well a candidate serves a square tile. Effective resolution first,
 * divided by how far it is from square - a wordmark four times wider than tall
 * is a quarter of the tile high, unreadable at 40px.
 */
export function tileScore(m: Measured): number {
  // Wider than 4:1 is a quarter of the tile high or less: a sharp file that
  // reads as a smudge. The letter tile is the better answer.
  if (m.whiteOnly || m.aspect > 4) return -1;
  const fit = m.aspect <= 1.35 ? 1 : 1 / m.aspect;
  // At equal quality the firm's own file wins over a third party's copy of it.
  const own = m.from === "google" || m.from === "header" ? 0.9 : m.from === "wikidata" || m.from === "app" ? 0.95 : 1;
  return Math.min(m.eff, 512) * fit * own;
}

/**
 * Icons rejected by eye, by average hash. Each is a firm's own file that is
 * not its logo, and too rare to be caught as a platform default.
 */
const REJECTED = new Set([
  // thirdpoint.com: a grey square reading "Apple Touch Icon", a template's placeholder.
  "fffffffffffffffffffff81ff81ff81ff81ffc3ff81fffffffffffffffffffff",
  // App Store icons that are a product's, not the firm's: RBC's lightbulb
  // "insights" app, BlackRock's investor-app arch, McKinsey's "Insights" app.
  "000005a007e00bd006601df807f00660024003c003c0018007e007e007e00000",
  "00000000000000001ff81ff81ff81e781e781e781e781e781e78000000000000",
  "8001c003e006f00c3c382ffa03fc01f800f800703ffc1ffc179c000000000000",
  // From the review of every App Store pick: a product's app, not the firm's mark.
  // hsbc.com: HSBC Hong Kong app ("HK").
  "fffffffffffffffff81ff00fe247e247f00ff81ffffffc3ffc3fff3fffffffff",
  // societegenerale.com: Societe Generale "SGNC" app.
  "fffffffffc3ffc3ffc3ff81ff81fffffffff00000000000006c0000000000000",
  // nuveen.com: Nuveen/TIAA "33 Arch Street" building app.
  "000000000000000003c01ff8183c0000efff480c07e007e00000000000000000",
  // aig.com: AIG "Medical Indemnity" app.
  "000000001ff815e817f81ff81ff81ff800003ffc3fdc1f7c3ffc3ff000000000",
  // spglobal.com: S&P "Capital IQ Pro" app.
  "0000000000003ffc040000040000210c5fee2c4400000000ffffffffffffffff",
  // www2.deloitte.com: a Deloitte product app.
  "fffffffffc3ff81ff01ff00ff04ff21ff81ffe7fffffefffc007c007ffffffff",
  // bankofamerica.com: Bank of America "Private Bank" app.
  "fffffffffffffc3fe00fc003f007f91ffe3fffffffffffffc083c003ffffffff",
  // massmutual.com: MassMutual smartwatch app.
  "fffffffff81ff81ff00ff00ff24ff24ff5aff00ff00ff00ff81ff81fffffffff",
  // northerntrust.com: Northern Trust "Private Passport" app.
  "000000000000000000007ff07ff05ff07ffe7ffe022000000000000000040000",
  // symetra.com: Symetra "Health" app.
  "00000000000010601ff81ff80c600ff007f000000ff03ffc3ffc000000000000",
  // anthonypompliano.com: a podcast's cover art, from a person's site, not Pomp Investments' mark.
  "00000000000003c003c007e007e00fc00f80118007f00ff00fe003c003c00000",
  // mwmrj.com: a square crop through the middle of a wordmark, unreadable and not the filed firm's name.
  "fffffefffe7ffffffff9240c020c400effffffff100000200020feffffffffff",
  // mwmrj.com: the same crop as its favicon.ico.
  "ffffff7ffe7ffffffffd240c00044006ffffffff100000200020feffffffffff",
  // dunncapital.com: an awards badge ("HFM European Performance Awards 2023 Winner"), not the firm's mark.
  "ffffffff9fff9fffffff807feba3800180018001fffffeffffffffffffffffff",
]);

type Entry = { u: string; px: number; from: Measured["from"] } | { none: string };

function pick(
  domains: Map<string, string[]>,
  site: Map<string, SiteRow>,
  wiki: Map<string, WikiRow[]>,
  apps: Map<string, Measured[]>,
): { manifest: Record<string, Entry>; report: string[] } {
  // Platform defaults: the same artwork on several domains of unrelated firms.
  const owners = new Map<string, Set<string>>();
  for (const [domain, row] of site)
    for (const c of row.candidates) {
      if (!c.ahash) continue;
      const set = owners.get(c.ahash) ?? new Set<string>();
      set.add(registrableDomain(domain));
      owners.set(c.ahash, set);
    }
  const generic = new Set<string>();
  for (const [hash, set] of owners) {
    if (set.size < GENERIC_AT) continue;
    // Related firms legitimately share a mark (Blue Owl's four domains): only
    // generic when the owning firms' names have nothing in common.
    const first = [...set].map((d) => nameTokens(domains.get(d)?.[0] ?? domains.get(`www.${d}`)?.[0] ?? d)[0] ?? d);
    if (new Set(first).size > 1) generic.add(hash);
  }

  const manifest: Record<string, Entry> = {};
  const report = ["domain,firm,decision,source,effective_px,aspect,url"];
  const csv = (s: string) => `"${s.replace(/"/g, '""')}"`;
  for (const [domain, names] of domains) {
    const row = site.get(domain);
    if (!row) continue;
    if (row.moved) {
      manifest[domain] = { none: `redirects to ${row.landed}` };
      report.push([domain, csv(names[0]), "none", "moved", "", "", row.landed].join(","));
      continue;
    }
    const all = [...row.candidates, ...(wiki.get(domain) ?? []).flatMap((w) => w.candidates), ...(apps.get(domain) ?? [])].filter(
      (c) => !generic.has(c.ahash) && !REJECTED.has(c.ahash),
    );
    // A square mark the tile can show at full size beats any wordmark, however
    // sharp: Bain Capital's 90px icon over its 2:1 Wikidata wordmark.
    const squares = all.filter((c) => c.aspect <= 1.35 && c.eff >= 64 && !c.whiteOnly);
    const best = (squares.length ? squares : all).sort((a, b) => tileScore(b) - tileScore(a))[0];
    if (!best || tileScore(best) < MIN_EFFECTIVE) {
      const why = !all.length ? "no icon" : best?.whiteOnly ? "white-only mark" : "only blurry icons";
      manifest[domain] = { none: why };
      report.push([domain, csv(names[0]), "none", csv(why), best?.eff ?? "", best?.aspect.toFixed(2) ?? "", best?.url ?? ""].join(","));
      continue;
    }
    manifest[domain] = { u: best.url, px: Math.round(tileScore(best)), from: best.from };
    report.push([domain, csv(names[0]), "logo", best.from, best.eff, best.aspect.toFixed(2), csv(best.url)].join(","));
  }
  return { manifest, report };
}

// ------------------------------------------------------------------- sheet

/** A grid of chosen logos with their firm names, for checking by eye. */
async function contactSheet(entries: { name: string; domain: string; url: string | null }[], out: string) {
  const cell = 160;
  const cols = 8;
  const rows = Math.ceil(entries.length / cols);
  const tiles: OverlayOptions[] = [];
  await Promise.all(
    entries.map(async (e, i) => {
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      const img = e.url ? await get(e.url, 3_000_000, e.url.includes("wikimedia") ? WIKI_UA : UA) : null;
      if (img) {
        try {
          const svg = isSvg(img.bytes, img.type);
          const ico = svg ? null : decodeIco(img.bytes);
          const png = await (ico
            ? "png" in ico
              ? sharp(ico.png)
              : sharp(ico.raw, { raw: { width: ico.w, height: ico.h, channels: 4 } })
            : sharp(img.bytes, svg ? { density: 300 } : { pages: 1 }))
            .resize(96, 96, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
            .png()
            .toBuffer();
          tiles.push({ input: png, left: x + 32, top: y + 12 });
        } catch {}
      }
      const text = `${e.name}`.slice(0, 24).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const sub = (e.url ? e.domain : `${e.domain} (none)`).slice(0, 28).replace(/&/g, "&amp;");
      tiles.push({
        input: Buffer.from(
          `<svg width="${cell}" height="48" xmlns="http://www.w3.org/2000/svg"><text x="80" y="18" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#111">${text}</text><text x="80" y="36" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#888">${sub}</text></svg>`,
        ),
        left: x,
        top: y + 112,
      });
    }),
  );
  await sharp({ create: { width: cols * cell, height: rows * cell, channels: 4, background: "#ffffff" } })
    .composite(tiles)
    .png()
    .toFile(out);
}

// -------------------------------------------------------------------- main

/** The promise's value, or `fallback` once `ms` have passed without one. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/**
 * The firm's flagship iOS app icon: a 512px square of its own artwork, which
 * is exactly what a tile wants - and for firms like Vanguard, BlackRock and
 * Nomura, whose sites publish only a 16px favicon and a long wordmark, the
 * only sharp square mark there is.
 *
 * Accepted only when the developer's website is on the firm's own domain (or
 * the same name under another country's suffix: macquarie.com.au for
 * macquarie.com). Searching "BlackRock" also returns a coffee chain; its
 * developer site is not blackrock.com, so it never qualifies. The first
 * qualifying result is taken - the most popular, normally the flagship.
 */
async function appCandidates(domain: string, names: string[]): Promise<Measured[]> {
  const term = names[0].replace(/\s*\(.*?\)\s*/g, " ").replace(/,?\s+(llc|inc|lp|l\.p\.|ltd|corp|co)\.?$/i, "").trim();
  const got = await get(`https://itunes.apple.com/search?entity=software&country=us&limit=15&term=${encodeURIComponent(term)}`, 2_000_000);
  let results: { sellerUrl?: string; artworkUrl512?: string }[] = [];
  try {
    results = got ? JSON.parse(got.bytes.toString("utf8")).results ?? [] : [];
  } catch {}
  const ours = registrableDomain(domain);
  const ourLabel = ours.split(".")[0];
  for (const r of results) {
    if (!r.sellerUrl || !r.artworkUrl512) continue;
    let theirs: string;
    try {
      theirs = registrableDomain(new URL(r.sellerUrl).hostname);
    } catch {
      continue;
    }
    if (theirs !== ours && !(ourLabel.length >= 4 && theirs.split(".")[0] === ourLabel)) continue;
    const img = await get(r.artworkUrl512, 3_000_000);
    const m = img && (await measure(img.bytes, img.type, r.artworkUrl512, "app"));
    return m ? [m] : [];
  }
  return [];
}

/**
 * Badges, social icons and press marks a page also calls "logo": FINRA's
 * BrokerCheck, the CFP mark, "as seen on" strips, app-store buttons.
 */
const NOT_THE_FIRMS_LOGO = /(finra|brokercheck|sipc|cfp|sec\.gov|adviserinfo|linkedin|facebook|twitter|instagram|youtube|tiktok|award|badge|partner|bbb|member|seal|certif|sponsor|client|press|forbes|barron|google|apple|app-?store|play|social|hamburger|menu|arrow|chevron|anniversary)/i;

function attr(tag: string, name: string) {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? "";
}

/**
 * The logo a firm's own homepage shows, for firms whose site publishes no
 * usable icon - which is most small advisers: no apple-touch-icon, a 16px
 * favicon, but their real logo at the top of the page.
 *
 * Trusted in this order: the schema.org Organization "logo" the site declares
 * for itself; then an <img> marked as the logo whose file name, alt text or
 * class also names THIS firm (a word of its name, or its domain); then an
 * og:image named as both. The naming rule is what keeps out the press strip
 * and the partner's mark that pages also label "logo".
 */
export function headerLogoUrls(html: string, base: string, names: string[], domain: string): { url: string; how: string }[] {
  const abs = (u: string) => {
    try {
      return new URL(u.replace(/&amp;/g, "&").replace(/\\\//g, "/"), base).toString();
    } catch {
      return null;
    }
  };
  const ours = [...new Set([...names.flatMap(nameTokens).filter((t) => t.length >= 4), label(domain)].filter((t) => t.length >= 3))];
  const namesUs = (hint: string) => {
    const h = hint.toLowerCase().replace(/[^a-z0-9]/g, "");
    return ours.some((t) => h.includes(t));
  };
  const GENERIC = /^(site[-_]?|main[-_]?|header[-_]?)?logo([-_.]?(dark|light|white|black|color|colour|full|main|header|primary|horizontal|vertical|retina|small|large|default|2x|@2x|\d+))*\.(svg|png|jpe?g|webp|gif)$/i;
  const fileOf = (u: string) => decodeURIComponent(u.split(/[?#]/)[0].split("/").pop() ?? "");
  // Whether a FILE is this firm's: its name names the firm, or is a short form
  // of it - citi-logo.svg for Citigroup - at least three letters long, so that
  // sp-logo.svg is not taken for Summit Park.
  const fileNamesUs = (file: string) => {
    const stem = file.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/logo|[^a-z]/g, "");
    return namesUs(file) || (stem.length >= 3 && ours.some((t) => t.startsWith(stem)));
  };
  const out: { url: string; how: string }[] = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const l = /"logo"\s*:\s*(?:"([^"]+)"|\{[^}]*?"(?:url|contentUrl)"\s*:\s*"([^"]+)")/i.exec(m[1]);
    const u = l && abs(l[1] ?? l[2]);
    // The declared logo still has to be this firm's file: a site built on a
    // vendor's template can declare the vendor's (Cuadrilla's says Infodesk).
    if (u && !NOT_THE_FIRMS_LOGO.test(u) && (GENERIC.test(fileOf(u)) || fileNamesUs(fileOf(u)))) out.push({ url: u, how: "jsonld" });
  }
  let imgs = 0;
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = attr(tag, "src") || attr(tag, "data-src") || attr(tag, "data-lazy-src");
    const hint = `${attr(tag, "class")} ${attr(tag, "id")} ${attr(tag, "alt")} ${src}`;
    if (!src || src.startsWith("data:") || !/logo/i.test(hint) || NOT_THE_FIRMS_LOGO.test(hint)) continue;
    // The FILE must be this firm's: its name names the firm, or it is a
    // generic "logo.svg" whose alt text does. Alt text alone is not enough -
    // pages caption a TV station's logo or a client's with their own name
    // (WXIA-NBC-Logo-1.png, KME-SPECIAL-Logo.jpg).
    const file = fileOf(src);
    if (!fileNamesUs(file) && !(GENERIC.test(file) && namesUs(attr(tag, "alt")))) continue;
    const u = abs(src);
    if (u) out.push({ url: u, how: "img" });
    if (++imgs >= 2) break;
  }
  const og = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/i.exec(html)?.[1];
  if (og && /logo/i.test(og) && namesUs(og) && !NOT_THE_FIRMS_LOGO.test(og)) {
    const u = abs(og);
    if (u) out.push({ url: u, how: "og" });
  }
  return [...new Map(out.map((o) => [o.url, o])).values()];
}

// ------------------------------------------------------- stage 2d: browser

/**
 * A real browser, for sites a plain request got nothing usable from: a bot
 * wall, or a page whose icons and logo JavaScript adds. On a sample of 40
 * such sites it loaded 25, and 16 of those declared icons once rendered. CHROMIUM_PATH points it at an installed Chromium; HTTPS_PROXY is
 * passed through, and the proxy's CA must be in the browser's trust store
 * (NSS) - verification is never switched off.
 *
 * EVERY REQUEST THROUGH A CHECKED ADDRESS
 * ---------------------------------------
 * This loads thousands of firm homepages - domains out of a seed file, plus
 * wherever each one redirects - on an operator's own machine. With no proxy,
 * Chromium resolves those names itself and will dial whatever comes back,
 * including 127.0.0.1 and the laptop's LAN. So when the operator has not put a
 * proxy of their own in front of it, this starts
 * lib/monitoring/render-proxy.ts and points Chromium at that: it resolves each
 * hostname once, refuses internal addresses and non-web ports, and dials the
 * address it checked. Identical to what the crawler's rendered path does - see
 * the comment above `getBrowser` in
 * src/lib/monitoring/connectors/generic.ts for why the per-page check it also
 * runs cannot close this on its own.
 *
 * `--proxy-bypass-list=<-loopback>` is not optional, and it is passed in the
 * HTTPS_PROXY case too: Chromium bypasses a proxy for localhost and 127.0.0.1
 * by default, which is the one destination worth refusing.
 *
 * HTTPS_PROXY still wins when it is set. That is the containerised run this
 * file was written for, where the operator's own proxy IS the filter and
 * replacing it would cut the browser's only route out.
 */
let browser: Promise<Browser> | null = null;
let renderProxy: RenderProxy | null = null;

/**
 * The proxy, loaded at the one moment it is needed.
 *
 * `import "server-only"` at the top of lib/monitoring/render-proxy throws
 * unless node was given --conditions=react-server, so the stage that renders
 * pages is where that requirement is enforced - and it is enforced by
 * refusing, never by launching an unfiltered browser instead. The message says
 * exactly what to re-run, because the React one ("cannot be imported from a
 * Client Component module") explains nothing to an operator harvesting logos.
 */
async function startFilteringProxy(): Promise<RenderProxy> {
  try {
    const { startRenderProxy } = await import("@/lib/monitoring/render-proxy");
    return await startRenderProxy();
  } catch (err) {
    if (String(err).includes("Client Component")) {
      throw new Error(
        "The browser stage needs the crawler's filtering proxy, which is server-only code.\n" +
          "  Re-run with: npx tsx --conditions=react-server scripts/find-firm-logos.ts\n" +
          "  (or add --skip-browser to use only the stages that need no browser)",
      );
    }
    throw err;
  }
}

function getBrowser(): Promise<Browser> {
  browser ??= (async () => {
    const ownProxy = process.env.HTTPS_PROXY;
    // `--no-sandbox` is the container's problem, not every operator's.
    // Chromium's sandbox is the thing standing between a hostile page and the
    // rest of the machine, and this file turned it off unconditionally for the
    // sake of the one environment that cannot keep it (no user namespaces in
    // the image, which is also where CHROMIUM_PATH and HTTPS_PROXY are set).
    // An ordinary operator run on a laptop now keeps it; the container, which
    // is the thing that sets those two variables, still gets it switched off.
    const containerised = Boolean(ownProxy || process.env.CHROMIUM_PATH);
    const proxy = ownProxy ? null : await startFilteringProxy();
    renderProxy = proxy;
    try {
      return await puppeteer.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: [
          ...(containerised ? ["--no-sandbox"] : []),
          `--proxy-server=${ownProxy ?? `http://127.0.0.1:${proxy!.port}`}`,
          "--proxy-bypass-list=<-loopback>",
        ],
        // The browser child inherits none of this process's environment. Run
        // with --env-file=.env.local, process.env here holds live database and
        // API credentials, and a thousand third-party pages have no business
        // in the same process tree as those. HOME survives in the HTTPS_PROXY
        // case alone, because NSS reads the proxy's CA out of $HOME/.pki/nssdb
        // and without it every https page in the container would fail to
        // verify.
        env: ownProxy && process.env.HOME ? { HOME: process.env.HOME } : {},
      });
    } catch (err) {
      // A failed launch must not leave the proxy listening - its socket would
      // keep this process alive - and must not cache its own rejection as the
      // browser for the rest of the run.
      await proxy?.close().catch(() => {});
      renderProxy = null;
      browser = null;
      throw err;
    }
  })();
  return browser;
}

/** Closes the browser and, with it, the proxy that is only there to serve it.
 *  Both or neither: the listening socket keeps the process alive on its own. */
async function closeBrowser(): Promise<void> {
  const pending = browser;
  const proxy = renderProxy;
  browser = null;
  renderProxy = null;
  if (pending) {
    const b = await pending.catch(() => null);
    if (b) await b.close().catch(() => {});
  }
  if (proxy) await proxy.close().catch(() => {});
}

async function viaPage(page: Page, url: string): Promise<{ bytes: Buffer; type: string; url: string } | null> {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (!res || !res.ok()) return null;
    return { bytes: Buffer.from(await res.buffer()), type: res.headers()["content-type"] ?? "", url: res.url() };
  } catch {
    return null;
  }
}

/** Icons and the homepage logo, as a browser sees the site. Same rules as the plain stages. */
async function browserCandidates(page: Page, domain: string, names: string[]): Promise<{ landed: string; moved: boolean; candidates: Measured[] }> {
  let home: Awaited<ReturnType<typeof viaPage>> = null;
  let html = "";
  for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
    home = await viaPage(page, u);
    if (home) {
      // Icons and logos a script adds land just after the document does.
      await new Promise((r) => setTimeout(r, 1500));
      html = await page.content().catch(() => "");
      break;
    }
  }
  if (!home) return { landed: "", moved: false, candidates: [] };
  const landedHost = new URL(home.url).hostname;
  const landed = registrableDomain(landedHost);
  const moved =
    landed !== registrableDomain(domain) && SAME_BRAND_REDIRECTS.get(domain) !== landed && !sameBrand(names, domain, landedHost);
  if (moved) return { landed, moved, candidates: [] };
  const origin = new URL(home.url).origin;
  const wanted: { href: string; from: Measured["from"] }[] = [
    ...iconLinks(html, home.url).filter((l) => l.from !== "manifest").sort((a, b) => b.size - a.size).slice(0, 4),
    { href: `${origin}/apple-touch-icon.png`, from: "apple" },
    ...headerLogoUrls(html, home.url, names, domain).slice(0, 3).map((h) => ({ href: h.url, from: "header" as const })),
    { href: `${origin}/favicon.ico`, from: "link" },
  ];
  const candidates: Measured[] = [];
  for (const w of [...new Map(wanted.map((x) => [x.href, x])).values()]) {
    if (!/^(https:\/\/|data:image\/)/i.test(w.href)) continue;
    const img = w.href.startsWith("data:") ? decodeDataUri(w.href) : await viaPage(page, w.href);
    if (!img) continue;
    const m = await measure(img.bytes, img.type, img.url, w.from === "link" && isSvg(img.bytes, img.type) ? "svg" : w.from);
    if (!m) continue;
    if (w.from === "header" && (m.whiteOnly || m.lightOnClear || (m.colors ?? 0) > 300)) continue;
    candidates.push(m);
  }
  return { landed, moved, candidates };
}

async function headerCandidates(domain: string, names: string[]): Promise<Measured[]> {
  let page = await get(`https://${domain}/`, 1_200_000);
  if (!page && !domain.startsWith("www.")) page = await get(`https://www.${domain}/`, 1_200_000);
  if (!page) return [];
  const out: Measured[] = [];
  for (const c of headerLogoUrls(page.bytes.toString("utf8"), page.url, names, domain).slice(0, 3)) {
    const img = await get(c.url, 3_000_000);
    const m = img && (await measure(img.bytes, img.type, img.url, "header"));
    // A photo (hundreds of colours) or artwork drawn for a dark header is not
    // a logo this tile can show.
    if (m && !m.whiteOnly && !m.lightOnClear && (m.colors ?? 0) <= 300) out.push(m);
  }
  return out;
}

/** The firms students look at most: hand-curated, verified programmes, tiered, or $50B+ AUM. */
function notableDomains(): Set<string> {
  return new Set(
    FIRM_SEEDS.filter((f) => f.hasVerifiedStudentProgram !== false || f.ibTier || f.peTier || (f.aum ?? 0) >= 5e10)
      .map((f) => logoDomain(f.website))
      .filter(Boolean),
  );
}

/** Every firm on the site, grouped by the domain its logo is looked up by. */
function firmDomains(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of FIRM_SEEDS) {
    const d = logoDomain(f.website);
    if (!d) continue;
    out.set(d, [...(out.get(d) ?? []), f.name]);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? null : (args[i + 1] ?? "");
  };
  mkdirSync(CACHE_DIR, { recursive: true });

  const domains = firmDomains();
  const only = flag("--only")?.split(",").map((d) => logoDomain(d)).filter(Boolean);
  const targets = only?.length ? only : [...domains.keys()];
  const refresh = args.includes("--refresh");
  console.log(`${FIRM_SEEDS.length} firms, ${domains.size} logo domains.`);

  if (flag("--sheet") !== null) {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, Entry>;
    const which = flag("--sheet");
    const list =
      which === "top"
        ? FIRM_SEEDS.filter((f) => f.ibTier || f.peTier || f.hasVerifiedStudentProgram !== false).slice(0, 400)
        : FIRM_SEEDS.filter((f) => targets.includes(logoDomain(f.website)));
    const offset = Number(flag("--from") ?? 0);
    const page = list.slice(offset, offset + 64);
    const out = path.join(CACHE_DIR, `sheet-${which}-${offset}.png`);
    await contactSheet(
      page.map((f) => {
        const d = logoDomain(f.website);
        const e = manifest[d];
        return { name: f.name, domain: d || f.website || "(no website)", url: e && "u" in e ? e.u : null };
      }),
      out,
    );
    console.log(`Wrote ${out} (${page.length} of ${list.length} firms).`);
    return;
  }

  if (!args.includes("--pick")) {
    // Stage 1.
    const done = new Set(refresh ? [] : readJsonl<SiteRow>(SITE_CACHE).map((r) => r.domain));
    const todo = targets.filter((d) => !done.has(d));
    console.log(`Site icons: ${todo.length} to fetch (${done.size} cached).`);
    let n = 0;
    await pool(todo, 24, async (domain) => {
      // A watchdog as well as the per-request timeouts: one site whose
      // response stalled without ever erroring left a promise that could not
      // settle, and Node exits - silently, code 0 - when only that is left.
      // A stuck site is recorded as having nothing, and the run goes on.
      const row = await withTimeout(siteCandidates(domain, domains.get(domain) ?? []), 90_000, {
        domain,
        landed: "",
        moved: false,
        candidates: [],
      });
      appendFileSync(SITE_CACHE, JSON.stringify(row) + "\n");
      if (++n % 250 === 0 || only?.length) {
        const best = row.candidates.sort((a, b) => tileScore(b) - tileScore(a))[0];
        console.log(`  ${n}/${todo.length} ${domain}: ${row.moved ? `moved to ${row.landed}` : best ? `${best.from} ${best.eff}px` : "nothing"}`);
      }
    });

    // Stage 2: Wikidata. --skip-wikidata leaves it for a later run - for when
    // Wikimedia is pacing this script and the stages after it should not wait.
    if (!args.includes("--skip-wikidata")) {
      const wikiDone = new Set(refresh ? [] : readJsonl<{ domain: string; checked?: boolean }>(WIKI_CACHE).map((r) => r.domain));
      const wikiTodo = targets.filter((d) => !wikiDone.has(d));
      console.log(`Wikidata: ${wikiTodo.length} domains to look up.`);
      const batches: string[][] = [];
      for (let i = 0; i < wikiTodo.length; i += 40) batches.push(wikiTodo.slice(i, i + 40));
      const measureFiles = async (files: string[]) => {
        const out: Measured[] = [];
        for (const f of files.slice(0, 2)) {
          const url = await commonsPng(f);
          const img = url && (await get(url, 3_000_000, WIKI_UA, 20_000));
          const m = img && (await measure(img.bytes, img.type, img.url, "wikidata"));
          if (m) out.push(m);
        }
        return out;
      };
      let b = 0;
      await pool(batches, 3, async (batch) => {
        const hits = await withTimeout(wikidataBatch(batch), 180_000, null);
        if (!hits) {
          console.log(`  Wikidata batch failed, left for the next run: ${batch[0]}..`);
          return;
        }
        const lines: string[] = [];
        for (const hit of hits) {
          const names = domains.get(hit.domain) ?? [];
          // Matched on the website; the name must agree too, or it is a parent
          // or a namesake that happens to list the same site.
          if (!sameName(names, hit.label)) continue;
          const candidates = await measureFiles(hit.files);
          lines.push(JSON.stringify({ domain: hit.domain, qid: hit.qid, label: hit.label, candidates, files: hit.files } satisfies WikiRow));
        }
        // A marker per domain looked at, hit or not, so a resumed run skips it.
        for (const d of batch) lines.push(JSON.stringify({ domain: d, checked: true }));
        appendFileSync(WIKI_CACHE, lines.join("\n") + "\n");
        if (++b % 25 === 0) console.log(`  ${b}/${batches.length} Wikidata batches`);
      });

      // Stage 2a, by name: every firm the exact-website match missed and that
      // has no sharp square icon of its own (one with would never pick a
      // Wikidata wordmark). Slow - two API calls a firm, most of them small
      // advisers Wikidata has never heard of - so it has its own resume marker,
      // and notable firms go first.
      const wikiRows = readJsonl<WikiRow & { checked?: boolean; named?: boolean }>(WIKI_CACHE);
      const exact = new Set(wikiRows.filter((r) => r.qid).map((r) => r.domain));
      const named = new Set(refresh ? [] : wikiRows.filter((r) => r.named).map((r) => r.domain));
      const siteNow = new Map(readJsonl<SiteRow>(SITE_CACHE).map((r) => [r.domain, r]));
      const notableNow = notableDomains();
      const needsName = (d: string) => {
        const r = siteNow.get(d);
        return !exact.has(d) && !named.has(d) && !r?.moved && !(r?.candidates ?? []).some((c) => c.aspect <= 1.35 && c.eff >= 128 && !c.whiteOnly);
      };
      const nameTodo = targets.filter(needsName).sort((x, y) => Number(notableNow.has(y)) - Number(notableNow.has(x)));
      console.log(`Wikidata by name: ${nameTodo.length} firms to search.`);
      let n2 = 0;
      await pool(nameTodo, 10, async (d) => {
        const hits = await withTimeout(wikidataByName(d, domains.get(d) ?? [d]), 120_000, null);
        if (!hits) return; // timed out: left unmarked for the next run
        const lines: string[] = [];
        for (const hit of hits) {
          const candidates = await measureFiles(hit.files);
          lines.push(JSON.stringify({ domain: d, qid: hit.qid, label: hit.label, candidates, files: hit.files } satisfies WikiRow));
        }
        lines.push(JSON.stringify({ domain: d, named: true }));
        appendFileSync(WIKI_CACHE, lines.join("\n") + "\n");
        if (++n2 % 500 === 0) console.log(`  ${n2}/${nameTodo.length} searched by name`);
      });

      // Matches whose images could not be fetched at the time - Wikimedia
      // pacing, a timeout - are fetched again rather than left without a logo.
      const latest = new Map<string, WikiRow>();
      for (const r of readJsonl<WikiRow & { checked?: boolean; named?: boolean }>(WIKI_CACHE)) if (r.qid) latest.set(`${r.domain}|${r.qid}`, r);
      const retry = [...latest.values()].filter((r) => r.files?.length && !r.candidates.length);
      if (retry.length) console.log(`Wikidata: fetching images again for ${retry.length} matches.`);
      for (const r of retry) {
        const candidates = await measureFiles(r.files!);
        if (candidates.length) appendFileSync(WIKI_CACHE, JSON.stringify({ ...r, candidates }) + "\n");
      }
    }
  }

  // Stage 3: last write per domain wins, so --refresh re-runs replace old rows.
  const site = new Map(readJsonl<SiteRow>(SITE_CACHE).map((r) => [r.domain, r]));
  const wiki = new Map<string, WikiRow[]>();
  for (const r of readJsonl<WikiRow & { checked?: boolean; named?: boolean }>(WIKI_CACHE)) {
    if (r.checked || r.named) continue;
    wiki.set(r.domain, [...(wiki.get(r.domain) ?? []).filter((w) => w.qid !== r.qid), r]);
  }

  // Stage 2b: App Store icons, for notable firms still without a sharp
  // square mark. Apple allows ~20 searches a minute, hence the pacing and
  // hence notable firms only - small advisers rarely publish an app anyway.
  if (!args.includes("--pick")) {
    const appDone = new Set(refresh ? [] : readJsonl<{ domain: string }>(APP_CACHE).map((r) => r.domain));
    const notable = notableDomains();
    const sharpSquare = (d: string) =>
      [...(site.get(d)?.candidates ?? []), ...(wiki.get(d) ?? []).flatMap((w) => w.candidates)].some(
        (c) => c.aspect <= 1.35 && c.eff >= 128 && !c.whiteOnly && !REJECTED.has(c.ahash),
      );
    const appTodo = targets.filter((d) => notable.has(d) && !appDone.has(d) && !site.get(d)?.moved && !sharpSquare(d));
    console.log(`App Store: ${appTodo.length} notable firms to look up.`);
    for (const [i, d] of appTodo.entries()) {
      const candidates = await withTimeout(appCandidates(d, domains.get(d) ?? [d]), 90_000, []);
      appendFileSync(APP_CACHE, JSON.stringify({ domain: d, candidates }) + "\n");
      if (only?.length) console.log(`  ${d}: ${candidates.length ? `app ${candidates[0].eff}px` : "no app"}`);
      if (i < appTodo.length - 1) await new Promise((r) => setTimeout(r, 3200));
    }
  }
  const apps = new Map(readJsonl<{ domain: string; candidates: Measured[] }>(APP_CACHE).map((r) => [r.domain, r.candidates]));

  // Stage 2c: the logo on the firm's own homepage, for every firm that would
  // otherwise get the letter tile.
  if (!args.includes("--pick")) {
    const headerDone = new Set(refresh ? [] : readJsonl<{ domain: string }>(HEADER_CACHE).map((r) => r.domain));
    const best = (d: string) =>
      Math.max(
        -1,
        ...[...(site.get(d)?.candidates ?? []), ...(wiki.get(d) ?? []).flatMap((w) => w.candidates), ...(apps.get(d) ?? [])]
          .filter((c) => !REJECTED.has(c.ahash))
          .map(tileScore),
      );
    const headerTodo = targets.filter((d) => !headerDone.has(d) && !site.get(d)?.moved && best(d) < MIN_EFFECTIVE);
    console.log(`Homepage logos: ${headerTodo.length} firms without one yet.`);
    let n3 = 0;
    await pool(headerTodo, 24, async (d) => {
      const candidates = await withTimeout(headerCandidates(d, domains.get(d) ?? []), 90_000, null);
      if (!candidates) return; // stalled: left for the next run
      appendFileSync(HEADER_CACHE, JSON.stringify({ domain: d, candidates }) + "\n");
      if (++n3 % 500 === 0 || only?.length) console.log(`  ${n3}/${headerTodo.length} homepages read${only?.length ? ` - ${d}: ${candidates.length ? `${candidates[0].eff}px ${candidates[0].aspect.toFixed(1)}:1` : "none"}` : ""}`);
    });
  }
  // Stage 2d: a real browser, for every firm still without a logo - whose
  // homepage never answered a plain request, or answered with a page whose
  // icons and logo JavaScript adds after it loads.
  if (!args.includes("--pick") && !args.includes("--skip-browser")) {
    const browserDone = new Set(refresh ? [] : readJsonl<{ domain: string }>(BROWSER_CACHE).map((r) => r.domain));
    const headerNow = new Map(readJsonl<{ domain: string; candidates: Measured[] }>(HEADER_CACHE).map((r) => [r.domain, r.candidates]));
    const bestNow = (d: string) =>
      Math.max(
        -1,
        ...[...(site.get(d)?.candidates ?? []), ...(wiki.get(d) ?? []).flatMap((w) => w.candidates), ...(apps.get(d) ?? []), ...(headerNow.get(d) ?? [])]
          .filter((c) => !REJECTED.has(c.ahash))
          .map(tileScore),
      );
    const browserTodo = targets.filter((d) => !browserDone.has(d) && !site.get(d)?.moved && bestNow(d) < MIN_EFFECTIVE);
    console.log(`Browser: ${browserTodo.length} sites still without a logo.`);
    if (browserTodo.length) {
      const b = await getBrowser();
      let n4 = 0;
      await pool(browserTodo, 6, async (d) => {
        const page = await b.newPage();
        try {
          await page.setUserAgent(UA);
          const row = await withTimeout(browserCandidates(page, d, domains.get(d) ?? []), 120_000, null);
          if (row) appendFileSync(BROWSER_CACHE, JSON.stringify({ domain: d, ...row }) + "\n");
        } finally {
          await page.close().catch(() => {});
        }
        if (++n4 % 250 === 0 || only?.length) console.log(`  ${n4}/${browserTodo.length} sites loaded in the browser`);
      });
      await closeBrowser();
    }
  }
  const browserRows = readJsonl<{ domain: string; landed: string; moved: boolean; candidates: Measured[] }>(BROWSER_CACHE);
  for (const r of browserRows) {
    // A site the browser followed to another company is that company's: its
    // plain-request row learns it moved, and gets no logo.
    if (r.moved) site.set(r.domain, { ...(site.get(r.domain) ?? { domain: r.domain, candidates: [] }), landed: r.landed, moved: true });
    else if (r.candidates.length) apps.set(r.domain, [...(apps.get(r.domain) ?? []), ...r.candidates]);
  }
  const headers = new Map(readJsonl<{ domain: string; candidates: Measured[] }>(HEADER_CACHE).map((r) => [r.domain, r.candidates]));
  for (const [d, c] of headers) apps.set(d, [...(apps.get(d) ?? []), ...c]);
  const { manifest, report } = pick(domains, site, wiki, apps);
  const previous = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, Entry>) : {};
  const merged = { ...previous, ...manifest };
  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST, "{\n" + Object.entries(sorted).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") + "\n}\n");
  writeFileSync(REPORT, report.join("\n") + "\n");
  const logos = Object.values(manifest).filter((e) => "u" in e).length;
  console.log(`Picked: ${logos} logos, ${Object.keys(manifest).length - logos} none. Manifest: ${MANIFEST}. Report: ${REPORT}.`);
}

// Run only when invoked, so the measuring and brand checks can be imported by tests.
if (process.argv[1]?.endsWith("find-firm-logos.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
